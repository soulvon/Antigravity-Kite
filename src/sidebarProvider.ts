import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import * as crypto from 'crypto';
import * as accountStore from './accountStore';
import {
  runOAuthUiFlow, copyActiveOAuthUrl, openActiveOAuthBrowser, submitActiveOAuthCallback, cancelActiveOAuthSession,
} from './oauthService';
import { previewLocalAccount, confirmImport, cancelImport } from './localReader';
import * as importService from './importService';
import { WebviewMessage, UsageSnapshot, AccountHealth } from './types';
import type { TokenLedgerSummary } from './tokenLedger';
import type { StatsSummary } from './usageTracker';
import { enableCdp } from './cdpGate';
import { probeCdpPort } from './declarationSuppressor';
import { t, localeBundle, getLang } from './i18n';
import { logInfo, logWarn, logError } from './logger';
import { normalizeRefreshScope } from './quotaOrchestrator';
import { notifyUi, UiPresenter, UiAskOptions, UiStatus } from './uiChannel';

export interface SidebarActionHandlers {
  requestSwitch: (email: string) => Promise<void>;
  refreshOneUsage: (email: string) => Promise<void>;
  refreshAllWithProgress: (onProgress: (done: number, total: number) => void) => Promise<{ total: number; successCount: number; errorCount: number; lastError: string }>;
  isRefreshInFlight: () => boolean;
  getUsageSnapshot: (email: string) => UsageSnapshot | undefined;
  getUsageError: (email: string) => string | undefined;
  probeOneHealth: (email: string) => Promise<AccountHealth | null>;
  onQuotaRefreshMinutesChanged: () => void;
  onPrivacyChanged: (enabled: boolean) => void;
  getTrackerSummary?: () => StatsSummary | null;
  getLedgerSummary?: (forceRescan?: boolean) => Promise<TokenLedgerSummary> | TokenLedgerSummary;
}

const _htmlTemplateCache = new Map<string, string>();

export class SidebarProvider implements vscode.WebviewViewProvider, UiPresenter, vscode.Disposable {
  public static readonly viewType = 'antigravityKite.sidebar';
  private _view?: vscode.WebviewView;
  private _webviewReady = false;
  /** webview 未就绪时暂存的提示/询问，ready 后按序补发 */
  private _outbox: unknown[] = [];
  private _askResolvers = new Map<string, (ok: boolean, reason?: string) => void>();
  private _askTimers = new Set<NodeJS.Timeout>();
  private _savingSettingsDepth = 0;
  private _statsTimer: NodeJS.Timeout | null = null;
  private _cachedPerAccountTokens: Record<string, unknown> = {};
  private _disposed = false;
  private _messageDisposable?: vscode.Disposable;
  private _viewDisposeDisposable?: vscode.Disposable;
  private _visibilityDisposable?: vscode.Disposable;
  private _context: vscode.ExtensionContext;
  private _handlers: Partial<SidebarActionHandlers>;

  constructor(
    private readonly _extensionUri: vscode.Uri,
    context: vscode.ExtensionContext,
    handlers: Partial<SidebarActionHandlers> = {}
  ) {
    this._context = context;
    this._handlers = handlers;
  }

  public refresh(): void {
    if (this._view) {
      this._pushAccounts();
    }
  }

  public refreshStatsSummary(forceRescan = false): void {
    if (this._disposed || !this._view) return;
    if (this._statsTimer) {
      clearTimeout(this._statsTimer);
      this._statsTimer = null;
    }
    this._statsTimer = setTimeout(() => {
      this._statsTimer = null;
      void this._pushStatsSummary(forceRescan);
    }, 300);
  }

  private async _pushStatsSummary(forceRescan: boolean): Promise<void> {
    if (this._disposed || !this._view) return;
    try {
      const tracker = this._handlers.getTrackerSummary?.() ?? null;
      const ledger = this._handlers.getLedgerSummary ? await this._handlers.getLedgerSummary(forceRescan) : null;
      if (this._disposed || !this._view) return;
      if (ledger?.perAccount) {
        this._cachedPerAccountTokens = ledger.perAccount;
      }
      void this._view.webview.postMessage({
        type: 'sidebarStats',
        todayTokens: ledger?.totals.today.total ?? 0,
        todayWeighted: ledger?.totals.today.weighted ?? 0,
        todayCostUsd: ledger?.totals.today.costUsd ?? 0,
        todaySavedUsd: ledger?.totals.today.savedByCacheUsd ?? 0,
        todayDesktopTokens: ledger?.totals.today.desktopTotal ?? 0,
        todayCliTokens: ledger?.totals.today.cliTotal ?? 0,
        todaySteps: ledger?.totals.today.steps ?? 0,
        todaySwitches: tracker?.totalSwitches ?? 0,
        todayRefreshes: tracker?.totalRefreshes ?? 0,
        perAccountTokens: this._cachedPerAccountTokens,
      });
    } catch (err) {
      logWarn('sidebar.pushStatsFail', err instanceof Error ? err.message : String(err));
    }
  }

