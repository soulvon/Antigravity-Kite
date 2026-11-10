/**
 * Multi-Window Manager — Antigravity Kite 多开窗口管理器
 * 支持创建/启动/停止/聚焦/管理独立绑定账号的伴生 IDE 窗口。
 * 全局共享同一套会话资产与项目上下文，纯为多账号并发服务。
 */
import * as fs from 'fs';
import * as path from 'path';
import * as cp from 'child_process';
import * as crypto from 'crypto';
import * as vscode from 'vscode';
import { MultiWindowConfig, MultiWindowView } from './types';
import { getSharedStorageDir, migrateDataIfNeeded } from './storage';
import { getAppDataDir } from './platformPaths';
import {
  getDefaultUserDataDir,
  getCurrentUserDataDir,
  normalizePath,
  detectExePath,
  getRunningEntries,
  invalidateProcessCache,
  runPowerShellAsync,
  runShellAsync,
} from './ideRuntime';
import { logInfo, logWarn, logError } from './logger';
import { t } from './i18n';

export { invalidateProcessCache } from './ideRuntime';

const MULTI_WINDOWS_FILE = 'multi_windows.json';
const LEGACY_INSTANCES_FILE = 'instances.json';
const WINDOWS_DIR_NAME = 'windows';
const BIND_FILE = '.kite-bind';

/**
 * spawn 新 IDE 实例必须清掉的继承环境变量。
 *
 * 实测（v1.2.13 真机事故）：扩展宿主继承的 ELECTRON_RUN_AS_NODE=1 会让 IDE 以纯 Node 模式
 * 启动，Node 不认识 --user-data-dir，直接 "bad option" 退出（exit 9）。spawn 仍拿得到 pid，
 * 但进程几百毫秒内秒退、多开目录只剩 .kite-bind，界面看起来就是「点了没反应」。
 * 用干净环境启动同一命令则正常存活并完整初始化多开目录（已在本机对照验证）。
 *
 * VSCODE_IPC_HOOK 一类变量实测未导致秒退，但仍一并清理：避免新实例把启动请求
 * 转发给已运行的主窗口而不新开窗口。
 */
const INHERITED_ENV_BLOCKLIST = [
  'ELECTRON_RUN_AS_NODE',
  'ELECTRON_NO_ATTACH_CONSOLE',
  'VSCODE_IPC_HOOK',
  'VSCODE_IPC_HOOK_CLI',
  'VSCODE_PID',
  'VSCODE_CWD',
  'VSCODE_HANDLES_UNCAUGHT_ERRORS',
];

/** 启动后的存活观察窗口：少于该时长即退出视为启动失败（真实 IDE 冷启动远长于此） */
const START_PROBE_MS = 2000;

const isWindows = process.platform === 'win32';
const isMac = process.platform === 'darwin';

interface MultiWindowStore {
  windows: MultiWindowConfig[];
}

let _storageDir = '';
let _context: vscode.ExtensionContext | null = null;

export function init(context: vscode.ExtensionContext): void {
  _context = context;
  migrateDataIfNeeded(context, MULTI_WINDOWS_FILE);
  _storageDir = getSharedStorageDir();
}

export function getEffectiveCurrentUserDataDir(): string {
  if (_context && _context.globalStorageUri) {
    try {
      const p = _context.globalStorageUri.fsPath;
      const candidate = path.resolve(p, '../../..');
      if (fs.existsSync(candidate)) return candidate;
    } catch {}
  }
  return getCurrentUserDataDir();
}

function getWindowsRootDir(): string {
  return path.join(_storageDir, WINDOWS_DIR_NAME);
}

function getStoreFilePath(): string {
  return path.join(_storageDir, MULTI_WINDOWS_FILE);
}

function getLegacyStoreFilePath(): string {
  return path.join(_storageDir, LEGACY_INSTANCES_FILE);
}

// ─── Store 读写 ─────────────────────────────────────────

let _storeCache: MultiWindowStore | null = null;
let _storeCacheTs = 0;
const CACHE_TTL_MS = 2000;

