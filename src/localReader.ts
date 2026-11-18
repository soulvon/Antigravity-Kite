import * as fs from 'fs';
import { StoredAccount } from './types';
import { t } from './i18n';
import { logWarn } from './logger';
import { getEffectiveCurrentUserDataDir } from './ideRuntime';
import {
  resolveIdeStateDbPaths,
  resolveIdeStateDbPathFromUserData,
  readIdeOAuthTokenFromDb,
  readIdeUserStatusFromDb,
} from './ideStateDb';
import {
  computeTokenFingerprint,
  refreshGoogleAccessToken,
  fetchGoogleUserInfo,
} from './googleOAuth';

/** 解析当前 IDE 实例对应的 state.vscdb 路径：优先当前 --user-data-dir，其次跨平台候选路径 */
export function resolveLocalStateDbPath(): string {
  const effectiveUda = getEffectiveCurrentUserDataDir().trim();
  const customDb = effectiveUda ? resolveIdeStateDbPathFromUserData(effectiveUda) : '';
  if (customDb && fs.existsSync(customDb)) {
    return customDb;
  }
  const candidates = resolveIdeStateDbPaths();
  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) {
      return candidate;
    }
  }
  return customDb || candidates[0];
}

// 缓存预览的凭证，供确认导入时使用
let pendingCredential: StoredAccount | null = null;

/**
 * 预览本地账号（检测是否存在）：
 * 优先通过 OAuth token 获取 email，失败时用 refreshToken 刷新，仍失败时从 userStatus 兜底读取。
 */
export async function previewLocalAccount(
  existingEmails: string[],
): Promise<{ email: string; exists: boolean; tokenExpired?: boolean }> {
  const dbPath = resolveLocalStateDbPath();
  if (!fs.existsSync(dbPath)) {
    throw new Error(t('lrNoLocalLogin'));
  }

  let accessToken: string | undefined;
  let refreshToken: string | undefined;
  let idToken: string | undefined;
  let expiresAt: string | undefined;
  let verifiedAtHash: string | undefined;
  let verifiedAt: number | undefined;
  let tokenExpired = false;

  try {
    const tokens = readIdeOAuthTokenFromDb(dbPath);
    accessToken = tokens.accessToken;
    refreshToken = tokens.refreshToken;
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (msg === t('errSqliteUnavailable')) {
      throw e;
    }
    logWarn('localReader.readToken.fail', { dbPath, error: msg });
  }

  let userInfo: { email?: string; name?: string } = {};
  if (accessToken) {
    userInfo = (await fetchGoogleUserInfo(accessToken)) || {};
  }

  if (!userInfo.email && refreshToken) {
    const refreshed = await refreshGoogleAccessToken(refreshToken);
    if (refreshed?.accessToken) {
      accessToken = refreshed.accessToken;
      if (refreshed.idToken) idToken = refreshed.idToken;
      const ttlSec = typeof refreshed.expiresIn === 'number' && refreshed.expiresIn > 0
        ? refreshed.expiresIn
        : 3600;
      expiresAt = new Date(Date.now() + ttlSec * 1000).toISOString();
      verifiedAtHash = computeTokenFingerprint(accessToken);
      verifiedAt = Date.now();
      userInfo = (await fetchGoogleUserInfo(accessToken)) || {};
    } else {
      tokenExpired = true;
    }
  }

  if (!userInfo.email) {
    try {
      const statusInfo = readIdeUserStatusFromDb(dbPath);
      if (statusInfo.email) {
        userInfo.email = statusInfo.email;
        userInfo.name = statusInfo.name;
        tokenExpired = true;
      }
    } catch (e) {
      logWarn('localReader.readUserStatus.fail', {
        dbPath,
        error: e instanceof Error ? e.message : String(e),
      });
    }
  }

  if (!userInfo.email) {
    throw new Error(t('lrCannotGetEmail'));
  }

  pendingCredential = {
    email: userInfo.email,
    accessToken: accessToken || '',
    refreshToken,
    expiresAt,
    idToken,
    name: userInfo.name || userInfo.email.split('@')[0],
    disabled: tokenExpired,
    verifiedAtHash,
    verifiedAt,
    importMeta: {
      source: 'local',
      importedAt: new Date().toISOString(),
    },
  };

  const exists = existingEmails.some((e) => e.toLowerCase() === userInfo.email!.toLowerCase());
  return { email: userInfo.email, exists, tokenExpired };
}

/** 确认导入（使用缓存的凭证） */
export function confirmImport(): StoredAccount | null {
  const credential = pendingCredential;
  pendingCredential = null;
  return credential;
}

/** 取消导入 */
export function cancelImport(): void {
  pendingCredential = null;
}
