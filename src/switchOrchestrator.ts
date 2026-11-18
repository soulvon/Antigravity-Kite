/**
 * 切号与 Remote SSH 认证同步编排器
 *
 * 完整流水线：
 * - CDP 门控 → Phase A（OAuth/缓存复用 + agy 预热 + Win32 凭据预读并发）
 * - Windows 凭据写入与加密备份（credential-backup.json 对 access_token/refresh_token 使用 AES-256-GCM 加密）
 * - IDE state.vscdb 写入 + agy active-account 指针 + ~/.gemini 原子同步
 * - Phase B（seamlessSwitch + agy 引擎热重载 + Remote SSH 远端登录态同步并发）
 * - uss-userStatus 实时推送 + 弹窗守护主动补扫
 */
import * as path from 'path';
import * as vscode from 'vscode';
import * as accountStore from './accountStore';
import { atomicWriteJsonSync } from './atomicFile';
import { encryptSecret } from './accountCrypto';
import { ensureCdpGate } from './cdpGate';
import { pokeGuard } from './declarationSuppressor';
import { readActiveAccount, syncGeminiLocalCreds, writeAgyActiveAccount } from './geminiFiles';
import { t } from './i18n';
import * as ideRuntime from './ideRuntime';
import { resolveIdeStateDbPathFromUserData, switchIdeStateIdentity } from './ideStateDb';
import { logError, logInfo, logWarn } from './logger';
import {
  applyRemoteAuthRefresh,
  isRemoteAuthSyncEnabled,
  isSupportedRemoteSession,
  RemoteSyncResult,
  RemoteTokenPreviousState,
  resolveRemoteAuthority,
  resolveRemoteHomeDir,
  syncCredentialToRemote,
} from './remoteAuthSync';
import { prepareSwitchToken, pushLiveIdentityUpdate, seamlessSwitch } from './seamlessSwitcher';
import { getSharedStorageDir } from './storage';
import { notifyUi } from './uiChannel';
import { describeError } from './usageService';
import { UsageTracker } from './usageTracker';
import {
  buildIdeCredentialBlob,
  IdeCredential,
  readIdeCredential,
  swapIdeCredential,
} from './winCredential';

const REMOTE_TOKEN_REFRESH_BUFFER_MS = 5 * 60 * 1000;

let switchInFlight = false;
const pendingRemoteRefreshTimers = new Set<NodeJS.Timeout>();

export interface SwitchAccountDeps {
  usageTracker: UsageTracker;
  refreshAfterSwitch: (email: string) => void;
  pushAccounts: () => void;
  postMessage: (msg: unknown) => void;
  onLogPanelUpdate: () => void;
}

/** 清理挂起的远端刷新定时器（供扩展停用时调用） */
export function disposeSwitchOrchestrator(): void {
  for (const timer of pendingRemoteRefreshTimers) {
    clearTimeout(timer);
  }
  pendingRemoteRefreshTimers.clear();
}

/**
 * 解析当前本地激活账号的有效 IdeCredential（供 Remote SSH 启动自动同步复用）。
 * Windows 优先直读 CredMan `gemini:antigravity`（兼容尚未导入号池的官方登录态）；
 * 若 AT 临期或非 Windows 环境，则通过 accountStore + prepareSwitchToken 刷新构造。
 */
async function resolveLocalCredentialForRemoteSync(
  context: vscode.ExtensionContext,
): Promise<IdeCredential | null> {
  let writerId = '';
  let authMethod = 'consumer';
  let candidateEmail = '';

  if (process.platform === 'win32') {
    const localCred = await readIdeCredential();
    if (localCred.ok && localCred.parsed?.id_token_email) {
      const parsed = localCred.parsed;
      writerId = parsed.writer_id || '';
      authMethod = parsed.auth_method || 'consumer';
      candidateEmail = parsed.id_token_email;
      const expMs = Date.parse(parsed.token?.expiry || '');
      const credFresh = Boolean(parsed.token?.access_token)
        && Number.isFinite(expMs)
        && expMs > Date.now() + REMOTE_TOKEN_REFRESH_BUFFER_MS;
      if (credFresh && parsed.token?.refresh_token) {
        return parsed;
      }
      // 尚未导入 Kite 号池但本地凭据仍含有效 AT/RT：直接透传，让远端 agy 自行用 RT 续期
      if (!accountStore.getByEmail(candidateEmail) && (parsed.token?.access_token || parsed.token?.refresh_token)) {
        return parsed;
      }
    }
  }

  if (!candidateEmail) {
    candidateEmail = context.globalState.get<string>('currentEmail') || readActiveAccount();
  }
  if (!candidateEmail) return null;

  const account = accountStore.getByEmail(candidateEmail);
  if (!account) return null;

  const prepared = await prepareSwitchToken(account);
  if (!prepared.ok) {
    logWarn('remote.sync.prepare-local-fail', { email: account.email, error: prepared.message });
    return null;
  }

  const expiryMs = prepared.token.expiryDateSeconds > Math.floor(Date.now() / 1000)
    ? prepared.token.expiryDateSeconds * 1000
    : Date.now() + 3600_000;

  return buildIdeCredentialBlob({
    email: account.email,
    accessToken: prepared.token.accessToken,
    refreshToken: prepared.token.refreshToken,
    expiryMs,
    authMethod,
    writerId,
  }).parsed;
}