  public postMessage(message: unknown): void {
    if (this._view) {
      void this._view.webview.postMessage(message);
    }
  }

  public broadcastPrivacy(enabled: boolean): void {
    this._view?.webview.postMessage({ type: 'privacyMode', enabled });
  }

  /** 单条提示：走侧栏 toast */
  public notify(status: UiStatus, message: string): void {
    this._post({ type: 'toast', status, message });
  }

  /** 需要确认的询问：走侧栏模态框，返回是否点了主按钮 */
  public ask(options: UiAskOptions): Promise<boolean> {
    const id = 'ask_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 7);
    return new Promise<boolean>((resolve) => {
      let settled = false;
      let timeout: NodeJS.Timeout | undefined;
      let unavailableTimer: NodeJS.Timeout | undefined;
      const settle = (ok: boolean, reason?: string) => {
        if (settled) return;
        settled = true;
        this._askResolvers.delete(id);
        if (timeout) {
          clearTimeout(timeout);
          this._askTimers.delete(timeout);
        }
        if (unavailableTimer) {
          clearTimeout(unavailableTimer);
          this._askTimers.delete(unavailableTimer);
        }
        if (reason) logWarn('ui.ask.' + reason, { id, title: options.title });
        if (ok && options.linkUrl) {
          void vscode.env.openExternal(vscode.Uri.parse(options.linkUrl));
        }
        resolve(ok);
      };
      timeout = setTimeout(() => {
        const wasOpen = this._askResolvers.has(id);
        settle(false, 'timeout');
        if (wasOpen) this._view?.webview.postMessage({ type: 'askDismiss', id });
      }, 120000);
      this._askTimers.add(timeout);
      this._askResolvers.set(id, settle);
      this._post({ type: 'ask', id, ...options }, !options.silent);
      if (!options.silent) {
        unavailableTimer = setTimeout(() => {
          if (!settled && !this._webviewReady) settle(false, 'sidebar-unavailable');
        }, 5000);
        this._askTimers.add(unavailableTimer);
      }
    });
  }

  /** 投递一条消息：webview 就绪立即发，否则入队 */
  private _post(msg: { type: string; [key: string]: unknown }, focusSidebar = true): void {
    if (this._webviewReady && this._view) {
      const res = this._view.webview.postMessage(msg);
      if (res && typeof (res as unknown as PromiseLike<boolean>).then === 'function') {
        (res as unknown as Promise<boolean>).then(
          (ok) => { if (!ok) logWarn('ui.post', { type: msg.type, delivered: false }); },
          (e) => logWarn('ui.post', e),
        );
      }
      return;
    }
    if (this._outbox.length > 20) this._outbox.shift();
    this._outbox.push(msg);
    if (!focusSidebar) {
      logInfo('ui.queued', { type: msg.type, silent: true });
      return;
    }
    void vscode.commands.executeCommand('antigravityKite.sidebar.focus').then(
      () => logInfo('ui.focus', { ok: true }),
      (e) => logWarn('ui.focus', e),
    );
  }

  private _flushOutbox(): void {
    if (!this._view || !this._webviewReady) return;
    const queued = this._outbox;
    this._outbox = [];
    for (const msg of queued) {
      void this._view.webview.postMessage(msg);
    }
  }

  public resolveWebviewView(
    webviewView: vscode.WebviewView,
    _context: vscode.WebviewViewResolveContext,
    _token: vscode.CancellationToken,
  ): void {
    this._messageDisposable?.dispose();
    this._viewDisposeDisposable?.dispose();
    this._visibilityDisposable?.dispose();
    this._view = webviewView;
    this._webviewReady = false;
    logInfo('webview.resolve', { viewType: SidebarProvider.viewType });

    webviewView.webview.options = {
      enableScripts: true,
      localResourceRoots: [this._extensionUri],
    };

    webviewView.webview.html = this._getHtmlForWebview(webviewView.webview);
    try {
      webviewView.title = 'v' + this._context.extension.packageJSON.version;
    } catch (e) {
      logInfo('webview.title.readonly', { reason: e instanceof Error ? e.message : String(e) });
    }
    logInfo('webview.html-set', { bytes: webviewView.webview.html.length });

    this._messageDisposable = webviewView.webview.onDidReceiveMessage(async (msg: WebviewMessage) => {
      await this._handleMessage(msg);
    });
    this._visibilityDisposable = webviewView.onDidChangeVisibility(() => {
      if (webviewView.visible) this.refreshStatsSummary(false);
    });
    this._viewDisposeDisposable = webviewView.onDidDispose(() => {
      this._messageDisposable?.dispose();
      this._messageDisposable = undefined;
      this._visibilityDisposable?.dispose();
      this._visibilityDisposable = undefined;
      this._viewDisposeDisposable?.dispose();
      this._viewDisposeDisposable = undefined;
      if (this._view === webviewView) {
        this._view = undefined;
        this._webviewReady = false;
      }
    });

    this._pushAccounts();
  }

