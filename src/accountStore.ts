/**
 * 账号池持久化存储（运行期零 vscode 依赖）
 *
 * 特性：
 * - 基于 withFileLockSync + readJsonFileSafe + atomicWriteJsonSync 实现跨窗口/跨进程并发安全
 * - 通过 accountCrypto 在落盘时对 accessToken/refreshToken/idToken 实施 AES-256-GCM 静态加密
 * - 支持历史明文 accounts.json 平滑加密迁移（自动生成 accounts.pre-encrypt.bak）
 * - 防抹空保护：读失败/JSON 损坏时置 _loadHealthy=false 且保留内存数据；写前检测磁盘仍损坏则留存 accounts.corrupt.<ts>.bak 并拒写
 * - 每次变更均在文件锁内重读磁盘最新列表合并写盘，避免多窗口相互覆盖
 */
import * as fs from 'fs';
import * as path from 'path';
import type * as vscode from 'vscode';
import { StoredAccount } from './types';
import { migrateDataIfNeeded, getSharedStorageDir } from './storage';
import { logInfo, logWarn, logError } from './logger';
import { normalizeAccountTags, removeTagFromAccounts, sanitizeStoredAccounts } from './tagSanitizer';
import { atomicWriteJsonSync, readJsonFileSafe, withFileLockSync } from './atomicFile';
import { decryptAccountFromDisk, encryptAccountForDisk } from './accountCrypto';

let _accounts: StoredAccount[] = [];
let _storageDir = '';
let _loadHealthy = true;
let _watcher: fs.FSWatcher | null = null;
let _watchDebounceTimer: NodeJS.Timeout | null = null;
let _lastSelfSaveAt = 0;
let _lastKnownDiskSig = '';
const SELF_SAVE_IGNORE_MS = 150;
const _onChangeCallbacks = new Set<() => void>();

const ACCOUNTS_FILE = 'accounts.json';
const PRE_ENCRYPT_BACKUP_FILE = 'accounts.pre-encrypt.bak';

function readDiskSig(filePath: string): string {
  try {
    const st = fs.statSync(filePath);
    return `${st.mtimeMs}:${st.size}`;
  } catch {
    return 'missing';
  }
}

function ensureStorageDir(): string {
  if (!_storageDir) {
    _storageDir = getSharedStorageDir();
  }
  return _storageDir;
}

function getFilePath(): string {
  return path.join(ensureStorageDir(), ACCOUNTS_FILE);
}

function cloneAccount(acc: StoredAccount): StoredAccount {
  return {
    ...acc,
    ...(acc.tags ? { tags: [...acc.tags] } : {}),
    ...(acc.importMeta ? { importMeta: { ...acc.importMeta } } : {}),
    ...(acc.health ? { health: { ...acc.health } } : {}),
  };
}

function backupPlaintextIfNeeded(filePath: string, dir: string): void {
  const bakPath = path.join(dir, PRE_ENCRYPT_BACKUP_FILE);
  if (fs.existsSync(bakPath)) return;
  try {
    fs.copyFileSync(filePath, bakPath);
    if (process.platform !== 'win32') {
      try {
        fs.chmodSync(bakPath, 0o600);
      } catch (chmodErr) {
        logWarn('accountStore.backupPlain.chmod', chmodErr instanceof Error ? chmodErr.message : String(chmodErr));
      }
    }
    logInfo('accountStore.migrate.backup', { backup: bakPath });
  } catch (err) {
    logWarn('accountStore.migrate.backup.fail', err instanceof Error ? err.message : String(err));
  }
}

function backupCorruptFile(filePath: string, dir: string): string | undefined {
  if (!fs.existsSync(filePath)) return undefined;
  const corruptPath = path.join(dir, `accounts.corrupt.${Date.now()}.bak`);
  try {
    fs.copyFileSync(filePath, corruptPath);
    return corruptPath;
  } catch (err) {
    logWarn('accountStore.corruptBackup.fail', err instanceof Error ? err.message : String(err));
    return undefined;
  }
}

