/**
 * 配额与健康探测编排器
 *
 * 统一托管：
 * - usageCache（globalState 持久化快照）与本地 resetTime 到期回血折算（resolveEffectiveUsage）
 * - 三档后台刷新范围：active（仅当前账号，默认）/ all（全池错峰）/ manual（关闭后台定时）
 * - 账号间随机抖动错峰拉取（消除同 IP 同毫秒多号齐射指纹）与窗口长时失焦挂机休眠
 * - 按需手动推理健康探针（与后台轮询彻底解耦，不在后台定时戳备用号推理端点）
 */
import * as vscode from 'vscode';
import * as accountStore from './accountStore';
import { readActiveAccount } from './geminiFiles';
import { extractPoolsFromModels, UsageTracker } from './usageTracker';
import { fetchUsage, checkAccountHealth, classifyAccountError, describeError } from './usageService';
import { AccountHealth, StoredAccount, UsageSnapshot } from './types';
import { t } from './i18n';
import { logInfo, logWarn } from './logger';
import { notifyUi } from './uiChannel';

const HEALTH_STALE_MS = 60 * 60 * 1000;
const IDLE_UNFOCUSED_PAUSE_MS = 30 * 60 * 1000;
const INTERACTIVE_CONCURRENCY = 2;
const BG_JITTER_MIN_MS = 1200;
const BG_JITTER_MAX_MS = 2500;
const FG_JITTER_MIN_MS = 550;
const FG_JITTER_MAX_MS = 1200;

export type QuotaRefreshScope = 'active' | 'all' | 'manual';

export function normalizeRefreshScope(v: unknown): QuotaRefreshScope {
  if (v === 'active' || v === 'all' || v === 'manual') return v;
  return 'active';
}

/**
 * 纯函数：将已跨过官方 resetTime 的配额窗口在读取侧折算为 100%（保留原 resetTime 供界面展示「已重置」），
 * 不原地修改持久化快照，也不写入历史曲线。
 */
export function resolveEffectiveUsage(
  snapshot: UsageSnapshot | undefined,
  nowMs = Date.now(),
): UsageSnapshot | undefined {
  if (!snapshot || !Array.isArray(snapshot.models) || snapshot.models.length === 0) {
    return snapshot;
  }
  let changed = false;
  const nextModels = snapshot.models.map((m) => {
    if (m.remainingPercent < 100 && m.resetTime) {
      const ts = Date.parse(m.resetTime);
      if (Number.isFinite(ts) && ts <= nowMs) {
        changed = true;
        return { ...m, remainingPercent: 100 };
      }
    }
    return m;
  });
  if (!changed) return snapshot;
  const minRemainingPercent = Math.min(...nextModels.map((m) => m.remainingPercent));
  return {
    ...snapshot,
    minRemainingPercent,
    models: nextModels,
  };
}

export interface QuotaUiBridge {
  onUsageUpdated?: (email: string, snapshot: UsageSnapshot) => void;
  onUsageError?: (email: string, error: string) => void;
  onHealthUpdated?: (email: string, health: AccountHealth) => void;
  onAccountsRefreshNeeded?: () => void;
  onTrackerChanged?: () => void;
}

export interface QuotaOrchestratorOptions {
  sleepFn?: (ms: number) => Promise<void>;
  focusResumeDelayMs?: number;
}

export class QuotaOrchestrator implements vscode.Disposable {
  private readonly _context: vscode.ExtensionContext;
  private readonly _usageTracker: UsageTracker;
  private readonly _bridge: QuotaUiBridge;
  private readonly _sleepFn: (ms: number) => Promise<void>;
  private readonly _focusResumeDelayMs: number;
  private readonly _usageCache = new Map<string, UsageSnapshot>();
  private readonly _usageErrors = new Map<string, string>();
  private _usageCacheLastRefresh = 0;
  private _refreshAllInFlight = false;
  private _quotaRefreshTimer: NodeJS.Timeout | null = null;
  private _startupUsageTimer: NodeJS.Timeout | null = null;
  private _focusResumeTimer: NodeJS.Timeout | null = null;
  private _windowStateSub: vscode.Disposable | undefined;
  private _unfocusedSince: number | null = null;
  private _disposed = false;

  constructor(
    context: vscode.ExtensionContext,
    usageTracker: UsageTracker,
    bridge: QuotaUiBridge = {},
    opts: QuotaOrchestratorOptions = {},
  ) {
    this._context = context;
    this._usageTracker = usageTracker;
    this._bridge = bridge;
    this._sleepFn = opts.sleepFn ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
    this._focusResumeDelayMs = opts.focusResumeDelayMs ?? (opts.sleepFn ? 5 : 1200);
    this._loadUsageCache();
    this._initWindowFocusTracking();
  }

  getUsage(email: string): UsageSnapshot | undefined {
    return resolveEffectiveUsage(this._usageCache.get(email));
  }

  getUsageError(email: string): string | undefined {
    return this._usageErrors.get(email);
  }

  isRefreshInFlight(): boolean {
    return this._refreshAllInFlight;
  }

