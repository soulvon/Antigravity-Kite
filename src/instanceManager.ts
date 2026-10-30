/**
 * Instance Manager — Antigravity IDE 多实例分身管理
 * 支持创建/删除/启动/停止/聚焦独立数据目录的 IDE 实例
 */
import * as fs from 'fs';
import * as path from 'path';
import * as cp from 'child_process';
import * as crypto from 'crypto';
import * as os from 'os';
import * as vscode from 'vscode';

// ─── 类型 ───────────────────────────────────────────────

export interface InstanceConfig {
  id: string;
  name: string;
  userDataDir: string;
  bindEmail: string;
  createdAt: number;
  lastPid?: number;
  assignedTag?: string;
  source?: 'cockpit';
}

export interface InstanceView extends InstanceConfig {
  running: boolean;
  current: boolean;
}

interface InstanceStore {
  instances: InstanceConfig[];
}

// ─── 常量 ───────────────────────────────────────────────

const INSTANCES_DIR_NAME = 'instances';
const INSTANCES_FILE = 'instances.json';
const BIND_FILE = '.kite-bind';
const COPY_EXCLUDE = ['GPUCache', 'Cache', 'CachedData', 'Code Cache', 'blob_storage', 'Crashpad', 'logs', 'Crash Reports'];

const isWindows = process.platform === 'win32';
const isMac = process.platform === 'darwin';

import { migrateDataIfNeeded, getSharedStorageDir } from './storage';

// ─── 路径 ───────────────────────────────────────────────

let _storageDir = '';

export function init(context: vscode.ExtensionContext): void {
  migrateDataIfNeeded(context, INSTANCES_FILE);
  _storageDir = getSharedStorageDir();
}

function getInstancesRoot(): string {
  return path.join(_storageDir, INSTANCES_DIR_NAME);
}

function getInstancesFilePath(): string {
  return path.join(_storageDir, INSTANCES_FILE);
}

function getAppDataDir(): string {
  if (isWindows) return process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming');
  if (isMac) return path.join(os.homedir(), 'Library', 'Application Support');
  return process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config');
}

function getDefaultUserDataDir(): string {
  const candidates = [
    path.join(getAppDataDir(), 'Antigravity IDE'),
    path.join(getAppDataDir(), 'Antigravity IDE - Next'),
  ];
  for (const c of candidates) {
    if (fs.existsSync(c)) return c;
  }
  return candidates[0];
}

// ─── Store 读写 ─────────────────────────────────────────

let _storeCache: InstanceStore | null = null;
let _storeCacheTs = 0;
const CACHE_TTL = 3000;

function loadStore(forceFresh = false): InstanceStore {
  const now = Date.now();
  if (!forceFresh && _storeCache && now - _storeCacheTs < CACHE_TTL) {
    return _storeCache;
  }
  const p = getInstancesFilePath();
  if (!fs.existsSync(p)) { return { instances: [] }; }
  try {
    const raw = fs.readFileSync(p, 'utf8');
    const parsed = JSON.parse(raw);
    _storeCache = { instances: Array.isArray(parsed.instances) ? parsed.instances : [] };
    _storeCacheTs = now;
    return _storeCache;
  } catch {
    return { instances: [] };
  }
}

function saveStore(store: InstanceStore): void {
  try { fs.mkdirSync(_storageDir, { recursive: true }); } catch {}
  const p = getInstancesFilePath();
  const tmp = p + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(store, null, 2), 'utf8');
  fs.renameSync(tmp, p);
  _storeCache = store;
  _storeCacheTs = Date.now();
}

// ─── 文件监听 ────────────────────────────────────────────

let instanceFileWatcher: fs.FSWatcher | null = null;
const instanceChangeListeners: Set<() => void> = new Set();

function startInstanceWatcher(): void {
  if (instanceFileWatcher) return;
  try {
    instanceFileWatcher = fs.watch(_storageDir, (_evt, filename) => {
      if (!filename || filename === INSTANCES_FILE) {
        _storeCache = null;
        for (const fn of instanceChangeListeners) {
          try { fn(); } catch {}
        }
      }
    });
    instanceFileWatcher.on('error', () => {
      try { instanceFileWatcher?.close(); } catch {}
      instanceFileWatcher = null;
      setTimeout(() => { if (instanceChangeListeners.size > 0) startInstanceWatcher(); }, 1000);
    });
  } catch {}
}