function decodeDiskList(
  rawList: unknown[],
  dir: string,
): { accounts: StoredAccount[]; anyPlaintext: boolean; cleanedTags: number } {
  const decrypted: StoredAccount[] = [];
  let anyPlaintext = false;

  for (const item of rawList) {
    if (!item || typeof item !== 'object') {
      throw new Error('Invalid account record in accounts.json');
    }
    const { account, wasPlaintext } = decryptAccountFromDisk(item as StoredAccount, dir);
    if (wasPlaintext) {
      anyPlaintext = true;
    }
    decrypted.push(account);
  }

  const cleanedTags = sanitizeStoredAccounts(decrypted);
  return { accounts: decrypted, anyPlaintext, cleanedTags };
}

function encryptAndWriteList(filePath: string, dir: string, list: StoredAccount[]): void {
  const encryptedList = list.map((acc) => encryptAccountForDisk(acc, dir));
  _lastSelfSaveAt = Date.now();
  atomicWriteJsonSync(filePath, encryptedList, 0o600);
  _lastSelfSaveAt = Date.now();
  _lastKnownDiskSig = readDiskSig(filePath);
}

export function init(context: vscode.ExtensionContext): void {
  if (_watchDebounceTimer) {
    clearTimeout(_watchDebounceTimer);
    _watchDebounceTimer = null;
  }
  _watcher?.close();
  _watcher = null;

  // 进行可能的数据迁移，并确定共享存储目录
  migrateDataIfNeeded(context, ACCOUNTS_FILE);
  _storageDir = getSharedStorageDir();

  load();

  // 监听文件变化（多窗口同步；忽略自身写入、非 accounts.json 变动及未变签名）
  try {
    const targetFilePath = path.join(_storageDir, ACCOUNTS_FILE);
    _watcher = fs.watch(_storageDir, (_event, filename) => {
      if (filename && filename !== ACCOUNTS_FILE) return;
      if (Date.now() - _lastSelfSaveAt < SELF_SAVE_IGNORE_MS) return;
      if (_watchDebounceTimer) clearTimeout(_watchDebounceTimer);
      _watchDebounceTimer = setTimeout(() => {
        _watchDebounceTimer = null;
        if (Date.now() - _lastSelfSaveAt < SELF_SAVE_IGNORE_MS) return;
        const currentSig = readDiskSig(targetFilePath);
        if (currentSig === _lastKnownDiskSig) return;
        load();
        notifyChange();
      }, 80);
    });
    logInfo('accountStore.watch', { ok: true, dir: _storageDir });
  } catch (e) {
    logWarn('accountStore.watch', e);
  }
}

/** 当前使用的共享存储目录（用于日志/诊断） */
export function getStorageDirPath(): string {
  return ensureStorageDir();
}

/** 当前磁盘加载是否处于健康状态（读失败/损坏时为 false） */
export function isLoadHealthy(): boolean {
  return _loadHealthy;
}

export function dispose(): void {
  if (_watchDebounceTimer) {
    clearTimeout(_watchDebounceTimer);
    _watchDebounceTimer = null;
  }
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
      logWarn('accountStore.onChange.fail', error instanceof Error ? error.message : String(error));
    }
  }
}

