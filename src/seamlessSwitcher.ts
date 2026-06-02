/**
 * 无感换号服务
 * 通过 Antigravity IDE 内部 API 直接切换账号
 */

import * as vscode from 'vscode';
import { StoredAccount } from './types';
import { ensureFreshToken } from './usageService';

const SEAMLESS_TIMEOUT_MS = 8000;

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

export interface SwitchResult {
  success: boolean;
  email?: string;
  message?: string;
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
      reject(new Error(`无感切号超时：${stage}`));
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

  // 验证必要字段
  if (!account.accessToken && !account.refreshToken) {
    return {
      success: false,
      email: account.email,
      message: '缺少 accessToken 和 refreshToken'
    };
  }

  if (!account.refreshToken) {
    return {
      success: false,
      email: account.email,
      message: '缺少 refreshToken'
    };
  }

  // 切号前先确保 token 有效（对齐 cockpit 的 getAccessTokenStatusForAccount 流程）
  let freshAccessToken: string;
  let tokenWasRefreshed = false;
  try {
    freshAccessToken = await ensureFreshToken(account);
    tokenWasRefreshed = freshAccessToken !== account.accessToken;
  } catch {
    freshAccessToken = account.accessToken;
  }

  if (!freshAccessToken) {
    return {
      success: false,
      email: account.email,
      message: 'accessToken 无效且刷新失败'
    };
  }

  // 过期时间：如果 token 被刷新了，用 1 小时后；否则用存储的
  let expiryDateSeconds: number;
  if (tokenWasRefreshed) {
    expiryDateSeconds = Math.floor((Date.now() + 3600 * 1000) / 1000);
  } else if (account.expiresAt) {
    const expiryMs = Date.parse(account.expiresAt);
    expiryDateSeconds = Number.isNaN(expiryMs)
      ? Math.floor((Date.now() + 3600 * 1000) / 1000)
      : Math.floor(expiryMs / 1000);
  } else {
    expiryDateSeconds = Math.floor((Date.now() + 3600 * 1000) / 1000);
  }

  const tokenInfo: OAuthTokenInfoPayload = {
    accessToken: freshAccessToken,
    refreshToken: account.refreshToken,
    expiryDateSeconds,
    tokenType: 'Bearer',
    isGcpTos: false
  };

  console.log(`[SeamlessSwitcher] Injecting token for ${account.email}, refreshed=${tokenWasRefreshed}, expiry=${new Date(expiryDateSeconds * 1000).toISOString()}`);

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
        console.log(`[SeamlessSwitcher] Readback: token=${readEmail}, match=${applied?.accessToken === freshAccessToken}`);
      } catch (e) {
        console.warn('[SeamlessSwitcher] Token readback failed:', e);
      }
    }

    return {
      success: true,
      email: account.email,
      message: '无感切号成功'
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
 * 获取当前宿主的 token 信息
 */
export async function getCurrentHostToken(): Promise<OAuthTokenInfoPayload | null> {
  const tokenApi = getTokenApi();
  if (!tokenApi || typeof tokenApi.getOAuthTokenInfo !== 'function') {
    return null;
  }

  try {
    return await withTimeout(
      Promise.resolve(tokenApi.getOAuthTokenInfo()),
      SEAMLESS_TIMEOUT_MS,
      'getOAuthTokenInfo'
    );
  } catch {
    return null;
  }
}
