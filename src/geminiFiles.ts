/**
 * ~/.gemini 下的本地凭据文件（切号必须同步的两处）。
 *
 * 真机对照矩阵（基线：只改凭据管理器 → 每次必弹安全声明）：
 * | 写入项                       | 结果 |
 * |------------------------------|------|
 * | 只 google_accounts.active     | 弹   |
 * | 只 oauth_creds 的 email       | 弹   |
 * | 只 oauth_creds 的 token       | 弹   |
 * | active + email               | 弹   |
 * | email  + token               | 弹   |
 * | **active + token**           | **不弹** |
 *
 * 结论：IDE 判定“账号是否变更”需要这两处同时指向目标账号，缺一即弹。
 * 参考同类实现（AgyHop）同样维护 oauth_creds.json + google_accounts.json + 凭据管理器三处。
 */
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { logInfo, logWarn } from './logger';
import { getSharedStorageDir } from './storage';

export interface GeminiLocalCreds {
  email: string;
  accessToken: string;
  refreshToken?: string;
  expiryMs: number;
  scope?: string;
}

function geminiDir(): string {
  return path.join(os.homedir(), '.gemini');
}

/** 备份两个文件（仅首次，保留最原始的一份，便于回滚） */
function backupOnce(file: string, tag: string): void {
  try {
    const dir = getSharedStorageDir();
    const target = path.join(dir, `bak-${tag}`);
    if (!fs.existsSync(target) && fs.existsSync(file)) {
      fs.copyFileSync(file, target);
      logInfo('geminiFiles.backup', { tag, from: file, to: target });
    }
  } catch (e) {
    logWarn('geminiFiles.backup.fail', e);
  }
}

/**
 * 同步 ~/.gemini 的两处凭据文件到目标账号。
 * 两处必须同时更新，否则 agent 面板会判定为账号变更并弹出安全声明。
 */
export function syncGeminiLocalCreds(creds: GeminiLocalCreds): { ok: boolean; error?: string } {
  const dir = geminiDir();
  try {
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }

    // 1) oauth_creds.json：token 为主体（email 字段非必需，但一并对齐避免歧义）
    const credFile = path.join(dir, 'oauth_creds.json');
    backupOnce(credFile, 'oauth_creds.json');
    let cred: Record<string, unknown> = {};
    if (fs.existsSync(credFile)) {
      try { cred = JSON.parse(fs.readFileSync(credFile, 'utf8')) as Record<string, unknown>; } catch { cred = {}; }
    }
    cred.access_token = creds.accessToken;
    if (creds.refreshToken) cred.refresh_token = creds.refreshToken;
    cred.token_type = 'Bearer';
    cred.expiry_date = creds.expiryMs;
    // 兼容第三方写入的字段（Cockpit 等）：一并对齐，避免文件内部自相矛盾
    if ('antigravity_cockpit_active_email' in cred) cred.antigravity_cockpit_active_email = creds.email;
    if ('id_token_email' in cred) cred.id_token_email = creds.email;
    fs.writeFileSync(credFile, JSON.stringify(cred, null, 2), 'utf8');

    // 2) google_accounts.json：active 指向目标账号，历史列表保留
    const accFile = path.join(dir, 'google_accounts.json');
    backupOnce(accFile, 'google_accounts.json');
    let acc: { active?: string; old?: string[] } = {};
    if (fs.existsSync(accFile)) {
      try { acc = JSON.parse(fs.readFileSync(accFile, 'utf8')) as { active?: string; old?: string[] }; } catch { acc = {}; }
    }
    const oldList = Array.isArray(acc.old) ? acc.old.slice() : [];
    acc.active = creds.email;
    if (!oldList.includes(creds.email)) oldList.push(creds.email);
    acc.old = oldList;
    fs.writeFileSync(accFile, JSON.stringify(acc, null, 2), 'utf8');

    logInfo('geminiFiles.sync', { email: creds.email, expiryMs: creds.expiryMs, dir });
    return { ok: true };
  } catch (e) {
    const error = e instanceof Error ? e.message : String(e);
    logWarn('geminiFiles.sync.fail', { error });
    return { ok: false, error };
  }
}

/** 读取当前 ~/.gemini/google_accounts.json 的 active（诊断用） */
export function readActiveAccount(): string {
  try {
    const accFile = path.join(geminiDir(), 'google_accounts.json');
    if (!fs.existsSync(accFile)) return '';
    const acc = JSON.parse(fs.readFileSync(accFile, 'utf8')) as { active?: string };
    return acc.active || '';
  } catch {
    return '';
  }
}