function load(): void {
  const dir = ensureStorageDir();
  const filePath = path.join(dir, ACCOUNTS_FILE);

  const readRes = readJsonFileSafe<unknown>(filePath);
  if (readRes.status === 'missing') {
    _accounts = [];
    _loadHealthy = true;
    _lastKnownDiskSig = 'missing';
    logWarn('accountStore.load', { file: filePath, exists: false, count: 0 });
    return;
  }

  if (readRes.status === 'error') {
    // 读失败 = 未知：绝不将内存 _accounts 抹空，只降级健康标志并留痕
    _loadHealthy = false;
    logError('accountStore.load.fail', { file: filePath, error: readRes.error });
    return;
  }

  if (!Array.isArray(readRes.data)) {
    _loadHealthy = false;
    logError('accountStore.load.fail', { file: filePath, error: 'accounts.json root is not an array' });
    return;
  }

  try {
    const { accounts, anyPlaintext, cleanedTags } = decodeDiskList(readRes.data, dir);
    _accounts = accounts;
    _loadHealthy = true;
    _lastKnownDiskSig = readDiskSig(filePath);

    logInfo('accountStore.load', {
      file: filePath,
      exists: true,
      bytes: readRes.rawBytes,
      count: _accounts.length,
      cleanedLegacyTags: cleanedTags,
      migratedFromPlaintext: anyPlaintext,
    });

    if (anyPlaintext || cleanedTags > 0) {
      try {
        withFileLockSync(filePath, () => {
          const latest = readJsonFileSafe<unknown>(filePath);
          if (latest.status !== 'ok' || !Array.isArray(latest.data)) {
            return;
          }
          const decodedLatest = decodeDiskList(latest.data, dir);
          if (decodedLatest.anyPlaintext) {
            backupPlaintextIfNeeded(filePath, dir);
          }
          if (decodedLatest.anyPlaintext || decodedLatest.cleanedTags > 0) {
            encryptAndWriteList(filePath, dir, decodedLatest.accounts);
            _accounts = decodedLatest.accounts;
          }
        });
      } catch (migrateErr) {
        logError('accountStore.migrate.fail', {
          file: filePath,
          error: migrateErr instanceof Error ? migrateErr.message : String(migrateErr),
        });
      }
    }
  } catch (e) {
    // 解密或数据结构异常：保留内存 _accounts 不置空
    _loadHealthy = false;
    logError('accountStore.load.fail', {
      file: filePath,
      error: e instanceof Error ? e.message : String(e),
    });
  }
}

/**
 * 统一跨窗口读-改-写原语：
 * - 在文件锁内从磁盘重读最新列表，合并外部窗口变更
 * - 若磁盘仍损坏则拒绝覆盖写入，保留 accounts.corrupt.<ts>.bak 并返回 { ok: false }
 * - 仅在发生实质改动时执行加密与原子落盘
 */
function mutateAndSave<R>(
  mutator: (accounts: StoredAccount[]) => { changed: boolean; result: R },
): { ok: true; result: R } | { ok: false; error: string } {
  const dir = ensureStorageDir();
  const filePath = path.join(dir, ACCOUNTS_FILE);

  try {
    const lockedOutcome = withFileLockSync(filePath, () => {
      const disk = readJsonFileSafe<unknown>(filePath);
      let workingList: StoredAccount[] = [];
      let diskRawList: unknown[] | null = null;
      let needsDiskNormalize = false;

      if (disk.status === 'error') {
        _loadHealthy = false;
        const backup = backupCorruptFile(filePath, dir);
        logError('accountStore.write.blockedCorrupt', { file: filePath, backup, error: disk.error });
        return { ok: false as const, error: `Refused to overwrite corrupt accounts.json: ${disk.error}` };
      }

      if (disk.status === 'ok') {
        if (!Array.isArray(disk.data)) {
          _loadHealthy = false;
          const backup = backupCorruptFile(filePath, dir);
          logError('accountStore.write.blockedNonArray', { file: filePath, backup });
          return { ok: false as const, error: 'Refused to overwrite non-array accounts.json' };
        }
        diskRawList = disk.data;
        let decoded: { accounts: StoredAccount[]; anyPlaintext: boolean; cleanedTags: number };
        try {
          decoded = decodeDiskList(disk.data, dir);
        } catch (decodeErr) {
          _loadHealthy = false;
          const msg = decodeErr instanceof Error ? decodeErr.message : String(decodeErr);
          const backup = backupCorruptFile(filePath, dir);
          logError('accountStore.write.blockedDecrypt', { file: filePath, backup, error: msg });
          return { ok: false as const, error: `Refused to overwrite undecryptable accounts.json: ${msg}` };
        }
        if (decoded.anyPlaintext) {
          backupPlaintextIfNeeded(filePath, dir);
        }
        needsDiskNormalize = decoded.anyPlaintext || decoded.cleanedTags > 0;
        workingList = decoded.accounts;
      }

      const { changed, result } = mutator(workingList);
      const shouldPersist = changed || needsDiskNormalize || (diskRawList !== null && hasPlaintextOrDirtyTags(diskRawList, workingList));

      if (shouldPersist) {
        encryptAndWriteList(filePath, dir, workingList);
      }

      _accounts = workingList;
      _loadHealthy = true;
      return { ok: true as const, result, changed };
    });

    if (!lockedOutcome.ok) {
      return lockedOutcome;
    }
    if (lockedOutcome.changed) {
      notifyChange();
    }
    return { ok: true as const, result: lockedOutcome.result };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logError('accountStore.save.fail', { file: filePath, error: msg });
    return { ok: false as const, error: msg };
  }
}

