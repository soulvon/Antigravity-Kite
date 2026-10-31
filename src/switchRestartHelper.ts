/**
 * 切号重启助手（在 IDE 之外以 ELECTRON_RUN_AS_NODE 模式运行）
 *
 * 职责：优雅关闭 IDE 主进程 → 进程完全退出后干净写入状态库 → 用原 exe+参数重启 IDE。
 * 只依赖 node 内置模块与 out/ideStateDb.js，严禁 import vscode。
 * 无论写库成败都必须重启 IDE，不能把用户晾在关机状态。
 */
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as cp from 'child_process';
import { switchIdeStateIdentity } from './ideStateDb';
import { writeIdeCredentialBlob, syncGeminiAccountFiles } from './winCredential';
import { t } from './i18n';

interface PendingPlan {
  email: string;
  token: {
    accessToken: string;
    refreshToken?: string;
    expiryDateSeconds?: number;
    isGcpTos?: boolean;
    idToken?: string;
  };
  dbPath: string;
  exePath: string;
  launchArgs: string[];
  mainPid: number;
  /** 凭据管理器 blob（身份唯一权威来源，本助手在 IDE 关闭后写入） */
  credential?: { blobBase64: string; user: string };
  /** ~/.gemini 账号文件同步参数 */
  geminiSync?: { email: string; accessToken: string; refreshToken: string; expiryMs: number };
}

const CLOSE_TIMEOUT_MS = 20000;   // 优雅关闭等待上限（参考实现对齐）
const FORCE_TIMEOUT_MS = 5000;    // 强杀后等待上限
const POST_EXIT_SETTLE_MS = 1000; // 退出后等文件句柄/WAL 收尾

