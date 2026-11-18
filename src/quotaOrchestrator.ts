/**
 * 配额与健康探测编排器
 *
 * 统一托管：
 * - usageCache（globalState 持久化快照）与 usageErrors（失败不抹除旧快照）
 * - 单号刷新、后台定时全池刷新、交互式/带进度全池刷新（3 并发受控池 + 全局并发闸）
 * - 独立推理健康探针（与额度端点分离，只在状态翻转时落盘 accounts.json）
 * - 启动延迟任务与可清理定时器生命周期管理
 */
import * as vscode from 'vscode';
import * as accountStore from './accountStore';
import { UsageTracker } from './usageTracker';
import { fetchUsage, checkAccountHealth, classifyAccountError, describeError } from './usageService';
import { AccountHealth, UsageSnapshot } from './types';
import { t } from './i18n';
import { logInfo, logWarn } from './logger';
import { notifyUi } from './uiChannel';

const HEALTH_PROBE_INTERVAL_MS = 60 * 60 * 1000;
const POOL_CONCURRENCY = 3;

export interface QuotaUiBridge {
  onUsageUpdated?: (email: string, snapshot: UsageSnapshot) => void;
  onUsageError?: (email: string, error: string) => void;
  onHealthUpdated?: (email: string, health: AccountHealth) => void;
  onAccountsRefreshNeeded?: () => void;
  onTrackerChanged?: () => void;
}

export class QuotaOrchestrator implements vscode.Disposable {
  private readonly _context: vscode.ExtensionContext;
  private readonly _usageTracker: UsageTracker;
  private readonly _bridge: QuotaUiBridge;
  private readonly _usageCache = new Map<string, UsageSnapshot>();
  private readonly _usageErrors = new Map<string, string>();
  private _usageCacheLastRefresh = 0;
  private _refreshAllInFlight = false;
  private _quotaRefreshTimer: NodeJS.Timeout | null = null;
  private _healthProbeTimer: NodeJS.Timeout | null = null;
  private _startupUsageTimer: NodeJS.Timeout | null = null;
  private _startupHealthTimer: NodeJS.Timeout | null = null;
  private _disposed = false;

  constructor(context: vscode.ExtensionContext, usageTracker: UsageTracker, bridge: QuotaUiBridge = {}) {
    this._context = context;
    this._usageTracker = usageTracker;
    this._bridge = bridge;
    this._loadUsageCache();
  }

  getUsage(email: string): UsageSnapshot | undefined {
    return this._usageCache.get(email);
  }

  getUsageError(email: string): string | undefined {
    return this._usageErrors.get(email);
  }

  isRefreshInFlight(): boolean {
    return this._refreshAllInFlight;
  }

  isCacheStale(): boolean {
    return this._usageCache.size === 0 || Date.now() - this._usageCacheLastRefresh > this._quotaRefreshMs();
  }

  async refreshOneAccountUsage(email: string, opts: { batch?: boolean } = {}): Promise<UsageSnapshot | null> {
    const account = accountStore.getAll().find((a) => a.email === email && !a.disabled);
    if (!account) return null;

    try {
      const snapshot = await fetchUsage(account);
      this._usageCache.set(email, snapshot);
      this._usageCacheLastRefresh = Date.now();
      this._usageErrors.delete(email);
      if (account.health?.status === 'auth_invalid') {
        accountStore.update(email, { health: undefined });
      }
      if (!opts.batch) {
        this._saveUsageCache();
      }
      this._usageTracker.recordRefresh();
      this._usageTracker.recordUsage(email, snapshot.minRemainingPercent, snapshot.tierId);
      this._bridge.onUsageUpdated?.(email, snapshot);
      if (!opts.batch) {
        this._bridge.onTrackerChanged?.();
      }
      return snapshot;
    } catch (err) {
      const msg = describeError(err);
      logWarn('usage.refresh.fail', { email, error: msg });
      this._usageErrors.set(email, msg);
      // 失败不清 usageCache：继续展示上次成功快照，仅标注失败明细；只让明确的凭据失效/封禁信号落盘
      const health = this._healthFromError(err);
      if (health.status === 'auth_invalid' || health.status === 'banned') {
        this._persistHealthIfChanged(email, health);
      }
      this._bridge.onUsageError?.(email, msg);
      return null;
    }
  }