function hasPlaintextOrDirtyTags(rawDisk: unknown[], decoded: StoredAccount[]): boolean {
  if (rawDisk.length !== decoded.length) return true;
  for (const item of rawDisk) {
    if (!item || typeof item !== 'object') return true;
    const raw = item as StoredAccount;
    if (
      (typeof raw.accessToken === 'string' && raw.accessToken.length > 0 && !raw.accessToken.startsWith('enc:v1:')) ||
      (typeof raw.refreshToken === 'string' && raw.refreshToken.length > 0 && !raw.refreshToken.startsWith('enc:v1:')) ||
      (typeof raw.idToken === 'string' && raw.idToken.length > 0 && !raw.idToken.startsWith('enc:v1:'))
    ) {
      return true;
    }
  }
  return false;
}

export function getAll(): StoredAccount[] {
  return _accounts.map(cloneAccount);
}

export function getByEmail(email: string): StoredAccount | undefined {
  const lower = email.toLowerCase();
  const found = _accounts.find((a) => a.email.toLowerCase() === lower);
  return found ? cloneAccount(found) : undefined;
}

export function add(account: StoredAccount): boolean {
  const hasExplicitTags = Object.prototype.hasOwnProperty.call(account, 'tags') || Object.prototype.hasOwnProperty.call(account, 'tag');
  const incoming = cloneAccount(account);
  delete incoming.usage;
  normalizeAccountTags(incoming, { stripLegacy: true });

  const outcome = mutateAndSave((list) => {
    const lower = incoming.email.toLowerCase();
    const existing = list.find((a) => a.email.toLowerCase() === lower);
    if (existing) {
      const prevTags = existing.tags;
      const prevHealth = existing.health;
      Object.assign(existing, incoming);
      if (!hasExplicitTags && prevTags && prevTags.length > 0) {
        existing.tags = [...prevTags];
      }
      if (
        !incoming.disabled
        && (incoming.accessToken || incoming.refreshToken)
        && !incoming.health
        && prevHealth?.status === 'auth_invalid'
      ) {
        delete existing.health;
      }
      normalizeAccountTags(existing, { stripLegacy: true });
    } else {
      list.push(incoming);
    }
    return { changed: true, result: true };
  });

  return outcome.ok ? outcome.result : false;
}

export function remove(email: string): boolean {
  const lower = email.toLowerCase();
  const outcome = mutateAndSave((list) => {
    const idx = list.findIndex((a) => a.email.toLowerCase() === lower);
    if (idx < 0) {
      return { changed: false, result: false };
    }
    list.splice(idx, 1);
    return { changed: true, result: true };
  });

  return outcome.ok ? outcome.result : false;
}

