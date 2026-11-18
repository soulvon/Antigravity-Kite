/**
 * IDE 运行时探测：主程序路径、当前窗口进程快照、agy 引擎热重载。
 * 切号链路只依赖这些能力，不再承载多实例分身管理。
 */
import * as vscode from 'vscode';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as cp from 'child_process';
import { getAppDataDir } from './platformPaths';
import { ensureWinNativeHelper, reloadWinAgyNative } from './winNativeHelper';
import { logInfo, logWarn } from './logger';
import { t } from './i18n';

const isWindows = process.platform === 'win32';
const isMac = process.platform === 'darwin';

export function getDefaultUserDataDir(): string {
  const candidates = [
    path.join(getAppDataDir(), 'Antigravity IDE'),
    path.join(getAppDataDir(), 'Antigravity IDE - Next'),
  ];
  for (const c of candidates) {
    if (fs.existsSync(c)) return c;
  }
  return candidates[0];
}

export function normalizePath(p: string): string {
  const trimmed = p.trim();
  if (isWindows) return trimmed.toLowerCase().replace(/\//g, '\\').replace(/\\+$/, '');
  return trimmed.replace(/\\+/g, '/').replace(/\/+$/, '');
}

let _effectiveUserDataDirOverride: string | null = null;

export function setEffectiveCurrentUserDataDir(dir: string): void {
  _effectiveUserDataDirOverride = dir && dir.trim() ? dir.trim() : null;
}

export function getEffectiveCurrentUserDataDir(): string {
  return _effectiveUserDataDirOverride || getCurrentUserDataDir();
}

/** 当前窗口的 user-data-dir（非默认数据目录启动时会带 --user-data-dir 参数） */
export function getCurrentUserDataDir(): string {
  const args = process.argv;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--user-data-dir' && args[i + 1]) return args[i + 1];
    const eqMatch = args[i].match(/^--user-data-dir=(.+)$/);
    if (eqMatch) return eqMatch[1];
  }
  return getDefaultUserDataDir();
}

// ─── 主程序路径 ─────────────────────────────────────────

let _exePathCache: { path: string | null; ts: number } | null = null;

export async function detectExePath(): Promise<string | null> {
  if (_exePathCache && Date.now() - _exePathCache.ts < 10000) {
    if (!_exePathCache.path || fs.existsSync(_exePathCache.path)) return _exePathCache.path;
  }
  const found = isWindows ? await detectExeWindows() : await detectExeUnix();
  _exePathCache = { path: found, ts: Date.now() };
  return found;
}

async function detectExeWindows(): Promise<string | null> {
  // 1. 从 vscode.env.appRoot 推导
  const appRoot = vscode.env.appRoot; // e.g. C:\Program Files\Antigravity IDE\resources\app
  const exeNames = ['Antigravity IDE.exe', 'Antigravity.exe'];
  for (const name of exeNames) {
    const fromAppRoot = path.resolve(appRoot, '..', '..', name);
    if (fs.existsSync(fromAppRoot)) return fromAppRoot;
  }

  // 2. 常见安装路径及模糊子目录扫描（兼容 C:\Program Files\Antigravity1.18.4\Antigravity.exe 等多版本情况）
  const localAppData = process.env.LOCALAPPDATA || '';
  const programFiles = process.env.ProgramFiles || 'C:\\Program Files';
  const candidates: string[] = [];

  for (const name of exeNames) {
    const mainDir = name.slice(0, -4); // 'Antigravity IDE' 或 'Antigravity'
    candidates.push(
      path.join(localAppData, 'Programs', mainDir, name),
      path.join(programFiles, mainDir, name)
    );

    const drives = ['C', 'D', 'E', 'F'];
    const roots = ['Program Files', 'Program'];
    for (const drive of drives) {
      for (const root of roots) {
        const rootPath = path.join(`${drive}:\\`, root);
        if (fs.existsSync(rootPath)) {
          try {
            const subdirs = fs.readdirSync(rootPath);
            for (const sub of subdirs) {
              if (sub.toLowerCase().startsWith('antigravity')) {
                candidates.push(path.join(rootPath, sub, name));
              }
            }
          } catch (e) {
            logWarn('ideRuntime.scanDir.fail', { rootPath, error: e instanceof Error ? e.message : String(e) });
          }
        }
      }
    }
  }

  for (const c of candidates) {
    if (c && fs.existsSync(c)) return c;
  }

  // 3. 从正在运行的进程获取（支持两种进程名；Win11 优先 PowerShell CIM，无结果再回退 wmic）
  const entries = await getRunningEntries();
  for (const [pid] of entries) {
    const psOut = await runPowerShellAsync(
      `(Get-CimInstance Win32_Process -Filter "ProcessId=${pid}").ExecutablePath`,
      3000
    );
    const psPath = psOut?.replace(/^\uFEFF/, '').trim();
    if (psPath && fs.existsSync(psPath)) return psPath;

    const out = await runShellAsync(`wmic process where "ProcessId=${pid}" get ExecutablePath /FORMAT:LIST`, 3000);
    const match = out?.match(/ExecutablePath=(.+)/);
    const exePath = match?.[1]?.trim();
    if (exePath && fs.existsSync(exePath)) return exePath;
  }

  // 4. PATH
  for (const name of exeNames) {
    try {
      const out = cp.execSync(`where "${name}"`, { encoding: 'utf8', timeout: 3000, windowsHide: true });
      const first = out.split('\n').map(l => l.trim()).find(l => l && fs.existsSync(l));
      if (first) return first;
    } catch { /* PATH 中未找到该可执行名 */ }
  }

  return null;
}