  async refreshAllBackground(): Promise<void> {
    if (this._refreshAllInFlight || this._disposed) {
      logInfo('usage.refresh.skip.inflight');
      return;
    }
    this._refreshAllInFlight = true;
    try {
      logInfo('usage.refresh.background.start');
      const accounts = accountStore.getAll().filter((a) => !a.disabled);
      await this._runConcurrent(accounts, POOL_CONCURRENCY, async (account) => {
        await this.refreshOneAccountUsage(account.email, { batch: true });
      });
      this._saveUsageCache();
      this._bridge.onTrackerChanged?.();
      logInfo('usage.refresh.background.done', { count: accounts.length });
    } finally {
      this._refreshAllInFlight = false;
    }
  }

  async refreshAllInteractive(): Promise<number> {
    if (this._refreshAllInFlight) {
      notifyUi('info', t('refreshInProgress'));
      logInfo('usage.refresh.skip.inflight');
      return 0;
    }
    this._refreshAllInFlight = true;
    try {
      const accounts = accountStore.getAll().filter((a) => !a.disabled);
      let successCount = 0;
      await this._runConcurrent(accounts, POOL_CONCURRENCY, async (account) => {
        const snap = await this.refreshOneAccountUsage(account.email, { batch: true });
        if (snap) successCount++;
      });
      this._saveUsageCache();
      this._bridge.onTrackerChanged?.();
      this._bridge.onAccountsRefreshNeeded?.();
      return successCount;
    } finally {
      this._refreshAllInFlight = false;
    }
  }

  async refreshAllWithProgress(
    onProgress?: (done: number, total: number) => void,
  ): Promise<{ total: number; successCount: number; errorCount: number; lastError: string }> {
    if (this._refreshAllInFlight) {
      logInfo('usage.refresh.skip.inflight');
      return { total: 0, successCount: 0, errorCount: 0, lastError: '' };
    }
    this._refreshAllInFlight = true;
    try {
      const accounts = accountStore.getAll().filter((a) => !a.disabled);
      const total = accounts.length;
      let successCount = 0;
      let doneCount = 0;
      let lastError = '';

      if (total > 0) {
        onProgress?.(0, total);
      }

      await this._runConcurrent(accounts, POOL_CONCURRENCY, async (account) => {
        const snap = await this.refreshOneAccountUsage(account.email, { batch: true });
        if (snap) {
          successCount++;
        } else {
          const err = this._usageErrors.get(account.email);
          if (err) lastError = err;
        }
        doneCount++;
        onProgress?.(doneCount, total);
      });

      const errorCount = total - successCount;
      if (!lastError && errorCount > 0) {
        lastError = Array.from(this._usageErrors.values()).pop() || '';
      }

      this._saveUsageCache();
      this._bridge.onAccountsRefreshNeeded?.();
      this._bridge.onTrackerChanged?.();
      return { total, successCount, errorCount, lastError };
    } finally {
      this._refreshAllInFlight = false;
    }
  }

  async probeOneHealth(email: string): Promise<AccountHealth | null> {
    const account = accountStore.getAll().find((a) => a.email === email);
    if (!account) return null;
    const health = await checkAccountHealth(account);
    this._persistHealthIfChanged(email, health);
    return health;
  }

  async probeAllHealth(onlyStale = false): Promise<void> {
    if (this._disposed) return;
    logInfo('health.probeAll.start', { onlyStale });
    const accounts = accountStore.getAll().filter((a) => {
      if (a.disabled) return false;
      if (!onlyStale) return true;
      if (!a.health) return true;
      const age = Date.parse(a.health.checkedAt);
      return a.health.status !== 'ok' || !Number.isFinite(age) || Date.now() - age > HEALTH_PROBE_INTERVAL_MS;
    });

    await this._runConcurrent(accounts, POOL_CONCURRENCY, async (account) => {
      try {
        const health = await checkAccountHealth(account);
        this._persistHealthIfChanged(account.email, health);
      } catch (e) {
        logWarn('health.probe.unexpected', {
          email: account.email,
          error: e instanceof Error ? e.message : String(e),
        });
      }
    });
    logInfo('health.probeAll.done', { count: accounts.length });
  }