export function update(email: string, updates: Partial<StoredAccount>): boolean {
  const lower = email.toLowerCase();
  const cleanUpdates: Partial<StoredAccount> = { ...updates };
  delete cleanUpdates.usage;

  const outcome = mutateAndSave((list) => {
    const account = list.find((a) => a.email.toLowerCase() === lower);
    if (!account) {
      return { changed: false, result: false };
    }
    Object.assign(account, cleanUpdates);
    if ('tags' in cleanUpdates || 'tag' in cleanUpdates) {
      normalizeAccountTags(account, { stripLegacy: false });
    }
    return { changed: true, result: true };
  });

  return outcome.ok ? outcome.result : false;
}

function shouldOverwriteExistingToken(existing: StoredAccount, incoming: StoredAccount): boolean {
  const hasNewCred = Boolean(incoming.accessToken || incoming.refreshToken);
  if (!hasNewCred) return false;

  const sameAT = (incoming.accessToken || '') === (existing.accessToken || '');
  const sameRT = (incoming.refreshToken || '') === (existing.refreshToken || '');
  const sameId = !incoming.idToken || incoming.idToken === existing.idToken;
  if (sameAT && sameRT && sameId) {
    return false;
  }

  // 若是同一 refreshToken 且外部带来的 expiresAt 明显更旧（>60s），不回退覆盖已有更新鲜的 AT
  if (sameRT && existing.accessToken && existing.expiresAt && incoming.expiresAt) {
    const oldExp = Date.parse(existing.expiresAt);
    const newExp = Date.parse(incoming.expiresAt);
    if (Number.isFinite(oldExp) && Number.isFinite(newExp) && newExp < oldExp - 60_000) {
      return false;
    }
  }

  return true;
}

/**
 * 批量新增或智能覆盖更新账号（大小写不敏感匹配邮箱，单次原子写盘）。
 * - overwriteTokens=true 时：对已有账号智能续期更新 token（保留原有 tags / disabled / projectId）
 * - 写失败必须抛错暴露，绝不伪造成功
 */
export function upsertBatch(
  accounts: StoredAccount[],
  opts?: { overwriteTokens?: boolean },
): { added: number; updated: number; skipped: number } {
  const overwriteTokens = opts?.overwriteTokens === true;

  const outcome = mutateAndSave((list) => {
    const byEmail = new Map<string, StoredAccount>();
    for (const acc of list) {
      if (acc.email) {
        byEmail.set(acc.email.toLowerCase(), acc);
      }
    }

    let added = 0;
    let updated = 0;
    let skipped = 0;

    for (const rawIncoming of accounts) {
      if (!rawIncoming || !rawIncoming.email) continue;
      const incoming = cloneAccount(rawIncoming);
      delete incoming.usage;
      normalizeAccountTags(incoming, { stripLegacy: true });

      const key = incoming.email.toLowerCase();
      const existing = byEmail.get(key);

      if (!existing) {
        list.push(incoming);
        byEmail.set(key, incoming);
        added++;
        continue;
      }

      if (!overwriteTokens || !shouldOverwriteExistingToken(existing, incoming)) {
        skipped++;
        continue;
      }

      const prevAccessToken = existing.accessToken;
      const prevRefreshToken = existing.refreshToken;
      const rtChanged = Boolean(incoming.refreshToken && incoming.refreshToken !== prevRefreshToken);
      if (incoming.accessToken) {
        existing.accessToken = incoming.accessToken;
      } else if (rtChanged) {
        existing.accessToken = '';
        delete existing.expiresAt;
      }
      if (incoming.refreshToken) {
        existing.refreshToken = incoming.refreshToken;
      }
      if (incoming.expiresAt) {
        existing.expiresAt = incoming.expiresAt;
      }
      if (incoming.idToken) {
        existing.idToken = incoming.idToken;
      }
      if (!existing.name && incoming.name) {
        existing.name = incoming.name;
      }
      if (!existing.projectId && incoming.projectId) {
        existing.projectId = incoming.projectId;
      }
      if (incoming.importMeta) {
        existing.importMeta = incoming.importMeta;
      }
      // 更换了 accessToken 或 refreshToken 时清理旧指纹与失效标记，防止错配复用
      const atChanged = Boolean(incoming.accessToken && incoming.accessToken !== prevAccessToken);
      if (atChanged || rtChanged) {
        if (atChanged && incoming.verifiedAtHash && incoming.verifiedAt) {
          existing.verifiedAtHash = incoming.verifiedAtHash;
          existing.verifiedAt = incoming.verifiedAt;
        } else {
          delete existing.verifiedAtHash;
          delete existing.verifiedAt;
        }
        if (existing.health?.status === 'auth_invalid') {
          delete existing.health;
        }
      }
      updated++;
    }

    return { changed: added > 0 || updated > 0, result: { added, updated, skipped } };
  });

  if (!outcome.ok) {
    throw new Error(outcome.error);
  }
  return outcome.result;
}

