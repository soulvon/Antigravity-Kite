/**
 * 用量统计追踪器
 *
 * - 每日汇总计数持久化到 globalState（轻量小对象）
 * - 配额变动历史（最多 10000 条）持久化到共享目录下的 quota-history.json（走 atomicFile）
 * - 首次构造时若 globalState 仍存有旧 usageTracker.quotaHistory，自动迁移至独立文件并从 globalState 清除
 */
import * as fs from 'fs';
import * as path from 'path';
import type * as vscode from 'vscode';
import { getSharedStorageDir } from './storage';
import { atomicWriteJsonSync, readJsonFileSafe, withFileLockSync } from './atomicFile';
import { logError, logInfo, logWarn } from './logger';

// ─── 类型 ───────────────────────────────────────────────

export interface AccountStats {
  switchToCount: number;
  usedPct: number;       // 已用百分比 (100 - minRemainingPercent)
  lastCheckTs: number;
  tierId?: string;
}

export interface QuotaPoolsSnapshot {
  claude?: number | null;
  gemini?: number | null;
  argon?: number | null;
}

export interface QuotaHistoryEntry {
  ts: number;
  email: string;
  remaining: number;     // minRemainingPercent
  delta: number;         // 变化量（负数 = 消耗）
  tierId?: string;
  pools?: QuotaPoolsSnapshot;
}

export interface PoolStats {
  totalSwitches: number;
  totalRefreshes: number;
  sessionStartTs: number;
  lastResetDate: string;
  accounts: Record<string, AccountStats>;
}

export interface StatsSummary {
  totalSwitches: number;
  totalRefreshes: number;
  avgUsedPct: number;
  totalUsedPct: number;
  accountCount: number;
  sessionStartTs: number;
  date: string;
  perAccount: Record<string, AccountStats>;
}

// ─── 常量 ───────────────────────────────────────────────

const STORAGE_KEY = 'usageTracker.stats';
const LEGACY_HISTORY_KEY = 'usageTracker.quotaHistory';
const HISTORY_FILE = 'quota-history.json';
const MAX_HISTORY = 10000;

function normalizePools(raw: unknown): QuotaPoolsSnapshot | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const r = raw as Record<string, unknown>;
  const out: QuotaPoolsSnapshot = {};
  let hasAny = false;
  for (const key of ['claude', 'gemini', 'argon'] as const) {
    const v = r[key];
    if (typeof v === 'number' && Number.isFinite(v)) {
      out[key] = Math.round(v);
      hasAny = true;
    } else if (v === null) {
      out[key] = null;
    }
  }
  return hasAny ? out : undefined;
}

function formatPoolSig(pools?: QuotaPoolsSnapshot): string {
  if (!pools) return '';
  return `${pools.claude ?? ''}:${pools.gemini ?? ''}:${pools.argon ?? ''}`;
}

function normalizeHistoryEntry(item: unknown): QuotaHistoryEntry | null {
  if (!item || typeof item !== 'object') return null;
  const e = item as Partial<QuotaHistoryEntry>;
  if (
    typeof e.ts !== 'number' ||
    !Number.isFinite(e.ts) ||
    typeof e.email !== 'string' ||
    !e.email ||
    typeof e.remaining !== 'number' ||
    !Number.isFinite(e.remaining)
  ) {
    return null;
  }
  const pools = normalizePools(e.pools);
  return {
    ts: e.ts,
    email: e.email,
    remaining: e.remaining,
    delta: typeof e.delta === 'number' && Number.isFinite(e.delta) ? e.delta : 0,
    ...(typeof e.tierId === 'string' && e.tierId ? { tierId: e.tierId } : {}),
    ...(pools ? { pools } : {}),
  };
}

function parseValidHistory(items: unknown[]): QuotaHistoryEntry[] {
  const out: QuotaHistoryEntry[] = [];
  for (const item of items) {
    const normalized = normalizeHistoryEntry(item);
    if (normalized) out.push(normalized);
  }
  return out;
}

// ─── 实现 ───────────────────────────────────────────────