  public dispose(): void {
    this._disposed = true;
    cancelActiveOAuthSession();
    if (this._statsTimer) {
      clearTimeout(this._statsTimer);
      this._statsTimer = null;
    }
    this._messageDisposable?.dispose();
    this._messageDisposable = undefined;
    this._visibilityDisposable?.dispose();
    this._visibilityDisposable = undefined;
    this._viewDisposeDisposable?.dispose();
    this._viewDisposeDisposable = undefined;
    for (const timer of this._askTimers) {
      clearTimeout(timer);
    }
    this._askTimers.clear();
    for (const [, settle] of this._askResolvers) {
      settle(false, 'disposed');
    }
    this._askResolvers.clear();
    this._view = undefined;
    this._webviewReady = false;
  }

  private _pushAccounts(): void {
    const accounts = accountStore.getAll();
    const currentEmail = this._context.globalState.get<string>('currentEmail') || '';
    const accountsWithUsage = accounts.map(a => ({
      ...a,
      usage: this._handlers.getUsageSnapshot?.(a.email),
      _usageError: this._handlers.getUsageError?.(a.email),
    }));
    const payload = {
      type: 'accounts',
      accounts: accountsWithUsage,
      currentEmail,
      privacyMode: this._context.globalState.get<boolean>('privacyMode', false),
      perAccountTokens: this._cachedPerAccountTokens,
    };
    const res = this._view?.webview.postMessage(payload);
    if (res && typeof (res as unknown as PromiseLike<boolean>).then === 'function') {
      (res as unknown as Promise<boolean>).then(
        (ok) => logInfo('webview.pushAccounts', { count: accountsWithUsage.length, currentEmail, viewAttached: true, delivered: ok }),
        (err) => logError('webview.pushAccounts.reject', { count: accountsWithUsage.length, error: err instanceof Error ? err.message : String(err) }),
      );
    } else {
      logWarn('webview.pushAccounts', { count: accountsWithUsage.length, currentEmail, viewAttached: false });
    }
  }

  /** 状态栏快速切号入口：复用统一切号处理器 */
  public async requestSwitch(email: string): Promise<void> {
    await this._handleMessage({ type: 'setCurrentAccount', email });
  }

  /** 底栏"打开设置"快捷入口：聚焦侧栏并弹出设置模态框（可选定位至视图区块） */
  public openSettingsUi(section?: string): void {
    void vscode.commands.executeCommand('antigravityKite.sidebar.focus');
    this._post({ type: 'openSettings', section: section || '' }, true);
  }

  /** 推送设置到 webview */
  private _pushSettings(): void {
    const cfg = vscode.workspace.getConfiguration('antigravityKite');
    void this._view?.webview.postMessage({
      type: 'settings',
      settings: {
        updateAutoCheck: cfg.get<boolean>('update.autoCheck', true),
        updateAutoInstall: cfg.get<boolean>('update.autoInstall', true),
        autoConfirmDeclaration: cfg.get<boolean>('autoConfirmDeclaration', true),
        cdpPort: cfg.get<number>('cdpPort', 9333),
        cdpHeartbeatMs: cfg.get<number>('cdpHeartbeatMs', 500),
        syncGeminiFiles: cfg.get<boolean>('switch.syncGeminiFiles', true),
        syncRemoteAuth: cfg.get<boolean>('remote.syncAuth', true),
        quotaRefreshScope: normalizeRefreshScope(cfg.get<string>('quotaRefreshScope', 'active')),
        quotaRefreshMinutes: cfg.get<number>('quotaRefreshMinutes', 15),
        locale: cfg.get<string>('locale', 'auto'),
        sidebarCardView: cfg.get<string>('sidebar.cardView', 'classic'),
        sidebarShowCardTokens: cfg.get<boolean>('sidebar.showCardTokens', true),
        statusBarEnabled: cfg.get<boolean>('statusBar.enabled', true),
        statusBarPosition: cfg.get<string>('statusBar.position', 'right'),
        statusBarStyle: cfg.get<string>('statusBar.style', 'pulse'),
        statusBarAccount: cfg.get<boolean>('statusBar.showAccount', true),
        statusBarModels: cfg.get<boolean>('statusBar.showModels', true),
        statusBarCredits: cfg.get<boolean>('statusBar.showCredits', true),
        statusBarPool: cfg.get<boolean>('statusBar.showPool', true),
        statusBarTier: cfg.get<boolean>('statusBar.showTier', true),
        statusBarResetCountdown: cfg.get<boolean>('statusBar.showResetCountdown', true),
        statusBarLiveContext: cfg.get<boolean>('statusBar.showLiveContext', true),
        statusBarLiveSpeed: cfg.get<boolean>('statusBar.showLiveSpeed', true),
        statusBarFamilies: cfg.get<string[]>('statusBar.families', ['claude', 'gemini', 'argon']),
      },
    });
  }

