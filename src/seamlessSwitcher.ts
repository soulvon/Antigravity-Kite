/**
 * 无感换号服务
 * 通过 Antigravity IDE 内部 API 直接切换账号
 */

import * as vscode from 'vscode';
import { StoredAccount } from './types';
import { ensureFreshToken, refreshAccessToken } from './usageService';
import * as accountStore from './accountStore';
import { createUserStatusPayloadBase64 } from './ideStateDb';
import { t } from './i18n';

const SEAMLESS_TIMEOUT_MS = 8000;
const TOKEN_REFRESH_BUFFER_MS = 5 * 60 * 1000;

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
    UserStatus?: {
      clearUserStatus?(): Promise<void> | Thenable<void>;
    };
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

function shouldRefreshForSwitch(account: StoredAccount): boolean {
  const expiryMs = parseExpiryMs(account.expiresAt);
  if (!expiryMs) {
    return true;
  }
  return expiryMs - Date.now() < TOKEN_REFRESH_BUFFER_MS;
}

export async function prepareSwitchToken(account: StoredAccount): Promise<{ ok: true; token: PreparedSwitchToken } | { ok: false; message: string }> {
  if (!account.refreshToken) {
    return { ok: false, message: t('errNoRefreshToken') };
  }

  const beforeAccessToken = account.accessToken || '';

  // 关键：切号必须「强制刷新」——号池缓存的 AT 可能是其它工具换取、scope 不含
  // agent 所需的 aicode 权限（真机实证：403 ACCESS_TOKEN_SCOPE_INSUFFICIENT 导致
  // agy 进程 process_exit_nonzero 崩溃）。用 RT 现场刷新出的 AT 才带正确授权范围。
  // 刷新失败宁可取消切号，也不能写入权限不足的 token 把 agent 后端搞崩。
  let refreshedToken: Awaited<ReturnType<typeof refreshAccessToken>> = null;
  try {
    refreshedToken = await refreshAccessToken(account.refreshToken);
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

  const newExpiry = new Date(Date.now() + 3600000).toISOString();
  const updates: Partial<StoredAccount> = { accessToken: refreshedToken.accessToken, expiresAt: newExpiry };
  if (refreshedToken.idToken) updates.idToken = refreshedToken.idToken;
  accountStore.update(account.email, updates);

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
export async function seamlessSwitch(account: StoredAccount): Promise<SwitchResult> {
  const api = vscode as unknown as AntigravityVsCodeApi;
  const hasUnified = !!(api.antigravityUnifiedStateSync?.OAuthPreferences);
  const hasLegacy = !!(api.antigravityAuth);
  console.log(`[SeamlessSwitcher] API probe: unified=${hasUnified}, legacy=${hasLegacy}`);

  const tokenApi = getTokenApi();
  
  if (!tokenApi) {
    console.warn('[SeamlessSwitcher] No token API found on vscode namespace');
    return {
      success: false,
      email: account.email,
      message: `无感换号不可用：宿主未暴露 OAuthPreferences API（unified=${hasUnified}, legacy=${hasLegacy}）`
    };
  }

  const prepared = await prepareSwitchToken(account);
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
    await withTimeout(
      Promise.resolve(tokenApi.setOAuthTokenInfo(tokenInfo)),
      SEAMLESS_TIMEOUT_MS,
      'setOAuthTokenInfo'
    );
    console.log('[SeamlessSwitcher] setOAuthTokenInfo succeeded');

    // 验证写入
    if (typeof tokenApi.getOAuthTokenInfo === 'function') {
      try {
        const applied = await withTimeout(
          Promise.resolve(tokenApi.getOAuthTokenInfo()),
          SEAMLESS_TIMEOUT_MS,
          'getOAuthTokenInfo'
        );
        const readEmail = applied?.accessToken ? applied.accessToken.substring(0, 20) + '...' : 'null';
        const accessTokenMatched = applied?.accessToken === prepared.token.accessToken;
        const refreshTokenMatched = !applied?.refreshToken || applied.refreshToken === prepared.token.refreshToken;
        console.log(`[SeamlessSwitcher] Readback: token=${readEmail}, accessTokenMatch=${accessTokenMatched}, refreshTokenMatch=${refreshTokenMatched}`);
        if (applied && !accessTokenMatched) {
          return {
            success: false,
            email: account.email,
            message: t('errSwitchReadback')
          };
        }
      } catch (e) {
        console.warn('[SeamlessSwitcher] Token readback failed:', e);
      }
    }

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

/**
 * 登出语义：清空宿主 token 与身份（触发 session 移除与模型列表等缓存重置）
 */
export async function clearHostAuth(): Promise<void> {
  const api = (vscode as unknown as AntigravityVsCodeApi);
  const tokenApi = getTokenApi();
  if (tokenApi) {
    await Promise.resolve(tokenApi.setOAuthTokenInfo(null));
  }
  const userStatus = api.antigravityUnifiedStateSync?.UserStatus;
  if (userStatus && typeof userStatus.clearUserStatus === 'function') {
    await Promise.resolve(userStatus.clearUserStatus());
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

  await uss.pushUpdate({
    topicName: 'uss-userStatus',
    appliedUpdate: {
      key: 'userStatusSentinelKey',
      newRow: {
        value: createUserStatusPayloadBase64(email),
        eTag: 0,
      },
    },
  });

  // 读回校验（内置 getUserStatus 直读总线），失败必须暴露
  if (typeof uss.getUserStatus === 'function') {
    await new Promise((r) => setTimeout(r, 300));
    let current = '';
    try {
      current = (await uss.getUserStatus()) || '';
    } catch (e) {
      return { ok: false, error: `身份推送后读回失败：${e instanceof Error ? e.message : String(e)}` };
    }
    // 读回值无论是否一致都记录，作为总线是否真正接收的证据
    console.log('[Kite] 身份总线读回:', JSON.stringify({ expect: email, actual: current }));
    if (current && current !== email) {
      return { ok: false, error: `身份推送读回不一致：期望 ${email}，实际 ${current}` };
    }
  }
  return { ok: true };
}