function loadStore(forceFresh = false): MultiWindowStore {
  const now = Date.now();
  if (!forceFresh && _storeCache && now - _storeCacheTs < CACHE_TTL_MS) {
    return _storeCache;
  }

  const p = getStoreFilePath();
  const legacyP = getLegacyStoreFilePath();

  // 若新文件不存在但老 instances.json 存在，执行无损平滑迁移
  if (!fs.existsSync(p) && fs.existsSync(legacyP)) {
    try {
      const raw = fs.readFileSync(legacyP, 'utf8');
      const parsed = JSON.parse(raw);
      const list = Array.isArray(parsed.instances) ? parsed.instances : [];
      _storeCache = {
        windows: list.map((i: any) => ({
          id: i.id || crypto.randomBytes(6).toString('hex'),
          name: i.name || '多开',
          userDataDir: i.userDataDir || '',
          bindEmail: i.bindEmail || '',
          assignedTag: i.assignedTag,
          createdAt: i.createdAt || Date.now(),
          source: i.source,
        })),
      };
      saveStore(_storeCache);
      return _storeCache;
    } catch {}
  }

  if (!fs.existsSync(p)) {
    _storeCache = { windows: [] };
    _storeCacheTs = now;
    return _storeCache;
  }

  try {
    const raw = fs.readFileSync(p, 'utf8');
    const parsed = JSON.parse(raw);
    let dirty = false;
    const rawWindows = Array.isArray(parsed.windows) ? parsed.windows : [];
    const defaultDirNorm = normalizePath(getDefaultUserDataDir());
    const windows = rawWindows.map((win: MultiWindowConfig) => {
      const isDef = win.id === 'default' || normalizePath(win.userDataDir) === defaultDirNorm;
      let cleanName = win.name;
      if (isDef || cleanName === '默认实例' || cleanName === '默认多开') {
        cleanName = t('mwMainWinTitle') || '主窗口';
      } else {
        cleanName = cleanName.replace(/实例/g, '多开');
      }
      if (cleanName !== win.name) dirty = true;
      return { ...win, name: cleanName };
    });
    _storeCache = { windows };
    _storeCacheTs = now;
    if (dirty) saveStore(_storeCache);
    return _storeCache;
  } catch (e) {
    logError('multiWindow.loadStore.fail', e);
    return { windows: [] };
  }
}

function saveStore(store: MultiWindowStore): void {
  try { fs.mkdirSync(_storageDir, { recursive: true }); } catch {}
  const p = getStoreFilePath();
  const tmp = p + '.tmp';
  try {
    fs.writeFileSync(tmp, JSON.stringify(store, null, 2), 'utf8');
    fs.renameSync(tmp, p);
    _storeCache = store;
    _storeCacheTs = Date.now();
  } catch (e) {
    logError('multiWindow.saveStore.fail', e);
  }
}

// ─── 文件监听 ────────────────────────────────────────────

let _fileWatcher: fs.FSWatcher | null = null;
const _changeListeners: Set<() => void> = new Set();

function startWatcher(): void {
  if (_fileWatcher) return;
  try {
    _fileWatcher = fs.watch(_storageDir, (_evt, filename) => {
      if (!filename || filename === MULTI_WINDOWS_FILE) {
        _storeCache = null;
        for (const fn of _changeListeners) {
          try { fn(); } catch {}
        }
      }
    });
    _fileWatcher.on('error', () => {
      try { _fileWatcher?.close(); } catch {}
      _fileWatcher = null;
      setTimeout(() => { if (_changeListeners.size > 0) startWatcher(); }, 1000);
    });
  } catch (e) {
    logWarn('multiWindow.watch.fail', e);
  }
}

export function watchMultiWindowsFile(onChange: () => void): () => void {
  _changeListeners.add(onChange);
  startWatcher();
  return () => {
    _changeListeners.delete(onChange);
    if (_changeListeners.size === 0 && _fileWatcher) {
      try { _fileWatcher.close(); } catch {}
      _fileWatcher = null;
    }
  };
}

export function dispose(): void {
  if (_fileWatcher) {
    try { _fileWatcher.close(); } catch {}
    _fileWatcher = null;
  }
  _changeListeners.clear();
}

// ─── 核心辅助 ───────────────────────────────────────────

function generateId(): string {
  return 'mw_' + crypto.randomBytes(6).toString('hex');
}

