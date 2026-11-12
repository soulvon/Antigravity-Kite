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
import { logWarn } from './logger';
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
  const appRoot = vscode.env.appRoot; // e.g. F:\Program\Antigravity IDE\resources\app
  const exeNames = ['Antigravity IDE.exe', 'Antigravity.exe'];
  for (const name of exeNames) {
    const fromAppRoot = path.resolve(appRoot, '..', '..', name);
    if (fs.existsSync(fromAppRoot)) return fromAppRoot;
  }

  // 2. 常见安装路径及模糊子目录扫描（兼容 F:\Program\Antigravity1.18.4\Antigravity.exe 等多版本情况）
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
          } catch {}
        }
      }
    }
  }

  for (const c of candidates) {
    if (c && fs.existsSync(c)) return c;
  }

  // 3. 从正在运行的进程获取（支持两种进程名）
  const entries = await getRunningEntries();
  for (const [pid] of entries) {
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
    } catch {}
  }

  return null;
}

async function detectExeUnix(): Promise<string | null> {
  const home = os.homedir();
  const candidates = isMac
    ? [
        '/Applications/Antigravity IDE.app/Contents/MacOS/Electron',
        path.join(home, 'Applications', 'Antigravity IDE.app', 'Contents', 'MacOS', 'Electron'),
      ]
    : [
        '/usr/bin/antigravity-ide',
        '/usr/local/bin/antigravity-ide',
        '/opt/Antigravity IDE/antigravity-ide',
        path.join(home, '.local', 'bin', 'antigravity-ide'),
      ];
  for (const c of candidates) {
    if (fs.existsSync(c)) return c;
  }
  try {
    const out = cp.execSync('which antigravity-ide', { encoding: 'utf8', timeout: 3000 });
    const found = out.trim();
    if (found && fs.existsSync(found)) return found;
  } catch {}
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
 *   "...exe" --user-data-dir C:\...\mw_xxx "e:\project\foo"
 * 旧正则要求路径后紧跟 -- 或行尾，会把多开实例误判成主窗口。
 */
export function parseUserDataDir(cmd: string): string {
  const m = cmd.match(/--user-data-dir[= ]+(?:"([^"]+)"|'([^']+)'|(\S+))/i);
  const dir = m ? (m[1] || m[2] || m[3] || '').trim() : '';
  return dir || getDefaultUserDataDir();
}

/**
 * IDE 主进程判定。只排除 --type= 是不够的：tsserver / typingsInstaller / jsonServer
 * 同样带 exe 名且没有 --type=，会被当成窗口主进程 —— 停止多开时会误杀语言服务。
 */
export function isIdeMainProcessCmd(cmd: string): boolean {
  if (/--type=/i.test(cmd)) return false;
  if (/[\\/]resources[\\/]app[\\/]extensions[\\/]/i.test(cmd)) return false;
  if (/\.js["']?(?:\s|$)/i.test(cmd)) return false;
  // Chromium 内部参数：只做精确匹配，避免用户工作区路径含 plugin/gpu 这类词时误伤主进程
  if (/--node-ipc\b/i.test(cmd)) return false;
  if (/--clientprocessid=/i.test(cmd)) return false;
  if (/[\\/]crashpad[\\/]/i.test(cmd)) return false;
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
      let cmdline = '';
      try { cmdline = fs.readFileSync(`/proc/${pid}/cmdline`, 'utf8').replace(/\0/g, ' '); } catch {
        cmdline = parts.slice(10).join(' ');
      }
      const normalized = cmdline.replace(/\0/g, ' ').trim();
      if (!isIdeMainProcessCmd(normalized)) continue;
      entries.push([pid, parseUserDataDir(normalized)]);
    }
  } catch {}
  return entries;
}

export interface LaunchInfo {
  pid: number | null;
  exePath: string | null;
  /** 主进程完整启动参数（快照自运行进程，含 --remote-debugging-port 等用户自行附加的参数） */
  args: string[];
}

function tokenizeCommandLine(cmd: string): string[] {
  const out: string[] = [];
  let cur = '';
  let inQuote = false;
  for (let i = 0; i < cmd.length; i++) {
    const c = cmd[i];
    if (c === '"') { inQuote = !inQuote; continue; }
    if (!inQuote && /\s/.test(c)) {
      if (cur) { out.push(cur); cur = ''; }
      continue;
    }
    cur += c;
  }
  if (cur) out.push(cur);
  return out;
}

interface IdeProcessInfo {
  pid: number;
  cmd: string;
}

async function listIdeProcesses(): Promise<IdeProcessInfo[]> {
  const out: IdeProcessInfo[] = [];
  if (!isWindows) {
    // POSIX：ps aux 快照，解析主进程命令行（与 getRunningEntriesUnix 同源）
    const stdout = await runShellAsync('ps aux', 8000);
    if (!stdout) return out;
    for (const line of stdout.split('\n')) {
      if (!/antigravity/i.test(line) || /grep/i.test(line)) continue;
      const parts = line.trim().split(/\s+/);
      const pid = parseInt(parts[1], 10);
      if (!pid || isNaN(pid)) continue;
      let cmd = '';
      try { cmd = fs.readFileSync(`/proc/${pid}/cmdline`, 'utf8').replace(/\0/g, ' '); } catch {
        cmd = parts.slice(10).join(' ');
      }
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
        if (pid) out.push({ pid, cmd: cmdMatch ? cmdMatch[1] : '' });
      }
      if (out.length > 0) return out;
    }
  } catch { /* 走 PowerShell 回退 */ }
  try {
    const psCmd = `Get-CimInstance Win32_Process -Filter "name='Antigravity IDE.exe' or name='Antigravity.exe'" | Select-Object ProcessId,CommandLine | ConvertTo-Json -Compress`;
    const stdout = await runPowerShellAsync(psCmd, 10000);
    if (stdout && stdout.trim()) {
      const parsed = JSON.parse(stdout);
      const list = Array.isArray(parsed) ? parsed : [parsed];
      for (const p of list) {
        const pid = Number(p.ProcessId);
        if (pid) out.push({ pid, cmd: p.CommandLine || '' });
      }
    }
  } catch { /* 枚举失败由调用方处理 */ }
  return out;
}