/** 将指定 IdeCredential 写入当前 Remote SSH 窗口对应的远端 ~/.gemini/jetski-standalone-oauth-token */
async function syncCredentialForRemoteSession(
  context: vscode.ExtensionContext,
  credential: IdeCredential,
  isExplicitSwitch: boolean,
): Promise<{ result: RemoteSyncResult; authority?: string }> {
  const authority = await resolveRemoteAuthority({ logUriFsPath: context.logUri?.fsPath });
  if (!authority) {
    return { result: { ok: false, wrote: false, error: t('remoteSyncNoAuthority') } };
  }
  const homeRes = await resolveRemoteHomeDir(authority, undefined, { logUriFsPath: context.logUri?.fsPath });
  if (!homeRes.ok || !homeRes.homeDir) {
    return { authority, result: { ok: false, wrote: false, error: homeRes.error || t('ui.unknown') } };
  }
  const res = await syncCredentialToRemote(homeRes.homeDir, authority, credential, {
    forceOverwrite: isExplicitSwitch,
  });
  return { authority, result: res };
}

/** Remote SSH 窗口激活后：若远端缺登录态或与本地激活账号不一致，则自动同步并唤醒右侧官方面板 */
export async function syncStartupAuthToRemote(context: vscode.ExtensionContext): Promise<void> {
  if (!isSupportedRemoteSession() || !isRemoteAuthSyncEnabled()) return;

  try {
    let authority = await resolveRemoteAuthority({ logUriFsPath: context.logUri?.fsPath });
    if (!authority) {
      await new Promise((r) => setTimeout(r, 2500));
      authority = await resolveRemoteAuthority({ logUriFsPath: context.logUri?.fsPath });
    }
    if (!authority) {
      logWarn('remote.sync.startup.no-authority', { remoteName: vscode.env.remoteName });
      return;
    }

    const cred = await resolveLocalCredentialForRemoteSync(context);
    if (!cred) {
      logInfo('remote.sync.startup.no-local-auth', {});
      return;
    }

    const { result } = await syncCredentialForRemoteSession(context, cred, false);
    if (!result.ok) {
      logWarn('remote.sync.startup.fail', { email: cred.id_token_email, error: result.error });
      return;
    }
    if (!result.wrote) {
      logInfo('remote.sync.startup.skip', { email: cred.id_token_email, reason: result.reason });
      return;
    }

    const refresh = await applyRemoteAuthRefresh(context, {
      previousState: result.previousState,
      email: cred.id_token_email,
      authority,
      isExplicitSwitch: false,
    });
    if (refresh.mode === 'reconnect') {
      notifyUi('success', t('remoteSyncStartupDone', cred.id_token_email));
    }
  } catch (e) {
    logWarn('remote.sync.startup.unexpected', e);
  }
}

/**
 * 执行完整账号热切换。
 * 并发防连点保护，失败必须暴露 toast 与日志，绝不静默。
 */