function ensureDefaultWindow(store: MultiWindowStore): void {
  const defaultDir = getDefaultUserDataDir();
  if (!defaultDir) return;
  const normDefault = normalizePath(defaultDir);
  const existing = store.windows.find(w => w.id === 'default' || normalizePath(w.userDataDir) === normDefault);
  if (existing) {
    existing.id = 'default';
    existing.name = t('mwMainWinTitle') || '主窗口';
    existing.userDataDir = defaultDir;
    return;
  }
  store.windows.unshift({
    id: 'default',
    name: t('mwMainWinTitle') || '主窗口',
    userDataDir: defaultDir,
    bindEmail: '',
    createdAt: 0,
  });
  saveStore(store);
}

function isPathUnder(target: string, base: string): boolean {
  const rel = path.relative(base, target);
  return !!rel && !rel.startsWith('..') && !path.isAbsolute(rel);
}

/** 获取正在运行的 Antigravity 多开窗口的 [pid, userDataDir] 映射 */
async function getRunningWindowMap(): Promise<Map<string, number>> {
  const map = new Map<string, number>();
  try {
    const entries = await getRunningEntries();
    const defaultDirNorm = normalizePath(getDefaultUserDataDir());
    for (const [pid, dir] of entries) {
      if (dir) {
        map.set(normalizePath(dir), pid);
      } else {
        // 未带 --user-data-dir 的即为主窗口进程
        if (!map.has(defaultDirNorm)) {
          map.set(defaultDirNorm, pid);
        }
      }
    }
  } catch (e) {
    logWarn('multiWindow.getRunningMap.fail', e);
  }
  return map;
}

// ─── 业务操作 ───────────────────────────────────────────

/** 列出所有多开窗口（带运行态与当前标记） */
export async function listWindows(): Promise<MultiWindowView[]> {
  const store = loadStore();
  try { ensureDefaultWindow(store); } catch {}
  const runningMap = await getRunningWindowMap();
  const currentDir = normalizePath(getEffectiveCurrentUserDataDir());
  const defaultDirNorm = normalizePath(getDefaultUserDataDir());

  let matchedCurrent = false;

  const views: MultiWindowView[] = store.windows.map(win => {
    const norm = normalizePath(win.userDataDir);
    const pid = runningMap.get(norm);
    const isDef = win.id === 'default' || norm === defaultDirNorm;
    const isCur = norm === currentDir;
    if (isCur) matchedCurrent = true;
    const isRun = isCur || pid !== undefined;

    const safeName = (isDef || win.name === '默认实例' || win.name === '默认多开')
      ? (t('mwMainWinTitle') || '主窗口')
      : win.name.replace(/实例/g, '多开');

    return {
      ...win,
      name: safeName,
      running: isRun,
      isRunning: isRun,
      current: isCur,
      isCurrent: isCur,
      isDefault: isDef,
      lastPid: pid ?? win.lastPid,
    };
  });

  // 兜底：如果没有任何一个窗口匹配上 currentDir，则主窗口即当前窗口
  if (!matchedCurrent) {
    const defWin = views.find(v => v.isDefault);
    if (defWin) {
      defWin.current = true;
      defWin.isCurrent = true;
      defWin.running = true;
      defWin.isRunning = true;
    }
  }

  return views;
}

/** 克隆主环境配置时的排除项：纯缓存，删掉 IDE 会自己重建 */
const PROFILE_COPY_EXCLUDE = new Set([
  'GPUCache', 'Cache', 'CachedData', 'Code Cache', 'blob_storage', 'Crashpad',
  'logs', 'Crash Reports', 'DawnGraphiteCache', 'DawnWebGPUCache', 'ShaderCache',
  'CachedProfilesData', 'Backups', 'Network', 'Session Storage', 'Local Storage',
  'WebStorage', 'Service Worker', 'Crashpad',
]);

function countProfileFiles(dir: string): number {
  let n = 0;
  try {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (PROFILE_COPY_EXCLUDE.has(entry.name)) continue;
      const p = path.join(dir, entry.name);
      if (entry.isDirectory()) n += countProfileFiles(p);
      else if (entry.isFile()) n++;
    }
  } catch { /* 读不到就不计入总数，不影响主流程 */ }
  return n;
}