export class UsageTracker {
  private _ctx: vscode.ExtensionContext;
  private _stats: PoolStats;
  private _dirty = false;
  private _saveTimer: NodeJS.Timeout | null = null;
  private _quotaHistory: QuotaHistoryEntry[] = [];
  private _lastQuotaMap: Map<string, number> = new Map(); // email → last remaining
  private _lastPoolSigMap: Map<string, string> = new Map(); // email → last pools sig
  private _historyDirty = false;
  private _historySaveTimer: NodeJS.Timeout | null = null;
  private _historyListeners = new Set<() => void>();
  private _historyLoaded = false;
  private _historyLoadHealthy = true;
  private _disposed = false;

  constructor(ctx: vscode.ExtensionContext) {
    this._ctx = ctx;
    this._stats = this._load();
    this._maybeResetDaily();
    this._loadHistoryOnce();
  }

  private _getHistoryFilePath(): string {
    return path.join(getSharedStorageDir(), HISTORY_FILE);
  }

  private _loadHistoryOnce(): void {
    if (this._historyLoaded) return;
    this._historyLoaded = true;

    const historyPath = this._getHistoryFilePath();
    const diskRes = readJsonFileSafe<unknown>(historyPath);
    const legacy = this._ctx.globalState.get<unknown>(LEGACY_HISTORY_KEY);
    const hasLegacyArray = Array.isArray(legacy);
    const legacyEntries = hasLegacyArray ? parseValidHistory(legacy) : [];

    if (diskRes.status === 'error') {
      // 读失败 = 未知：绝不盲目置空或覆盖原磁盘历史文件
      this._historyLoadHealthy = false;
      this._quotaHistory = [];
      logError('usageTracker.history.loadFail', { file: historyPath, error: diskRes.error });
    } else if (diskRes.status === 'ok') {
      if (!Array.isArray(diskRes.data)) {
        this._historyLoadHealthy = false;
        this._quotaHistory = [];
        logError('usageTracker.history.loadFail', { file: historyPath, error: 'quota-history.json root is not an array' });
      } else {
        this._historyLoadHealthy = true;
        this._quotaHistory = parseValidHistory(diskRes.data).slice(-MAX_HISTORY);

        // 若 globalState 仍有遗留数据，合并去重后清除旧键
        if (hasLegacyArray) {
          if (legacyEntries.length > 0) {
            const seen = new Set(this._quotaHistory.map((e) => `${e.ts}:${e.email}`));
            const merged = [...this._quotaHistory];
            let added = 0;
            for (const entry of legacyEntries) {
              const key = `${entry.ts}:${entry.email}`;
              if (!seen.has(key)) {
                seen.add(key);
                merged.push(entry);
                added++;
              }
            }
            if (added > 0) {
              merged.sort((a, b) => a.ts - b.ts);
              this._quotaHistory = merged.slice(-MAX_HISTORY);
              if (this._writeHistorySync()) {
                void this._ctx.globalState.update(LEGACY_HISTORY_KEY, undefined);
              }
            } else {
              void this._ctx.globalState.update(LEGACY_HISTORY_KEY, undefined);
            }
          } else {
            void this._ctx.globalState.update(LEGACY_HISTORY_KEY, undefined);
          }
        }
      }
    } else {
      // 磁盘尚无 quota-history.json：若 globalState 有旧历史则自动迁移落盘
      this._historyLoadHealthy = true;
      if (hasLegacyArray) {
        this._quotaHistory = legacyEntries.slice(-MAX_HISTORY);
        if (this._quotaHistory.length > 0) {
          if (this._writeHistorySync()) {
            void this._ctx.globalState.update(LEGACY_HISTORY_KEY, undefined);
            logInfo('usageTracker.history.migrated', { count: this._quotaHistory.length, file: historyPath });
          }
        } else {
          void this._ctx.globalState.update(LEGACY_HISTORY_KEY, undefined);
        }
      } else {
        this._quotaHistory = [];
      }
    }

    // 恢复 lastQuotaMap 与 lastPoolSigMap
    for (let i = this._quotaHistory.length - 1; i >= 0; i--) {
      const e = this._quotaHistory[i];
      if (!this._lastQuotaMap.has(e.email)) {
        this._lastQuotaMap.set(e.email, e.remaining);
      }
      if (e.pools && !this._lastPoolSigMap.has(e.email)) {
        this._lastPoolSigMap.set(e.email, formatPoolSig(e.pools));
      }
    }
  }