export function watchInstancesFile(onChange: () => void): () => void {
  instanceChangeListeners.add(onChange);
  startInstanceWatcher();
  return () => {
    instanceChangeListeners.delete(onChange);
    if (instanceChangeListeners.size === 0 && instanceFileWatcher) {
      try { instanceFileWatcher.close(); } catch {}
      instanceFileWatcher = null;
    }
  };
}

export function dispose(): void {
  if (instanceFileWatcher) {
    try { instanceFileWatcher.close(); } catch {}
    instanceFileWatcher = null;
  }
  instanceChangeListeners.clear();
}

// ─── CRUD ───────────────────────────────────────────────

function generateId(): string {
  return crypto.randomBytes(8).toString('hex');
}

function normalizePath(p: string): string {
  const trimmed = p.trim();
  if (isWindows) return trimmed.toLowerCase().replace(/\//g, '\\').replace(/\\+$/, '');
  return trimmed.replace(/\\+/g, '/').replace(/\/+$/, '');
}

function isPathUnder(target: string, base: string): boolean {
  const rel = path.relative(base, target);
  return !!rel && !rel.startsWith('..') && !path.isAbsolute(rel);
}

function ensureDefaultInstance(store: InstanceStore): void {
  const defaultDir = getDefaultUserDataDir();
  if (!defaultDir || !fs.existsSync(defaultDir)) return;
  const normDefault = normalizePath(defaultDir);
  if (store.instances.some(i => normalizePath(i.userDataDir) === normDefault)) return;
  store.instances.unshift({
    id: 'default',
    name: '默认实例',
    userDataDir: defaultDir,
    bindEmail: '',
    createdAt: 0,
  });
  saveStore(store);
}

export async function listInstances(): Promise<InstanceView[]> {
  const store = loadStore();
  try { ensureDefaultInstance(store); } catch {}
  const runningDirs = await getRunningInstanceDirs();
  const currentDir = normalizePath(getCurrentUserDataDir());
  return store.instances.map(inst => ({
    ...inst,
    running: runningDirs.has(normalizePath(inst.userDataDir)),
    current: normalizePath(inst.userDataDir) === currentDir,
  }));
}

export interface CreateInstanceOptions {
  name: string;
  bindEmail: string;
  onProgress?: (msg: string) => void;
}

export async function createInstance(opts: CreateInstanceOptions): Promise<InstanceConfig> {
  const store = loadStore();
  const name = opts.name.trim();
  if (!name) throw new Error('实例名称不能为空');
  if (store.instances.some(i => i.name === name)) throw new Error('实例名称已存在');

  const id = generateId();
  const instanceDir = path.join(getInstancesRoot(), id);
  if (fs.existsSync(instanceDir)) throw new Error('实例目录已存在');

  const sourceDir = getDefaultUserDataDir();
  if (!fs.existsSync(sourceDir)) throw new Error('默认 IDE 数据目录不存在');

  opts.onProgress?.('正在统计文件…');
  const total = countFiles(sourceDir);
  const progress: CopyProgress = { copied: 0, total, onProgress: opts.onProgress, lastReportTs: 0 };
  opts.onProgress?.(`复制中… 0/${total} (0%)`);
  await copyDirSelective(sourceDir, instanceDir, progress);

  // 写入绑定标记
  fs.writeFileSync(path.join(instanceDir, BIND_FILE), JSON.stringify({ bindEmail: opts.bindEmail }), 'utf8');

  const instance: InstanceConfig = {
    id,
    name,
    userDataDir: instanceDir,
    bindEmail: opts.bindEmail,
    createdAt: Date.now(),
  };

  store.instances.push(instance);
  saveStore(store);
  opts.onProgress?.('实例创建完成');
  return instance;
}

export function deleteInstance(instanceId: string): void {
  if (instanceId === 'default') throw new Error('默认实例不可删除');
  const store = loadStore();
  const idx = store.instances.findIndex(i => i.id === instanceId);
  if (idx < 0) throw new Error('实例不存在');
  const inst = store.instances[idx];

  // 安全校验：只删除在 instances 目录下的
  const instancesRoot = getInstancesRoot();
  if (isPathUnder(inst.userDataDir, instancesRoot)) {
    try {
      if (fs.existsSync(inst.userDataDir)) {
        fs.rmSync(inst.userDataDir, { recursive: true, force: true });
      }
    } catch (e) {
      console.warn('[instanceManager] 删除实例目录失败:', e);
    }
  }

  store.instances.splice(idx, 1);
  saveStore(store);
}

export function updateInstanceName(instanceId: string, newName: string): void {
  const store = loadStore();
  const inst = store.instances.find(i => i.id === instanceId);
  if (!inst) throw new Error('实例不存在');
  const name = newName.trim();
  if (!name) throw new Error('实例名称不能为空');
  if (store.instances.some(i => i.id !== instanceId && i.name === name)) throw new Error('名称已存在');
  inst.name = name;
  saveStore(store);
}

export function updateInstanceBind(instanceId: string, bindEmail: string): void {
  const store = loadStore();
  const inst = store.instances.find(i => i.id === instanceId);
  if (!inst) throw new Error('实例不存在');
  inst.bindEmail = bindEmail;
  const bindPath = path.join(inst.userDataDir, BIND_FILE);
  try { fs.writeFileSync(bindPath, JSON.stringify({ bindEmail }), 'utf8'); } catch {}
  saveStore(store);
}

// ─── 启动 / 停止 ───────────────────────────────────────

let _exePathCache: { path: string | null; ts: number } | null = null;

export async function detectExePath(): Promise<string | null> {
  // 1. 优先使用用户手动设置的自定义主程序路径
  const config = vscode.workspace.getConfiguration('antigravityKite');
  const customPath = config.get<string>('customIdeExePath');
  if (customPath && fs.existsSync(customPath)) {
    return customPath;
  }

  // 2. 自动探测与缓存
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

  // 2. 常见安装路径及智能模糊匹配 (兼容 F:\Program\Antigravity1.18.4\Antigravity.exe 等多版本情况)
  const localAppData = process.env.LOCALAPPDATA || '';
  const programFiles = process.env.ProgramFiles || 'C:\\Program Files';
  const candidates: string[] = [];

  for (const name of exeNames) {
    const mainDir = name.slice(0, -4); // 'Antigravity IDE' 或 'Antigravity'
    candidates.push(
      path.join(localAppData, 'Programs', mainDir, name),
      path.join(programFiles, mainDir, name)
    );
    
    // 增加各盘区 Program / Program Files 下的匹配与模糊子目录扫描
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

  // 3. 从正在运行的进程获取 (支持两种进程名)
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

export async function startInstance(instanceId: string, onLog?: (msg: string) => void): Promise<void> {
  const log = onLog || (() => {});
  const store = loadStore();
  const inst = store.instances.find(i => i.id === instanceId);
  if (!inst) throw new Error('实例不存在');
  if (!fs.existsSync(inst.userDataDir)) throw new Error(`实例数据目录不存在: ${inst.userDataDir}`);

  // 避免重复启动
  const runningDirs = await getRunningInstanceDirs();
  if (runningDirs.has(normalizePath(inst.userDataDir))) {
    throw new Error(`实例 "${inst.name}" 已在运行`);
  }

  const exePath = await detectExePath();
  if (!exePath) throw new Error('未找到 Antigravity IDE 可执行文件');

  // 通过 CLI 启动绕过单实例锁
  let realExePath = exePath;
  try { realExePath = fs.realpathSync(exePath); } catch {}
  const exeDir = path.dirname(exePath);
  const realExeDir = path.dirname(realExePath);
  const cliJsCandidates: string[] = isMac
    ? [path.join(exeDir, '..', 'Resources', 'app', 'out', 'cli.js')]
    : isWindows
      ? [path.join(exeDir, 'resources', 'app', 'out', 'cli.js')]
      : [
          path.join(exeDir, 'resources', 'app', 'out', 'cli.js'),
          path.join(realExeDir, 'resources', 'app', 'out', 'cli.js'),
          path.join(realExeDir, '..', 'resources', 'app', 'out', 'cli.js'),
        ];
  const cliJs = cliJsCandidates.find(p => fs.existsSync(p));

  let spawnCmd: string;
  let spawnArgs: string[];
  let spawnEnv: NodeJS.ProcessEnv;

  if (cliJs) {
    spawnCmd = exePath;
    if (!isWindows && !isMac) {
      const installRoot = path.resolve(path.dirname(cliJs), '..', '..', '..');
      const actualBinary = path.join(installRoot, 'antigravity-ide');
      if (fs.existsSync(actualBinary) && actualBinary !== exePath) spawnCmd = actualBinary;
    }
    spawnArgs = [cliJs, '--user-data-dir', inst.userDataDir];
    spawnEnv = { ...process.env, ELECTRON_RUN_AS_NODE: '1', VSCODE_DEV: '' };
  } else {
    spawnCmd = exePath;
    spawnArgs = ['--user-data-dir', inst.userDataDir];
    spawnEnv = { ...process.env };
  }

  try {
    const child = cp.spawn(spawnCmd, spawnArgs, {
      detached: true,
      stdio: 'ignore',
      windowsHide: false,
      env: spawnEnv,
    });

    const spawnError = await new Promise<Error | null>((resolve) => {
      child.on('error', (err) => resolve(err));
      setTimeout(() => resolve(null), 2000);
    });

    if (spawnError) throw new Error(`进程启动失败: ${spawnError.message}`);

    child.unref();
    inst.lastPid = child.pid;
    log(`启动成功 PID=${child.pid}`);
  } catch (e) {
    throw new Error(`启动失败: ${(e as Error).message}`);
  }

  saveStore(store);
  invalidateProcessCache();
}

export async function stopInstance(instanceId: string): Promise<void> {
  const store = loadStore();
  const inst = store.instances.find(i => i.id === instanceId);
  if (!inst) throw new Error('实例不存在');

  const entries = await getRunningEntries(true);
  const targetPids: number[] = [];
  for (const [pid, dir] of entries) {
    if (dir && normalizePath(dir) === normalizePath(inst.userDataDir)) {
      targetPids.push(pid);
    }
  }

  if (targetPids.length > 0) {
    // 优雅关闭
    if (isWindows) {
      const pidArgs = targetPids.map(p => `/PID ${p}`).join(' ');
      await runShellAsync(`taskkill ${pidArgs}`, 5000);
    } else {
      for (const p of targetPids) {
        try { process.kill(p, 'SIGTERM'); } catch {}
      }
    }

    // 等待退出
    const deadline = Date.now() + 3000;
    while (Date.now() < deadline) {
      await new Promise(r => setTimeout(r, 200));
      const fresh = await getRunningEntries(true);
      if (!fresh.some(([p]) => targetPids.includes(p))) break;
    }

    // 强杀
    const alive = await getRunningEntries(true);
    for (const [p] of alive.filter(([p]) => targetPids.includes(p))) {
      try {
        if (isWindows) {
          cp.execSync(`taskkill /PID ${p} /T /F`, { timeout: 10000, windowsHide: true });
        } else {
          process.kill(p, 'SIGKILL');
        }
      } catch {}
    }
  }

  inst.lastPid = undefined;
  saveStore(store);
  invalidateProcessCache();
}

/** 激活指定实例的窗口 */
export async function focusInstance(instanceId: string): Promise<void> {
  const store = loadStore();
  const inst = store.instances.find(i => i.id === instanceId);
  if (!inst) throw new Error('实例不存在');

  const entries = await getRunningEntries(true);
  const normDir = normalizePath(inst.userDataDir);
  const match = entries.find(([, dir]) => dir && normalizePath(dir) === normDir);
  if (!match) throw new Error('实例未运行');

  const pid = match[0];

  if (isWindows) {
    const script = `
      Add-Type @'
        using System;
        using System.Runtime.InteropServices;
        public class WinFocus {
          [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
          [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int c);
          [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr h);
        }
'@
      $p = Get-Process -Id ${pid} -ErrorAction SilentlyContinue
      if ($p -and $p.MainWindowHandle -ne [IntPtr]::Zero) {
        $h = $p.MainWindowHandle
        if ([WinFocus]::IsIconic($h)) { [WinFocus]::ShowWindow($h, 9) }
        [WinFocus]::SetForegroundWindow($h)
      }
    `;
    await runPowerShellAsync(script, 5000);
  } else if (isMac) {
    await runShellAsync(`osascript -e 'tell application "System Events" to set frontmost of (first process whose unix id is ${pid}) to true'`, 3000);
  } else {
    await runShellAsync(`xdotool search --pid ${pid} --onlyvisible windowactivate 2>/dev/null || wmctrl -i -a $(wmctrl -lp | awk '$3==${pid}{print $1; exit}') 2>/dev/null`, 3000);
  }
}

// ─── 进程检测 ───────────────────────────────────────────

let _processCache: { entries: Array<[number, string | null]>; ts: number } | null = null;

function invalidateProcessCache(): void { _processCache = null; }

async function getRunningEntries(forceFresh = false): Promise<Array<[number, string | null]>> {
  if (!forceFresh && _processCache && Date.now() - _processCache.ts < 3000) {
    return _processCache.entries;
  }
  const entries = isWindows ? await getRunningEntriesWindows() : await getRunningEntriesUnix();
  _processCache = { entries, ts: Date.now() };
  return entries;
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
        if (cmd.includes('--type=')) continue;
        const m = cmd.match(/--user-data-dir[= ]+["']?([^"']+?)["']?(?:\s+--|\s*$)/i);
        entries.push([pid, m ? m[1].trim() : getDefaultUserDataDir()]);
      }
      if (entries.length > 0) return entries;
    }
  } catch {}

  // PowerShell 回退
  try {
    const psCmd = `Get-CimInstance Win32_Process -Filter "name='Antigravity IDE.exe' or name='Antigravity.exe'" | Select-Object ProcessId,CommandLine | ConvertTo-Json -Compress`;
    const stdout = await runPowerShellAsync(psCmd, 10000);
    if (stdout && stdout.trim()) {
      const parsed = JSON.parse(stdout);
      const list = Array.isArray(parsed) ? parsed : [parsed];
      for (const p of list) {
        const pid = Number(p.ProcessId);
        const cmd: string = p.CommandLine || '';
        if (!pid || cmd.includes('--type=')) continue;
        const m = cmd.match(/--user-data-dir[= ]+["']?([^"']+?)["']?(?:\s+--|\s*$)/i);
        entries.push([pid, m ? m[1].trim() : getDefaultUserDataDir()]);
      }
    }
  } catch {}

  return entries;
}

