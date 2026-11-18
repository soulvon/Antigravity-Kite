/**
 * 多源账号导入服务（Cockpit Tools / Antigravity Manager / 本地 JSON 文件）
 *
 * 约定：禁止在导入阶段自动写入任何来源或状态标签属性。
 */
import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { StoredAccount } from './types';
import * as accountStore from './accountStore';
import { decryptSecureAccount, isEncryptedPayload, readSecureStorageKey } from './secureAccounts';
import { t } from './i18n';

interface ExternalAccount {
  id?: string;
  email: string;
  name?: string;
  token: {
    access_token: string;
    refresh_token: string;
    expiry_timestamp?: number;
    expires_in?: number;
  };
  disabled?: boolean;
}

interface AccountIndex {
  accounts: Array<{ id: string; email: string; name?: string }>;
  current_account_id?: string;
}

interface JsonImportItem {
  email?: string;
  refresh_token?: string;
  refreshToken?: string;
  access_token?: string;
  accessToken?: string;
  expiresAt?: string;
  expires_at?: string;
  expiry_timestamp?: number;
  expires_in?: number;
}

interface LocalAppImportSpec {
  label: string;
  getDir: () => string;
  dirMissingMsg: () => string;
  noAccountsMsg: (detail: string) => string;
}

function getHomeDir(): string {
  return os.homedir();
}

function getCockpitToolsDir(): string {
  return path.join(getHomeDir(), '.antigravity_cockpit');
}

function getAntigravityManagerDir(): string {
  return path.join(getHomeDir(), '.antigravity_tools');
}

function tokenExpiryToIso(token: ExternalAccount['token']): string | undefined {
  if (typeof token.expiry_timestamp === 'number' && Number.isFinite(token.expiry_timestamp)) {
    // 秒/毫秒自适应（阈值 1e10 ≈ 2286 年）：兼容外部工具未契约化的时间戳单位
    const ms = token.expiry_timestamp > 10_000_000_000 ? token.expiry_timestamp : token.expiry_timestamp * 1000;
    return new Date(ms).toISOString();
  }
  if (typeof token.expires_in === 'number' && Number.isFinite(token.expires_in)) {
    return new Date(Date.now() + token.expires_in * 1000).toISOString();
  }
  return undefined;
}

function normalizeExpiryToIso(value: unknown): string | undefined {
  if (typeof value === 'string' && value.trim()) {
    const expiryMs = Date.parse(value);
    return Number.isNaN(expiryMs) ? undefined : new Date(expiryMs).toISOString();
  }
  if (typeof value === 'number' && Number.isFinite(value)) {
    const seconds = value > 10_000_000_000 ? value / 1000 : value;
    return new Date(seconds * 1000).toISOString();
  }
  return undefined;
}

function convertToStoredAccount(ext: ExternalAccount): StoredAccount {
  return {
    email: ext.email,
    name: ext.name,
    accessToken: ext.token.access_token,
    refreshToken: ext.token.refresh_token,
    expiresAt: tokenExpiryToIso(ext.token),
    disabled: ext.disabled,
    importMeta: {
      source: 'local',
      importedAt: new Date().toISOString(),
    },
  };
}

async function loadAccountsFromDir(dataDir: string): Promise<{ accounts: ExternalAccount[]; failures: string[] }> {
  const accountsDir = path.join(dataDir, 'accounts');
  const indexPath = path.join(dataDir, 'accounts.json');

  if (!fs.existsSync(accountsDir)) {
    return { accounts: [], failures: [t('impDirMissing', accountsDir)] };
  }

  const accounts: ExternalAccount[] = [];
  const failures: string[] = [];
  const secureKey = readSecureStorageKey(dataDir);
  let missingKeyReported = false;

  // 读取索引文件获取账号列表
  let accountIds: string[] = [];
  if (fs.existsSync(indexPath)) {
    try {
      const indexData = JSON.parse(fs.readFileSync(indexPath, 'utf8')) as AccountIndex;
      accountIds = Array.isArray(indexData.accounts) ? indexData.accounts.map((a) => a.id) : [];
    } catch (e) {
      console.warn('[importService] Failed to read index:', e);
      failures.push(t('impIndexParseFailed'));
    }
  }

  // 如果没有索引，扫描目录
  if (accountIds.length === 0) {
    try {
      const files = fs.readdirSync(accountsDir);
      accountIds = files
        .filter((f) => f.endsWith('.json'))
        .map((f) => f.replace('.json', ''));
    } catch (e) {
      console.warn('[importService] Failed to scan accounts dir:', e);
      failures.push(t('impDirScanFailed'));
    }
  }

  // 读取每个账号文件
  for (const id of accountIds) {
    const accountPath = path.join(accountsDir, `${id}.json`);
    if (!fs.existsSync(accountPath)) {
      failures.push(t('impFileMissing', `${id}.json`));
      continue;
    }
    try {
      const data = JSON.parse(fs.readFileSync(accountPath, 'utf8'));
      let account: unknown = data;
      if (isEncryptedPayload(data)) {
        if (!secureKey) {
          // 仅在真实存在加密账号文件却缺失密钥时才暴露缺失密钥错误
          if (!missingKeyReported) {
            failures.push(t('impSecureKeyMissing'));
            missingKeyReported = true;
          }
          failures.push(t('impEncryptedNoKey', `${id}.json`));
          continue;
        }
        account = decryptSecureAccount(data, secureKey);
      }
      const acc = account as ExternalAccount;
      if (acc.email && acc.token) {
        accounts.push(acc);
      } else {
        failures.push(t('impMissingFields', `${id}.json`));
      }
    } catch (e) {
      // 解密失败/JSON 损坏逐文件留证，绝不静默吞掉后伪装成 0 账号
      const reason = e instanceof Error ? e.message : String(e);
      failures.push(t('impReadFailed', `${id}.json`, reason));
      console.warn(`[importService] Failed to read account ${id}:`, e);
    }
  }

  return { accounts, failures };
}