  applyRefreshInterval(): void {
    if (this._disposed) return;
    if (this._quotaRefreshTimer) {
      clearInterval(this._quotaRefreshTimer);
      this._quotaRefreshTimer = null;
    }
    this._quotaRefreshTimer = setInterval(() => {
      void this.refreshAllBackground();
    }, this._quotaRefreshMs());
  }

  scheduleStartupTasks(): vscode.Disposable {
    this._clearTimers();
    this._startupUsageTimer = setTimeout(() => {
      this._startupUsageTimer = null;
      if (!this._disposed && this.isCacheStale()) {
        void this.refreshAllBackground();
      }
    }, 2000);

    this._startupHealthTimer = setTimeout(() => {
      this._startupHealthTimer = null;
      if (!this._disposed) {
        void this.probeAllHealth(true);
      }
    }, 8000);

    this._healthProbeTimer = setInterval(() => {
      if (!this._disposed) {
        void this.probeAllHealth();
      }
    }, HEALTH_PROBE_INTERVAL_MS);

    this.applyRefreshInterval();
    return { dispose: () => this.dispose() };
  }

  dispose(): void {
    this._disposed = true;
    this._clearTimers();
  }

  private _clearTimers(): void {
    if (this._quotaRefreshTimer) {
      clearInterval(this._quotaRefreshTimer);
      this._quotaRefreshTimer = null;
    }
    if (this._healthProbeTimer) {
      clearInterval(this._healthProbeTimer);
      this._healthProbeTimer = null;
    }
    if (this._startupUsageTimer) {
      clearTimeout(this._startupUsageTimer);
      this._startupUsageTimer = null;
    }
    if (this._startupHealthTimer) {
      clearTimeout(this._startupHealthTimer);
      this._startupHealthTimer = null;
    }
  }

  private _loadUsageCache(): void {
    const saved = this._context.globalState.get<Record<string, UsageSnapshot>>('usageCache');
    const ts = this._context.globalState.get<number>('usageCacheTs') || 0;
    if (saved) {
      for (const [email, snap] of Object.entries(saved)) {
        this._usageCache.set(email, snap);
      }
    }
    this._usageCacheLastRefresh = ts;
  }

  private _saveUsageCache(): void {
    const obj: Record<string, UsageSnapshot> = {};
    this._usageCache.forEach((v, k) => {
      obj[k] = v;
    });
    void this._context.globalState.update('usageCache', obj);
    void this._context.globalState.update('usageCacheTs', this._usageCacheLastRefresh);
  }

  private _quotaRefreshMs(): number {
    const minutes = vscode.workspace.getConfiguration('antigravityKite').get<number>('quotaRefreshMinutes', 15);
    return Math.min(120, Math.max(5, minutes)) * 60 * 1000;
  }

  private _healthFromError(err: unknown): AccountHealth {
    const msg = err instanceof Error ? err.message : String(err);
    return {
      status: classifyAccountError(msg),
      checkedAt: new Date().toISOString(),
      detail: msg.slice(0, 300),
    };
  }

  private _persistHealthIfChanged(email: string, health: AccountHealth): void {
    const prev = accountStore.getByEmail(email)?.health;
    if (health.status !== 'ok') {
      logWarn('health.probe', { email, status: health.status, detail: health.detail || '' });
    }
    const prevAge = prev?.checkedAt ? Date.parse(prev.checkedAt) : NaN;
    const timestampStale = !Number.isFinite(prevAge) || Date.now() - prevAge > HEALTH_PROBE_INTERVAL_MS;
    const detailChanged = health.status !== 'ok' && (prev?.detail || '') !== (health.detail || '');
    if (prev?.status !== health.status || detailChanged || timestampStale) {
      accountStore.update(email, { health });
    }
    this._bridge.onHealthUpdated?.(email, health);
  }

  private async _runConcurrent<T>(
    items: readonly T[],
    concurrency: number,
    worker: (item: T) => Promise<void>,
  ): Promise<void> {
    if (items.length === 0) return;
    let idx = 0;
    const workers = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
      while (idx < items.length) {
        const item = items[idx++];
        await worker(item);
      }
    });
    await Promise.all(workers);
  }
}