function copyProfileDir(src: string, dst: string, onFile: () => void): void {
  fs.mkdirSync(dst, { recursive: true });
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    if (PROFILE_COPY_EXCLUDE.has(entry.name)) continue;
    const s = path.join(src, entry.name);
    const d = path.join(dst, entry.name);
    try {
      if (entry.isDirectory()) copyProfileDir(s, d, onFile);
      else if (entry.isFile()) {
        fs.copyFileSync(s, d);
        onFile();
      }
    } catch { /* 单个文件失败继续复制其余文件 */ }
  }
}

export interface CreateWindowOptions {
  name: string;
  bindEmail: string;
  assignedTag?: string;
  /** 创建阶段回调：用于界面显示「复制配置 12/278」等进度 */
  onProgress?: (text: string) => void;
}

/** 创建多开窗口：克隆主环境配置（排除缓存），让新窗口带着既有设置而不是一个空 IDE */
export async function createWindow(opts: CreateWindowOptions): Promise<MultiWindowConfig> {
  const store = loadStore();
  let name = (opts.name || '').trim();
  if (!name) {
    let idx = store.windows.length + 1;
    while (store.windows.some(w => w.name === `多开 ${idx}` || w.name === `Window ${idx}`)) {
      idx++;
    }
    name = t('mwDefaultWinName', String(idx)) || `多开 ${idx}`;
  }
  if (store.windows.some(w => w.name === name)) {
    throw new Error(t('mwNameDuplicate') || '多开名称已存在');
  }

  const id = generateId();
  const winDir = path.join(getWindowsRootDir(), id);
  if (fs.existsSync(winDir)) throw new Error('多开目录冲突，请重试');

  fs.mkdirSync(winDir, { recursive: true });

  // 克隆主环境的 User 配置（设置/扩展状态/项目索引），让新窗口一打开就是熟悉的环境。
  // 扩展本体在全局 extensions 目录，无需复制，所以只有十几 MB。
  const defaultDir = getDefaultUserDataDir();
  const srcUser = path.join(defaultDir, 'User');
  const dstUser = path.join(winDir, 'User');
  if (fs.existsSync(srcUser) && normalizePath(srcUser) !== normalizePath(dstUser)) {
    try {
      opts.onProgress?.(t('mwCopyingProfile'));
      const total = countProfileFiles(srcUser);
      let copied = 0;
      copyProfileDir(srcUser, dstUser, () => {
        copied++;
        if (copied % 50 === 0 || copied === total) {
          opts.onProgress?.(t('mwCopyProgress', String(copied), String(total)));
        }
      });
      logInfo('multiWindow.profileCloned', { id, copied, total });
    } catch (e) {
      // 克隆失败不阻断创建，但必须显式告知，不能悄悄给用户一个空环境
      logWarn('multiWindow.profileClone.fail', e);
      opts.onProgress?.(t('mwCopyFailed'));
    }
  }

  fs.writeFileSync(
    path.join(winDir, BIND_FILE),
    JSON.stringify({ bindEmail: opts.bindEmail.trim(), assignedTag: opts.assignedTag || '' }, null, 2),
    'utf8'
  );

  const config: MultiWindowConfig = {
    id,
    name,
    userDataDir: winDir,
    bindEmail: opts.bindEmail.trim(),
    assignedTag: opts.assignedTag?.trim(),
    createdAt: Date.now(),
  };

  store.windows.push(config);
  saveStore(store);
  logInfo('multiWindow.created', { id, name, bindEmail: opts.bindEmail });
  return config;
}

/** 启动指定多开窗口 */
/** 读取单个窗口配置（启动前预写身份需要 userDataDir / bindEmail） */
export function getWindowById(windowId: string): MultiWindowConfig | undefined {
  return loadStore().windows.find(w => w.id === windowId);
}