async function getRunningEntriesUnix(): Promise<Array<[number, string | null]>> {
  const entries: Array<[number, string | null]> = [];
  try {
    const stdout = await runShellAsync('ps aux', 5000);
    if (!stdout) return entries;
    for (const line of stdout.split('\n')) {
      if (!/antigravity/i.test(line) || /grep/i.test(line) || /--type=/i.test(line)) continue;
      const parts = line.trim().split(/\s+/);
      const pid = parseInt(parts[1], 10);
      if (!pid || isNaN(pid)) continue;
      let cmdline = '';
      try { cmdline = fs.readFileSync(`/proc/${pid}/cmdline`, 'utf8').replace(/\0/g, ' '); } catch {
        cmdline = parts.slice(10).join(' ');
      }
      const m = cmdline.match(/--user-data-dir[= ]+["']?([^"'\0]+?)["']?(?:\s+--|\s*$)/i);
      entries.push([pid, m ? m[1].trim() : getDefaultUserDataDir()]);
    }
  } catch {}
  return entries;
}

async function getRunningInstanceDirs(): Promise<Set<string>> {
  const dirs = new Set<string>();
  for (const [, dir] of await getRunningEntries()) {
    if (dir) dirs.add(normalizePath(dir));
  }
  return dirs;
}

export function getCurrentUserDataDir(): string {
  // 从进程参数获取
  const args = process.argv;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--user-data-dir' && args[i + 1]) return args[i + 1];
    const eqMatch = args[i].match(/^--user-data-dir=(.+)$/);
    if (eqMatch) return eqMatch[1];
  }
  return getDefaultUserDataDir();
}