  /** 外部（VS Code 原生设置面板 / settings.json）修改配置时同步侧栏，避免旧表单回写覆盖 */
  public onExternalConfigurationChanged(e: vscode.ConfigurationChangeEvent): void {
    if (this._savingSettingsDepth > 0 || !this._view) return;
    if (e.affectsConfiguration('antigravityKite.locale')) {
      this._webviewReady = false;
      this._view.webview.html = this._getHtmlForWebview(this._view.webview);
      return;
    }
    if (e.affectsConfiguration('antigravityKite')) {
      this._pushSettings();
    }
  }

  /** 保存设置到全局配置 */
  private async _saveSettings(s: Record<string, unknown>, silent = false): Promise<void> {
    const cfg = vscode.workspace.getConfiguration('antigravityKite');
    const target = vscode.ConfigurationTarget.Global;
    const port = Number(s.cdpPort);
    const prevLocale = cfg.get<string>('locale', 'auto');
    const nextLocale = String(s.locale ?? 'auto');
    const prevQuotaScope = normalizeRefreshScope(cfg.get<string>('quotaRefreshScope', 'active'));
    const nextQuotaScope = normalizeRefreshScope(s.quotaRefreshScope);
    const quotaMin = Number(s.quotaRefreshMinutes);
    const prevQuotaMin = cfg.get<number>('quotaRefreshMinutes', 15);
    const normalizedQuotaMin = Number.isFinite(quotaMin) ? Math.min(120, Math.max(5, Math.round(quotaMin))) : 15;

    this._savingSettingsDepth++;
    try {
      await cfg.update('update.autoCheck', s.updateAutoCheck !== false, target);
      await cfg.update('update.autoInstall', s.updateAutoInstall !== false, target);
      await cfg.update('autoConfirmDeclaration', s.autoConfirmDeclaration !== false, target);
      await cfg.update('cdpPort', Number.isFinite(port) && port > 0 ? port : 9333, target);
      const heartbeat = Number(s.cdpHeartbeatMs);
      await cfg.update('cdpHeartbeatMs', Number.isFinite(heartbeat) ? Math.min(5000, Math.max(200, Math.round(heartbeat))) : 500, target);
      await cfg.update('switch.syncGeminiFiles', s.syncGeminiFiles !== false, target);
      await cfg.update('remote.syncAuth', s.syncRemoteAuth !== false, target);
      await cfg.update('quotaRefreshScope', nextQuotaScope, target);
      await cfg.update('quotaRefreshMinutes', normalizedQuotaMin, target);
      await cfg.update('locale', nextLocale, target);
      const cardView = String(s.sidebarCardView ?? 'classic');
      await cfg.update('sidebar.cardView', cardView === 'compact' ? 'compact' : 'classic', target);
      await cfg.update('sidebar.showCardTokens', s.sidebarShowCardTokens !== false, target);
      await cfg.update('statusBar.enabled', s.statusBarEnabled !== false, target);
      const sbPosition = String(s.statusBarPosition ?? 'right');
      const sbStyle = String(s.statusBarStyle ?? 'pulse');
      await cfg.update('statusBar.position', sbPosition === 'left' ? 'left' : 'right', target);
      await cfg.update('statusBar.style', ['pulse', 'smart', 'dot', 'percent', 'compact', 'dual', 'labeled', 'full'].includes(sbStyle) ? sbStyle : 'pulse', target);
      await cfg.update('statusBar.showAccount', s.statusBarAccount !== false, target);
      await cfg.update('statusBar.showModels', s.statusBarModels !== false, target);
      await cfg.update('statusBar.showCredits', s.statusBarCredits !== false, target);
      await cfg.update('statusBar.showPool', s.statusBarPool !== false, target);
      await cfg.update('statusBar.showTier', s.statusBarTier !== false, target);
      await cfg.update('statusBar.showResetCountdown', s.statusBarResetCountdown !== false, target);
      await cfg.update('statusBar.showLiveContext', s.statusBarLiveContext !== false, target);
      await cfg.update('statusBar.showLiveSpeed', s.statusBarLiveSpeed !== false, target);
      const famsIn = Array.isArray(s.statusBarFamilies)
        ? s.statusBarFamilies.filter((x: unknown): x is string => typeof x === 'string' && ['claude', 'gemini', 'argon'].includes(x))
        : ['claude', 'gemini', 'argon'];
      await cfg.update('statusBar.families', famsIn.length > 0 ? famsIn : ['claude', 'gemini', 'argon'], target);
    } finally {
      this._savingSettingsDepth--;
    }

    logInfo('settings.saved', { ...s });
    if (nextQuotaScope !== prevQuotaScope || (Number.isFinite(quotaMin) && normalizedQuotaMin !== prevQuotaMin)) {
      this._handlers.onQuotaRefreshMinutesChanged?.();
    }
    if (nextLocale !== prevLocale && this._view) {
      this._webviewReady = false;
      this._view.webview.html = this._getHtmlForWebview(this._view.webview);
      if (!silent) {
        this.notify('success', t('settingsSaved'));
      }
      return;
    }
    if (!silent) {
      void this._view?.webview.postMessage({ type: 'toast', status: 'success', message: t('settingsSaved') });
    }
    this._pushSettings();
  }