/** 批量删除指定邮箱账号（单次原子写盘），返回实际删除数量 */
export function removeMany(emails: string[]): number {
  const targets = new Set(emails.filter(Boolean).map((e) => e.toLowerCase()));
  if (targets.size === 0) return 0;

  const outcome = mutateAndSave((list) => {
    const before = list.length;
    for (let i = list.length - 1; i >= 0; i--) {
      if (targets.has(list[i].email.toLowerCase())) {
        list.splice(i, 1);
      }
    }
    const removed = before - list.length;
    return { changed: removed > 0, result: removed };
  });

  if (!outcome.ok) {
    throw new Error(outcome.error);
  }
  return outcome.result;
}

/** 批量启用/禁用指定邮箱账号（单次原子写盘），返回实际状态变更数量 */
export function setDisabledMany(emails: string[], disabled: boolean): number {
  const targets = new Set(emails.filter(Boolean).map((e) => e.toLowerCase()));
  if (targets.size === 0) return 0;

  const outcome = mutateAndSave((list) => {
    let changedCount = 0;
    for (const acc of list) {
      if (!targets.has(acc.email.toLowerCase())) continue;
      if (Boolean(acc.disabled) !== disabled) {
        acc.disabled = disabled;
        changedCount++;
      }
    }
    return { changed: changedCount > 0, result: changedCount };
  });

  if (!outcome.ok) {
    throw new Error(outcome.error);
  }
  return outcome.result;
}

/** 批量设置指定邮箱账号的标签列表（单次原子写盘），返回实际变更数量 */
export function batchUpdateTags(emails: string[], tags: string[]): number {
  const targets = new Set(emails.filter(Boolean).map((e) => e.toLowerCase()));
  if (targets.size === 0) return 0;

  const outcome = mutateAndSave((list) => {
    let changedCount = 0;
    for (const acc of list) {
      if (!targets.has(acc.email.toLowerCase())) continue;
      const before = JSON.stringify(acc.tags ?? []);
      acc.tags = [...tags];
      normalizeAccountTags(acc, { stripLegacy: false });
      const after = JSON.stringify(acc.tags ?? []);
      if (before !== after || Object.prototype.hasOwnProperty.call(acc, 'tag')) {
        changedCount++;
      }
    }
    return { changed: changedCount > 0, result: changedCount };
  });

  if (!outcome.ok) {
    throw new Error(outcome.error);
  }
  return outcome.result;
}

/** 从所有账号中永久删除指定标签（原子写盘一次），返回受影响账号数 */
export function removeTagEverywhere(tag: string): number {
  const trimmed = tag.trim();
  if (!trimmed) return 0;

  const outcome = mutateAndSave((list) => {
    const affected = removeTagFromAccounts(list, trimmed);
    return { changed: affected > 0, result: affected };
  });

  if (!outcome.ok) {
    throw new Error(outcome.error);
  }
  if (outcome.result > 0) {
    logInfo('accountStore.removeTagEverywhere', { tag: trimmed, affected: outcome.result });
  }
  return outcome.result;
}

export function setDisabled(email: string, disabled: boolean): boolean {
  return update(email, { disabled });
}

export function count(): number {
  return _accounts.length;
}

export function countActive(): number {
  return _accounts.filter((a) => !a.disabled).length;
}