/** 当前实例主进程 PID（切号重启流程用它关闭 IDE 主进程） */
export async function getCurrentInstanceMainPid(): Promise<number | null> {
  const entries = await getRunningEntries(true);
  const currentDir = normalizePath(getCurrentUserDataDir());
  const match = entries.find(([, dir]) => dir && normalizePath(dir) === currentDir);
  return match ? match[0] : null;
}

export interface InstanceLaunchInfo {
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

/**
 * 快照当前实例主进程的 PID / exe / 完整启动参数。
 * 重启必须复用原参数（如 --remote-debugging-port），否则用户自行附加的启动配置会丢。
 */
export async function getCurrentInstanceLaunchInfo(): Promise<InstanceLaunchInfo> {
  const currentDir = normalizePath(getCurrentUserDataDir());
  let cmdline = '';
  let pid: number | null = null;

  try {
    const stdout = await runShellAsync(
      'wmic process where "name=\'Antigravity IDE.exe\' or name=\'Antigravity.exe\'" get ProcessId,CommandLine /FORMAT:LIST',
      10000
    );
    if (stdout && stdout.trim()) {
      for (const block of stdout.split(/\r?\n\r?\n/)) {
        const cmdMatch = block.match(/CommandLine=(.*)/);
        const pidMatch = block.match(/ProcessId=(\d+)/);
        if (!pidMatch) continue;
        const cmd = cmdMatch ? cmdMatch[1].trim() : '';
        if (cmd.includes('--type=')) continue;
        const m = cmd.match(/--user-data-dir[= ]+["']?([^"']+?)["']?(?:\s+--|\s*$)/i);
        const dir = m ? m[1].trim() : getDefaultUserDataDir();
        if (normalizePath(dir) === currentDir) {
          cmdline = cmd;
          pid = parseInt(pidMatch[1], 10);
          break;
        }
      }
    }
  } catch { /* 走 PowerShell 回退 */ }

  if (!cmdline) {
    try {
      const psCmd = `Get-CimInstance Win32_Process -Filter "name='Antigravity IDE.exe' or name='Antigravity.exe'" | Select-Object ProcessId,CommandLine | ConvertTo-Json -Compress`;
      const stdout = await runPowerShellAsync(psCmd, 10000);
      if (stdout && stdout.trim()) {
        const parsed = JSON.parse(stdout);
        const list = Array.isArray(parsed) ? parsed : [parsed];
        for (const p of list) {
          const ppid = Number(p.ProcessId);
          const cmd: string = p.CommandLine || '';
          if (!ppid || cmd.includes('--type=')) continue;
          const m = cmd.match(/--user-data-dir[= ]+["']?([^"']+?)["']?(?:\s+--|\s*$)/i);
          const dir = m ? m[1].trim() : getDefaultUserDataDir();
          if (normalizePath(dir) === currentDir) {
            cmdline = cmd;
            pid = ppid;
            break;
          }
        }
      }
    } catch { /* 快照失败由调用方走 detectExePath 兜底 */ }
  }

  if (!cmdline) return { pid, exePath: null, args: [] };
  const tokens = tokenizeCommandLine(cmdline);
  return { pid, exePath: tokens[0] || null, args: tokens.slice(1) };
}

// ─── Shell 工具 ──────────────────────────────────────────

function runShellAsync(cmd: string, timeoutMs: number): Promise<string | null> {
  return new Promise((resolve) => {
    try {
      cp.exec(cmd, { encoding: 'utf8', timeout: timeoutMs, windowsHide: true }, (err, stdout) => resolve(err ? null : stdout));
    } catch { resolve(null); }
  });
}

function runPowerShellAsync(script: string, timeoutMs: number): Promise<string | null> {
  return new Promise((resolve) => {
    try {
      const encoded = Buffer.from(script, 'utf16le').toString('base64');
      cp.exec(
        `powershell -NoProfile -NonInteractive -EncodedCommand ${encoded}`,
        { encoding: 'utf8', timeout: timeoutMs, windowsHide: true },
        (err, stdout) => resolve(err ? null : stdout)
      );
    } catch { resolve(null); }
  });
}

// ─── 从 Cockpit Tools 导入实例 ───────────────────────────────

export type CockpitInstance = { id: string; dir: string; name?: string; bindEmail?: string; imported?: boolean };

/** Cockpit Tools 的实例根目录（自动探测 antigravity / windsurf 子目录） */
function getCockpitInstancesDir(): string {
  let base: string;
  try {
    base = path.join(getAppDataDir(), '.antigravity_cockpit', 'instances');
  } catch {
    base = path.join(os.homedir(), '.antigravity_cockpit', 'instances');
  }
  // 优先 antigravity 子目录，其次 codex，最后 windsurf
  for (const sub of ['antigravity', 'codex', 'windsurf']) {
    const candidate = path.join(base, sub);
    if (fs.existsSync(candidate)) return candidate;
  }
  return base;
}

let _cockpitCache: { items: Array<Omit<CockpitInstance, 'imported'>>; ts: number } | null = null;
const COCKPIT_CACHE_TTL = 10000;
const BIND_MARK_CACHE_TTL = 30000;

export function listCockpitInstances(forceFresh = false): CockpitInstance[] {
  let baseList: Array<Omit<CockpitInstance, 'imported'>>;
  if (!forceFresh && _cockpitCache && Date.now() - _cockpitCache.ts < COCKPIT_CACHE_TTL) {
    baseList = _cockpitCache.items;
  } else {
    baseList = scanCockpitInstances();
    _cockpitCache = { items: baseList, ts: Date.now() };
  }
  const store = loadStore();
  const importedDirs = new Set(store.instances.map(i => normalizePath(i.userDataDir)));
  return baseList.map(item => ({
    ...item,
    imported: importedDirs.has(normalizePath(item.dir)),
  }));
}

function scanCockpitInstances(): Array<Omit<CockpitInstance, 'imported'>> {
  const result: Array<Omit<CockpitInstance, 'imported'>> = [];
  const root = getCockpitInstancesDir();
  if (!fs.existsSync(root)) return result;
  let dirs: fs.Dirent[] = [];
  try { dirs = fs.readdirSync(root, { withFileTypes: true }); } catch { return result; }
  for (const d of dirs) {
    if (!d.isDirectory()) continue;
    const instDir = path.join(root, d.name);
    // 只接受看起来像 IDE 数据目录的（含 User 子目录）
    if (!fs.existsSync(path.join(instDir, 'User'))) continue;
    const bindEmail = readBindMarkFromStateDb(instDir);
    result.push({ id: d.name, dir: instDir, bindEmail: bindEmail || undefined });
  }
  return result;
}

function invalidateCockpitCache(): void { _cockpitCache = null; }

export function hasUnimportedCockpitInstances(): boolean {
  return listCockpitInstances().some(ci => !ci.imported);
}

const _bindMarkCache = new Map<string, { email: string | null; ts: number }>();

function readBindMarkFromStateDb(instDir: string): string | null {
  const cached = _bindMarkCache.get(instDir);
  if (cached && Date.now() - cached.ts < BIND_MARK_CACHE_TTL) return cached.email;

  // 1. 优先读取绑定标记文件
  const bindPath = path.join(instDir, BIND_FILE);
  if (fs.existsSync(bindPath)) {
    try {
      const raw = JSON.parse(fs.readFileSync(bindPath, 'utf8'));
      if (raw.bindEmail) { _bindMarkCache.set(instDir, { email: raw.bindEmail, ts: Date.now() }); return raw.bindEmail; }
    } catch {}
  }

  // 2. 从 state.vscdb 提取 email
  const dbPath = path.join(instDir, 'User', 'globalStorage', 'state.vscdb');
  if (!fs.existsSync(dbPath)) { _bindMarkCache.set(instDir, { email: null, ts: Date.now() }); return null; }
  try {
    const stats = fs.statSync(dbPath);
    if (stats.size > 20 * 1024 * 1024) { _bindMarkCache.set(instDir, { email: null, ts: Date.now() }); return null; }
    const content = fs.readFileSync(dbPath).toString('utf8');
    // 收集 auth-{email} 形式，取出现次数最多的
    const authMatches = content.matchAll(/(?:antigravity|windsurf)_auth-([\w._%+-]+@[\w.-]+\.\w+)/gi);
    const counter = new Map<string, number>();
    for (const m of authMatches) { const e = m[1].trim(); counter.set(e, (counter.get(e) || 0) + 1); }
    if (counter.size > 0) {
      const sorted = [...counter.entries()].sort((a, b) => b[1] - a[1]);
      _bindMarkCache.set(instDir, { email: sorted[0][0], ts: Date.now() });
      return sorted[0][0];
    }
    const m = content.match(/"email"\s*:\s*"([\w._%+-]+@[\w.-]+\.\w+)"/) || content.match(/[\w._%+-]+@[\w.-]+\.\w+/);
    const email = m ? (m[1] || m[0]) : null;
    _bindMarkCache.set(instDir, { email, ts: Date.now() });
    return email;
  } catch {
    _bindMarkCache.set(instDir, { email: null, ts: Date.now() });
    return null;
  }
}

export async function importCockpitInstance(cockpitId: string, newName: string, newBindEmail: string): Promise<InstanceConfig> {
  const cockpitDir = path.join(getCockpitInstancesDir(), cockpitId);
  if (!fs.existsSync(cockpitDir)) throw new Error('Cockpit 实例不存在');

  const store = loadStore();
  const name = newName.trim();
  if (!name) throw new Error('实例名称不能为空');
  if (store.instances.some(i => i.name === name)) throw new Error('实例名称已存在');

  const targetNorm = normalizePath(cockpitDir);
  if (store.instances.some(i => normalizePath(i.userDataDir) === targetNorm)) throw new Error('该 Cockpit 实例已被导入');

  // 直接引用 Cockpit 目录，不复制（节省空间）
  try { fs.writeFileSync(path.join(cockpitDir, BIND_FILE), JSON.stringify({ bindEmail: newBindEmail }), 'utf8'); } catch {}

  const instance: InstanceConfig = {
    id: generateId(),
    name,
    userDataDir: cockpitDir,
    bindEmail: newBindEmail,
    createdAt: Date.now(),
    source: 'cockpit',
  };
  store.instances.push(instance);
  saveStore(store);
  invalidateCockpitCache();
  return instance;
}

// ─── 目录复制 ────────────────────────────────────────────

function countFiles(src: string): number {
  let count = 0;
  try {
    const entries = fs.readdirSync(src, { withFileTypes: true });
    for (const entry of entries) {
      if (COPY_EXCLUDE.includes(entry.name)) continue;
      if (entry.isDirectory()) count += countFiles(path.join(src, entry.name));
      else if (entry.isFile()) count++;
    }
  } catch {}
  return count;
}

interface CopyProgress {
  copied: number;
  total: number;
  onProgress?: (msg: string) => void;
  lastReportTs: number;
}

async function copyDirSelective(src: string, dst: string, progress?: CopyProgress): Promise<void> {
  try { fs.mkdirSync(dst, { recursive: true }); } catch {}
  const entries = fs.readdirSync(src, { withFileTypes: true });
  for (const entry of entries) {
    if (COPY_EXCLUDE.includes(entry.name)) continue;
    const srcPath = path.join(src, entry.name);
    const dstPath = path.join(dst, entry.name);
    if (entry.isDirectory()) {
      await copyDirSelective(srcPath, dstPath, progress);
    } else if (entry.isFile()) {
      try {
        fs.copyFileSync(srcPath, dstPath);
        if (progress) {
          progress.copied++;
          const now = Date.now();
          if (now - progress.lastReportTs > 200 || progress.copied === progress.total) {
            progress.lastReportTs = now;
            const pct = progress.total > 0 ? Math.round((progress.copied / progress.total) * 100) : 0;
            progress.onProgress?.(`复制中… ${progress.copied}/${progress.total} (${pct}%)`);
            await new Promise(r => setImmediate(r));
          }
        }
      } catch {}
    }
  }
}