function isRegularFile(p: string): boolean {
  try {
    return fs.existsSync(p) && !fs.statSync(p).isDirectory();
  } catch (e) {
    logWarn('ideRuntime.isRegularFile.fail', { path: p, error: e instanceof Error ? e.message : String(e) });
    return false;
  }
}

async function detectExeUnix(): Promise<string | null> {
  const appRoot = vscode.env.appRoot || '';
  if (appRoot) {
    if (isMac) {
      for (const name of ['Electron', 'Antigravity IDE', 'Antigravity']) {
        const fromAppRoot = path.resolve(appRoot, '..', '..', 'MacOS', name);
        if (isRegularFile(fromAppRoot)) return fromAppRoot;
      }
    } else {
      for (const name of ['antigravity-ide', 'antigravity', 'Antigravity IDE', 'Antigravity']) {
        const fromAppRoot = path.resolve(appRoot, '..', '..', name);
        if (isRegularFile(fromAppRoot)) return fromAppRoot;
      }
    }
  }

  const home = os.homedir();
  const candidates = isMac
    ? [
        '/Applications/Antigravity IDE.app/Contents/MacOS/Electron',
        '/Applications/Antigravity.app/Contents/MacOS/Electron',
        path.join(home, 'Applications', 'Antigravity IDE.app', 'Contents', 'MacOS', 'Electron'),
        path.join(home, 'Applications', 'Antigravity.app', 'Contents', 'MacOS', 'Electron'),
      ]
    : [
        '/usr/bin/antigravity-ide',
        '/usr/local/bin/antigravity-ide',
        '/opt/Antigravity IDE/antigravity-ide',
        '/usr/share/antigravity-ide/antigravity-ide',
        '/usr/bin/antigravity',
        '/usr/local/bin/antigravity',
        '/opt/Antigravity/antigravity',
        '/usr/share/antigravity/antigravity',
        path.join(home, '.local', 'bin', 'antigravity-ide'),
        path.join(home, '.local', 'bin', 'antigravity'),
      ];
  for (const c of candidates) {
    if (isRegularFile(c)) return c;
  }
  for (const binName of ['antigravity-ide', 'antigravity']) {
    try {
      const out = cp.execSync(`which ${binName}`, { encoding: 'utf8', timeout: 3000 });
      const found = out.trim().split(/\r?\n/)[0]?.trim();
      if (found && isRegularFile(found)) return found;
    } catch { /* PATH 中未找到该可执行名 */ }
  }
  return null;
}

// ─── 进程检测 ───────────────────────────────────────────

let _processCache: { entries: Array<[number, string | null]>; ts: number } | null = null;

/** 主动失效进程缓存（多开启停后调用，消除 3s 缓存盲区） */
export function invalidateProcessCache(): void {
  _processCache = null;
}

export async function getRunningEntries(forceFresh = false): Promise<Array<[number, string | null]>> {
  if (!forceFresh && _processCache && Date.now() - _processCache.ts < 3000) {
    return _processCache.entries;
  }
  const entries = isWindows ? await getRunningEntriesWindows() : await getRunningEntriesUnix();
  _processCache = { entries, ts: Date.now() };
  return entries;
}

/**
 * 从完整命令行解析 --user-data-dir。
 * 必须支持「后面还跟着工作区路径」的形态：
 *   "...exe" --user-data-dir C:\...\mw_xxx "e:\project\demo"
 * 旧正则要求路径后紧跟 -- 或行尾，会把多开实例误判成主窗口。
 */
export function parseUserDataDir(cmd: string): string {
  const m = cmd.match(/--user-data-dir[= ]+(?:"([^"]+)"|'([^']+)'|(\S+))/i);
  const dir = m ? (m[1] || m[2] || m[3] || '').trim() : '';
  return dir || getDefaultUserDataDir();
}

const NON_IDE_MAIN_EXECUTABLES = new Set([
  'sh', 'bash', 'zsh', 'dash', 'ash', 'fish', 'ksh', 'csh',
  'cmd', 'cmd.exe', 'pwsh', 'pwsh.exe', 'powershell', 'powershell.exe',
  'node', 'node.exe', 'env', 'sudo', 'su', 'ssh', 'ssh.exe',
]);

