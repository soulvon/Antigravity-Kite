/**
 * 无感换号服务
 * 通过 Antigravity IDE 内部 API 直接切换账号
 */

import * as vscode from 'vscode';
import { StoredAccount } from './types';
import { ensureFreshToken } from './usageService';
import * as instanceMgr from './instanceManager';
import * as accountStore from './accountStore';

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
  };
  antigravityAuth?: OAuthPreferencesApi;
}

export interface SwitchResult {
  success: boolean;
  email?: string;
  message?: string;
}

export interface AutoSwitchOptions {
  context?: vscode.ExtensionContext;
  onSwitched?: (email: string) => void | Promise<void>;
  notify?: boolean;
}

interface PreparedSwitchToken {
  accessToken: string;
  refreshToken: string;
  expiryDateSeconds: number;
  refreshed: boolean;
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

async function prepareTokenForSwitch(account: StoredAccount): Promise<{ ok: true; token: PreparedSwitchToken } | { ok: false; message: string }> {
  if (!account.refreshToken) {
    return { ok: false, message: '缺少 refreshToken' };
  }

  const beforeAccessToken = account.accessToken || '';
  const refreshRequired = shouldRefreshForSwitch(account);
  let freshAccessToken = '';

  try {
    freshAccessToken = await ensureFreshToken(account);
  } catch (error) {
    const err = error instanceof Error ? error.message : String(error);
    return { ok: false, message: `刷新 accessToken 失败：${err}` };
  }

  const latestAccount = accountStore.getByEmail(account.email) || account;
  const accessToken = freshAccessToken || latestAccount.accessToken || account.accessToken;
  if (!accessToken) {
    return { ok: false, message: 'accessToken 无效且刷新失败' };
  }

  const expiryMs = parseExpiryMs(latestAccount.expiresAt || account.expiresAt);
  const expiryReady = !!expiryMs && expiryMs - Date.now() >= TOKEN_REFRESH_BUFFER_MS;
  const refreshed = accessToken !== beforeAccessToken;

  if (refreshRequired && !refreshed && !expiryReady) {
    return {
      ok: false,
      message: '目标账号 accessToken 已过期或即将过期，且 refreshToken 刷新失败，请重新授权该账号',
    };
  }

  if (!expiryMs) {
    return {
      ok: false,
      message: '目标账号缺少有效 expiresAt，无法确认 token 有效期，请重新授权该账号',
    };
  }

  return {
    ok: true,
    token: {
      accessToken,
      refreshToken: account.refreshToken,
      expiryDateSeconds: Math.floor(expiryMs / 1000),
      refreshed,
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

  const prepared = await prepareTokenForSwitch(account);
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
            message: '无感切号写入后读回校验不一致，宿主未应用目标账号 accessToken'
          };
        }
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

/**
 * 自动切换当前分身实例绑定的账号
 */
export async function autoSwitchInstanceBoundAccount(options: AutoSwitchOptions = {}): Promise<void> {
  try {
    const instances = await instanceMgr.listInstances();
    // 找出 running 且 current 的实例
    const currentInst = instances.find(i => i.current);
    if (!currentInst) {
      console.log('[Kite-AutoSwitch] 未能定位当前实例');
      return;
    }

    if (currentInst.id === 'default') {
      // 默认实例不执行分身绑定账号自动切号
      return;
    }

    const bindEmail = currentInst.bindEmail ? currentInst.bindEmail.trim().toLowerCase() : '';
    if (!bindEmail) {
      console.log(`[Kite-AutoSwitch] 当前分身实例 [${currentInst.name}] 未绑定特定账号`);
      return;
    }

    // 从号池中找到该邮箱对应的账号
    const allAccounts = accountStore.getAll();
    const targetAccount = allAccounts.find((a: StoredAccount) => a.email.toLowerCase() === bindEmail);
    if (!targetAccount) {
      console.warn(`[Kite-AutoSwitch] 绑定的账号邮箱 ${bindEmail} 不存在于号池中，忽略自动切号`);
      return;
    }

    if (targetAccount.disabled) {
      console.warn(`[Kite-AutoSwitch] 绑定的账号邮箱 ${bindEmail} 已被禁用，忽略自动切号`);
      return;
    }

    // 获取当前宿主的 Token 信息
    const hostToken = await getCurrentHostToken();
    if (hostToken) {
      // 对比 Token 凭证以确定是否已是该账号
      // 注意：如果 refresh_token 一致，说明是同一个账号（因为 access_token 可能会变，而 refresh_token 标识唯一授权）
      const sameRefreshToken = !!(hostToken.refreshToken && targetAccount.refreshToken &&
        hostToken.refreshToken === targetAccount.refreshToken);

      const sameAccessToken = !!(hostToken.accessToken && targetAccount.accessToken &&
        hostToken.accessToken === targetAccount.accessToken);

      if (sameRefreshToken || sameAccessToken) {
        console.log(`[Kite-AutoSwitch] 当前分身实例已处于绑定账号 [${bindEmail}] 登录状态，无需切号`);
        return;
      }
    }

    console.log(`[Kite-AutoSwitch] 检测到分身实例 [${currentInst.name}] 绑定账号为 ${bindEmail}，与当前登录状态不一致，正在执行后台无感自动切号...`);
    const result = await seamlessSwitch(targetAccount);
    if (result.success) {
      console.log(`[Kite-AutoSwitch] 成功为分身实例自动无感切号至: ${bindEmail}`);
      await options.context?.globalState.update('currentEmail', targetAccount.email);
      await options.onSwitched?.(targetAccount.email);
      if (options.notify !== false) {
        vscode.window.showInformationMessage(`[Kite] 自动为您无感登录分身账号: ${bindEmail}`);
      }
    } else {
      console.error(`[Kite-AutoSwitch] 自动无感切号失败: ${result.message}`);
    }
  } catch (e) {
    console.error('[Kite-AutoSwitch] 执行自动绑定切号异常:', e);
  }
}