async function importFromLocalApp(spec: LocalAppImportSpec): Promise<{ imported: number; skipped: number }> {
  const dataDir = spec.getDir();

  if (!fs.existsSync(dataDir)) {
    throw new Error(spec.dirMissingMsg());
  }

  const { accounts, failures } = await loadAccountsFromDir(dataDir);
  if (accounts.length === 0) {
    const detail = failures.length > 0
      ? `：${failures.slice(0, 3).join('；')}${failures.length > 3 ? t('errImportMore', failures.length) : ''}`
      : '';
    throw new Error(spec.noAccountsMsg(detail));
  }
  if (failures.length > 0) {
    console.warn(`[importService] ${spec.label} 部分账号读取失败: ${failures.join('；')}`);
  }

  const batch = accounts.map(convertToStoredAccount);
  const res = accountStore.upsertBatch(batch, { overwriteTokens: true });
  return { imported: res.added + res.updated, skipped: res.skipped };
}

const COCKPIT_IMPORT_SPEC: LocalAppImportSpec = {
  label: 'Cockpit Tools',
  getDir: getCockpitToolsDir,
  dirMissingMsg: () => t('impCockpitDirMissing'),
  noAccountsMsg: (detail) => t('impCockpitNoAccounts', detail),
};

const MANAGER_IMPORT_SPEC: LocalAppImportSpec = {
  label: 'Antigravity Manager',
  getDir: getAntigravityManagerDir,
  dirMissingMsg: () => t('impManagerDirMissing'),
  noAccountsMsg: (detail) => t('impManagerNoAccounts', detail),
};

export async function importFromCockpitTools(): Promise<{ imported: number; skipped: number }> {
  return importFromLocalApp(COCKPIT_IMPORT_SPEC);
}

export async function importFromAntigravityManager(): Promise<{ imported: number; skipped: number }> {
  return importFromLocalApp(MANAGER_IMPORT_SPEC);
}

export async function importFromJsonFile(): Promise<{ imported: number; skipped: number }> {
  const uris = await vscode.window.showOpenDialog({
    canSelectFiles: true,
    canSelectMany: false,
    filters: { 'JSON Files': ['json'] },
    title: t('impPickJsonTitle'),
  });

  if (!uris || uris.length === 0) {
    throw new Error(t('impNoFileSelected'));
  }

  const filePath = uris[0].fsPath;
  const content = fs.readFileSync(filePath, 'utf8');
  let data: unknown;

  try {
    data = JSON.parse(content);
  } catch (err) {
    console.warn('[importService] Failed to parse selected JSON file:', err instanceof Error ? err.message : String(err));
    throw new Error(t('impBadJson'));
  }

  let accounts: JsonImportItem[] = [];
  if (Array.isArray(data)) {
    accounts = data as JsonImportItem[];
  } else if (data && typeof data === 'object') {
    const obj = data as { email?: unknown; accounts?: unknown };
    if (typeof obj.email === 'string' && obj.email) {
      accounts = [obj as JsonImportItem];
    } else if (Array.isArray(obj.accounts)) {
      accounts = obj.accounts as JsonImportItem[];
    } else {
      throw new Error(t('impUnsupportedFormat'));
    }
  } else {
    throw new Error(t('impUnsupportedFormat'));
  }

  const nowIso = new Date().toISOString();
  const batch: StoredAccount[] = [];
  for (const acc of accounts) {
    if (!acc || typeof acc.email !== 'string' || !acc.email.trim()) continue;
    batch.push({
      email: acc.email.trim(),
      accessToken: acc.access_token || acc.accessToken || '',
      refreshToken: acc.refresh_token || acc.refreshToken,
      expiresAt: normalizeExpiryToIso(acc.expiresAt ?? acc.expires_at ?? acc.expiry_timestamp)
        ?? (typeof acc.expires_in === 'number' && Number.isFinite(acc.expires_in)
          ? new Date(Date.now() + acc.expires_in * 1000).toISOString()
          : undefined),
      importMeta: {
        source: 'manual',
        importedAt: nowIso,
      },
    });
  }

  const res = accountStore.upsertBatch(batch, { overwriteTokens: true });
  return { imported: res.added + res.updated, skipped: res.skipped };
}

export function getAvailableImportSources(): Array<{ id: string; name: string; description: string; available: boolean }> {
  return [
    {
      id: 'cockpit-tools',
      name: 'Cockpit Tools',
      description: t('impDescCockpit'),
      available: fs.existsSync(getCockpitToolsDir()),
    },
    {
      id: 'antigravity-manager',
      name: 'Antigravity Manager',
      description: t('impDescManager'),
      available: fs.existsSync(getAntigravityManagerDir()),
    },
    {
      id: 'json-file',
      name: t('impNameLocalFile'),
      description: t('impDescLocalFile'),
      available: true,
    },
  ];
}
