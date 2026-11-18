/**
 * 无感换号服务
 * 通过 Antigravity IDE 内部 API 直接切换账号
 */

import * as vscode from 'vscode';
import { StoredAccount } from './types';
import { computeTokenFingerprint, refreshGoogleAccessToken } from './googleOAuth';
import * as accountStore from './accountStore';
import { createUserStatusPayloadBase64 } from './ideStateDb';
import { t } from './i18n';
import { logInfo, logWarn } from './logger';

const SEAMLESS_TIMEOUT_MS = 8000;
const VERIFIED_TOKEN_MIN_REMAINING_MS = 15 * 60 * 1000;
const VERIFIED_TOKEN_MAX_AGE_MS = 45 * 60 * 1000;

interface OAuthTokenInfoPayload {
  accessToken: string;
  refreshToken: string;
  expiryDateSeconds: number;
  tokenType: string;
  isGcpTos: boolean;
}

interface OAuthPreferencesApi {
  getOAuthTokenInfo?(): Promise<OAuthTokenInfoPayload | null>;
  setOAuthTokenInfo(tokenInfo: OAuthTokenInfoPayload | null): Promise<void>;
}

interface AntigravityVsCodeApi {
  antigravityUnifiedStateSync?: {
    OAuthPreferences?: OAuthPreferencesApi;
  };
  antigravityAuth?: OAuthPreferencesApi;
}

/** 本次切号已落定的 token，供状态库持久化直接复用（不依赖宿主读回 API） */
export interface SwitchToken {
  accessToken: string;
  refreshToken?: string;
  expiryDateSeconds?: number;
  isGcpTos?: boolean;
  idToken?: string;
}

export interface SwitchResult {
  success: boolean;
  email?: string;
  message?: string;
  token?: SwitchToken;
}

interface PreparedSwitchToken {
  accessToken: string;
  refreshToken: string;
  expiryDateSeconds: number;
  refreshed: boolean;
  idToken?: string;
}

/**
 * 获取可用的 Token API
 */
function getTokenApi(): OAuthPreferencesApi | null {
  const api = vscode as unknown as AntigravityVsCodeApi;
  
  // 优先使用新版 API
  const unified = api.antigravityUnifiedStateSync?.OAuthPreferences;
  if (unified && typeof unified.setOAuthTokenInfo === 'function') {
    return unified;
  }
  
  // 回退到旧版 API
  const legacy = api.antigravityAuth;
  if (legacy && typeof legacy.setOAuthTokenInfo === 'function') {
    return legacy;
  }
  
  return null;
}

/**
 * 检查无感换号是否可用
 */
export function isSeamlessSwitchAvailable(): boolean {
  return getTokenApi() !== null;
}

/**
 * 带超时的 Promise
 */
async function withTimeout<T>(promise: Promise<T>, timeoutMs: number, stage: string): Promise<T> {
  let timeoutId: ReturnType<typeof setTimeout> | undefined;
  const timeoutPromise = new Promise<never>((_, reject) => {
    timeoutId = setTimeout(() => {
      reject(new Error(t('ssTimeout', stage)));
    }, timeoutMs);
  });

  try {
    return await Promise.race([promise, timeoutPromise]);
  } finally {
    if (timeoutId) {
      clearTimeout(timeoutId);
    }
  }
}

function parseExpiryMs(expiresAt?: string): number | null {
  if (!expiresAt) {
    return null;
  }
  const expiryMs = Date.parse(expiresAt);
  return Number.isNaN(expiryMs) ? null : expiryMs;
}

/**
 * 判断是否可安全复用本地 accessToken（省去 ~1s Google OAuth 往返）。
 * 严格五重守卫：必须有 RT + AT、未被封/失效、SHA256 指纹与 Kite 刷出记录精确一致（防外部低 scope token 混入）、
 * 距校验不超过 45 分钟、且距过期仍有 >15 分钟余量。
 */
export function canReuseVerifiedSwitchToken(account: StoredAccount, nowMs = Date.now()): boolean {
  if (!account.accessToken || !account.refreshToken || !account.verifiedAtHash || !account.verifiedAt) {
    return false;
  }
  const health = account.health?.status;
  if (health === 'auth_invalid' || health === 'banned') {
    return false;
  }
  if (computeTokenFingerprint(account.accessToken) !== account.verifiedAtHash) {
    return false;
  }
  if (nowMs - account.verifiedAt >= VERIFIED_TOKEN_MAX_AGE_MS || nowMs < account.verifiedAt) {
    return false;
  }
  const expiryMs = parseExpiryMs(account.expiresAt);
  if (!expiryMs || expiryMs - nowMs <= VERIFIED_TOKEN_MIN_REMAINING_MS) {
    return false;
  }
  return true;
}