  /** 探测调试端口并把状态推给设置面板 */
  private async _pushCdpStatus(): Promise<void> {
    const expected = vscode.workspace.getConfiguration('antigravityKite').get<number>('cdpPort', 9333);
    const port = await probeCdpPort();
    logInfo('cdp.status', { connected: !!port, port: port || expected });
    void this._view?.webview.postMessage({ type: 'cdpStatus', connected: !!port, port: port || expected, expected });
  }

  /** 导出账号（全部或指定邮箱集合） */
  private async _exportAccounts(onlyEmails?: string[]): Promise<void> {
    const all = accountStore.getAll();
    const picked = onlyEmails ? all.filter(a => onlyEmails.includes(a.email)) : all;
    if (picked.length === 0) {
      void this._view?.webview.postMessage({ type: 'toast', status: 'warning', message: t('noAccountsToExport') });
      return;
    }
    let masked = false;
    if (!onlyEmails) {
      const mode = await vscode.window.showQuickPick([t('exportModeFull'), t('exportModeMasked')], {
        placeHolder: t('exportModePrompt', picked.length),
      });
      if (!mode) return;
      masked = mode !== t('exportModeFull');
    }
    const data = picked.map(a => masked
      ? { email: a.email, name: a.name || '', tags: a.tags || [], disabled: !!a.disabled, importMeta: a.importMeta }
      : a);
    const payload = {
      type: 'antigravity-kite-export',
      exportedAt: new Date().toISOString(),
      count: picked.length,
      masked,
      accounts: data,
    };
    const uri = await vscode.window.showSaveDialog({
      title: t('exportDialogTitle'),
      filters: { JSON: ['json'] },
    });
    if (!uri) return;
    try {
      await vscode.workspace.fs.writeFile(uri, Buffer.from(JSON.stringify(payload, null, 2), 'utf8'));
      void this._view?.webview.postMessage({ type: 'toast', status: 'success', message: t('exported', picked.length, uri.fsPath) });
    } catch (err) {
      void this._view?.webview.postMessage({ type: 'toast', status: 'error', message: t('exportFailed', err instanceof Error ? err.message : String(err)) });
    }
  }

  private async _refreshUsage(email: string): Promise<void> {
    try {
      await this._handlers.refreshOneUsage?.(email);
    } finally {
      void this._view?.webview.postMessage({ type: 'refreshDone', scope: 'one', email });
    }
  }

  private async _refreshAllUsage(): Promise<void> {
    if (this._handlers.isRefreshInFlight?.()) {
      void this._view?.webview.postMessage({ type: 'refreshDone', scope: 'all' });
      void this._view?.webview.postMessage({ type: 'toast', status: 'info', message: t('refreshInProgress') });
      logInfo('usage.refresh.skip.inflight');
      return;
    }
    try {
      const result = await this._handlers.refreshAllWithProgress?.((done, total) => {
        if (total > 0) {
          void this._view?.webview.postMessage({ type: 'refreshProgress', done, total });
        }
      });
      this._pushAccounts();
      if (result && result.total > 0) {
        if (result.errorCount === 0) {
          void this._view?.webview.postMessage({ type: 'toast', status: 'success', message: t('refreshedQuota', result.successCount) });
        } else if (result.successCount === 0) {
          void this._view?.webview.postMessage({ type: 'toast', status: 'error', message: t('refreshAllFailed', result.errorCount, result.lastError) });
        } else {
          void this._view?.webview.postMessage({ type: 'toast', status: 'warning', message: t('refreshPartial', result.successCount, result.errorCount) });
        }
      }
    } finally {
      void this._view?.webview.postMessage({ type: 'refreshDone', scope: 'all' });
    }
  }