export function tokenizeCommandLine(cmd: string): string[] {
  const out: string[] = [];
  let cur = '';
  let quote: '"' | "'" | null = null;
  for (let i = 0; i < cmd.length; i++) {
    const c = cmd[i];
    if (quote) {
      if (c === quote) { quote = null; continue; }
      cur += c;
      continue;
    }
    if (c === '"' || c === "'") { quote = c; continue; }
    if (/\s/.test(c)) {
      if (cur) { out.push(cur); cur = ''; }
      continue;
    }
    cur += c;
  }
  if (cur) out.push(cur);
  return out;
}

function quoteCmdValue(val: string): string {
  if (!/[\s"']/.test(val)) return val;
  if (!val.includes('"')) return `"${val}"`;
  if (!val.includes("'")) return `'${val}'`;
  return val.split('"').map((seg) => (seg ? `"${seg}"` : '')).join('\'"\'');
}

/** 将 Linux /proc/<pid>/cmdline 的 NUL 分隔 argv 无损拼装为命令行，保留含空格/引号的参数边界 */
export function formatUnixProcCmdline(raw: Buffer | string): string {
  const text = Buffer.isBuffer(raw) ? raw.toString('utf8') : String(raw || '');
  if (!text.includes('\0')) return text.trim();
  const tokens = text.split('\0').filter((s) => s.length > 0);
  return tokens
    .map((tok) => {
      const eq = tok.match(/^(--?[A-Za-z0-9_-]+=)(.*)$/s);
      if (eq) return eq[1] + quoteCmdValue(eq[2]);
      return quoteCmdValue(tok);
    })
    .join(' ')
    .trim();
}

function readUnixProcCmdline(pid: number, fallback: string): string {
  try {
    return formatUnixProcCmdline(fs.readFileSync(`/proc/${pid}/cmdline`));
  } catch {
    return formatUnixProcCmdline(fallback);
  }
}

/**
 * IDE 主进程判定。除 --type= / js 扩展宿主 / crashpad 外，
 * 还必须排除 Remote SSH/WSL 的 shell 包装器（sh/bash）与远端服务端进程（.antigravity*-server/--start-server/*-reh），
 * 防止开启 CDP 或获取主程序路径时把 `sh` 当成桌面主程序；同时保留携带 --remote/--folder-uri 的本地桌面窗口主进程。
 */
export function isIdeMainProcessCmd(cmd: string): boolean {
  const trimmed = (cmd || '').trim();
  if (!trimmed) return false;
  if (/--type=/i.test(trimmed)) return false;
  if (/[\\/]resources[\\/]app[\\/]extensions[\\/]/i.test(trimmed)) return false;
  if (/\.js["']?(?:\s|$)/i.test(trimmed)) return false;
  // Chromium 内部参数：只做精确匹配，避免用户工作区路径含 plugin/gpu 这类词时误伤主进程
  if (/--node-ipc\b/i.test(trimmed)) return false;
  if (/--clientprocessid=/i.test(trimmed)) return false;
  if (/[\\/]crashpad[\\/]/i.test(trimmed)) return false;
  if (/[\\/]\.(?:antigravity(?:-ide)?|vscode|cursor)-server[\\/]/i.test(trimmed)) return false;
  if (/[\\/]out[\\/]server-main\.js\b/i.test(trimmed)) return false;
  if (/--(?:start-server|enable-remote-auto-shutdown)\b/i.test(trimmed)) return false;

  const tokens = tokenizeCommandLine(trimmed);
  const exe = (tokens[0] || '').replace(/\\/g, '/');
  const exeBase = (exe.split('/').pop() || '').toLowerCase();
  if (!exeBase || NON_IDE_MAIN_EXECUTABLES.has(exeBase)) return false;
  if (/-reh$/i.test(exeBase) || /^antigravity(?:-ide)?-server$/i.test(exeBase)) return false;
  return true;
}

async function getRunningEntriesWindows(): Promise<Array<[number, string | null]>> {
  const entries: Array<[number, string | null]> = [];

  // wmic 查询
  try {
    const stdout = await runShellAsync(
      'wmic process where "name=\'Antigravity IDE.exe\' or name=\'Antigravity.exe\'" get ProcessId,CommandLine /FORMAT:LIST',
      10000
    );
    if (stdout && stdout.trim()) {
      const blocks = stdout.split(/\r?\n\r?\n/);
      for (const block of blocks) {
        const cmdMatch = block.match(/CommandLine=(.*)/);
        const pidMatch = block.match(/ProcessId=(\d+)/);
        if (!pidMatch) continue;
        const pid = parseInt(pidMatch[1], 10);
        const cmd = cmdMatch ? cmdMatch[1] : '';
        if (!isIdeMainProcessCmd(cmd)) continue;
        entries.push([pid, parseUserDataDir(cmd)]);
      }
      if (entries.length > 0) return entries;
    }
  } catch (e) {
    // Win11 已移除 wmic，这里失败属预期，但必须留痕以便区分「没进程」与「查询失败」
    logWarn('ideRuntime.enum.wmic', e);
  }

  // PowerShell 回退
  try {
    const psCmd = `Get-CimInstance Win32_Process -Filter "name='Antigravity IDE.exe' or name='Antigravity.exe'" | Select-Object ProcessId,CommandLine | ConvertTo-Json -Compress`;
    const stdout = await runPowerShellAsync(psCmd, 10000);
    if (stdout && stdout.trim()) {
      // PowerShell 输出可能带 BOM，直接 JSON.parse 会抛错并被吞掉，导致枚举结果为空
      const parsed = JSON.parse(stdout.trim().replace(/^\uFEFF/, ''));
      const list = Array.isArray(parsed) ? parsed : [parsed];
      for (const p of list) {
        const pid = Number(p.ProcessId);
        const cmd: string = p.CommandLine || '';
        if (!pid || !isIdeMainProcessCmd(cmd)) continue;
        entries.push([pid, parseUserDataDir(cmd)]);
      }
    }
  } catch (e) {
    logWarn('ideRuntime.enum.powershell', e);
  }

  return entries;
}

async function getRunningEntriesUnix(): Promise<Array<[number, string | null]>> {
  const entries: Array<[number, string | null]> = [];
  try {
    const stdout = await runShellAsync('ps aux', 5000);
    if (!stdout) return entries;
    for (const line of stdout.split('\n')) {
      if (!/antigravity/i.test(line) || /grep/i.test(line)) continue;
      const parts = line.trim().split(/\s+/);
      const pid = parseInt(parts[1], 10);
      if (!pid || isNaN(pid)) continue;
      const normalized = readUnixProcCmdline(pid, parts.slice(10).join(' '));
      if (!isIdeMainProcessCmd(normalized)) continue;
      entries.push([pid, parseUserDataDir(normalized)]);
    }
  } catch (e) {
    logWarn('ideRuntime.enumUnix', e);
  }
  return entries;
}

export interface LaunchInfo {
  pid: number | null;
  exePath: string | null;
  /** 主进程完整启动参数（快照自运行进程，含 --remote-debugging-port 等用户自行附加的参数） */
  args: string[];
}

interface IdeProcessInfo {
  pid: number;
  cmd: string;
}

async function listIdeProcesses(): Promise<IdeProcessInfo[]> {
  const out: IdeProcessInfo[] = [];
  if (!isWindows) {
    // POSIX：ps aux 快照，与 getRunningEntriesUnix 共用 isIdeMainProcessCmd 过滤非桌面主进程
    const stdout = await runShellAsync('ps aux', 8000);
    if (!stdout) return out;
    for (const line of stdout.split('\n')) {
      if (!/antigravity/i.test(line) || /grep/i.test(line)) continue;
      const parts = line.trim().split(/\s+/);
      const pid = parseInt(parts[1], 10);
      if (!pid || isNaN(pid)) continue;
      const cmd = readUnixProcCmdline(pid, parts.slice(10).join(' '));
      if (!isIdeMainProcessCmd(cmd)) continue;
      out.push({ pid, cmd });
    }
    return out;
  }
  try {
    const stdout = await runShellAsync(
      'wmic process where "name=\'Antigravity IDE.exe\' or name=\'Antigravity.exe\'" get ProcessId,CommandLine /FORMAT:LIST',
      10000
    );
    if (stdout && stdout.trim()) {
      const blocks = stdout.split(/\r?\n\r?\n/);
      for (const block of blocks) {
        const cmdMatch = block.match(/CommandLine=(.*)/);
        const pidMatch = block.match(/ProcessId=(\d+)/);
        if (!pidMatch) continue;
        const pid = parseInt(pidMatch[1], 10);
        const cmd = cmdMatch ? cmdMatch[1] : '';
        if (pid && isIdeMainProcessCmd(cmd)) out.push({ pid, cmd });
      }
      if (out.length > 0) return out;
    }
  } catch { /* 走 PowerShell 回退 */ }
  try {
    const psCmd = `Get-CimInstance Win32_Process -Filter "name='Antigravity IDE.exe' or name='Antigravity.exe'" | Select-Object ProcessId,CommandLine | ConvertTo-Json -Compress`;
    const stdout = await runPowerShellAsync(psCmd, 10000);
    if (stdout && stdout.trim()) {
      const cleaned = stdout.replace(/^\uFEFF/, '').trim();
      const parsed = JSON.parse(cleaned);
      const list = Array.isArray(parsed) ? parsed : [parsed];
      for (const p of list) {
        const pid = Number(p.ProcessId);
        const cmd: string = p.CommandLine || '';
        if (pid && isIdeMainProcessCmd(cmd)) out.push({ pid, cmd });
      }
    }
  } catch (e) { logWarn('ideRuntime.listIdeProcesses.fail', e); }
  return out;
}

function processMatchesCurrentWindow(cmd: string): boolean {
  const currentDir = normalizePath(getEffectiveCurrentUserDataDir());
  return normalizePath(parseUserDataDir(cmd)) === currentDir;
}

/**
 * 快照当前窗口主进程的 PID / exe / 完整启动参数。
 * 重启必须复用原参数（如 --remote-debugging-port），否则用户自行附加的启动配置会丢。
 */
export async function getCurrentLaunchInfo(): Promise<LaunchInfo> {
  let cmdline = '';
  let pid: number | null = null;
  for (const p of await listIdeProcesses()) {
    if (p.cmd.includes('--type=')) continue;
    if (!processMatchesCurrentWindow(p.cmd)) continue;
    cmdline = p.cmd;
    pid = p.pid;
    break;
  }
  if (!cmdline) return { pid, exePath: null, args: [] };
  const tokens = tokenizeCommandLine(cmdline);
  return { pid, exePath: tokens[0] || null, args: tokens.slice(1) };
}

export interface ProcSnapshot {
  name: string;
  pid: number;
  ppid: number;
  cmd: string;
}

/**
 * 解析 POSIX `ps -eo pid=,comm=` 输出提取 agy PID。
 * macOS BSD ps 的 comm 输出完整可执行路径且路径可能含空格（如 /Applications/Antigravity IDE.app/.../agy），
 * 严禁用 `\S+$` 匹配末段（否则含空格路径直接漏掉）。
 */
export function parseUnixAgyPidsFromPs(stdout: string): number[] {
  const pids: number[] = [];
  for (const line of stdout.split('\n')) {
    const m = line.trim().match(/^(\d+)\s+(.+)$/);
    if (!m) continue;
    const pid = Number(m[1]);
    const commPath = m[2].trim();
    if (pid && /(^|\/)agy$/i.test(commPath)) {
      pids.push(pid);
    }
  }
  return pids;
}

/**
 * 解析 POSIX `ps -eo pid=,ppid=,command=` 输出为进程快照。
 * 先剥离首个 CLI 参数（' -'）之前的可执行路径再提取 agy / basename，防 macOS 带空格 .app 路径截断失真。
 */
export function parseUnixProcessesFromPs(stdout: string): ProcSnapshot[] {
  const out: ProcSnapshot[] = [];
  for (const line of stdout.split('\n')) {
    const m = line.trim().match(/^(\d+)\s+(\d+)\s+(.+)$/);
    if (!m) continue;
    const pid = parseInt(m[1], 10);
    const ppid = parseInt(m[2], 10);
    if (!pid) continue;
    const cmd = m[3];
    const exePart = cmd.split(/\s+-/, 1)[0].trim();
    const agyMatch = exePart.match(/^(?:.*\/)?(agy)(?:\s|$)/i);
    const name = agyMatch ? agyMatch[1] : (exePart.split('/').pop() || '');
    out.push({ name, pid, ppid, cmd });
  }
  return out;
}

/** 解析 Linux /proc/<pid>/stat 单行（用 lastIndexOf(')') 兼容带空格或括号的 comm 名） */
export function parseLinuxProcStat(pid: number, statText: string): { pid: number; ppid: number; name: string } | null {
  const lp = statText.indexOf('(');
  const rp = statText.lastIndexOf(')');
  if (lp < 0 || rp <= lp) return null;
  const name = statText.slice(lp + 1, rp);
  const rest = statText.slice(rp + 2).trim().split(/\s+/);
  if (rest.length < 2) return null;
  const ppid = parseInt(rest[1], 10);
  if (!Number.isFinite(ppid) || ppid < 0) return null;
  return { pid, ppid, name };
}

/** Linux 零派生快路径：直接从 /proc 读进程树与必要命令行（无子进程，~10ms）；失败或受限返回 null 回退 ps */
export function readLinuxProcTree(): ProcSnapshot[] | null {
  try {
    if (!fs.existsSync('/proc')) return null;
    const entries = fs.readdirSync('/proc');
    const out: ProcSnapshot[] = [];
    for (const ent of entries) {
      if (!/^\d+$/.test(ent)) continue;
      const pid = parseInt(ent, 10);
      if (!pid) continue;
      try {
        const statText = fs.readFileSync(`/proc/${ent}/stat`, 'utf8');
        const parsed = parseLinuxProcStat(pid, statText);
        if (!parsed) continue;
        let cmd = '';
        // 仅对 IDE 主进程/助手/agy 按需读 cmdline，避免扫数百个无关系统进程耗时
        if (/antigravity|electron|agy/i.test(parsed.name)) {
          try {
            cmd = fs.readFileSync(`/proc/${ent}/cmdline`, 'utf8').replace(/\0/g, ' ').trim();
          } catch { /* 已退出或权限不足 */ }
        }
        out.push({ name: parsed.name, pid: parsed.pid, ppid: parsed.ppid, cmd });
      } catch { /* 短生命周期进程中途退出属正常态 */ }
    }
    return out.length > 0 ? out : null;
  } catch {
    return null;
  }
}

/**
 * 统一进程树定位算法：给定当前扩展宿主 selfPid，优先沿着同类 IDE 可执行名向上溯源到当前窗口主进程 rootPid，
 * 再 BFS 向下收集全部后代中的 agy 引擎 PID（单窗口双 utility/双 agy 也能全数命中，且不误伤旁路实例）。
 */
export function resolveAgyPidsFromTree(
  all: ProcSnapshot[],
  selfPid: number,
  windowsMode = isWindows,
): { rootPid: number | null; treeAgy: number[]; allAgy: number[] } {
  const byPid = new Map<number, ProcSnapshot>();
  const children = new Map<number, number[]>();
  const agyNameRe = windowsMode ? /(^|\\)agy\.exe$/i : /(^|\/)agy$/i;
  const allAgy: number[] = [];

  for (const p of all) {
    byPid.set(p.pid, p);
    const list = children.get(p.ppid) || [];
    list.push(p.pid);
    children.set(p.ppid, list);
    if (agyNameRe.test(p.name)) allAgy.push(p.pid);
  }

  let rootPid: number | null = null;
  const selfProc = selfPid > 0 ? byPid.get(selfPid) : undefined;
  if (selfProc) {
    let cur = selfPid;
    const selfBase = selfProc.name.toLowerCase();
    const seen = new Set<number>();
    while (byPid.has(cur) && !seen.has(cur)) {
      seen.add(cur);
      const node = byPid.get(cur)!;
      const parent = byPid.get(node.ppid);
      if (!parent) break;
      const pLower = parent.name.toLowerCase();
      const sameFamily =
        (selfBase.length > 0 && pLower === selfBase)
        || /antigravity|electron/i.test(parent.name);
      if (!sameFamily) break;
      cur = parent.pid;
    }
    rootPid = cur;
  }

  if (rootPid === null) {
    const mains = all.filter((p) => isIdeMainProcess(p));
    const matched = mains.filter((p) => processMatchesCurrentWindow(p.cmd));
    if (matched.length > 0) rootPid = matched[0].pid;
    else if (mains.length === 1) rootPid = mains[0].pid;
  }

  const descendants = new Set<number>();
  if (rootPid !== null) {
    const queue = [rootPid];
    while (queue.length > 0) {
      const pid = queue.shift()!;
      for (const child of children.get(pid) || []) {
        if (!descendants.has(child)) {
          descendants.add(child);
          queue.push(child);
        }
      }
    }
  }

  const treeAgy = allAgy.filter((pid) => descendants.has(pid));
  return { rootPid, treeAgy, allAgy };
}

async function listAllProcesses(): Promise<ProcSnapshot[]> {
  if (!isWindows) {
    if (process.platform === 'linux') {
      const fastProc = readLinuxProcTree();
      if (fastProc && fastProc.length > 0) return fastProc;
    }
    // POSIX / macOS：ps -eo 快照，cmd 为完整命令行，ppid 直接可得
    const stdout = await runShellAsync('ps -eo pid=,ppid=,command=', 15000);
    return stdout ? parseUnixProcessesFromPs(stdout) : [];
  }
  const psCmd = `Get-CimInstance Win32_Process | Select-Object Name,ProcessId,ParentProcessId,CommandLine | ConvertTo-Json -Compress`;
  const stdout = await runPowerShellAsync(psCmd, 15000);
  const out: ProcSnapshot[] = [];
  if (stdout && stdout.trim()) {
    try {
      // PowerShell 输出可能带 BOM，直接 JSON.parse 会抛错并被吞掉，导致枚举结果为空
      const cleaned = stdout.trim().replace(/^\uFEFF/, '');
      const parsed = JSON.parse(cleaned);
      const list = Array.isArray(parsed) ? parsed : [parsed];
      for (const p of list) {
        const pid = Number(p.ProcessId);
        if (!pid) continue;
        out.push({
          name: String(p.Name || ''),
          pid,
          ppid: Number(p.ParentProcessId) || 0,
          cmd: String(p.CommandLine || ''),
        });
      }
    } catch (e) {
      logWarn('agy.enum.parse', {
        stage: 'powershell-json',
        message: e instanceof Error ? e.message : String(e),
        bytes: stdout.length,
      });
    }
  } else {
    logWarn('agy.enum.parse', { stage: 'powershell-empty', reason: 'runPowerShellAsync 返回空（命令失败或无输出）' });
  }
  if (out.length === 0) {
    // wmic 回退（Win11 起可能已移除，失败必须留痕，不能把「读失败」当成「没有进程」）
    const stdout2 = await runShellAsync(
      'wmic process get Name,ProcessId,ParentProcessId,CommandLine /FORMAT:CSV',
      15000
    );
    if (stdout2 && stdout2.trim()) {
      for (const line of stdout2.split(/\r?\n/)) {
        // CSV: Node,CommandLine,Name,ParentProcessId,ProcessId
        const m = line.match(/^[^,]*,(.*),([^,]+),(\d+),(\d+)\s*$/);
        if (!m) continue;
        const pid = parseInt(m[4], 10);
        if (!pid) continue;
        out.push({ name: m[2], pid, ppid: parseInt(m[3], 10), cmd: m[1] || '' });
      }
    } else {
      logWarn('agy.enum.wmic', { reason: 'wmic 回退无输出或执行失败', empty: stdout2 === null });
    }
  }
  return out;
}

interface AgyPidProbe {
  /** ok=false 表示命令本身失败、结果未知；绝不可与「确实没有 agy 进程」混淆 */
  ok: boolean;
  pids: number[];
  reason?: string;
}

/**
 * 独立 agy PID 校验：Windows 走 tasklist、POSIX 走 ps，不派生 PowerShell。
 * 主枚举（listAllProcesses）依赖 powershell -EncodedCommand，实测在部分环境会被拒；
 * 这条独立通道保证「agy 在跑却枚举不到」时仍能真正杀掉引擎、让 IDE 用新凭据重建。
 */
async function listAgyPids(): Promise<AgyPidProbe> {
  const pids: number[] = [];
  if (process.platform === 'win32') {
    const stdout = await runShellAsync('tasklist /FI "IMAGENAME eq agy.exe" /FO CSV /NH', 8000);
    if (stdout === null) {
      logWarn('agy.enum.tasklist', { reason: 'tasklist 执行失败' });
      return { ok: false, pids, reason: 'tasklist 执行失败' };
    }
    if (/INFO:\s*No tasks are running/i.test(stdout)) {
      return { ok: true, pids };
    }
    for (const line of stdout.split(/\r?\n/)) {
      const m = line.match(/^"?agy\.exe"?\s*,\s*"?(\d+)"?/i);
      if (m) pids.push(Number(m[1]));
    }
    return { ok: true, pids };
  }
  if (process.platform === 'linux') {
    const procTree = readLinuxProcTree();
    if (procTree) {
      for (const p of procTree) {
        if (/^agy$/i.test(p.name)) pids.push(p.pid);
      }
      return { ok: true, pids };
    }
  }
  const stdout = await runShellAsync('ps -eo pid=,comm=', 8000);
  if (stdout === null) {
    logWarn('agy.enum.tasklist', { reason: 'ps 执行失败' });
    return { ok: false, pids, reason: 'ps 执行失败' };
  }
  return { ok: true, pids: parseUnixAgyPidsFromPs(stdout) };
}

function isIdeMainProcess(p: ProcSnapshot): boolean {
  if (!isIdeMainProcessCmd(p.cmd)) return false;
  if (isWindows) {
    if (!/antigravity(\s|\.)/i.test(p.name) && !/antigravity.*ide\.exe/i.test(p.name)) return false;
    return /antigravity/i.test(p.cmd);
  }
  // POSIX：ps 快照的 name 是可执行文件末段（如 Electron），主进程判定走完整命令行
  return /antigravity/i.test(p.cmd);
}

/**
 * 杀掉当前窗口进程树下的 agy.exe（IDE 内置 agent 引擎）。
 * agy 由 IDE 的 NodeService 孙子进程拉起（主进程 → utility → agy），
 * 匹配必须沿进程树 BFS 收集全部后代，单层父子匹配会漏杀（0.8.34 真机实证）。
 * 被杀后 IDE 按需以新凭据重建引擎——agent 面板无感切号的机制。
 */
/** Phase A 并发预热：Windows 提前确保原生 .exe 已编译就绪；POSIX 验证快通道就绪 */
export async function prepareAgyReload(): Promise<void> {
  if (isWindows) {
    await ensureWinNativeHelper();
  }
}

export interface KillAgyResult {
  killed: number;
  error?: string;
  agyWasRunning: boolean;
  remoteSkipped?: boolean;
}

/**
 * 杀掉当前窗口进程树下的 agy 引擎。
 * Windows 优先走编译缓存的原生 .exe（Toolhelp32 一次完成「树定位 + 强杀」~134ms）；
 * Linux 走零派生 /proc 读取 + SIGKILL（~15ms）；macOS 走修复空格路径的单次 ps + SIGKILL（~40ms）。
 */
export async function killAgyEngine(): Promise<KillAgyResult> {
  // 远程工作区下 agy 跑在远端，跳过本地清理以防误杀其他本地窗口的 agy.exe
  const remoteName = typeof vscode.env?.remoteName === 'string' ? vscode.env.remoteName.trim() : '';
  if (remoteName) {
    logInfo('agy.reload.remote-skip', { remoteName });
    return { killed: 0, agyWasRunning: false, remoteSkipped: true };
  }

  // Windows 快路径：原生 .exe 一次性完成 CreateToolhelp32Snapshot + 祖先定位 + 树级强杀
  if (isWindows) {
    const winRes = await reloadWinAgyNative(process.pid);
    if (winRes && !winRes.needsDisambiguate) {
      if (winRes.allAgy.length === 0) {
        logWarn('agy.reload.no-engine', { reason: '切号时 agy 引擎未运行 (native)' });
        return { killed: 0, agyWasRunning: false, error: t('agyReloadNoEngine') };
      }
      if (winRes.killed.length > 0) {
        return { killed: winRes.killed.length, agyWasRunning: true };
      }
      logWarn('agy.reload.nativeKillZero', { tree: winRes.treeAgy, failed: winRes.failed });
    }
  }

  // 独立校验通道（Windows 无 csc.exe 或需 disambiguate 时，以及全部 macOS/Linux）
  const probe = await listAgyPids();
  if (probe.ok === false) {
    // 读失败 = 未知：绝不当成「没有进程」静默走完切号
    return { killed: 0, agyWasRunning: false, error: t('agyReloadEnumFail', probe.reason || '') };
  }

  let agyPids: number[] = [];
  if (probe.pids.length === 1) {
    agyPids = probe.pids;
  } else if (probe.pids.length >= 2) {
    const all = await listAllProcesses();
    const resolved = resolveAgyPidsFromTree(all, process.pid, isWindows);
    const agyNameRe = isWindows ? /(^|\\)agy\.exe$/i : /(^|\/)agy$/i;
    const enumAgy = all.filter((p) => agyNameRe.test(p.name)).map((p) => p.pid);

    const enumSet = new Set(enumAgy);
    const probeSet = new Set(probe.pids);
    const onlyIndependent = probe.pids.filter((pid) => !enumSet.has(pid));
    const onlyEnum = enumAgy.filter((pid) => !probeSet.has(pid));
    if (onlyIndependent.length > 0 || onlyEnum.length > 0) {
      logWarn('agy.enum.mismatch', { stage: 'process-enum', onlyIndependent, onlyEnum });
    }

    const enumHit = resolved.treeAgy.length > 0 ? resolved.treeAgy : enumAgy;
    agyPids = enumHit.length > 0 ? enumHit : probe.pids;
  }

  const agyWasRunning = agyPids.length > 0;

  if (agyPids.length === 0) {
    logWarn('agy.reload.no-engine', { reason: '切号时 agy 引擎未运行' });
    return { killed: 0, agyWasRunning: false, error: t('agyReloadNoEngine') };
  }

  let killed = 0;
  for (const pid of agyPids) {
    if (isWindows) {
      const out = await runShellAsync(`taskkill /PID ${pid} /T /F`, 5000);
      if (out === null) {
        logWarn('agy.reload.taskkill', { pid, reason: 'taskkill 执行失败' });
        continue;
      }
    } else {
      try { process.kill(pid, 'SIGKILL'); } catch { /* 已退出即目标态 */ }
    }
    killed += 1;
  }
  if (killed === 0) {
    return { killed: 0, agyWasRunning, error: t('agyReloadEnumFail', 'agy 进程终止失败') };
  }
  return { killed, agyWasRunning };
}

// ─── Shell 工具 ──────────────────────────────────────────

export function runShellAsync(cmd: string, timeoutMs: number): Promise<string | null> {
  return new Promise((resolve) => {
    try {
      cp.exec(cmd, { encoding: 'utf8', timeout: timeoutMs, windowsHide: true }, (err, stdout) => resolve(err ? null : stdout));
    } catch (e) {
      logWarn('ideRuntime.runShell.threw', { cmd: cmd.slice(0, 80), message: e instanceof Error ? e.message : String(e) });
      resolve(null);
    }
  });
}

export function runPowerShellAsync(script: string, timeoutMs: number): Promise<string | null> {
  return new Promise((resolve) => {
    try {
      const encoded = Buffer.from(script, 'utf16le').toString('base64');
      cp.exec(
        `powershell -NoProfile -NonInteractive -EncodedCommand ${encoded}`,
        { encoding: 'utf8', timeout: timeoutMs, windowsHide: true },
        (err, stdout) => {
          if (err) {
            // 失败必须留痕：上层据此区分「读失败」与「确实没有进程」
            logWarn('powershell.exec.failed', { stage: script.slice(0, 80), message: err.message });
            resolve(null);
            return;
          }
          resolve(stdout);
        }
      );
    } catch (e) {
      logWarn('powershell.exec.threw', {
        stage: script.slice(0, 80),
        message: e instanceof Error ? e.message : String(e),
      });
      resolve(null);
    }
  });
}