export async function prepareSwitchToken(account: StoredAccount): Promise<{ ok: true; token: PreparedSwitchToken } | { ok: false; message: string }> {
  if (!account.refreshToken) {
    return { ok: false, message: t('errNoRefreshToken') };
  }

  // 快路径：刚由 Kite 自身用 RT 刷出且仍在充裕有效期内的 AT，直接零网络复用
  if (canReuseVerifiedSwitchToken(account)) {
    const expiryMs = parseExpiryMs(account.expiresAt)!;
    return {
      ok: true,
      token: {
        accessToken: account.accessToken,
        refreshToken: account.refreshToken,
        expiryDateSeconds: Math.floor(expiryMs / 1000),
        refreshed: false,
        idToken: account.idToken,
      },
    };
  }

  const beforeAccessToken = account.accessToken || '';

  // 首次/外部导入/临期时仍必须用 RT 现场刷新：号池缓存 AT 的 scope 可能不含 aicode 权限，
  // 写入会导致 agy 403 ACCESS_TOKEN_SCOPE_INSUFFICIENT 后崩溃。用 RT 现场刷新出的 AT 才带正确授权范围。
  // 刷新失败宁可取消切号，也不能写入权限不足的 token 把 agent 后端搞崩。
  let refreshedToken: Awaited<ReturnType<typeof refreshGoogleAccessToken>> = null;
  try {
    refreshedToken = await refreshGoogleAccessToken(account.refreshToken);
  } catch (error) {
    const err = error instanceof Error ? error.message : String(error);
    return { ok: false, message: t('errTokenRefreshFailed', err) };
  }
  if (!refreshedToken || !refreshedToken.accessToken) {
    return {
      ok: false,
      message: t('errTokenRefreshCancelled'),
    };
  }

  const expiresSec = typeof refreshedToken.expiresIn === 'number' && refreshedToken.expiresIn > 0
    ? refreshedToken.expiresIn
    : 3600;
  const newExpiry = new Date(Date.now() + expiresSec * 1000).toISOString();
  const now = Date.now();
  const fingerprint = computeTokenFingerprint(refreshedToken.accessToken);
  const updates: Partial<StoredAccount> = {
    accessToken: refreshedToken.accessToken,
    expiresAt: newExpiry,
    verifiedAtHash: fingerprint,
    verifiedAt: now,
  };
  if (refreshedToken.idToken) updates.idToken = refreshedToken.idToken;
  if (!accountStore.update(account.email, updates)) {
    logWarn('seamless.accountUpdate.fail', { email: account.email });
  }

  const latestAccount = accountStore.getByEmail(account.email) || account;
  const expiryMs = parseExpiryMs(latestAccount.expiresAt || newExpiry);
  if (!expiryMs) {
    return {
      ok: false,
      message: t('errTokenExpiryInvalid'),
    };
  }

  return {
    ok: true,
    token: {
      accessToken: refreshedToken.accessToken,
      refreshToken: account.refreshToken,
      expiryDateSeconds: Math.floor(expiryMs / 1000),
      refreshed: refreshedToken.accessToken !== beforeAccessToken,
      idToken: refreshedToken.idToken || latestAccount.idToken || account.idToken,
    },
  };
}

/**
 * 执行无感换号
 */