  private async _checkHealth(email: string): Promise<void> {
    const health = await this._handlers.probeOneHealth?.(email) ?? null;
    if (health) {
      void this._view?.webview.postMessage({ type: 'healthResult', email, health });
    }
  }

  private async _handleMessage(msg: WebviewMessage): Promise<void> {
    const msgType = typeof msg.type === 'string' ? msg.type : '';
    const email = typeof msg.email === 'string' ? msg.email : '';
    logInfo('msg.in', { type: msgType, email });

    switch (msgType) {
      case 'oauthLogin':
        void runOAuthUiFlow({
          openBrowser: msg.openBrowser !== false,
          copyUrl: msg.copyUrl === true,
          post: (m) => void this._view?.webview.postMessage(m),
          notify: (st, text) => notifyUi(st, text),
          onAccount: async (account) => {
            accountStore.add(account);
            await this._context.globalState.update('currentEmail', account.email);
            this._pushAccounts();
            notifyUi('success', t('accountAdded', account.email));
            void this._refreshUsage(account.email);
          },
        });
        break;
      case 'oauthCopyUrl':
        if (await copyActiveOAuthUrl()) {
          void this._view?.webview.postMessage({ type: 'oauthUrlCopied' });
          notifyUi('success', t('oauthUrlCopiedToast'));
        } else {
          void this._view?.webview.postMessage({ type: 'oauthCallbackError', message: t('oauthSessionMissing') });
        }
        break;
      case 'oauthOpenBrowser':
        if (!(await openActiveOAuthBrowser())) void this._view?.webview.postMessage({ type: 'oauthCallbackError', message: t('oauthSessionMissing') });
        break;
      case 'oauthSubmitCallback':
        try {
          await submitActiveOAuthCallback(typeof msg.callbackUrl === 'string' ? msg.callbackUrl : '');
        } catch (err) {
          void this._view?.webview.postMessage({ type: 'oauthCallbackError', message: err instanceof Error ? err.message : String(err) });
        }
        break;
      case 'oauthCancel':
        cancelActiveOAuthSession();
        void this._view?.webview.postMessage({ type: 'oauthSession', active: false });
        break;

      case 'importLocal':
        void this._view?.webview.postMessage({ type: 'authWait', action: 'local', active: true });
        try {
          const existingEmails = accountStore.getAll().map(a => a.email);
          const preview = await previewLocalAccount(existingEmails);
          void this._view?.webview.postMessage({
            type: 'localImportPreview',
            email: preview.email,
            exists: preview.exists,
            tokenExpired: preview.tokenExpired,
          });
        } catch (err) {
          notifyUi('error', t('detectFailed', err instanceof Error ? err.message : String(err)));
        } finally {
          void this._view?.webview.postMessage({ type: 'authWait', action: 'local', active: false });
        }
        break;

      case 'confirmImport':
        try {
          const account = confirmImport();
          if (account) {
            accountStore.add(account);
            await this._context.globalState.update('currentEmail', account.email);
            this._pushAccounts();
            notifyUi('success', t('accountImported', account.email));
            void this._refreshUsage(account.email);
          }
        } catch (err) {
          notifyUi('error', t('importFailed', err instanceof Error ? err.message : String(err)));
        }
        break;

      case 'cancelImport':
        cancelImport();
        break;

      case 'importFromCockpitTools':
        void this._view?.webview.postMessage({ type: 'importStatus', status: 'loading', source: 'Cockpit Tools' });
        try {
          const result1 = await importService.importFromCockpitTools();
          this._pushAccounts();
          void this._view?.webview.postMessage({
            type: 'importStatus',
            status: 'success',
            source: 'Cockpit Tools',
            imported: result1.imported,
            skipped: result1.skipped,
          });
          if (result1.imported > 0) void this._refreshAllUsage();
        } catch (err) {
          void this._view?.webview.postMessage({
            type: 'importStatus',
            status: 'error',
            source: 'Cockpit Tools',
            message: err instanceof Error ? err.message : String(err),
          });
        }
        break;

      case 'importFromAntigravityManager':
        void this._view?.webview.postMessage({ type: 'importStatus', status: 'loading', source: 'Antigravity Manager' });
        try {
          const result2 = await importService.importFromAntigravityManager();
          this._pushAccounts();
          void this._view?.webview.postMessage({
            type: 'importStatus',
            status: 'success',
            source: 'Antigravity Manager',
            imported: result2.imported,
            skipped: result2.skipped,
          });
          if (result2.imported > 0) void this._refreshAllUsage();
        } catch (err) {
          void this._view?.webview.postMessage({
            type: 'importStatus',
            status: 'error',
            source: 'Antigravity Manager',
            message: err instanceof Error ? err.message : String(err),
          });
        }
        break;

      case 'importFromJsonFile':
        void this._view?.webview.postMessage({ type: 'importStatus', status: 'loading', source: t('impSourceLocalFile') });
        try {
          const result3 = await importService.importFromJsonFile();
          this._pushAccounts();
          void this._view?.webview.postMessage({
            type: 'importStatus',
            status: 'success',
            source: t('impSourceLocalFile'),
            imported: result3.imported,
            skipped: result3.skipped,
          });
          if (result3.imported > 0) void this._refreshAllUsage();
        } catch (err) {
          if (err instanceof Error && err.message === t('impNoFileSelected')) {
            void this._view?.webview.postMessage({ type: 'importStatus', status: 'cancelled' });
          } else {
            void this._view?.webview.postMessage({
              type: 'importStatus',
              status: 'error',
              source: t('impSourceLocalFile'),
              message: err instanceof Error ? err.message : String(err),
            });
          }
        }
        break;

      case 'removeAccount':
        if (email) {
          const cur = this._context.globalState.get<string>('currentEmail') || '';
          if (cur && cur.toLowerCase() === email.toLowerCase()) {
            await this._context.globalState.update('currentEmail', '');
          }
          accountStore.remove(email);
          this._pushAccounts();
        }
        break;

      case 'setCurrentAccount':
        if (email) {
          if (this._handlers.requestSwitch) {
            await this._handlers.requestSwitch(email);
          } else {
            logWarn('switch.noHandler', { email });
            void this._view?.webview.postMessage({ type: 'switchResult', ok: false });
          }
        }
        break;

      case 'getSettings':
        this._pushSettings();
        break;

      case 'privacyChanged': {
        const enabled = msg.enabled === true;
        await this._context.globalState.update('privacyMode', enabled);
        this._handlers.onPrivacyChanged?.(enabled);
        void this._view?.webview.postMessage({ type: 'privacyMode', enabled });
        break;
      }

      case 'openSettings':
        void this._view?.webview.postMessage({ type: 'openSettings' });
        break;

      case 'openStatsPanel': {
        const tab = typeof msg.tab === 'string' && msg.tab ? msg.tab : undefined;
        const account = typeof msg.account === 'string' && msg.account ? msg.account : undefined;
        const navTarget = account ? { tab: tab || 'tokens', account } : tab;
        void vscode.commands.executeCommand('antigravityKite.openLogPanel', navTarget);
        break;
      }

      case 'getCdpStatus':
        await this._pushCdpStatus();
        break;

      case 'enableCdp': {
        const r = await enableCdp(this._context);
        if (!r.ok) {
          notifyUi('error', t('gateEnableFailed') + (r.error || ''));
          await this._pushCdpStatus();
        }
        break;
      }

      case 'saveSettings': {
        const settingsObj = (msg.settings && typeof msg.settings === 'object') ? msg.settings as Record<string, unknown> : {};
        await this._saveSettings(settingsObj, msg.silent === true);
        break;
      }

      case 'exportAccounts':
        await this._exportAccounts();
        break;

      case 'batchExport':
        if (Array.isArray(msg.emails)) {
          const emails = msg.emails.filter((e): e is string => typeof e === 'string' && e.length > 0);
          if (emails.length > 0) await this._exportAccounts(emails);
        }
        break;

      case 'toggleDisabled':
        if (email) {
          const acct = accountStore.getByEmail(email);
          if (acct) {
            accountStore.setDisabled(email, !acct.disabled);
            this._pushAccounts();
          }
        }
        break;

      case 'refreshAll':
        this._pushAccounts();
        void this._view?.webview.postMessage({ type: 'toast', status: 'info', message: t('refreshingQuota') });
        void this._refreshAllUsage();
        break;

      case 'refreshUsage':
        if (email) {
          void this._refreshUsage(email);
        }
        break;

      case 'checkHealth':
        if (email) {
          void this._checkHealth(email);
        }
        break;

      case 'updateTag':
        if (email && Array.isArray(msg.tags)) {
          const tags = msg.tags.filter((x): x is string => typeof x === 'string');
          accountStore.update(email, { tags });
          this._pushAccounts();
        }
        break;

      case 'batchTag':
        if (Array.isArray(msg.emails) && Array.isArray(msg.tags)) {
          const emails = msg.emails.filter((e): e is string => typeof e === 'string' && e.length > 0);
          const tags = msg.tags.filter((x): x is string => typeof x === 'string');
          if (emails.length > 0) {
            accountStore.batchUpdateTags(emails, tags);
            this._pushAccounts();
            void this._view?.webview.postMessage({ type: 'toast', status: 'success', message: t('tagsUpdated', emails.length) });
          }
        }
        break;

      case 'deleteTag': {
        const tag = typeof msg.tag === 'string' ? msg.tag.trim() : '';
        if (tag) {
          const affected = accountStore.removeTagEverywhere(tag);
          this._pushAccounts();
          void this._view?.webview.postMessage({ type: 'toast', status: 'success', message: t('tagDeleted', tag, affected) });
        }
        break;
      }

      case 'batchDelete':
        if (Array.isArray(msg.emails)) {
          const emails = msg.emails.filter((e): e is string => typeof e === 'string' && e.length > 0);
          if (emails.length > 0) {
            const cur = this._context.globalState.get<string>('currentEmail') || '';
            if (cur && emails.some((e) => e.toLowerCase() === cur.toLowerCase())) {
              await this._context.globalState.update('currentEmail', '');
            }
            accountStore.removeMany(emails);
            this._pushAccounts();
            void this._view?.webview.postMessage({ type: 'toast', status: 'success', message: t('accountsDeleted', emails.length) });
          }
        }
        break;

      case 'batchEnable':
        if (Array.isArray(msg.emails)) {
          const emails = msg.emails.filter((e): e is string => typeof e === 'string' && e.length > 0);
          if (emails.length > 0) {
            accountStore.setDisabledMany(emails, false);
            this._pushAccounts();
            void this._view?.webview.postMessage({ type: 'toast', status: 'success', message: t('accountsEnabled', emails.length) });
          }
        }
        break;

      case 'batchDisable':
        if (Array.isArray(msg.emails)) {
          const emails = msg.emails.filter((e): e is string => typeof e === 'string' && e.length > 0);
          if (emails.length > 0) {
            accountStore.setDisabledMany(emails, true);
            this._pushAccounts();
            void this._view?.webview.postMessage({ type: 'toast', status: 'success', message: t('accountsDisabled', emails.length) });
          }
        }
        break;

      case 'webviewReady':
        this._webviewReady = true;
        this._pushAccounts();
        this._pushSettings();
        this.refreshStatsSummary(false);
        this._flushOutbox();
        break;

      case 'askResult': {
        const settle = this._askResolvers.get(String(msg.id));
        if (settle) settle(msg.ok === true);
        break;
      }

      case 'webviewError':
        notifyUi('error', `Webview Error: ${String(msg.message || '')} (Line ${String(msg.line ?? 0)}, Col ${String(msg.col ?? 0)})\n${String(msg.stack || '')}`);
        break;

      default:
        logWarn('msg.unknown', { type: msgType });
        break;
    }
  }