export async function switchAccount(
  context: vscode.ExtensionContext,
  email: string,
  deps: SwitchAccountDeps,
): Promise<void> {
  const account = accountStore.getByEmail(email);
  if (!account) {
    logWarn('switch.accountNotFound', { email });
    deps.postMessage({ type: 'switchResult', ok: false });
    return;
  }

  if (switchInFlight) {
    logWarn('switch.skip.inflight', { email: account.email });
    return;
  }
  switchInFlight = true;
  logInfo('switch.start', { email: account.email });

  try {
    // CDP 门控：首次切号探测调试端口；未开启则一次性引导（改快捷方式 + 重启）。
    // 'relaunching' = IDE 正在重启，中止本次切号；ready/manual 均照常执行。
    const gate = await ensureCdpGate(context);
    logInfo('switch.gate', { result: gate });
    if (gate === 'relaunching') {
      deps.postMessage({ type: 'switchResult', ok: false });
      return;
    }

    // Phase A：并发准备 token、预热原生 agy 重载器，并在 Windows 下并发预读旧凭据
    const [prepared, , preReadCred] = await Promise.all([
      prepareSwitchToken(account),
      ideRuntime.prepareAgyReload(),
      process.platform === 'win32'
        ? readIdeCredential()
        : Promise.resolve(undefined),
    ]);
    if (!prepared.ok) {
      logWarn('switch.token.fail', { email: account.email, message: prepared.message });
      deps.postMessage({ type: 'toast', status: 'error', message: t('switchCancelled', prepared.message) });
      deps.postMessage({ type: 'switchResult', ok: false });
      return;
    }

    const switchToken = {
      accessToken: prepared.token.accessToken,
      refreshToken: prepared.token.refreshToken,
      expiryDateSeconds: prepared.token.expiryDateSeconds,
      isGcpTos: false,
      idToken: prepared.token.idToken,
    };
    logInfo('switch.token', {
      source: prepared.token.refreshed ? 'refreshed' : 'kite-cache',
      prepareOk: true,
    });

    const expiryMs = switchToken.expiryDateSeconds > Math.floor(Date.now() / 1000)
      ? switchToken.expiryDateSeconds * 1000
      : Date.now() + 3600000;

    // 本地凭据与远端 ~/.gemini/jetski-standalone-oauth-token 共用同一结构，提前统一构造
    const targetCred = buildIdeCredentialBlob({
      email: account.email,
      accessToken: switchToken.accessToken,
      refreshToken: switchToken.refreshToken,
      expiryMs,
      authMethod: preReadCred?.parsed?.auth_method,
      writerId: preReadCred?.parsed?.writer_id,
    });

    // 1) Windows 凭据管理器写入 + 加密备份旧凭据
    if (process.platform === 'win32') {
      logInfo('switch.cred.build', { email: account.email, expiryMs });
      const cw = await swapIdeCredential(targetCred.blobBase64, 'antigravity', undefined, preReadCred);
      logInfo('switch.hot.cred', { ok: cw.ok, error: cw.error });
      if (!cw.ok) {
        deps.postMessage({ type: 'toast', status: 'error', message: t('switchCredFail', cw.error || t('ui.unknown')) });
        deps.postMessage({ type: 'switchResult', ok: false });
        return;
      }
      if (cw.previous) {
        try {
          const backupPath = path.join(getSharedStorageDir(), 'credential-backup.json');
          const encryptedBlob: IdeCredential = {
            ...cw.previous,
            token: {
              ...cw.previous.token,
              access_token: encryptSecret(cw.previous.token?.access_token || ''),
              refresh_token: encryptSecret(cw.previous.token?.refresh_token || ''),
            },
          };
          atomicWriteJsonSync(backupPath, {
            savedAt: Date.now(),
            user: cw.previousUser,
            blob: encryptedBlob,
          }, 0o600);
          logInfo('switch.cred.backup', { path: backupPath, prevEmail: cw.previous.id_token_email });
        } catch (e) {
          logWarn('switch.cred.backup.write', e);
        }
      } else {
        logWarn('switch.cred.backup.unavailable', { reason: 'previous blob missing' });
      }
    } else {
      logInfo('switch.hot.cred.skip', { platform: process.platform });
    }

    // 2) 状态库（agent/模型一致性）
    const userDataDir = path.resolve(context.globalStorageUri.fsPath, '..', '..', '..');
    const dbRes = switchIdeStateIdentity(account.email, {
      accessToken: switchToken.accessToken,
      refreshToken: switchToken.refreshToken,
      expiryDateSeconds: switchToken.expiryDateSeconds,
      isGcpTos: false,
      idToken: switchToken.idToken,
    }, { dbPath: resolveIdeStateDbPathFromUserData(userDataDir) });
    logInfo('switch.hot.db', { dbWritten: dbRes.dbWritten, error: dbRes.error });

    // 3) agy 指针 + ~/.gemini 凭据文件（受 switch.syncGeminiFiles 控制，原子写入）
    const agyPtr = writeAgyActiveAccount(account.email);
    let geminiLocal: { ok: boolean; error?: string } = { ok: true };
    if (vscode.workspace.getConfiguration('antigravityKite').get<boolean>('switch.syncGeminiFiles', true)) {
      geminiLocal = syncGeminiLocalCreds({
        email: account.email,
        accessToken: switchToken.accessToken,
        refreshToken: switchToken.refreshToken,
        expiryMs,
      });
    } else {
      geminiLocal = { ok: true, error: 'skipped (setting off)' };
    }
    logInfo('switch.hot.files', { agyPtr: agyPtr.ok, gemini: geminiLocal.ok, error: agyPtr.error || geminiLocal.error });

    // 4) Phase B：会话层 token 热切、agent 引擎重载与 Remote SSH 远端登录态同步并行推进
    const shouldSyncRemote = isSupportedRemoteSession() && isRemoteAuthSyncEnabled();
    const [hot, agyReload, remoteSync] = await Promise.all([
      seamlessSwitch(account, prepared.token),
      ideRuntime.killAgyEngine(),
      shouldSyncRemote
        ? syncCredentialForRemoteSession(context, targetCred.parsed, true)
        : Promise.resolve(null),
    ]);
    logInfo('switch.hot.session', { success: hot.success, message: hot.message });
    logInfo('switch.hot.agyReload', {
      killed: agyReload.killed,
      agyWasRunning: agyReload.agyWasRunning,
      remoteSkipped: agyReload.remoteSkipped,
      error: agyReload.error,
    });
    if (remoteSync) {
      logInfo('switch.hot.remoteSync', remoteSync.result);
    }

    // 5) 总线身份推送（依赖会话层已写入）
    const identity = await pushLiveIdentityUpdate(account.email);
    logInfo('switch.hot.identity', { ok: identity.ok, error: identity.error });

    // 5.5) 弹窗守护立即补扫：agy 重建/换端口后的新表面马上进守护
    pokeGuard();

    await context.globalState.update('currentEmail', account.email);
    deps.usageTracker.recordSwitch(account.email);
    deps.pushAccounts();
    deps.postMessage({ type: 'switchResult', ok: true });
    deps.onLogPanelUpdate();
    deps.refreshAfterSwitch(account.email);

    const notes: string[] = [];
    let degraded = false;
    let pendingRemoteRefresh: { previousState?: RemoteTokenPreviousState; email: string; authority: string } | null = null;
    if (!agyPtr.ok) { notes.push(t('switchAgyPtrFail', agyPtr.error || '')); degraded = true; }
    if (!geminiLocal.ok && geminiLocal.error) { notes.push(t('switchGeminiFail', geminiLocal.error)); degraded = true; }
    if (agyReload.error) { notes.push(agyReload.error); degraded = true; }
    else if (remoteSync) {
      if (!remoteSync.result.ok) {
        notes.push(t('remoteSyncFail', remoteSync.result.error || t('ui.unknown')));
        degraded = true;
      } else if (remoteSync.result.wrote && remoteSync.authority) {
        pendingRemoteRefresh = {
          previousState: remoteSync.result.previousState,
          email: account.email,
          authority: remoteSync.authority,
        };
        notes.push(t('remoteSyncDone', account.email));
      } else {
        notes.push(t('remoteSyncAligned', account.email));
      }
    } else if (agyReload.remoteSkipped) {
      notes.push(t('agyReloadRemoteNote', account.email));
      degraded = true;
    }
    if (hot.success && !identity.ok) { notes.push(t('switchMenuAlignLater')); degraded = true; }
    if (notes.length === 0) {
      notes.push(t('switchDone', account.email));
    }
    deps.postMessage({
      type: 'toast',
      status: degraded ? 'warning' : 'success',
      message: notes.join('；'),
    });

    if (pendingRemoteRefresh) {
      const refOpts = pendingRemoteRefresh;
      const timer = setTimeout(() => {
        pendingRemoteRefreshTimers.delete(timer);
        void applyRemoteAuthRefresh(context, { ...refOpts, isExplicitSwitch: true });
      }, 150);
      pendingRemoteRefreshTimers.add(timer);
    }
  } catch (err) {
    const errMsg = describeError(err);
    logError('switch.unexpected', { email: account.email, error: errMsg });
    deps.postMessage({ type: 'toast', status: 'error', message: t('switchCancelled', errMsg) });
    deps.postMessage({ type: 'switchResult', ok: false });
  } finally {
    switchInFlight = false;
  }
}
