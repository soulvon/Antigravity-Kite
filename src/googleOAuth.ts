/**
 * Google OAuth 公共常量与轻量认证原语（零 vscode 依赖）
 */
import * as crypto from 'crypto';
import { httpRequest } from './httpClient';

export const OAUTH_CLIENT_ID = '1071006060591-tmhssin2h21lcre235vtolojh4g403ep.apps.googleusercontent.com';
export const OAUTH_CLIENT_SECRET = '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';
export const OAUTH_SCOPES = [
  'openid',
  'https://www.googleapis.com/auth/cloud-platform',
  'https://www.googleapis.com/auth/userinfo.email',
  'https://www.googleapis.com/auth/userinfo.profile',
];
export const OAUTH_TOKEN_URL = 'https://oauth2.googleapis.com/token';
export const OAUTH_AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth';
export const OAUTH_USERINFO_URL = 'https://www.googleapis.com/oauth2/v2/userinfo';

/** 计算 accessToken 短指纹（仅用于绑定验证来源，绝不明文落盘） */
export function computeTokenFingerprint(accessToken: string): string {
  return crypto.createHash('sha256').update(accessToken).digest('hex').slice(0, 16);
}

/** 用 refreshToken 刷新 Google accessToken（同时提取可选的 idToken 与 expiresIn） */
export async function refreshGoogleAccessToken(
  refreshToken: string,
  timeoutMs = 10_000,
): Promise<{ accessToken: string; idToken?: string; expiresIn?: number } | null> {
  if (!refreshToken) return null;
  const body = new URLSearchParams({
    client_id: OAUTH_CLIENT_ID,
    client_secret: OAUTH_CLIENT_SECRET,
    refresh_token: refreshToken,
    grant_type: 'refresh_token',
  }).toString();

  try {
    const res = await httpRequest(OAUTH_TOKEN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body,
      timeoutMs,
    });
    if (res.status !== 200) {
      console.warn(`[googleOAuth] Token refresh failed with HTTP ${res.status}`);
      return null;
    }
    const json = JSON.parse(res.body) as Record<string, unknown>;
    if (typeof json.access_token !== 'string' || !json.access_token) {
      console.warn('[googleOAuth] Token refresh response missing access_token');
      return null;
    }
    return {
      accessToken: json.access_token,
      idToken: typeof json.id_token === 'string' && json.id_token ? json.id_token : undefined,
      expiresIn: typeof json.expires_in === 'number' && Number.isFinite(json.expires_in) ? json.expires_in : undefined,
    };
  } catch (err) {
    console.warn('[googleOAuth] Token refresh error:', err instanceof Error ? err.message : String(err));
    return null;
  }
}

/** 查询 Google 用户信息（email / name） */
export async function fetchGoogleUserInfo(
  accessToken: string,
  timeoutMs = 8_000,
): Promise<{ email?: string; name?: string } | null> {
  if (!accessToken) return null;
  try {
    const res = await httpRequest(OAUTH_USERINFO_URL, {
      method: 'GET',
      headers: { Authorization: `Bearer ${accessToken}` },
      timeoutMs,
    });
    if (res.status !== 200) {
      console.warn(`[googleOAuth] UserInfo request failed with HTTP ${res.status}`);
      return null;
    }
    const json = JSON.parse(res.body) as Record<string, unknown>;
    return {
      email: typeof json.email === 'string' && json.email ? json.email : undefined,
      name: typeof json.name === 'string' && json.name ? json.name : undefined,
    };
  } catch (err) {
    console.warn('[googleOAuth] UserInfo error:', err instanceof Error ? err.message : String(err));
    return null;
  }
}
