import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { StoredAccount } from './types';

import { migrateDataIfNeeded, getSharedStorageDir } from './storage';
import { logInfo, logWarn, logError } from './logger';

let _accounts: StoredAccount[] = [];
let _storageDir: string = '';
let _watcher: fs.FSWatcher | null = null;
const _onChangeCallbacks = new Set<() => void>();

const ACCOUNTS_FILE = 'accounts.json';

function getFilePath(): string {
  return path.join(_storageDir, ACCOUNTS_FILE);
}

export function init(context: vscode.ExtensionContext): void {
  // 进行可能的数据迁移，并确定共享存储目录
  migrateDataIfNeeded(context, ACCOUNTS_FILE);
  _storageDir = getSharedStorageDir();

  load();

  // 监听文件变化（多窗口同步）
  try {
    _watcher = fs.watch(_storageDir, (event, filename) => {
      if (filename === ACCOUNTS_FILE) {
        load();
        notifyChange();
      }
    });
    logInfo('accountStore.watch', { ok: true, dir: _storageDir });
  } catch (e) { logWarn('accountStore.watch', e); }
}

/** 当前使用的共享存储目录（用于日志/诊断） */
export function getStorageDirPath(): string {
  return _storageDir;
}

export function dispose(): void {
  _watcher?.close();
  _watcher = null;
  _onChangeCallbacks.clear();
}

export function onChange(callback: () => void): { dispose(): void } {
  _onChangeCallbacks.add(callback);
  return {
    dispose: () => {
      _onChangeCallbacks.delete(callback);
    },
  };
}

function notifyChange(): void {
  for (const callback of _onChangeCallbacks) {
    try {
      callback();
    } catch (error) {
      console.warn('[accountStore] onChange callback failed:', error);
    }
  }
}

function load(): void {
  try {
    const filePath = getFilePath();
    const exists = fs.existsSync(filePath);
    if (exists) {
      const data = fs.readFileSync(filePath, 'utf8');
      _accounts = JSON.parse(data);
      logInfo('accountStore.load', { file: filePath, exists, bytes: data.length, count: Array.isArray(_accounts) ? _accounts.length : 'not-array' });
    } else {
      logWarn('accountStore.load', { file: filePath, exists, count: 0 });
    }
  } catch (e) {
    logError('accountStore.load.fail', { file: getFilePath(), error: e instanceof Error ? e.message : String(e) });
    _accounts = [];
  }
}

function save(): void {
  try {
    const filePath = getFilePath();
    fs.writeFileSync(filePath, JSON.stringify(_accounts, null, 2), 'utf8');
  } catch (err) {
    console.error('[accountStore] save failed:', err);
  }
}

export function getAll(): StoredAccount[] {
  return [..._accounts];
}

export function getByEmail(email: string): StoredAccount | undefined {
  return _accounts.find(a => a.email.toLowerCase() === email.toLowerCase());
}

export function add(account: StoredAccount): boolean {
  const existing = getByEmail(account.email);
  if (existing) {
    // 更新已有账号
    Object.assign(existing, account);
  } else {
    _accounts.push(account);
  }
  save();
  return true;
}

export function remove(email: string): boolean {
  const idx = _accounts.findIndex(a => a.email.toLowerCase() === email.toLowerCase());
  if (idx >= 0) {
    _accounts.splice(idx, 1);
    save();
    return true;
  }
  return false;
}

export function update(email: string, updates: Partial<StoredAccount>): boolean {
  const account = getByEmail(email);
  if (account) {
    Object.assign(account, updates);
    save();
    return true;
  }
  return false;
}

export function setDisabled(email: string, disabled: boolean): boolean {
  return update(email, { disabled });
}

export function count(): number {
  return _accounts.length;
}

export function countActive(): number {
  return _accounts.filter(a => !a.disabled).length;
}