  public _getHtmlForWebview(webview: vscode.Webview): string {
    const baseDir = this._extensionUri?.fsPath || path.resolve(__dirname, '..');
    const htmlPath = path.join(baseDir, 'resources', 'webview', 'sidebar.html');
    let template = _htmlTemplateCache.get(htmlPath);
    if (!template) {
      template = fs.readFileSync(htmlPath, 'utf8');
      _htmlTemplateCache.set(htmlPath, template);
    }

    const nonce = crypto.randomBytes(16).toString('base64');
    const cssUri = String(webview.asWebviewUri(vscode.Uri.joinPath(this._extensionUri, 'resources', 'webview', 'main.css')));
    const jsUri = String(webview.asWebviewUri(vscode.Uri.joinPath(this._extensionUri, 'resources', 'webview', 'sidebar.js')));
    const i18nJson = JSON.stringify(localeBundle('ui.')).replace(/</g, '\\u003c');
    const lang = getLang() === 'zh' ? 'zh-CN' : 'en';

    return template
      .split('{{LANG}}').join(lang)
      .split('{{CSP_SOURCE}}').join(webview.cspSource)
      .split('{{NONCE}}').join(nonce)
      .split('{{CSS_URI}}').join(cssUri)
      .split('{{JS_URI}}').join(jsUri)
      .split('{{I18N_JSON}}').join(i18nJson);
  }
}