export async function startWindow(windowId: string): Promise<void> {
  const store = loadStore();
  const win = store.windows.find(w => w.id === windowId);
  if (!win) throw new Error(t('mwNotFound') || '多开不存在');
  if (!fs.existsSync(win.userDataDir)) {
    throw new Error(t('mwDirNotFound') + `: ${win.userDataDir}`);
  }

  const runningMap = await getRunningWindowMap();
  if (runningMap.has(normalizePath(win.userDataDir))) {
    // 若已在运行，直接执行置顶聚焦
    await focusWindow(windowId);
    return;
  }

  const exePath = await detectExePath();
  if (!exePath) throw new Error(t('gateNoExe') || '未找到 Antigravity IDE 可执行文件');

  // 拼接启动参数：独立数据目录，打开当前工作区
  const args: string[] = ['--user-data-dir', win.userDataDir, '--reuse-window'];
  const curFolder = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  if (curFolder && fs.existsSync(curFolder)) {
    args.push(curFolder);
  }

  // 必须清理继承自扩展宿主的环境变量：ELECTRON_RUN_AS_NODE=1 会让 IDE 以 Node 模式启动并秒退
  const env: NodeJS.ProcessEnv = { ...process.env };
  const droppedEnv: string[] = [];
  for (const key of INHERITED_ENV_BLOCKLIST) {
    if (key in env) {
      delete env[key];
      droppedEnv.push(key);
    }
  }

  // stdout/stderr 落文件而非 ignore：启动失败必须留下可查原因，不能静默
  const logPath = path.join(getSharedStorageDir(), 'logs', `mw-${win.id}.log`);
  let logFd: number | undefined;
  try {
    fs.mkdirSync(path.dirname(logPath), { recursive: true });
    logFd = fs.openSync(logPath, 'w');
  } catch (e) {
    logWarn('multiWindow.log.open.fail', e);
  }

  const readLogTail = (): string => {
    try { return fs.readFileSync(logPath, 'utf8').trim().slice(-800); } catch { return ''; }
  };

  // spawn 的失败是异步 error 事件，try/catch 抓不到；必须显式等一个存活观察窗口
  const outcome = await new Promise<{ alive: boolean; error?: Error; code?: number | null }>((resolve) => {
    let settled = false;
    const finish = (v: { alive: boolean; error?: Error; code?: number | null }) => {
      if (settled) return;
      settled = true;
      resolve(v);
    };
    let child: cp.ChildProcess;
    try {
      child = cp.spawn(exePath, args, {
        detached: true,
        stdio: logFd === undefined ? 'ignore' : ['ignore', logFd, logFd],
        windowsHide: false,
        env,
        cwd: path.dirname(exePath),
      });
    } catch (e) {
      finish({ alive: false, error: e instanceof Error ? e : new Error(String(e)) });
      return;
    }
    child.once('error', (e) => finish({ alive: false, error: e }));
    child.once('exit', (code) => finish({ alive: false, code }));
    setTimeout(() => {
      finish({ alive: true });
      child.unref();
    }, START_PROBE_MS);
  });

  // 父进程关闭自己的句柄，子进程已继承，不影响它继续写日志
  if (logFd !== undefined) {
    try { fs.closeSync(logFd); } catch {}
  }

  if (!outcome.alive) {
    const tail = readLogTail();
    const reason = outcome.error
      ? outcome.error.message
      : t('mwStartExited', String(outcome.code ?? '?')) + (tail ? `\n${tail}` : '');
    logError('multiWindow.start.fail', { id: win.id, exePath, args, droppedEnv, reason, logPath });
    throw new Error(t('mwStartFail') + `: ${reason}`);
  }

  invalidateProcessCache();
  logInfo('multiWindow.started', { id: win.id, args, droppedEnv, logPath });
}

/** 停止指定多开窗口 */
export async function stopWindow(windowId: string): Promise<void> {
  if (windowId === 'default') {
    throw new Error(t('mwDefaultCannotStop') || '主窗口不可通过快捷面板停止');
  }
  const store = loadStore();
  const win = store.windows.find(w => w.id === windowId);
  if (!win) throw new Error(t('mwNotFound') || '多开不存在');

  const runningMap = await getRunningWindowMap();
  const pid = runningMap.get(normalizePath(win.userDataDir));
  if (!pid) return; // 已经未在运行

  if (normalizePath(win.userDataDir) === normalizePath(getCurrentUserDataDir())) {
    throw new Error(t('mwCurrentCannotStop') || '当前正在操作的窗口不可直接关闭');
  }

  if (isWindows) {
    await runShellAsync(`taskkill /PID ${pid} /T /F`, 5000);
  } else {
    try { process.kill(pid, 'SIGKILL'); } catch {}
  }
  invalidateProcessCache();
  logInfo('multiWindow.stopped', { id: win.id, pid });
}

