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
    return new Date(token.expiry_timestamp * 1000).toISOString();
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

function convertToStoredAccount(ext: ExternalAccount, source: string): StoredAccount {
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
    tag: source,
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
  // Cockpit Tools 新版加密存储：密钥缺失时加密文件必须逐个暴露为失败，而不是当成 0 账号
  const secureKey = readSecureStorageKey(dataDir);
  if (!secureKey) {
    failures.push(t('impSecureKeyMissing'));
  }

  // 读取索引文件获取账号列表
  let accountIds: string[] = [];
  if (fs.existsSync(indexPath)) {
    try {
      const indexData = JSON.parse(fs.readFileSync(indexPath, 'utf8')) as AccountIndex;
      accountIds = indexData.accounts.map(a => a.id);
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
        .filter(f => f.endsWith('.json'))
        .map(f => f.replace('.json', ''));
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

export async function importFromCockpitTools(): Promise<{ imported: number; skipped: number }> {
  const dataDir = getCockpitToolsDir();

  if (!fs.existsSync(dataDir)) {
    throw new Error(t('impCockpitDirMissing'));
  }

  const { accounts, failures } = await loadAccountsFromDir(dataDir);
  if (accounts.length === 0) {
    const detail = failures.length > 0 ? `：${failures.slice(0, 3).join('；')}${failures.length > 3 ? ` 等 ${failures.length} 项` : ''}` : '';
    throw new Error(t('impCockpitNoAccounts', detail));
  }
  if (failures.length > 0) {
    console.warn(`[importService] Cockpit Tools 部分账号读取失败: ${failures.join('；')}`);
  }

  let imported = 0;
  let skipped = 0;

  for (const ext of accounts) {
    const existing = accountStore.getAll().find(a => a.email === ext.email);
    if (existing) {
      skipped++;
      continue;
    }

    const stored = convertToStoredAccount(ext, 'cockpit-tools');
    accountStore.add(stored);
    imported++;
  }

  return { imported, skipped };
}

export async function importFromAntigravityManager(): Promise<{ imported: number; skipped: number }> {
  const dataDir = getAntigravityManagerDir();

  if (!fs.existsSync(dataDir)) {
    throw new Error(t('impManagerDirMissing'));
  }

  const { accounts, failures } = await loadAccountsFromDir(dataDir);
  if (accounts.length === 0) {
    const detail = failures.length > 0 ? `：${failures.slice(0, 3).join('；')}${failures.length > 3 ? ` 等 ${failures.length} 项` : ''}` : '';
    throw new Error(t('impManagerNoAccounts', detail));
  }
  if (failures.length > 0) {
    console.warn(`[importService] Antigravity Manager 部分账号读取失败: ${failures.join('；')}`);
  }

  let imported = 0;
  let skipped = 0;

  for (const ext of accounts) {
    const existing = accountStore.getAll().find(a => a.email === ext.email);
    if (existing) {
      skipped++;
      continue;
    }

    const stored = convertToStoredAccount(ext, 'antigravity-manager');
    accountStore.add(stored);
    imported++;
  }

  return { imported, skipped };
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
  let data: any;
  
  try {
    data = JSON.parse(content);
  } catch {
    throw new Error(t('impBadJson'));
  }

  // 支持多种格式
  let accounts: Array<{
    email: string;
    refresh_token?: string;
    refreshToken?: string;
    access_token?: string;
    accessToken?: string;
    expiresAt?: string;
    expires_at?: string;
    expiry_timestamp?: number;
    expires_in?: number;
  }> = [];
  
  if (Array.isArray(data)) {
    accounts = data;
  } else if (data.email) {
    accounts = [data];
  } else if (data.accounts && Array.isArray(data.accounts)) {
    accounts = data.accounts;
  } else {
    throw new Error(t('impUnsupportedFormat'));
  }

  let imported = 0;
  let skipped = 0;

  for (const acc of accounts) {
    if (!acc.email) continue;
    
    const existing = accountStore.getAll().find(a => a.email === acc.email);
    if (existing) {
      skipped++;
      continue;
    }

    const stored: StoredAccount = {
      email: acc.email,
      accessToken: acc.access_token || acc.accessToken || '',
      refreshToken: acc.refresh_token || acc.refreshToken,
      expiresAt: normalizeExpiryToIso(acc.expiresAt ?? acc.expires_at ?? acc.expiry_timestamp)
        ?? (typeof acc.expires_in === 'number' && Number.isFinite(acc.expires_in)
          ? new Date(Date.now() + acc.expires_in * 1000).toISOString()
          : undefined),
      importMeta: {
        source: 'manual',
        importedAt: new Date().toISOString(),
      },
      tag: 'json-import',
    };
    
    accountStore.add(stored);
    imported++;
  }

  return { imported, skipped };
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
