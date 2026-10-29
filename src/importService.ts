import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { StoredAccount } from './types';
import * as accountStore from './accountStore';

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

async function loadAccountsFromDir(dataDir: string): Promise<ExternalAccount[]> {
  const accountsDir = path.join(dataDir, 'accounts');
  const indexPath = path.join(dataDir, 'accounts.json');
  
  if (!fs.existsSync(accountsDir)) {
    return [];
  }

  const accounts: ExternalAccount[] = [];
  
  // 读取索引文件获取账号列表
  let accountIds: string[] = [];
  if (fs.existsSync(indexPath)) {
    try {
      const indexData = JSON.parse(fs.readFileSync(indexPath, 'utf8')) as AccountIndex;
      accountIds = indexData.accounts.map(a => a.id);
    } catch (e) {
      console.warn('[importService] Failed to read index:', e);
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
    }
  }

  // 读取每个账号文件
  for (const id of accountIds) {
    const accountPath = path.join(accountsDir, `${id}.json`);
    if (fs.existsSync(accountPath)) {
      try {
        const data = JSON.parse(fs.readFileSync(accountPath, 'utf8'));
        if (data.email && data.token) {
          accounts.push(data as ExternalAccount);
        }
      } catch (e) {
        console.warn(`[importService] Failed to read account ${id}:`, e);
      }
    }
  }

  return accounts;
}

export async function importFromCockpitTools(): Promise<{ imported: number; skipped: number }> {
  const dataDir = getCockpitToolsDir();
  
  if (!fs.existsSync(dataDir)) {
    throw new Error('Cockpit Tools 数据目录不存在');
  }

  const accounts = await loadAccountsFromDir(dataDir);
  if (accounts.length === 0) {
    throw new Error('Cockpit Tools 中没有找到账号');
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
    throw new Error('Antigravity Manager 数据目录不存在');
  }

  const accounts = await loadAccountsFromDir(dataDir);
  if (accounts.length === 0) {
    throw new Error('Antigravity Manager 中没有找到账号');
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
    title: '选择账号 JSON 文件',
  });

  if (!uris || uris.length === 0) {
    throw new Error('未选择文件');
  }

  const filePath = uris[0].fsPath;
  const content = fs.readFileSync(filePath, 'utf8');
  let data: any;
  
  try {
    data = JSON.parse(content);
  } catch {
    throw new Error('JSON 格式错误');
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
    throw new Error('不支持的 JSON 格式');
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
      description: '从 Cockpit Tools 导入账号',
      available: fs.existsSync(getCockpitToolsDir()),
    },
    {
      id: 'antigravity-manager',
      name: 'Antigravity Manager',
      description: '从 Antigravity Manager 导入账号',
      available: fs.existsSync(getAntigravityManagerDir()),
    },
    {
      id: 'json-file',
      name: '从本地文件导入',
      description: '选择 JSON 文件导入账号（支持多种格式）',
      available: true,
    },
  ];
}