/** 置顶聚焦指定多开窗口（通过 Windows API / 句柄置顶） */
export async function focusWindow(windowId: string): Promise<void> {
  const store = loadStore();
  const win = store.windows.find(w => w.id === windowId);
  if (!win) throw new Error(t('mwNotFound') || '多开不存在');

  const runningMap = await getRunningWindowMap();
  const pid = runningMap.get(normalizePath(win.userDataDir));
  if (!pid) throw new Error(t('mwNotRunning') || '该多开尚未运行');

  if (isWindows) {
    const ps = `
      Add-Type @'
        using System;
        using System.Runtime.InteropServices;
        public class WinFocus {
          [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
          [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int c);
          [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr h);
          [DllImport("user32.dll")] public static extern void SwitchToThisWindow(IntPtr h, bool fAltTab);
        }
'@
      $targetPid = ${pid}
      $p = Get-Process -Id $targetPid -ErrorAction SilentlyContinue
      $h = [IntPtr]::Zero
      if ($p -and $p.MainWindowHandle -ne [IntPtr]::Zero) {
        $h = $p.MainWindowHandle
      } else {
        # Electron 的 MainWindowHandle 可能依附在主进程直接派生的伴生子进程上
        $children = Get-CimInstance Win32_Process -Filter "ParentProcessId=$targetPid" -ErrorAction SilentlyContinue
        if ($children) {
          foreach ($c in $children) {
            $cp = Get-Process -Id $c.ProcessId -ErrorAction SilentlyContinue
            if ($cp -and $cp.MainWindowHandle -ne [IntPtr]::Zero) {
              $h = $cp.MainWindowHandle
              break
            }
          }
        }
      }
      if ($h -ne [IntPtr]::Zero) {
        if ([WinFocus]::IsIconic($h)) { [WinFocus]::ShowWindow($h, 9) }
        [WinFocus]::ShowWindow($h, 5)
        [WinFocus]::SetForegroundWindow($h)
        [WinFocus]::SwitchToThisWindow($h, $true)
      }
    `;
    await runPowerShellAsync(ps, 5000);
  } else if (isMac) {
    await runShellAsync(`osascript -e 'tell application "System Events" to set frontmost of (first process whose unix id is ${pid}) to true'`, 3000);
  } else {
    await runShellAsync(`xdotool search --pid ${pid} --onlyvisible windowactivate 2>/dev/null || wmctrl -i -a $(wmctrl -lp | awk '$3==${pid}{print $1; exit}') 2>/dev/null`, 3000);
  }
}

/** 更新多开信息（名称 / 绑定账号 / 分组） */
export function updateWindow(windowId: string, updates: { name?: string; bindEmail?: string; assignedTag?: string }): void {
  const store = loadStore();
  const win = store.windows.find(w => w.id === windowId);
  if (!win) throw new Error(t('mwNotFound') || '多开不存在');

  if (updates.name !== undefined) {
    const n = updates.name.trim();
    if (!n) throw new Error(t('mwNameRequired') || '多开名称不能为空');
    if (store.windows.some(w => w.id !== windowId && w.name === n)) {
      throw new Error(t('mwNameDuplicate') || '多开名称已存在');
    }
    win.name = n;
  }

  if (updates.bindEmail !== undefined) {
    win.bindEmail = updates.bindEmail.trim();
  }
  if (updates.assignedTag !== undefined) {
    win.assignedTag = updates.assignedTag.trim() || undefined;
  }

  // 刷新绑定文件
  try {
    const bPath = path.join(win.userDataDir, BIND_FILE);
    if (fs.existsSync(win.userDataDir)) {
      fs.writeFileSync(bPath, JSON.stringify({ bindEmail: win.bindEmail, assignedTag: win.assignedTag || '' }, null, 2), 'utf8');
    }
  } catch {}

  saveStore(store);
}