  private _writeHistorySync(): boolean {
    const historyPath = this._getHistoryFilePath();
    try {
      withFileLockSync(historyPath, () => {
        if (!this._historyLoadHealthy) {
          const check = readJsonFileSafe<unknown>(historyPath);
          if (check.status === 'error' || (check.status === 'ok' && !Array.isArray(check.data))) {
            const bakPath = path.join(path.dirname(historyPath), `quota-history.corrupt.${Date.now()}.bak`);
            try {
              fs.copyFileSync(historyPath, bakPath);
              logWarn('usageTracker.history.corruptBackup', { backup: bakPath });
            } catch (copyErr) {
              logError('usageTracker.history.corruptBackupFail', copyErr instanceof Error ? copyErr.message : String(copyErr));
              throw copyErr;
            }
          }
          this._historyLoadHealthy = true;
        }
        atomicWriteJsonSync(historyPath, this._quotaHistory, 0o600);
      });
      return true;
    } catch (err) {
      logError('usageTracker.history.saveFail', {
        file: historyPath,
        error: err instanceof Error ? err.message : String(err),
      });
      return false;
    }
  }

  addHistoryListener(cb: () => void): { dispose(): void } {
    this._historyListeners.add(cb);
    return { dispose: () => { this._historyListeners.delete(cb); } };
  }

  private _notifyHistoryListeners(): void {
    for (const cb of this._historyListeners) {
      try {
        cb();
      } catch (err) {
        logWarn('usageTracker.listener.fail', err instanceof Error ? err.message : String(err));
      }
    }
  }

  // ── 记录事件 ──

  recordSwitch(email: string): void {
    this._maybeResetDaily();
    this._stats.totalSwitches++;
    this._ensureAccount(email).switchToCount++;
    this._debounceSave();
  }

  recordRefresh(): void {
    this._maybeResetDaily();
    this._stats.totalRefreshes++;
    this._debounceSave();
  }

  recordUsage(email: string, minRemainingPercent: number, tierId?: string, pools?: QuotaPoolsSnapshot): void {
    this._maybeResetDaily();
    const acct = this._ensureAccount(email);
    acct.usedPct = Math.max(0, 100 - minRemainingPercent);
    acct.lastCheckTs = Date.now();
    acct.tierId = tierId;

    // 配额变动历史（总剩余或任意模型子池发生变动即记录）
    const remaining = Math.round(minRemainingPercent);
    const normalizedPools = normalizePools(pools);
    const poolSig = formatPoolSig(normalizedPools);
    const last = this._lastQuotaMap.get(email);
    const lastPoolSig = this._lastPoolSigMap.get(email) ?? '';
    if (last === undefined || last !== remaining || (poolSig !== '' && lastPoolSig !== poolSig)) {
      const delta = last !== undefined ? remaining - last : 0;
      this._quotaHistory.push({
        ts: Date.now(),
        email,
        remaining,
        delta,
        tierId,
        ...(normalizedPools ? { pools: normalizedPools } : {}),
      });
      if (this._quotaHistory.length > MAX_HISTORY) {
        this._quotaHistory.splice(0, this._quotaHistory.length - MAX_HISTORY);
      }
      this._lastQuotaMap.set(email, remaining);
      if (poolSig) this._lastPoolSigMap.set(email, poolSig);
      this._debounceHistorySave();
      this._notifyHistoryListeners();
    }

    this._debounceSave();
  }

  // ── 读取 ──

  getStats(): PoolStats {
    this._maybeResetDaily();
    return JSON.parse(JSON.stringify(this._stats));
  }

  getSummary(): StatsSummary {
    this._maybeResetDaily();
    const s = this._stats;
    let totalUsedPct = 0;
    let accountCount = 0;

    for (const acct of Object.values(s.accounts)) {
      if (acct.lastCheckTs > 0) {
        totalUsedPct += acct.usedPct;
        accountCount++;
      }
    }

    return {
      totalSwitches: s.totalSwitches,
      totalRefreshes: s.totalRefreshes,
      avgUsedPct: accountCount > 0 ? Math.round(totalUsedPct / accountCount) : 0,
      totalUsedPct: Math.round(totalUsedPct),
      accountCount,
      sessionStartTs: s.sessionStartTs,
      date: s.lastResetDate,
      perAccount: s.accounts,
    };
  }