export async function seamlessSwitch(account: StoredAccount, preparedExternal?: PreparedSwitchToken): Promise<SwitchResult> {
  const api = vscode as unknown as AntigravityVsCodeApi;
  const hasUnified = !!(api.antigravityUnifiedStateSync?.OAuthPreferences);
  const hasLegacy = !!(api.antigravityAuth);
  console.log(`[SeamlessSwitcher] API probe: unified=${hasUnified}, legacy=${hasLegacy}`);

  const tokenApi = getTokenApi();
  
  if (!tokenApi) {
    logWarn('seamless.noTokenApi', { hasUnified, legacy: hasLegacy });
    return {
      success: false,
      email: account.email,
      message: t('ssUnavailable', String(hasUnified), String(hasLegacy))
    };
  }

  // 2026-11-16 实测：切号链路外层已强制刷新过 token（switch.token），这里再刷一次
  // 等于每次切号双倍网络往返（hot.session 中位 3.7s 的一半来自重复刷新）。
  // 外部传入已落定的 token 时直接复用；仅在独立调用（无外部准备）时才自行刷新。
  const prepared = preparedExternal
    ? { ok: true as const, token: preparedExternal }
    : await prepareSwitchToken(account);
  if (!prepared.ok) {
    return {
      success: false,
      email: account.email,
      message: prepared.message
    };
  }

  const tokenInfo: OAuthTokenInfoPayload = {
    accessToken: prepared.token.accessToken,
    refreshToken: prepared.token.refreshToken,
    expiryDateSeconds: prepared.token.expiryDateSeconds,
    tokenType: 'Bearer',
    isGcpTos: false
  };

  console.log(`[SeamlessSwitcher] Injecting token for ${account.email}, refreshed=${prepared.token.refreshed}, expiry=${new Date(prepared.token.expiryDateSeconds * 1000).toISOString()}`);

  try {
    // 写入 token
    const setStart = Date.now();
    await withTimeout(
      Promise.resolve(tokenApi.setOAuthTokenInfo(tokenInfo)),
      SEAMLESS_TIMEOUT_MS,
      'setOAuthTokenInfo'
    );
    const setTokenMs = Date.now() - setStart;
    console.log(`[SeamlessSwitcher] setOAuthTokenInfo succeeded in ${setTokenMs}ms`);

    // 验证写入
    let readbackMs = -1;
    if (typeof tokenApi.getOAuthTokenInfo === 'function') {
      try {
        const readStart = Date.now();
        const applied = await withTimeout(
          Promise.resolve(tokenApi.getOAuthTokenInfo()),
          SEAMLESS_TIMEOUT_MS,
          'getOAuthTokenInfo'
        );
        readbackMs = Date.now() - readStart;
        const readFp = applied?.accessToken ? `fp:${computeTokenFingerprint(applied.accessToken).slice(0, 8)}` : 'null';
        const accessTokenMatched = applied?.accessToken === prepared.token.accessToken;
        const refreshTokenMatched = !applied?.refreshToken || applied.refreshToken === prepared.token.refreshToken;
        console.log(`[SeamlessSwitcher] Readback: token=${readFp}, accessTokenMatch=${accessTokenMatched}, refreshTokenMatch=${refreshTokenMatched}`);
        if (applied && !accessTokenMatched) {
          return {
            success: false,
            email: account.email,
            message: t('errSwitchReadback')
          };
        }
      } catch (e) {
        logWarn('seamless.readback.fail', { error: e instanceof Error ? e.message : String(e) });
      }
    }

    // 分段计时落盘：下一次切号即可看出 setOAuthTokenInfo / 读回各占多久
    logInfo('seamless.setToken', { setTokenMs, readbackMs, reusedPrepared: !!preparedExternal });
    return {
      success: true,
      email: account.email,
      message: t('switchSuccessMsg'),
      token: {
        accessToken: prepared.token.accessToken,
        refreshToken: prepared.token.refreshToken,
        expiryDateSeconds: prepared.token.expiryDateSeconds,
        isGcpTos: false,
        idToken: prepared.token.idToken
      }
    };
  } catch (error) {
    const err = error instanceof Error ? error.message : String(error);
    console.error(`[SeamlessSwitcher] Switch failed: ${err}`);
    return {
      success: false,
      email: account.email,
      message: err
    };
  }
}

interface UssSyncApi {
  pushUpdate?: (update: unknown) => Promise<void>;
  getUserStatus?: () => Promise<string>;
  subscribe?: (topic: string) => Promise<{ getState: () => Record<string, { value: string; eTag?: number }> }>;
}

/**
 * 运行中实时推送身份到 uss-userStatus（state-sync 总线）。
 *
 * workbench 的 userStatusService 实时订阅该 topic（账号菜单/头像/名字由此驱动），
 * 重建的 agy.exe 也从这里拿身份——这是「不重启切身份」的官方机制：
 * antigravityUnifiedStateSync.pushUpdate 就是官方 setOAuthTokenInfo/clearUserStatus
 * 背后的通用写入通道（逆向自 workbench.desktop.main.js / extensionHostProcess.js）。
 * newRow.value 为 Row 的 base64 protobuf，与 state.vscdb 中的行同构。
 */
export async function pushLiveIdentityUpdate(email: string): Promise<{ ok: boolean; error?: string }> {
  const uss = (vscode as unknown as { antigravityUnifiedStateSync?: UssSyncApi }).antigravityUnifiedStateSync;
  if (!uss || typeof uss.pushUpdate !== 'function') {
    return { ok: false, error: t('errNoPushUpdate') };
  }

  try {
    await withTimeout(
      Promise.resolve(
        uss.pushUpdate({
          topicName: 'uss-userStatus',
          appliedUpdate: {
            key: 'userStatusSentinelKey',
            newRow: {
              value: createUserStatusPayloadBase64(email),
              eTag: 0,
            },
          },
        }),
      ),
      3000,
      'pushUpdate',
    );
  } catch (e) {
    return { ok: false, error: t('ssPushFailed', e instanceof Error ? e.message : String(e)) };
  }

  // 读回校验（内置 getUserStatus 直读总线；50ms 短轮询最多 300ms），失败必须暴露
  if (typeof uss.getUserStatus === 'function') {
    let current = '';
    try {
      for (let i = 0; i < 6; i++) {
        await new Promise((r) => setTimeout(r, 50));
        current = (await withTimeout(Promise.resolve(uss.getUserStatus()), 1500, 'getUserStatus')) || '';
        if (current === email) break;
      }
    } catch (e) {
      return { ok: false, error: t('ssReadbackFailed', e instanceof Error ? e.message : String(e)) };
    }
    // 读回值无论是否一致都记录，作为总线是否真正接收的证据
    logInfo('seamless.identityReadback', { expect: email, actual: current });
    if (current && current !== email) {
      return { ok: false, error: t('ssReadbackMismatch', email, current) };
    }
  }
  return { ok: true };
}