/** 删除多开窗口 */
export async function deleteWindow(windowId: string): Promise<void> {
  if (windowId === 'default') {
    throw new Error(t('mwDefaultCannotDelete') || '主窗口不可删除');
  }
  const store = loadStore();
  const idx = store.windows.findIndex(w => w.id === windowId);
  if (idx < 0) throw new Error(t('mwNotFound') || '多开不存在');
  const win = store.windows[idx];

  const runningMap = await getRunningWindowMap();
  if (runningMap.has(normalizePath(win.userDataDir))) {
    throw new Error(t('mwDeleteRunningError') || '请先停止该多开，再进行删除');
  }

  // 安全删除目录（限定在 windows 目录下）
  const root = getWindowsRootDir();
  if (isPathUnder(win.userDataDir, root)) {
    try {
      if (fs.existsSync(win.userDataDir)) {
        fs.rmSync(win.userDataDir, { recursive: true, force: true });
      }
    } catch (e) {
      logWarn('multiWindow.deleteDir.warn', e);
    }
  }

  store.windows.splice(idx, 1);
  saveStore(store);
  logInfo('multiWindow.deleted', { id: windowId });
}

// ─── 启动自愈切号支持 ────────────────────────────────────

/** 读取当前窗口的绑定标记（若是分身多开，返回需要绑定的账号） */
export function getAutoSwitchTargetForCurrentWindow(): string | null {
  // 必须用 globalStorageUri 反推的可靠目录：扩展宿主是独立进程，
  // process.argv 里根本没有主进程的 --user-data-dir，读它会误判成主窗口而跳过失联切号
  const curDir = getEffectiveCurrentUserDataDir();
  const defDir = getDefaultUserDataDir();
  if (normalizePath(curDir) === normalizePath(defDir)) {
    return null; // 主窗口不自动覆盖
  }

  const bindPath = path.join(curDir, BIND_FILE);
  if (!fs.existsSync(bindPath)) return null;
  try {
    const data = JSON.parse(fs.readFileSync(bindPath, 'utf8'));
    return (data && data.bindEmail) ? String(data.bindEmail).trim() : null;
  } catch {
    return null;
  }
}

// ─── Cockpit Tools 导入 ─────────────────────────────────

export interface CockpitInstanceCandidate {
  id: string;
  name: string;
  userDataDir: string;
  bindEmail: string;
}

/** 探测 Cockpit Tools 中配置的多开 */
export function listCockpitCandidates(): CockpitInstanceCandidate[] {
  const store = loadStore();
  const registeredDirs = new Set(store.windows.map(w => normalizePath(w.userDataDir)));
  const candidates: CockpitInstanceCandidate[] = [];

  const appData = getAppDataDir();
  const possibleFiles = [
    path.join(appData, '.cockpit_tools', 'instances.json'),
    path.join(appData, '.cockpit_tools', 'antigravity_legacy_instances.json'),
    path.join(appData, 'cockpit-tools', 'instances.json'),
  ];

  for (const f of possibleFiles) {
    if (!fs.existsSync(f)) continue;
    try {
      const parsed = JSON.parse(fs.readFileSync(f, 'utf8'));
      const items = Array.isArray(parsed.instances) ? parsed.instances : [];
      for (const item of items) {
        if (!item.userDataDir || registeredDirs.has(normalizePath(item.userDataDir))) continue;
        candidates.push({
          id: item.id || crypto.randomBytes(6).toString('hex'),
          name: item.name || 'Cockpit 多开',
          userDataDir: item.userDataDir,
          bindEmail: item.bindEmail || item.bind_account_id || '',
        });
      }
    } catch {}
  }
  return candidates;
}

/** 导入 Cockpit 多开 */
export function importCockpitCandidate(name: string, userDataDir: string, bindEmail: string): MultiWindowConfig {
  const store = loadStore();
  const trimmedName = name.trim();
  if (!trimmedName) throw new Error(t('mwNameRequired') || '多开名称不能为空');
  if (store.windows.some(w => w.name === trimmedName)) {
    throw new Error(t('mwNameDuplicate') || '多开名称已存在');
  }
  if (!fs.existsSync(userDataDir)) {
    throw new Error(t('mwDirNotFound') + `: ${userDataDir}`);
  }

  const config: MultiWindowConfig = {
    id: generateId(),
    name: trimmedName,
    userDataDir,
    bindEmail: bindEmail.trim(),
    createdAt: Date.now(),
    source: 'cockpit',
  };

  store.windows.push(config);
  saveStore(store);
  return config;
}