function processMatchesCurrentWindow(cmd: string): boolean {
  const currentDir = normalizePath(getCurrentUserDataDir());
  const m = cmd.match(/--user-data-dir[= ]+["']?([^"']+?)["']?(?:\s+--|\s*$)/i);
  const dir = m ? m[1].trim() : getDefaultUserDataDir();
  return normalizePath(dir) === currentDir;
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

interface ProcSnapshot {
  name: string;
  pid: number;
  ppid: number;
  cmd: string;
}

async function listAllProcesses(): Promise<ProcSnapshot[]> {
  if (!isWindows) {
    // POSIX：ps -eo 快照，cmd 为完整命令行（含可执行路径），ppid 直接可得
    const out: ProcSnapshot[] = [];
    const stdout = await runShellAsync('ps -eo pid=,ppid=,command=', 15000);
    if (stdout) {
      for (const line of stdout.split('\n')) {
        const m = line.trim().match(/^(\d+)\s+(\d+)\s+(.+)$/);
        if (!m) continue;
        const pid = parseInt(m[1], 10);
        const ppid = parseInt(m[2], 10);
        if (!pid) continue;
        const cmd = m[3];
        // 进程名取可执行文件末段（真实 macOS/Linux 上 agy 引擎不带 .exe 后缀）
        const name = cmd.split(/\s+/)[0].split('/').pop() || '';
        out.push({ name, pid, ppid, cmd });
      }
    }
    return out;
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
  const stdout = await runShellAsync('ps -eo pid=,comm=', 8000);
  if (stdout === null) {
    logWarn('agy.enum.tasklist', { reason: 'ps 执行失败' });
    return { ok: false, pids, reason: 'ps 执行失败' };
  }
  for (const line of stdout.split(/\r?\n/)) {
    const m = line.trim().match(/^(\d+)\s+(\S+)$/);
    if (m && /(^|\/)agy$/.test(m[2])) pids.push(Number(m[1]));
  }
  return { ok: true, pids };
}

function isIdeMainProcess(p: ProcSnapshot): boolean {
  if (/--type=/i.test(p.cmd)) return false;
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
export async function killAgyEngine(): Promise<{ killed: number; error?: string; agyWasRunning: boolean }> {
  // 0) 独立校验先行：tasklist/ps 不依赖 PowerShell，主枚举失败时仍能拿到真实 agy PID
  const probe = await listAgyPids();

  // 1) 全量进程快照（一次 PowerShell 拿 Name/PID/PPID/CommandLine）
  const all = await listAllProcesses();

  // 2) 定位当前窗口主进程（无 --type= 且 user-data-dir 匹配；匹配不到则取唯一主进程兜底）
  const mains = all.filter((p) => isIdeMainProcess(p));
  let mainPid: number | null = null;
  const matched = mains.filter((p) => processMatchesCurrentWindow(p.cmd));
  if (matched.length > 0) {
    mainPid = matched[0].pid;
  } else if (mains.length === 1) {
    mainPid = mains[0].pid;
  }

  // 3) BFS 收集主进程全部后代
  const ppidMap = new Map<number, number[]>();
  for (const p of all) {
    const list = ppidMap.get(p.ppid) || [];
    list.push(p.pid);
    ppidMap.set(p.ppid, list);
  }
  const descendants = new Set<number>();
  if (mainPid !== null) {
    const queue = [mainPid];
    while (queue.length > 0) {
      const pid = queue.shift()!;
      for (const child of ppidMap.get(pid) || []) {
        if (!descendants.has(child)) {
          descendants.add(child);
          queue.push(child);
        }
      }
    }
  }

  // 4) 后代里的 agy 引擎（Windows: agy.exe；POSIX: agy，按平台匹配名称与路径分隔符）
  const agyNameRe = isWindows ? /(^|\\)agy\.exe$/i : /(^|\/)agy$/i;
  const treeAgy = all.filter((p) => agyNameRe.test(p.name) && descendants.has(p.pid)).map((p) => p.pid);
  const enumAgy = all.filter((p) => agyNameRe.test(p.name)).map((p) => p.pid);

  // 5) 主枚举与独立校验必须对齐：出现差异说明 PowerShell 快照不可信，留痕供排障
  if (probe.ok) {
    const enumSet = new Set(enumAgy);
    const probeSet = new Set(probe.pids);
    const onlyIndependent = probe.pids.filter((pid) => !enumSet.has(pid));
    const onlyEnum = enumAgy.filter((pid) => !probeSet.has(pid));
    if (onlyIndependent.length > 0 || onlyEnum.length > 0) {
      logWarn('agy.enum.mismatch', { stage: 'process-enum', onlyIndependent, onlyEnum });
    }
  }
  if (probe.ok === false) {
    // 读失败 = 未知：绝不当成「没有进程」静默走完切号
    return { killed: 0, agyWasRunning: false, error: t('agyReloadEnumFail', probe.reason || '') };
  }

  // 6) 合并三路结果：树内命中优先，独立校验补齐主枚举漏掉的进程
  const agyPids = Array.from(new Set([...treeAgy, ...enumAgy, ...probe.pids]));
  const agyWasRunning = agyPids.length > 0;

  if (agyPids.length === 0) {
    // agy 确实未运行：模型列表不会随本次切号重建，必须显式告知，不能静默当成功
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
    } catch { resolve(null); }
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