/** 助手独立日志：与扩展共用共享目录，前缀 [helper]，便于事后确认关-写-重启每步结果 */
function helperLog(stage: string, detail?: unknown): void {
  try {
    const dir = path.join(process.env.APPDATA || os.homedir(), '.antigravity-kite');
    fs.mkdirSync(dir, { recursive: true });
    const line = `[${new Date().toISOString()}] [INFO] [helper.${stage}]${detail === undefined ? '' : ' ' + JSON.stringify(detail)}`;
    fs.appendFileSync(path.join(dir, 'kite.log'), line + '\n', 'utf8');
  } catch { /* 日志失败不影响关-写-重启主流程 */ }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function pidAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

function run(cmd: string): Promise<string | null> {
  return new Promise((resolve) => {
    try {
      cp.exec(cmd, { encoding: 'utf8', timeout: 15000, windowsHide: true }, (err, stdout) => resolve(err ? null : stdout));
    } catch {
      resolve(null);
    }
  });
}

async function closeIde(pid: number): Promise<void> {
  if (!pidAlive(pid)) return;
  // 优雅关闭：taskkill 不带 /F 会向进程树窗口投递 WM_CLOSE
  await run(`taskkill /PID ${pid} /T`);
  const deadline = Date.now() + CLOSE_TIMEOUT_MS;
  while (Date.now() < deadline && pidAlive(pid)) {
    await sleep(300);
  }
  if (pidAlive(pid)) {
    await run(`taskkill /PID ${pid} /T /F`);
    const forceDeadline = Date.now() + FORCE_TIMEOUT_MS;
    while (Date.now() < forceDeadline && pidAlive(pid)) {
      await sleep(200);
    }
  }
  if (pidAlive(pid)) {
    throw new Error(`IDE 主进程 ${pid} 无法关闭`);
  }
  await sleep(POST_EXIT_SETTLE_MS);
}

async function main(): Promise<void> {
  const pendingPath = process.argv[2];
  if (!pendingPath || !fs.existsSync(pendingPath)) {
    process.exit(0);
    return;
  }
  let plan: PendingPlan | null = null;
  try {
    plan = JSON.parse(fs.readFileSync(pendingPath, 'utf8'));
  } catch {
    plan = null;
  }
  try { fs.rmSync(pendingPath, { force: true }); } catch { /* 已读到内容即可 */ }
  if (!plan || !plan.email || !plan.token || !plan.dbPath || !plan.exePath || !plan.mainPid) {
    process.exit(0);
    return;
  }

  const resultPath = path.join(path.dirname(pendingPath), 'switch-restart-result.json');
  let error: string | undefined;
  let warning: string | undefined;

  // 1) 关闭 IDE（失败即中止：IDE 还在运行时不得写任何状态）
  try {
    await closeIde(plan.mainPid);
    helperLog('ide.closed', { mainPid: plan.mainPid });
  } catch (e) {
    const msg = '关闭 IDE 失败：' + (e instanceof Error ? e.message : String(e));
    helperLog('ide.close.fail', { error: msg });
    try {
      fs.writeFileSync(resultPath, JSON.stringify({ ok: false, error: msg, email: plan.email, finishedAt: Date.now() }, null, 2), 'utf8');
    } catch { /* 结果日志失败不影响主流程 */ }
    process.exit(0);
    return;
  }

  // 2) 凭据管理器（身份唯一权威来源：id_token_email + token）
  if (plan.credential) {
    const cw = await writeIdeCredentialBlob(plan.credential.blobBase64, plan.credential.user);
    helperLog('cred.write', { ok: cw.ok, error: cw.error, email: plan.email });
    if (!cw.ok) {
      error = error ? `${error}；凭据写入失败：${cw.error}` : `凭据写入失败：${cw.error}`;
    }
  } else {
    helperLog('cred.write.skipped', {});
  }

  // 3) 状态库（agent/模型一致性；写失败不阻断凭据，但必须暴露）
  const dbRes = switchIdeStateIdentity(plan.email, plan.token, { dbPath: plan.dbPath });
  helperLog('db.write', { dbWritten: dbRes.dbWritten, error: dbRes.error });
  if (!dbRes.dbWritten) {
    error = error ? `${error}；状态库写入失败：${dbRes.error}` : `状态库写入失败：${dbRes.error}`;
  }

  // 4) agy.exe（IDE 内置 agent 引擎）的账号指针
  const agyAccountFile = process.env.KITE_AGY_ACCOUNT_FILE
    || path.join(os.homedir(), '.gemini', 'antigravity', 'active-account.json');
  try {
    fs.mkdirSync(path.dirname(agyAccountFile), { recursive: true });
    fs.writeFileSync(agyAccountFile, JSON.stringify({ email: plan.email, updatedAt: Date.now() }), 'utf8');
    helperLog('agy.pointer', { ok: true, file: agyAccountFile });
  } catch (e) {
    warning = `agy 账号指针写入失败：${e instanceof Error ? e.message : String(e)}`;
    helperLog('agy.pointer.fail', { error: warning });
  }

  // 5) ~/.gemini 账号文件（google_accounts.json / oauth_creds.json）
  if (plan.geminiSync) {
    const gs = syncGeminiAccountFiles(plan.geminiSync);
    helperLog('gemini.sync', { ok: gs.ok, error: gs.error });
    if (!gs.ok) {
      warning = warning ? `${warning}；${gs.error}` : gs.error;
    }
  }

  const ok = !error;

  // 重启 IDE：必须剥掉 ELECTRON_RUN_AS_NODE，否则拉起来的 IDE 会以 Node 模式启动；
  // 必须等 spawn 事件确认子进程已创建，否则立即 exit 会让重启偶发丢失
  try {
    const env: NodeJS.ProcessEnv = { ...process.env };
    delete env.ELECTRON_RUN_AS_NODE;
    const child = cp.spawn(plan.exePath, plan.launchArgs, {
      detached: true,
      stdio: 'ignore',
      windowsHide: false,
      env,
    });
    const spawned = await new Promise<boolean>((resolve) => {
      child.once('spawn', () => resolve(true));
      child.once('error', () => resolve(false));
    });
    if (!spawned) {
      throw new Error(t('srSpawnFailed'));
    }
    child.unref();
  } catch (e) {
    const msg = `重启 IDE 失败：${e instanceof Error ? e.message : String(e)}`;
    error = error ? `${error}；${msg}` : msg;
  }

  try {
    fs.writeFileSync(resultPath, JSON.stringify({ ok, error, warning, email: plan.email, finishedAt: Date.now() }, null, 2), 'utf8');
  } catch { /* 结果日志失败不影响主流程 */ }
  process.exit(0);
}

if (require.main === module) {
  void main();
}