  // ── 配额历史 ──

  getQuotaHistory(email?: string, limit = 200): QuotaHistoryEntry[] {
    let result = this._quotaHistory;
    if (email) result = result.filter((e) => e.email === email);
    return result.slice(-limit);
  }

  clearQuotaHistory(email?: string): void {
    if (email) {
      this._quotaHistory = this._quotaHistory.filter((e) => e.email !== email);
      this._lastQuotaMap.delete(email);
      this._lastPoolSigMap.delete(email);
    } else {
      this._quotaHistory = [];
      this._lastQuotaMap.clear();
      this._lastPoolSigMap.clear();
    }
    if (this._historySaveTimer) {
      clearTimeout(this._historySaveTimer);
      this._historySaveTimer = null;
    }
    this._historyDirty = false;
    this._writeHistorySync();
    this._notifyHistoryListeners();
  }

  getHistoryEmails(): string[] {
    const set = new Set<string>();
    for (const e of this._quotaHistory) set.add(e.email);
    return Array.from(set);
  }

  // ── 内部 ──

  private _load(): PoolStats {
    const saved = this._ctx.globalState.get<PoolStats>(STORAGE_KEY);
    if (saved && saved.lastResetDate) return saved;
    return this._empty();
  }

  private _empty(): PoolStats {
    return {
      totalSwitches: 0,
      totalRefreshes: 0,
      sessionStartTs: Date.now(),
      lastResetDate: todayStr(),
      accounts: {},
    };
  }

  private _debounceSave(): void {
    if (this._disposed) return;
    this._dirty = true;
    if (this._saveTimer) return;
    this._saveTimer = setTimeout(() => {
      this._saveTimer = null;
      if (this._dirty) {
        this._dirty = false;
        void this._ctx.globalState.update(STORAGE_KEY, this._stats);
      }
    }, 2000);
  }

  private _debounceHistorySave(): void {
    if (this._disposed) return;
    this._historyDirty = true;
    if (this._historySaveTimer) return;
    this._historySaveTimer = setTimeout(() => {
      this._historySaveTimer = null;
      if (this._historyDirty) {
        this._historyDirty = !this._writeHistorySync();
      }
    }, 3000);
  }

  private _maybeResetDaily(): void {
    const today = todayStr();
    if (this._stats.lastResetDate !== today) {
      this._stats.totalSwitches = 0;
      this._stats.totalRefreshes = 0;
      this._stats.accounts = {};
      this._stats.lastResetDate = today;
      this._lastQuotaMap.clear();
      this._lastPoolSigMap.clear();
      this._debounceSave();
    }
  }

  private _ensureAccount(email: string): AccountStats {
    if (!this._stats.accounts[email]) {
      this._stats.accounts[email] = {
        switchToCount: 0,
        usedPct: 0,
        lastCheckTs: 0,
      };
    }
    return this._stats.accounts[email];
  }

  dispose(): void {
    if (this._disposed) return;
    this._disposed = true;

    if (this._saveTimer) {
      clearTimeout(this._saveTimer);
      this._saveTimer = null;
    }
    if (this._historySaveTimer) {
      clearTimeout(this._historySaveTimer);
      this._historySaveTimer = null;
    }
    if (this._dirty) {
      this._dirty = false;
      void this._ctx.globalState.update(STORAGE_KEY, this._stats);
    }
    if (this._historyDirty) {
      this._historyDirty = !this._writeHistorySync();
    }
    this._historyListeners.clear();
  }
}

function todayStr(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

export function extractPoolsFromModels(
  models: ReadonlyArray<{ modelId: string; remainingPercent: number }>,
): QuotaPoolsSnapshot | undefined {
  const out: QuotaPoolsSnapshot = {};
  let hasAny = false;
  for (const key of ['claude', 'gemini', 'argon'] as const) {
    const five = models.find((m) => m.modelId === `${key}:5h`)?.remainingPercent;
    const week = models.find((m) => m.modelId === `${key}:weekly`)?.remainingPercent;
    const vals = [five, week].filter((v): v is number => typeof v === 'number' && Number.isFinite(v));
    if (vals.length > 0) {
      out[key] = Math.round(Math.min(...vals));
      hasAny = true;
    } else {
      out[key] = null;
    }
  }
  return hasAny ? out : undefined;
}