  isCacheStale(): boolean {
    return this._isTargetStale();
  }

  /** 仅供沙箱门禁注入模拟失焦起点时间戳 */
  _setUnfocusedSinceForTest(ts: number | null): void {
    this._unfocusedSince = ts;
  }

  async refreshOneAccountUsage(email: string, opts: { batch?: boolean } = {}): Promise<UsageSnapshot | null> {
    const targetLower = email.toLowerCase();
    const account = accountStore.getAll().find((a) => a.email.toLowerCase() === targetLower && !a.disabled);
    if (!account) return null;

    try {
      const snapshot = await fetchUsage(account);
      this._usageCache.set(account.email, snapshot);
      this._usageCacheLastRefresh = Date.now();
      this._usageErrors.delete(account.email);
      if (account.health?.status === 'auth_invalid') {
        accountStore.update(account.email, { health: undefined });
      }
      if (!opts.batch) {
        this._saveUsageCache();
      }
      this._usageTracker.recordRefresh();
      this._usageTracker.recordUsage(
        account.email,
        snapshot.minRemainingPercent,
        snapshot.tierId,
        extractPoolsFromModels(snapshot.models),
      );
      this._bridge.onUsageUpdated?.(account.email, resolveEffectiveUsage(snapshot) ?? snapshot);
      if (!opts.batch) {
        this._bridge.onTrackerChanged?.();
      }
      return snapshot;
    } catch (err) {
      const msg = describeError(err);
      logWarn('usage.refresh.fail', { email: account.email, error: msg });
      this._usageErrors.set(account.email, msg);
      // 失败不清 usageCache：继续展示上次成功快照，仅标注失败明细；只让明确的凭据失效/封禁信号落盘
      const health = this._healthFromError(err);
      if (health.status === 'auth_invalid' || health.status === 'banned') {
        this._persistHealthIfChanged(account.email, health);
      }
      this._bridge.onUsageError?.(account.email, msg);
      return null;
    }
  }

