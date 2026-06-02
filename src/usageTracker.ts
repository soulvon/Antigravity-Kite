/**
 * 用量统计追踪器
 *
 * 追踪每个账号和全局的用量数据，持久化到 globalState。
 * - 切号次数
 * - 配额刷新次数
 * - 每账号已用配额百分比（基于模型分组最低值）
 * - 配额变动历史（配额变化时记录快照）
 * - 每日自动重置计数
 */
import * as vscode from 'vscode';

// ─── 类型 ───────────────────────────────────────────────

export interface AccountStats {
  switchToCount: number;
  usedPct: number;       // 已用百分比 (100 - minRemainingPercent)
  lastCheckTs: number;
  tierId?: string;
}

export interface QuotaHistoryEntry {
  ts: number;
  email: string;
  remaining: number;     // minRemainingPercent
  delta: number;         // 变化量（负数 = 消耗）
  tierId?: string;
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
const HISTORY_KEY = 'usageTracker.quotaHistory';
const MAX_HISTORY = 10000;

// ─── 实现 ───────────────────────────────────────────────

export class UsageTracker {
  private _ctx: vscode.ExtensionContext;
  private _stats: PoolStats;
  private _dirty = false;
  private _saveTimer: NodeJS.Timeout | null = null;
  private _quotaHistory: QuotaHistoryEntry[] = [];
  private _lastQuotaMap: Map<string, number> = new Map(); // email → last remaining
  private _historyDirty = false;
  private _historySaveTimer: NodeJS.Timeout | null = null;
  private _historyListeners = new Set<() => void>();

  constructor(ctx: vscode.ExtensionContext) {
    this._ctx = ctx;
    this._stats = this._load();
    this._maybeResetDaily();
    this._quotaHistory = this._ctx.globalState.get<QuotaHistoryEntry[]>(HISTORY_KEY, []);
    // 恢复 lastQuotaMap
    for (let i = this._quotaHistory.length - 1; i >= 0; i--) {
      const e = this._quotaHistory[i];
      if (!this._lastQuotaMap.has(e.email)) {
        this._lastQuotaMap.set(e.email, e.remaining);
      }
    }
  }

  addHistoryListener(cb: () => void): { dispose(): void } {
    this._historyListeners.add(cb);
    return { dispose: () => { this._historyListeners.delete(cb); } };
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

  recordUsage(email: string, minRemainingPercent: number, tierId?: string): void {
    this._maybeResetDaily();
    const acct = this._ensureAccount(email);
    acct.usedPct = Math.max(0, 100 - minRemainingPercent);
    acct.lastCheckTs = Date.now();
    acct.tierId = tierId;

    // 配额变动历史（仅在数值变化时记录）
    const remaining = Math.round(minRemainingPercent);
    const last = this._lastQuotaMap.get(email);
    if (last === undefined || last !== remaining) {
      const delta = last !== undefined ? remaining - last : 0;
      this._quotaHistory.push({
        ts: Date.now(),
        email,
        remaining,
        delta,
        tierId,
      });
      if (this._quotaHistory.length > MAX_HISTORY) {
        this._quotaHistory.splice(0, this._quotaHistory.length - MAX_HISTORY);
      }
      this._lastQuotaMap.set(email, remaining);
      this._debounceHistorySave();
      for (const cb of this._historyListeners) { try { cb(); } catch {} }
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
    if (email) result = result.filter(e => e.email === email);
    return result.slice(-limit);
  }

  clearQuotaHistory(email?: string): void {
    if (email) {
      this._quotaHistory = this._quotaHistory.filter(e => e.email !== email);
      this._lastQuotaMap.delete(email);
    } else {
      this._quotaHistory = [];
      this._lastQuotaMap.clear();
    }
    this._ctx.globalState.update(HISTORY_KEY, this._quotaHistory);
    for (const cb of this._historyListeners) { try { cb(); } catch {} }
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
    this._dirty = true;
    if (this._saveTimer) return;
    this._saveTimer = setTimeout(() => {
      this._saveTimer = null;
      if (this._dirty) {
        this._dirty = false;
        this._ctx.globalState.update(STORAGE_KEY, this._stats);
      }
    }, 2000);
  }

  private _debounceHistorySave(): void {
    this._historyDirty = true;
    if (this._historySaveTimer) return;
    this._historySaveTimer = setTimeout(() => {
      this._historySaveTimer = null;
      if (this._historyDirty) {
        this._historyDirty = false;
        this._ctx.globalState.update(HISTORY_KEY, this._quotaHistory);
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
    if (this._saveTimer) { clearTimeout(this._saveTimer); this._saveTimer = null; }
    if (this._historySaveTimer) { clearTimeout(this._historySaveTimer); this._historySaveTimer = null; }
    if (this._dirty) {
      this._dirty = false;
      this._ctx.globalState.update(STORAGE_KEY, this._stats);
    }
    if (this._historyDirty) {
      this._historyDirty = false;
      this._ctx.globalState.update(HISTORY_KEY, this._quotaHistory);
    }
  }
}

function todayStr(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}
