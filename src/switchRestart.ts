/**
 * 切号重启调度器
 *
 * IDE 款运行中身份热切是平台级死路（UserStatus 写入口只在 workbench，
 * 运行中写 state.vscdb 会被退出钩子/并发写者回写覆盖）。
 * 权威流程：确认 → 派脱离进程助手 → 关 IDE → 进程完全退出后干净写库 → 用原 exe+参数重启。
 * 参考 devloop: antigravity-seamless-switch-protocol 与 lbjlaq/Antigravity-Manager 的 IDE 分支。
 */
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as cp from 'child_process';
import { getSharedStorageDir } from './storage';
import { SwitchToken } from './seamlessSwitcher';
import { t } from './i18n';

const PENDING_FILE = 'switch-restart-pending.json';
const RESULT_FILE = 'switch-restart-result.json';

export interface SwitchRestartPlan {
  email: string;
  token: SwitchToken;
  /** 要写入的 IDE 状态库（分身实例必须是该实例自己的库） */
  dbPath: string;
  /** 重启用 IDE 可执行文件 */
  exePath: string;
  /** 重启参数（至少含 --user-data-dir） */
  launchArgs: string[];
  /** IDE 主进程 PID */
  mainPid: number | null;
  /** 凭据管理器 blob（身份唯一权威来源，助手在 IDE 关闭后写入） */
  credential?: { blobBase64: string; user: string };
  /** ~/.gemini 账号文件同步参数 */
  geminiSync?: { email: string; accessToken: string; refreshToken: string; expiryMs: number };
}

export function getResultFilePath(): string {
  return path.join(getSharedStorageDir(), RESULT_FILE);
}

/**
 * agy.exe（IDE 内置 agent 引擎）的账号指针，agent 面板账号跟随它。
 * 无感切与重启助手共用同一文件语义（助手侧经 KITE_AGY_ACCOUNT_FILE 注入测试路径）。
 */
export function writeAgyActiveAccount(email: string): { ok: boolean; error?: string } {
  const file = path.join(os.homedir(), '.gemini', 'antigravity', 'active-account.json');
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify({ email, updatedAt: Date.now() }), 'utf8');
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

export function readSwitchRestartResult(): { ok: boolean; error?: string; warning?: string; email?: string; finishedAt?: number } | null {
  const p = getResultFilePath();
  if (!fs.existsSync(p)) return null;
  try {
    return JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch {
    return null;
  }
}

export function clearSwitchRestartResult(): void {
  try { fs.rmSync(getResultFilePath(), { force: true }); } catch { /* 文件不存在即目标态 */ }
}

/**
 * 落盘交接文件并派脱离进程助手执行「关 IDE → 写库 → 重启」。
 * 调度失败立即返回错误，绝不静默；调度成功后本扩展随 IDE 一起退出。
 */
export async function scheduleSwitchRestart(plan: SwitchRestartPlan): Promise<{ scheduled: boolean; error?: string }> {
  if (!plan.mainPid) {
    return { scheduled: false, error: t('errMainPid') };
  }
  if (!plan.exePath || !fs.existsSync(plan.exePath)) {
    return { scheduled: false, error: `未找到 Antigravity IDE 可执行文件：${plan.exePath}` };
  }
  if (!fs.existsSync(plan.dbPath)) {
    return { scheduled: false, error: `状态库不存在：${plan.dbPath}` };
  }
  const helperPath = path.join(__dirname, 'switchRestartHelper.js');
  if (!fs.existsSync(helperPath)) {
    return { scheduled: false, error: `重启助手缺失：${helperPath}` };
  }

  const pendingPath = path.join(getSharedStorageDir(), PENDING_FILE);
  fs.writeFileSync(pendingPath, JSON.stringify({ ...plan, createdAt: Date.now() }, null, 2), 'utf8');

  // 用 IDE 自带 Electron 以 Node 模式运行助手（ext host Node 22.13+ 自带 node:sqlite）
  const child = cp.spawn(process.execPath, [helperPath, pendingPath], {
    detached: true,
    stdio: 'ignore',
    windowsHide: true,
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
  });
  const spawnError = await new Promise<Error | null>((resolve) => {
    child.on('error', (err) => resolve(err));
    setTimeout(() => resolve(null), 1500);
  });
  if (spawnError) {
    try { fs.rmSync(pendingPath, { force: true }); } catch { /* 清理失败仅影响下次覆盖写 */ }
    return { scheduled: false, error: `重启助手启动失败：${spawnError.message}` };
  }
  child.unref();
  return { scheduled: true };
}