  /** 按当前配置的后台范围（active / all / manual）与窗口闲置状态执行单次后台周期 */
  async refreshBackgroundCycle(): Promise<void> {
    if (this._disposed) return;
    const scope = this._quotaRefreshScope();
    if (scope === 'manual') return;
    if (this._isIdlePaused()) {
      logInfo('usage.refresh.skip.idle_unfocused');
      return;
    }
    if (scope === 'all') {
      await this.refreshAllBackground();
      return;
    }
    if (this._refreshAllInFlight) {
      logInfo('usage.refresh.skip.inflight');
      return;
    }
    const active = this._resolveActiveEnabledAccount();
    if (!active) return;
    this._refreshAllInFlight = true;
    try {
      await this.refreshOneAccountUsage(active.email);
    } finally {
      this._refreshAllInFlight = false;
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
      await this._runStaggered(accounts, 1, BG_JITTER_MIN_MS, BG_JITTER_MAX_MS, async (account) => {
        if (!this._disposed) {
          await this.refreshOneAccountUsage(account.email, { batch: true });
        }
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
      await this._runStaggered(accounts, INTERACTIVE_CONCURRENCY, FG_JITTER_MIN_MS, FG_JITTER_MAX_MS, async (account) => {
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

      await this._runStaggered(accounts, INTERACTIVE_CONCURRENCY, FG_JITTER_MIN_MS, FG_JITTER_MAX_MS, async (account) => {
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
    const targetLower = email.toLowerCase();
    const account = accountStore.getAll().find((a) => a.email.toLowerCase() === targetLower);
    if (!account) return null;
    const health = await checkAccountHealth(account);
    this._persistHealthIfChanged(account.email, health);
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
      return a.health.status !== 'ok' || !Number.isFinite(age) || Date.now() - age > HEALTH_STALE_MS;
    });

    await this._runStaggered(accounts, INTERACTIVE_CONCURRENCY, FG_JITTER_MIN_MS, FG_JITTER_MAX_MS, async (account) => {
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
    const scope = this._quotaRefreshScope();
    if (scope === 'manual') {
      if (this._startupUsageTimer) {
        clearTimeout(this._startupUsageTimer);
        this._startupUsageTimer = null;
      }
      return;
    }
    this._quotaRefreshTimer = setInterval(() => {
      void this.refreshBackgroundCycle();
    }, this._quotaRefreshMs());
  }

  scheduleStartupTasks(): vscode.Disposable {
    this._clearTimers();
    if (this._quotaRefreshScope() !== 'manual') {
      this._startupUsageTimer = setTimeout(() => {
        this._startupUsageTimer = null;
        if (!this._disposed && this._isTargetStale()) {
          void this.refreshBackgroundCycle();
        }
      }, 2000);
    }
    this.applyRefreshInterval();
    return { dispose: () => this.dispose() };
  }

  dispose(): void {
    this._disposed = true;
    this._clearTimers();
    this._windowStateSub?.dispose();
    this._windowStateSub = undefined;
  }

  private _initWindowFocusTracking(): void {
    if (vscode.window?.state?.focused === false) {
      this._unfocusedSince = Date.now();
    }
    if (typeof vscode.window?.onDidChangeWindowState === 'function') {
      this._windowStateSub = vscode.window.onDidChangeWindowState((state) => {
        if (this._disposed) return;
        if (!state.focused) {
          if (this._unfocusedSince === null) {
            this._unfocusedSince = Date.now();
          }
          if (this._focusResumeTimer) {
            clearTimeout(this._focusResumeTimer);
            this._focusResumeTimer = null;
          }
          return;
        }
        this._unfocusedSince = null;
        if (this._quotaRefreshScope() === 'manual' || !this._isTargetStale()) return;
        if (this._focusResumeTimer) clearTimeout(this._focusResumeTimer);
        this._focusResumeTimer = setTimeout(() => {
          this._focusResumeTimer = null;
          if (!this._disposed && this._isTargetStale()) {
            void this.refreshBackgroundCycle();
          }
        }, this._focusResumeDelayMs);
      });
    }
  }

  private _isIdlePaused(): boolean {
    return this._unfocusedSince !== null && Date.now() - this._unfocusedSince >= IDLE_UNFOCUSED_PAUSE_MS;
  }

  private _resolveActiveEnabledAccount(): StoredAccount | undefined {
    const raw = this._context.globalState.get<string>('currentEmail') || readActiveAccount();
    if (!raw) return undefined;
    const lower = raw.toLowerCase();
    return accountStore.getAll().find((a) => !a.disabled && a.email.toLowerCase() === lower);
  }

  private _isAccountStale(email: string): boolean {
    const snap = this._usageCache.get(email);
    if (!snap || !snap.updatedAt) return true;
    return Date.now() - snap.updatedAt > this._quotaRefreshMs();
  }

  private _isTargetStale(): boolean {
    const scope = this._quotaRefreshScope();
    if (scope === 'manual') return false;
    if (scope === 'active') {
      const active = this._resolveActiveEnabledAccount();
      return active ? this._isAccountStale(active.email) : false;
    }
    const enabled = accountStore.getAll().filter((a) => !a.disabled);
    if (enabled.length === 0) return false;
    if (this._usageCache.size === 0 || Date.now() - this._usageCacheLastRefresh > this._quotaRefreshMs()) {
      return true;
    }
    return enabled.some((a) => this._isAccountStale(a.email));
  }

  private _clearTimers(): void {
    if (this._quotaRefreshTimer) {
      clearInterval(this._quotaRefreshTimer);
      this._quotaRefreshTimer = null;
    }
    if (this._startupUsageTimer) {
      clearTimeout(this._startupUsageTimer);
      this._startupUsageTimer = null;
    }
    if (this._focusResumeTimer) {
      clearTimeout(this._focusResumeTimer);
      this._focusResumeTimer = null;
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

  private _quotaRefreshScope(): QuotaRefreshScope {
    const raw = vscode.workspace.getConfiguration('antigravityKite').get<string>('quotaRefreshScope', 'active');
    return normalizeRefreshScope(raw);
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
    const timestampStale = !Number.isFinite(prevAge) || Date.now() - prevAge > HEALTH_STALE_MS;
    const detailChanged = health.status !== 'ok' && (prev?.detail || '') !== (health.detail || '');
    if (prev?.status !== health.status || detailChanged || timestampStale) {
      accountStore.update(email, { health });
    }
    this._bridge.onHealthUpdated?.(email, health);
  }

  /**
   * 错峰派发执行器：第 1 个任务立即启动，后续每派发一个新任务前串行等待随机抖动延迟 [minDelayMs, maxDelayMs]，
   * 确保同一出口 IP 上绝不出现多账号同毫秒并发齐射。
   */
  private async _runStaggered<T>(
    items: readonly T[],
    concurrency: number,
    minDelayMs: number,
    maxDelayMs: number,
    worker: (item: T) => Promise<void>,
  ): Promise<void> {
    if (items.length === 0) return;
    let idx = 0;
    let gateChain: Promise<void> = Promise.resolve();

    const acquireNext = async (): Promise<T | undefined> => {
      let picked: T | undefined;
      let isSubsequent = false;
      const prev = gateChain;
      let release!: () => void;
      gateChain = new Promise<void>((r) => {
        release = r;
      });
      await prev;
      try {
        if (idx >= items.length || this._disposed) {
          return undefined;
        }
        isSubsequent = idx > 0;
        picked = items[idx++];
        if (isSubsequent && maxDelayMs > 0) {
          const span = Math.max(0, maxDelayMs - minDelayMs);
          const delay = minDelayMs + Math.floor(Math.random() * (span + 1));
          await this._sleepFn(delay);
        }
        return picked;
      } finally {
        release();
      }
    };

    const workerCount = Math.min(Math.max(1, concurrency), items.length);
    const workers = Array.from({ length: workerCount }, async () => {
      while (!this._disposed) {
        const item = await acquireNext();
        if (item === undefined) break;
        await worker(item);
      }
    });
    await Promise.all(workers);
  }
}
