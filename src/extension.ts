import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import * as accountStore from './accountStore';
import { startOAuth } from './oauthService';
import { previewLocalAccount, confirmImport, cancelImport } from './localReader';
import * as importService from './importService';
import { WebviewMessage, UsageSnapshot } from './types';
import { seamlessSwitch, prepareSwitchToken, pushLiveIdentityUpdate } from './seamlessSwitcher';
import { switchIdeStateIdentity, resolveIdeStateDbPathFromUserData } from './ideStateDb';
import { readSwitchRestartResult, clearSwitchRestartResult, writeAgyActiveAccount } from './switchRestart';
import { logInfo, logWarn, logError } from './logger';
import { startDeclarationSuppressor } from './declarationSuppressor';
import { ensureCdpGate, enableCdp } from './cdpGate';
import { probeCdpPort } from './declarationSuppressor';
import { t, localeBundle, getLang } from './i18n';
import { swapIdeCredential, buildIdeCredentialBlob, syncGeminiAccountFiles } from './winCredential';
import { syncGeminiLocalCreds } from './geminiFiles';
import { getSharedStorageDir } from './storage';
import { StatusBarManager } from './statusBar';
import { fetchUsage, checkAccountHealth, classifyAccountError } from './usageService';
import { AccountHealth } from './types';
import * as ideRuntime from './ideRuntime';
import { UsageTracker } from './usageTracker';
import { showUpdateNotesOnStartup, autoCheckOnStartup, checkForUpdates } from './updater';
import { registerUiPresenter, notifyUi, askUi, UiPresenter, UiAskOptions, UiStatus } from './uiChannel';
import * as logPanel from './logPanelProvider';

let sidebarProvider: SidebarProvider;
let statusBarManager: StatusBarManager;
let usageTracker: UsageTracker;

/** 配额缓存（email → UsageSnapshot），持久化到 globalState */
const usageCache = new Map<string, UsageSnapshot>();
let usageCacheLastRefresh = 0; // 上次全量刷新时间戳
const USAGE_CACHE_TTL_MS = 5 * 60 * 1000; // 5 分钟缓存有效期

function loadUsageCache(context: vscode.ExtensionContext) {
  const saved = context.globalState.get<Record<string, UsageSnapshot>>('usageCache');
  const ts = context.globalState.get<number>('usageCacheTs') || 0;
  if (saved) {
    for (const [email, snap] of Object.entries(saved)) {
      usageCache.set(email, snap);
    }
  }
  usageCacheLastRefresh = ts;
}

/** 全池额度后台定时器（模块级句柄：设置保存时即时重排间隔，无需重启） */
let quotaRefreshTimer: NodeJS.Timeout | null = null;

/** 统一管线最近一次失败明细（批量汇总 toast 用；逐号明细已实时推卡片） */
let lastUsageError = '';

function applyQuotaRefreshInterval(context: vscode.ExtensionContext): void {
  if (quotaRefreshTimer) clearInterval(quotaRefreshTimer);
  const refreshMinutes = Math.max(5, vscode.workspace.getConfiguration('antigravityKite').get<number>('quotaRefreshMinutes', 15));
  quotaRefreshTimer = setInterval(() => backgroundRefreshAllUsage(context), refreshMinutes * 60 * 1000);
}

function saveUsageCache(context: vscode.ExtensionContext) {
  const obj: Record<string, UsageSnapshot> = {};
  usageCache.forEach((v, k) => { obj[k] = v; });
  context.globalState.update('usageCache', obj);
  context.globalState.update('usageCacheTs', usageCacheLastRefresh);
}

export function activate(context: vscode.ExtensionContext) {
  console.log('Antigravity Kite activated');
  logInfo('activate.start', {
    version: context.extension.packageJSON.version,
    extensionId: context.extension.id,
    extensionPath: context.extensionPath,
    globalStorage: context.globalStorageUri.fsPath,
  });

  accountStore.init(context);
  logInfo('activate.init-done', { accounts: accountStore.count(), storageDir: accountStore.getStorageDirPath() });

  // 初始化侧栏，并把 UI 通道接到它上面：此后所有提示/询问都走 webview，不再弹原生对话框
  sidebarProvider = new SidebarProvider(context.extensionUri, context);
  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider(SidebarProvider.viewType, sidebarProvider)
  );
  registerUiPresenter(sidebarProvider);

  // 安全声明弹窗自动关闭器：CDP 可用时给 hub 页面注入自动接受（切换账号必弹的那一个）
  startDeclarationSuppressor();

  // 上次切号重启的结果反馈（助手在 IDE 之外执行，结果落盘到共享目录）
  const lastRestart = readSwitchRestartResult();
  if (lastRestart) {
    clearSwitchRestartResult();
    if (!lastRestart.ok) {
      notifyUi('error', t('restartIncomplete', lastRestart.error || t('ui.unknown')));
    } else if (lastRestart.warning) {
      notifyUi('warning', t('restartWarning', lastRestart.warning));
    }
  }

  usageTracker = new UsageTracker(context);
  loadUsageCache(context);
  context.subscriptions.push(
    accountStore.onChange(() => {
      sidebarProvider?.refresh();
      statusBarManager?.update();
      logPanel.pushLogPanelData(context, usageTracker);
    })
  );

  // 初始化状态栏（快速切号复用侧栏完整链路；recordSwitch 已在链路内，不在此重复计数）
  statusBarManager = new StatusBarManager(
    context,
    (email) => {
      sidebarProvider?.refresh();
    },
    (email) => sidebarProvider.requestSwitch(email),
    // 管线合一：底栏数据与刷新全部走共享缓存与统一管线，不再自建定时抓取
    {
      getUsage: (email) => usageCache.get(email),
      refreshCurrent: (email) => refreshOneAccountUsage(email, context).then(() => undefined),
      refreshAll: () => refreshAllUsageInteractive(context).then(() => undefined),
      recheckHealth: () => backgroundProbeAllHealth(),
      openSettings: () => sidebarProvider?.openSettingsUi(),
      getPrivacy: () => context.globalState.get<boolean>('privacyMode', false),
    }
  );
  context.subscriptions.push(statusBarManager);

  // 版本更新说明：走侧栏 webview 模态框（不用 VS Code 原生模态）
  void showUpdateNotesOnStartup(context);

  // 自动检查更新
  autoCheckOnStartup();

  // 注册检查更新命令
  const checkUpdatesCmd = vscode.commands.registerCommand('antigravityKite.checkForUpdates', async () => {
    await checkForUpdates(false);
  });
  context.subscriptions.push(checkUpdatesCmd);

  // 注册打开统计面板命令
  const openLogPanelCmd = vscode.commands.registerCommand('antigravityKite.openLogPanel', (tab?: string) => {
    logPanel.openLogPanel(context, usageTracker, context.extensionUri, tab);
  });
  context.subscriptions.push(openLogPanelCmd);

  // 注册全量额度刷新命令（命令面板 / 快捷键可用）
  const refreshQuotaCmd = vscode.commands.registerCommand('antigravityKite.refreshQuota', async () => {
    await refreshAllUsageInteractive(context);
  });
  context.subscriptions.push(refreshQuotaCmd);

  // 注册健康复检命令（独立推理探针，封禁只在推理端点现形）
  const healthRecheckCmd = vscode.commands.registerCommand('antigravityKite.healthRecheck', async () => {
    await backgroundProbeAllHealth();
  });
  context.subscriptions.push(healthRecheckCmd);

  // 延迟 2 秒执行首次后台静默全局额度刷新
  setTimeout(() => backgroundRefreshAllUsage(context), 2000);

  // 健康探针：启动 8 秒后首轮定性，之后每小时一轮（独立于额度刷新，封禁只在推理端点现形）
  setTimeout(() => backgroundProbeAllHealth(), 8000);
  const healthInterval = setInterval(() => backgroundProbeAllHealth(), HEALTH_PROBE_INTERVAL_MS);
  context.subscriptions.push({ dispose: () => clearInterval(healthInterval) });

  // 后台定时刷新（间隔可配置，默认 15 分钟；设置保存时即时重排，无需重启）
  applyQuotaRefreshInterval(context);
  context.subscriptions.push({
    dispose: () => { if (quotaRefreshTimer) { clearInterval(quotaRefreshTimer); quotaRefreshTimer = null; } }
  });
}

export function deactivate() {
  accountStore.dispose();
  usageTracker?.dispose();
  statusBarManager?.dispose();
}

/**
 * 后台静默刷新所有账号的额度快照并分发
 */
/** 检测失败时从错误文本归类健康状态（封禁/凭据失效签名见 usageService.classifyAccountError） */
function healthFromError(err: unknown): AccountHealth {
  const msg = err instanceof Error ? err.message : String(err);
  return { status: classifyAccountError(msg), checkedAt: new Date().toISOString(), detail: msg.slice(0, 300) };
}

/**
 * 统一单账号额度刷新管线（v1.1.16 管线合一：唯一权威实现）。
 * 此前状态栏私有 30s 定时器、后台全池 15min、侧栏手动单号/全量四条路径各抓各的，
 * 缓存两份、tracker 漏采、健康归类缺失。现在全部收敛到这里：
 *   抓取 → 共享 usageCache → usageTracker 统计 → 失败健康归类 → 三端分发（底栏/侧栏/统计面板）
 * @param batch 批量模式：跳过逐号落盘与统计面板推送，由调用方收口一次（避免 8 号 ×2 次写盘风暴）
 */
async function refreshOneAccountUsage(
  email: string,
  context: vscode.ExtensionContext,
  opts: { batch?: boolean } = {}
): Promise<UsageSnapshot | null> {
  const account = accountStore.getAll().find(a => a.email === email && !a.disabled);
  if (!account) return null;
  try {
    const snapshot = await fetchUsage(account);
    usageCache.set(email, snapshot);
    usageCacheLastRefresh = Date.now();
    if (!opts.batch) saveUsageCache(context);
    usageTracker.recordRefresh();
    usageTracker.recordUsage(email, snapshot.minRemainingPercent, snapshot.tierId);
    statusBarManager?.updateUsage(email, snapshot);
    sidebarProvider?.postMessage({ type: 'usage', email, snapshot });
    if (!opts.batch) logPanel.pushLogPanelData(context, usageTracker);
    return snapshot;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.warn(`[Kite-Usage] 刷新账号 ${email} 额度失败:`, msg);
    lastUsageError = msg;
    // 元数据层失败顺路归类凭据失效；封禁在推理端点，由健康探针负责
    persistHealthIfChanged(email, healthFromError(err));
    sidebarProvider?.postMessage({ type: 'usage', email, error: msg });
    return null;
  }
}

/**
 * 健康状态落盘（去抖）：只在 status 翻转时写 accounts.json。
 * 背景探测每小时×N 账号，若每次都写盘会触发 watcher→load→pushAccounts 风暴，
 * 挤占切号流程的写窗口（v1.1.13 教训）。
 */
function persistHealthIfChanged(email: string, health: AccountHealth): void {
  const prev = accountStore.getByEmail(email)?.health;
  if (prev?.status !== health.status) {
    accountStore.update(email, { health });
  }
  // 无论是否落盘都推给侧栏：checkedAt/detail 实时可见，卡片即时变色
  sidebarProvider?.postMessage({ type: 'health', email, health });
  // 健康翻转同步底栏（封禁/失效在状态栏亮牌，额度满格不包庇封禁号）
  statusBarManager?.update();
}

/**
 * 后台独立健康探针：每小时一轮（生成探测 1 token/号，损耗可忽略）。
 * 与额度刷新分离——封禁只在推理端点现形，元数据 200 证明不了健康。
 */
const HEALTH_PROBE_INTERVAL_MS = 60 * 60 * 1000;

async function backgroundProbeAllHealth() {
  console.log('[Kite-Health] 开始后台账号健康探测...');
  const accounts = accountStore.getAll().filter(a => !a.disabled);
  for (const account of accounts) {
    try {
      const health = await checkAccountHealth(account);
      persistHealthIfChanged(account.email, health);
    } catch (e) {
      // checkAccountHealth 内部已兜底，这里只防意外抛出中断整轮
      console.warn(`[Kite-Health] 探测 ${account.email} 意外失败:`, e);
    }
  }
  console.log('[Kite-Health] 后台账号健康探测完成。');
}

async function backgroundRefreshAllUsage(context: vscode.ExtensionContext) {
  console.log('[Kite-Background] 正在执行后台定时静默全局额度刷新...');
  const accounts = accountStore.getAll().filter(a => !a.disabled);
  // 批量模式走统一管线（逐号分发底栏/侧栏，落盘与统计面板由本函数收口一次）
  for (const account of accounts) {
    await refreshOneAccountUsage(account.email, context, { batch: true });
  }
  saveUsageCache(context);
  logPanel.pushLogPanelData(context, usageTracker);
  console.log('[Kite-Background] 后台定时静默全局额度刷新完成。');
}

/** 全池刷新（QuickPick / 命令面板入口），带完成提示 */
async function refreshAllUsageInteractive(context: vscode.ExtensionContext) {
  const accounts = accountStore.getAll().filter(a => !a.disabled);
  let successCount = 0;
  for (const account of accounts) {
    const snap = await refreshOneAccountUsage(account.email, context, { batch: true });
    if (snap) successCount++;
  }
  saveUsageCache(context);
  logPanel.pushLogPanelData(context, usageTracker);
  sidebarProvider?.refresh();
  return successCount;
}

/** 切号防连点：调度成功后 IDE 会关闭，无需重置；调度失败时重置 */
let switchInFlight = false;

class SidebarProvider implements vscode.WebviewViewProvider, UiPresenter {
  public static readonly viewType = 'antigravityKite.sidebar';
  private _view?: vscode.WebviewView;
  private _webviewReady = false;
  /** webview 未就绪时暂存的提示/询问，ready 后按序补发（绝不回退原生弹窗） */
  private _outbox: any[] = [];
  private _askResolvers = new Map<string, (ok: boolean, reason?: string) => void>();
  private _context: vscode.ExtensionContext;

  constructor(private readonly _extensionUri: vscode.Uri, context: vscode.ExtensionContext) {
    this._context = context;
  }

  public refresh() {
    if (this._view) {
      this._pushAccounts();
    }
  }

  public postMessage(message: any) {
    if (this._view) {
      this._view.webview.postMessage(message);
    }
  }

  /** 单条提示：走侧栏 toast */
  public notify(status: UiStatus, message: string) {
    this._post({ type: 'toast', status, message });
  }

  /** 需要确认的询问：走侧栏模态框，返回是否点了主按钮 */
  public ask(options: UiAskOptions): Promise<boolean> {
    const id = 'ask_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 7);
    return new Promise<boolean>((resolve) => {
      let settled = false;
      let timeout: NodeJS.Timeout | undefined;
      const settle = (ok: boolean, reason?: string) => {
        if (settled) return;
        settled = true;
        this._askResolvers.delete(id);
        if (timeout) clearTimeout(timeout);
        if (reason) logWarn('ui.ask.' + reason, { id, title: options.title });
        if (ok && options.linkUrl) {
          void vscode.env.openExternal(vscode.Uri.parse(options.linkUrl));
        }
        resolve(ok);
      };
      // 用户长时间不响应：不让调用方永久挂起，弹窗一并收起（否则点了也没反应）
      timeout = setTimeout(() => {
        const wasOpen = this._askResolvers.has(id);
        settle(false, 'timeout');
        if (wasOpen) this._view?.webview.postMessage({ type: 'askDismiss', id });
      }, 120000);
      this._askResolvers.set(id, settle);
      this._post({ type: 'ask', id, ...options }, !options.silent);
      // 侧栏拉不起来（容器被隐藏等）按取消收口，避免切号等流程被挂住；
      // silent 询问本来就是等用户下次打开侧栏，不能提前判死（否则弹了也没人收结果）
      if (!options.silent) {
        setTimeout(() => {
          if (!settled && !this._webviewReady) settle(false, 'sidebar-unavailable');
        }, 5000);
      }
    });
  }

  /** 投递一条消息：webview 就绪立即发，否则入队；focusSidebar=false 时不抢前台焦点 */
  private _post(msg: any, focusSidebar = true) {
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

  private _flushOutbox() {
    if (!this._view || !this._webviewReady) return;
    const queued = this._outbox;
    this._outbox = [];
    for (const msg of queued) {
      this._view.webview.postMessage(msg);
    }
  }

  public resolveWebviewView(
    webviewView: vscode.WebviewView,
    _context: vscode.WebviewViewResolveContext,
    _token: vscode.CancellationToken,
  ) {
    this._view = webviewView;
    // 新 html 等于新脚本：监听器尚未注册，等 webviewReady 再投递
    this._webviewReady = false;
    logInfo('webview.resolve', { viewType: SidebarProvider.viewType });

    webviewView.webview.options = {
      enableScripts: true,
      localResourceRoots: [this._extensionUri]
    };

    webviewView.webview.html = this._getHtmlForWebview(webviewView.webview);
    // 版本号放在视图标题栏；容器名由 VS Code 自动前缀，这里只写版本号避免重名
    try { webviewView.title = 'v' + this._context.extension.packageJSON.version; } catch { /* 部分版本只读 */ }
    logInfo('webview.html-set', { bytes: webviewView.webview.html.length });

    webviewView.webview.onDidReceiveMessage(async (msg: WebviewMessage) => {
      await this._handleMessage(msg);
    });

    this._pushAccounts();

    // 推送 globalState 中的标签颜色
    const savedTagColors = this._context.globalState.get<Record<string, string>>('tagColors');
    if (savedTagColors && Object.keys(savedTagColors).length > 0) {
      webviewView.webview.postMessage({ type: 'tagColorsSync', colors: savedTagColors });
    }

    // 有缓存且未过期则跳过刷新，否则自动刷新
    const cacheAge = Date.now() - usageCacheLastRefresh;
    if (usageCache.size === 0 || cacheAge > USAGE_CACHE_TTL_MS) {
      this._refreshAllUsage();
    }
  }

  private _pushAccounts() {
    const accounts = accountStore.getAll();
    const currentEmail = this._context.globalState.get<string>('currentEmail') || '';
    // 附带配额缓存
    const accountsWithUsage = accounts.map(a => ({
      ...a,
      usage: usageCache.get(a.email),
    }));
    const payload = { type: 'accounts', accounts: accountsWithUsage, currentEmail, privacyMode: this._context.globalState.get<boolean>('privacyMode', false) };
    const res = this._view?.webview.postMessage(payload);
    // postMessage 返回 Thenable<boolean>：false/拒绝 表示 webview 未接收（桥接断开），必须留痕
    if (res && typeof (res as unknown as PromiseLike<boolean>).then === 'function') {
      (res as unknown as Promise<boolean>).then(
        (ok) => logInfo('webview.pushAccounts', { count: accountsWithUsage.length, currentEmail, viewAttached: true, delivered: ok }),
        (err) => logError('webview.pushAccounts.reject', { count: accountsWithUsage.length, error: err instanceof Error ? err.message : String(err) })
      );
    } else {
      logWarn('webview.pushAccounts', { count: accountsWithUsage.length, currentEmail, viewAttached: false });
    }
  }

  /** 状态栏快速切号入口：复用侧栏完整切号链路（门控/token/凭据/状态库/agy/gemini/会话/引擎重载） */
  async requestSwitch(email: string): Promise<void> {
    await this._handleMessage({ type: 'setCurrentAccount', email });
  }

  /** 底栏"打开设置"快捷入口：聚焦侧栏并弹出设置模态框 */
  openSettingsUi() {
    vscode.commands.executeCommand('antigravityKite.sidebar.focus');
    this._view?.webview.postMessage({ type: 'openSettings' });
  }

  /** 推送设置到 webview（读 package.json 中 contributes.configuration 的配置项） */
  private _pushSettings() {
    const cfg = vscode.workspace.getConfiguration('antigravityKite');
    this._view?.webview.postMessage({
      type: 'settings',
      settings: {
        updateAutoCheck: cfg.get<boolean>('update.autoCheck', true),
        updateAutoInstall: cfg.get<boolean>('update.autoInstall', true),
        autoConfirmDeclaration: cfg.get<boolean>('autoConfirmDeclaration', true),
        cdpPort: cfg.get<number>('cdpPort', 9333),
        cdpHeartbeatMs: cfg.get<number>('cdpHeartbeatMs', 500),
        syncGeminiFiles: cfg.get<boolean>('switch.syncGeminiFiles', true),
        quotaRefreshMinutes: cfg.get<number>('quotaRefreshMinutes', 15),
        locale: cfg.get<string>('locale', 'auto'),
        statusBarEnabled: cfg.get<boolean>('statusBar.enabled', true),
        statusBarPosition: cfg.get<string>('statusBar.position', 'right'),
        statusBarStyle: cfg.get<string>('statusBar.style', 'smart'),
        statusBarAccount: cfg.get<boolean>('statusBar.showAccount', true),
        statusBarModels: cfg.get<boolean>('statusBar.showModels', true),
        statusBarCredits: cfg.get<boolean>('statusBar.showCredits', true),
        statusBarPool: cfg.get<boolean>('statusBar.showPool', true),
        statusBarTier: cfg.get<boolean>('statusBar.showTier', true),
        statusBarResetCountdown: cfg.get<boolean>('statusBar.showResetCountdown', true),
        statusBarFamilies: cfg.get<string[]>('statusBar.families', ['claude', 'gemini', 'argon']),
        statusBarRefresh: cfg.get<number>('statusBar.refreshSeconds', 30),
      },
    });
  }

  /** 保存设置到全局配置（用户级 settings.json）。silent=true 时不弹提示（实时保存用） */
  private async _saveSettings(s: Record<string, unknown>, silent = false) {
    const cfg = vscode.workspace.getConfiguration('antigravityKite');
    const target = vscode.ConfigurationTarget.Global;
    const port = Number(s.cdpPort);
    const prevLocale = cfg.get<string>('locale', 'auto');
    const nextLocale = String(s.locale ?? 'auto');
    await cfg.update('update.autoCheck', s.updateAutoCheck !== false, target);
    await cfg.update('update.autoInstall', s.updateAutoInstall !== false, target);
    await cfg.update('autoConfirmDeclaration', s.autoConfirmDeclaration !== false, target);
    await cfg.update('cdpPort', Number.isFinite(port) && port > 0 ? port : 9333, target);
    const heartbeat = Number(s.cdpHeartbeatMs);
    await cfg.update('cdpHeartbeatMs', Number.isFinite(heartbeat) ? Math.min(5000, Math.max(200, Math.round(heartbeat))) : 500, target);
    await cfg.update('switch.syncGeminiFiles', s.syncGeminiFiles !== false, target);
    const quotaMin = Number(s.quotaRefreshMinutes);
    const prevQuotaMin = cfg.get<number>('quotaRefreshMinutes', 15);
    await cfg.update('quotaRefreshMinutes', Number.isFinite(quotaMin) ? Math.min(120, Math.max(5, Math.round(quotaMin))) : 15, target);
    await cfg.update('locale', nextLocale, target);
    await cfg.update('statusBar.enabled', s.statusBarEnabled !== false, target);
    const sbPosition = String(s.statusBarPosition ?? 'right');
    const sbStyle = String(s.statusBarStyle ?? 'smart');
    const sbRefresh = Number(s.statusBarRefresh);
    await cfg.update('statusBar.position', sbPosition === 'left' ? 'left' : 'right', target);
    await cfg.update('statusBar.style', ['smart', 'dot', 'percent', 'compact', 'dual', 'labeled', 'full'].includes(sbStyle) ? sbStyle : 'smart', target);
    await cfg.update('statusBar.refreshSeconds', Number.isFinite(sbRefresh) ? Math.min(600, Math.max(10, Math.round(sbRefresh))) : 30, target);
    await cfg.update('statusBar.showAccount', s.statusBarAccount !== false, target);
    await cfg.update('statusBar.showModels', s.statusBarModels !== false, target);
    await cfg.update('statusBar.showCredits', s.statusBarCredits !== false, target);
    await cfg.update('statusBar.showPool', s.statusBarPool !== false, target);
    await cfg.update('statusBar.showTier', s.statusBarTier !== false, target);
    await cfg.update('statusBar.showResetCountdown', s.statusBarResetCountdown !== false, target);
    const famsIn = Array.isArray(s.statusBarFamilies) ? s.statusBarFamilies.filter((x: unknown): x is string => typeof x === 'string' && ['claude', 'gemini', 'argon'].includes(x)) : ['claude', 'gemini', 'argon'];
    await cfg.update('statusBar.families', famsIn.length > 0 ? famsIn : ['claude', 'gemini', 'argon'], target);
    logInfo('settings.saved', { ...s });
    // 全池刷新间隔改动即时重排（此前要重启才生效）
    if (Number.isFinite(quotaMin) && Math.min(120, Math.max(5, Math.round(quotaMin))) !== prevQuotaMin) {
      applyQuotaRefreshInterval(this._context);
    }
    // 语言切换：重建 webview 使界面文案立即生效，并补推全部状态
    if (nextLocale !== prevLocale && this._view) {
      statusBarManager?.update();
      this._webviewReady = false;
      this._view.webview.html = this._getHtmlForWebview(this._view.webview);
      this._pushAccounts();
      this._pushSettings();
      this._syncWebviewState();
      return;
    }
    if (!silent) {
      this._view?.webview.postMessage({ type: 'toast', status: 'success', message: t('settingsSaved') });
    }
    this._pushSettings();
  }

  /** 探测调试端口并把状态推给设置面板 */
  private async _pushCdpStatus() {
    const expected = vscode.workspace.getConfiguration('antigravityKite').get<number>('cdpPort', 9333);
    const port = await probeCdpPort();
    logInfo('cdp.status', { connected: !!port, port: port || expected });
    this._view?.webview.postMessage({ type: 'cdpStatus', connected: !!port, port: port || expected, expected });
  }

  /** 重建 webview 后补推状态（对应 resolveWebviewView 的推送序列） */
  private _syncWebviewState() {
    const savedTagColors = this._context.globalState.get<Record<string, string>>('tagColors');
    if (savedTagColors && Object.keys(savedTagColors).length > 0) {
      this._view?.webview.postMessage({ type: 'tagColorsSync', colors: savedTagColors });
    }
  }

  /** 导出账号（全部或指定邮箱集合）：完整含 Token / 脱敏仅邮箱标签 */
  private async _exportAccounts(onlyEmails?: string[]) {
    const all = accountStore.getAll();
    const picked = onlyEmails ? all.filter(a => onlyEmails.includes(a.email)) : all;
    if (picked.length === 0) {
      this._view?.webview.postMessage({ type: 'toast', status: 'warning', message: t('noAccountsToExport') });
      return;
    }
    let masked = false;
    if (!onlyEmails) {
      const mode = await vscode.window.showQuickPick([t('exportModeFull'), t('exportModeMasked')], {
        placeHolder: t('exportModePrompt', picked.length)
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
      filters: { 'JSON': ['json'] },
    });
    if (!uri) return;
    try {
      await vscode.workspace.fs.writeFile(uri, Buffer.from(JSON.stringify(payload, null, 2), 'utf8'));
      this._view?.webview.postMessage({ type: 'toast', status: 'success', message: t('exported', picked.length, uri.fsPath) });
    } catch (err) {
      this._view?.webview.postMessage({ type: 'toast', status: 'error', message: t('exportFailed', err instanceof Error ? err.message : String(err)) });
    }
  }

  /** 刷新单个账号配额（v1.1.16 起委托统一管线：抓取→缓存→tracker→健康归类→三端分发） */
  private async _refreshUsage(email: string) {
    await refreshOneAccountUsage(email, this._context);
    // 无论成败都要收口旋转态，否则按钮会一直转
    this._view?.webview.postMessage({ type: 'refreshDone', scope: 'one', email });
  }

  /** 批量刷新所有账号配额（委托统一管线，批量模式统一落盘收口） */
  private async _refreshAllUsage() {
    const accounts = accountStore.getAll().filter(a => !a.disabled);
    let successCount = 0;
    for (const account of accounts) {
      const snap = await refreshOneAccountUsage(account.email, this._context, { batch: true });
      if (snap) successCount++;
    }
    const errorCount = accounts.length - successCount;
    saveUsageCache(this._context);
    this._pushAccounts();
    logPanel.pushLogPanelData(this._context, usageTracker);
    if (errorCount === 0) {
      this._view?.webview.postMessage({ type: 'toast', status: 'success', message: t('refreshedQuota', successCount) });
    } else if (successCount === 0) {
      // 失败明细已由统一管线逐号推送到卡片（usage error），toast 带最近一条明细
      this._view?.webview.postMessage({ type: 'toast', status: 'error', message: t('refreshAllFailed', errorCount, lastUsageError) });
    } else {
      this._view?.webview.postMessage({ type: 'toast', status: 'warning', message: t('refreshPartial', successCount, errorCount) });
    }
    this._view?.webview.postMessage({ type: 'refreshDone', scope: 'all' });
  }

  /** 单账号健康检测（人工点药丸触发：loadCodeAssist + generateContent 推理探针） */
  private async _checkHealth(email: string) {
    const account = accountStore.getAll().find(a => a.email === email);
    if (!account) return;
    const health = await checkAccountHealth(account);
    persistHealthIfChanged(email, health);
    this._view?.webview.postMessage({ type: 'healthResult', email, health });
  }

  private async _handleMessage(msg: WebviewMessage) {
    logInfo('msg.in', { type: (msg as { type?: string }).type, email: (msg as { email?: string }).email });
    switch (msg.type) {
      case 'oauthLogin':
        try {
          const account = await startOAuth();
          accountStore.add(account);
          this._context.globalState.update('currentEmail', account.email);
          this._pushAccounts();
          notifyUi('success', t('accountAdded', account.email));
          this._refreshUsage(account.email);
        } catch (err) {
          notifyUi('error', t('loginFailed', err instanceof Error ? err.message : String(err)));
        }
        break;

      case 'importLocal':
        try {
          const existingEmails = accountStore.getAll().map(a => a.email);
          const preview = await previewLocalAccount(existingEmails);
          // 发送预览结果到 webview，显示确认弹窗
          this._view?.webview.postMessage({
            type: 'localImportPreview',
            email: preview.email,
            exists: preview.exists,
            tokenExpired: preview.tokenExpired
          });
        } catch (err) {
          notifyUi('error', t('detectFailed', err instanceof Error ? err.message : String(err)));
        }
        break;

      case 'confirmImport':
        try {
          const account = confirmImport();
          if (account) {
            accountStore.add(account);
            this._context.globalState.update('currentEmail', account.email);
            this._pushAccounts();
            notifyUi('success', t('accountImported', account.email));
            this._refreshUsage(account.email);
          }
        } catch (err) {
          notifyUi('error', t('importFailed', err instanceof Error ? err.message : String(err)));
        }
        break;

      case 'cancelImport':
        cancelImport();
        break;

      case 'importFromCockpitTools':
        this._view?.webview.postMessage({ type: 'importStatus', status: 'loading', source: 'Cockpit Tools' });
        try {
          const result1 = await importService.importFromCockpitTools();
          this._pushAccounts();
          this._view?.webview.postMessage({
            type: 'importStatus',
            status: 'success',
            source: 'Cockpit Tools',
            imported: result1.imported,
            skipped: result1.skipped
          });
          if (result1.imported > 0) this._refreshAllUsage();
        } catch (err) {
          this._view?.webview.postMessage({
            type: 'importStatus',
            status: 'error',
            source: 'Cockpit Tools',
            message: err instanceof Error ? err.message : String(err)
          });
        }
        break;

      case 'importFromAntigravityManager':
        this._view?.webview.postMessage({ type: 'importStatus', status: 'loading', source: 'Antigravity Manager' });
        try {
          const result2 = await importService.importFromAntigravityManager();
          this._pushAccounts();
          this._view?.webview.postMessage({
            type: 'importStatus',
            status: 'success',
            source: 'Antigravity Manager',
            imported: result2.imported,
            skipped: result2.skipped
          });
          if (result2.imported > 0) this._refreshAllUsage();
        } catch (err) {
          this._view?.webview.postMessage({
            type: 'importStatus',
            status: 'error',
            source: 'Antigravity Manager',
            message: err instanceof Error ? err.message : String(err)
          });
        }
        break;

      case 'importFromJsonFile':
        this._view?.webview.postMessage({ type: 'importStatus', status: 'loading', source: t('impSourceLocalFile') });
        try {
          const result3 = await importService.importFromJsonFile();
          this._pushAccounts();
          this._view?.webview.postMessage({
            type: 'importStatus',
            status: 'success',
            source: t('impSourceLocalFile'),
            imported: result3.imported,
            skipped: result3.skipped
          });
          if (result3.imported > 0) this._refreshAllUsage();
        } catch (err) {
          if ((err as Error).message !== t('impNoFileSelected')) {
            this._view?.webview.postMessage({
              type: 'importStatus',
              status: 'error',
              source: t('impSourceLocalFile'),
              message: err instanceof Error ? err.message : String(err)
            });
          } else {
            this._view?.webview.postMessage({ type: 'importStatus', status: 'cancelled' });
          }
        }
        break;

      case 'removeAccount':
        if (msg.email) {
          accountStore.remove(msg.email);
          this._pushAccounts();
        }
        break;

      case 'setCurrentAccount':
        if (msg.email) {
          const account = accountStore.getByEmail(msg.email);
          if (account) {
            // 身份权威来源 = Windows 凭据管理器 gemini:antigravity 的 id_token_email
            // （真机实验证实：写它 + 重启 = 账号菜单/头像/名字/额度完整切换）。
            // 流程：备份当前凭据 → 构造目标凭据 → 助手关 IDE 后写凭据/状态库/agy 指针/gemini 文件 → 原参数重启。
            // 无感要求：无确认框，点击即切；用 in-flight 标记防连点重复调度。
            // （原「切号预检」已随 UI 入口移除：开关不可达，保留只会造成永远关闭的假象）
            if (switchInFlight) {
              logWarn('switch.skip.inflight', { email: account.email });
              break;
            }
            switchInFlight = true;
            logInfo('switch.start', { email: account.email });

            // CDP 门控：首次切号探测调试端口；未开启则一次性引导（改快捷方式 + 重启）。
            // 'relaunching' = IDE 正在重启，中止本次切号；ready/manual 均照常执行。
            const gate = await ensureCdpGate(this._context);
            logInfo('switch.gate', { result: gate });
            if (gate === 'relaunching') {
              switchInFlight = false;
              break;
            }

            // token 准备：刷新失败（离线等）时回退号池存储值——IDE 启动后会用 RT 自刷新
            // 切号必须用 RT 现场刷新出的 token（号池缓存 AT 的 scope 可能不含 aicode 权限，
            // 写入会导致 agy 403 ACCESS_TOKEN_SCOPE_INSUFFICIENT 后崩溃）。
            // 刷新失败即取消切号——不做 stored-fallback，那是把 agent 搞崩的元凶。
            let switchToken = {
              accessToken: '',
              refreshToken: '',
              expiryDateSeconds: 0,
              isGcpTos: false,
              idToken: undefined as string | undefined,
            };
            const prepared = await prepareSwitchToken(account);
            if (!prepared.ok) {
              switchInFlight = false;
              logWarn('switch.token.fail', { email: account.email, message: prepared.message });
              this._view?.webview.postMessage({ type: 'toast', status: 'error', message: t('switchCancelled', prepared.message) });
              this._view?.webview.postMessage({ type: 'switchResult', ok: false });
              break;
            }
            switchToken = {
              accessToken: prepared.token.accessToken,
              refreshToken: prepared.token.refreshToken,
              expiryDateSeconds: prepared.token.expiryDateSeconds,
              isGcpTos: false,
              idToken: prepared.token.idToken,
            };
            logInfo('switch.token', { source: 'refreshed', prepareOk: true });

            // 构造目标凭据（AT 过期无妨：IDE 启动后用 RT 自刷新）
            const expiryMs = switchToken.expiryDateSeconds > Math.floor(Date.now() / 1000)
              ? switchToken.expiryDateSeconds * 1000
              : Date.now() + 3600000;
            const blob = buildIdeCredentialBlob({
              email: account.email,
              accessToken: switchToken.accessToken,
              refreshToken: switchToken.refreshToken,
              expiryMs,
            });
            logInfo('switch.cred.build', { email: account.email, expiryMs });

            // ── 热切（不重启 IDE）——机制经真机实验证实 ──
            // 1) 一次 PowerShell 完成「读旧 + 写新」：旧 blob 的 writer_id/auth_method 由脚本内部继承，
            //    旧凭据回传后落盘成可回滚备份（省掉独立读凭据那一趟进程启动 + Add-Type 编译）
            const cw = await swapIdeCredential(blob.blobBase64, 'antigravity');
            logInfo('switch.hot.cred', { ok: cw.ok, error: cw.error });
            if (!cw.ok) {
              switchInFlight = false;
              this._view?.webview.postMessage({ type: 'toast', status: 'error', message: t('switchCredFail', cw.error || '') });
              this._view?.webview.postMessage({ type: 'switchResult', ok: false });
              break;
            }
            if (cw.previous) {
              try {
                const backupPath = path.join(getSharedStorageDir(), 'credential-backup.json');
                fs.writeFileSync(backupPath, JSON.stringify({
                  savedAt: Date.now(),
                  user: cw.previousUser,
                  blob: cw.previous,
                }, null, 2), 'utf8');
                logInfo('switch.cred.backup', { path: backupPath, prevEmail: cw.previous.id_token_email });
              } catch (e) {
                logWarn('switch.cred.backup.write', e);
              }
            } else {
              logWarn('switch.cred.backup.unavailable', { reason: 'previous blob missing' });
            }

            // 2) 状态库（agent/模型一致性）
            const userDataDir = path.resolve(this._context.globalStorageUri.fsPath, '..', '..', '..');
            const dbRes = switchIdeStateIdentity(account.email, {
              accessToken: switchToken.accessToken,
              refreshToken: switchToken.refreshToken,
              expiryDateSeconds: switchToken.expiryDateSeconds,
              isGcpTos: false,
              idToken: switchToken.idToken,
            }, { dbPath: resolveIdeStateDbPathFromUserData(userDataDir) });
            logInfo('switch.hot.db', { dbWritten: dbRes.dbWritten, error: dbRes.error });

            // 3) agy 指针 + gemini 账号文件
            const agyPtr = writeAgyActiveAccount(account.email);
            const gs = syncGeminiAccountFiles({
              email: account.email,
              accessToken: switchToken.accessToken,
              refreshToken: switchToken.refreshToken,
              expiryMs,
            });
            logInfo('switch.hot.files', { agyPtr: agyPtr.ok, gemini: gs.ok, error: agyPtr.error || gs.error });

            // 3.5) ~/.gemini 两处凭据文件同步（可关：AgyHop/Cockpit 用户自行管理时）
            let geminiLocal: { ok: boolean; error?: string } = { ok: true };
            if (vscode.workspace.getConfiguration('antigravityKite').get<boolean>('switch.syncGeminiFiles', true)) {
              geminiLocal = syncGeminiLocalCreds({
                email: account.email,
                accessToken: switchToken.accessToken,
                refreshToken: switchToken.refreshToken,
                expiryMs,
              });
            } else {
              geminiLocal = { ok: true, error: 'skipped (setting off)' };
            }
            logInfo('switch.hot.gemini', { ok: geminiLocal.ok, error: geminiLocal.error });

            // 4) 会话层 token 热切与 agent 引擎重启互不依赖：并行执行，省一段串行等待
            const [hot, agyReload] = await Promise.all([
              seamlessSwitch(account),
              ideRuntime.killAgyEngine(),
            ]);
            logInfo('switch.hot.session', { success: hot.success, message: hot.message });
            logInfo('switch.hot.agyReload', { killed: agyReload.killed, agyWasRunning: agyReload.agyWasRunning, error: agyReload.error });

            // 5) 总线身份推送（依赖会话层已写入）
            const identity = await pushLiveIdentityUpdate(account.email);
            logInfo('switch.hot.identity', { ok: identity.ok, error: identity.error });

            await this._context.globalState.update('currentEmail', msg.email);
            usageTracker.recordSwitch(msg.email);
            this._pushAccounts();
            this._view?.webview.postMessage({ type: 'switchResult', ok: true });
            statusBarManager?.refreshUsage();
            logPanel.pushLogPanelData(this._context, usageTracker);
            this._refreshUsage(msg.email);
            switchInFlight = false;

            const notes: string[] = [];
            if (!agyPtr.ok) notes.push(t('switchAgyPtrFail', agyPtr.error || ''));
            if (gs.error) notes.push(t('switchGeminiFail', gs.error));
            if (agyReload.error) notes.push(agyReload.error);
            if (hot.success && !identity.ok) notes.push(t('switchMenuAlignLater'));
            if (notes.length === 0) {
              notes.push(t('switchDone', account.email));
            }
            this._view?.webview.postMessage({
              type: 'toast',
              status: notes.length === 1 ? 'success' : 'warning',
              message: notes.join('；')
            });
          }
        }
        break;

      case 'getSettings':
        this._pushSettings();
        break;

      case 'privacyChanged':
        // G22：隐私模式权威源提升到 globalState——底栏/tooltip/QuickPick 同步脱敏，
        // 并广播给所有 webview（多窗口同步），不再局限在单个 webview 闭包里
        this._context.globalState.update('privacyMode', msg.enabled === true);
        statusBarManager?.update();
        this._view?.webview.postMessage({ type: 'privacyMode', enabled: msg.enabled === true });
        break;

      case 'openSettings':
        // 底栏 QuickPick"打开设置"落地：webview 侧弹出设置模态框
        this._view?.webview.postMessage({ type: 'openSettings' });
        break;

      case 'getCdpStatus':
        await this._pushCdpStatus();
        break;

      case 'enableCdp': {
        const r = await enableCdp(this._context);
        if (!r.ok) {
          notifyUi('error', t('gateEnableFailed') + (r.error || ''));
          await this._pushCdpStatus();
        }
        // 成功时会重启 IDE（约 10 秒），此处不必再回推
        break;
      }

      case 'saveSettings':
        await this._saveSettings(msg.settings || {}, msg.silent === true);
        break;

      case 'exportAccounts':
        await this._exportAccounts();
        break;

      case 'batchExport':
        if (Array.isArray(msg.emails) && msg.emails.length > 0) {
          await this._exportAccounts(msg.emails as string[]);
        }
        break;

      case 'toggleDisabled':
        if (msg.email) {
          const acct = accountStore.getByEmail(msg.email);
          if (acct) {
            accountStore.update(msg.email, { disabled: !acct.disabled });
            this._pushAccounts();
          }
        }
        break;

      case 'refreshAll':
        // 刷新账号列表和配额
        this._pushAccounts();
        this._view?.webview.postMessage({ type: 'toast', status: 'info', message: t('refreshingQuota') });
        this._refreshAllUsage();
        break;

      case 'refreshUsage':
        if (msg.email) {
          this._refreshUsage(msg.email);
        }
        break;

      case 'checkHealth':
        if (msg.email) {
          this._checkHealth(msg.email);
        }
        break;

      case 'updateTag':
        if (msg.email && Array.isArray(msg.tags)) {
          accountStore.update(msg.email, { tags: msg.tags });
          this._pushAccounts();
        }
        break;

      case 'batchTag':
        if (Array.isArray(msg.emails) && Array.isArray(msg.tags)) {
          for (const email of msg.emails) {
            accountStore.update(email, { tags: [...msg.tags] });
          }
          this._pushAccounts();
          this._view?.webview.postMessage({ type: 'toast', status: 'success', message: t('tagsUpdated', msg.emails.length) });
        }
        break;

      case 'batchDelete':
        if (Array.isArray(msg.emails)) {
          for (const email of msg.emails) {
            accountStore.remove(email);
          }
          this._pushAccounts();
          this._view?.webview.postMessage({ type: 'toast', status: 'success', message: t('accountsDeleted', msg.emails.length) });
        }
        break;

      case 'batchEnable':
        if (Array.isArray(msg.emails)) {
          for (const email of msg.emails) {
            accountStore.setDisabled(email, false);
          }
          this._pushAccounts();
          this._view?.webview.postMessage({ type: 'toast', status: 'success', message: t('accountsEnabled', msg.emails.length) });
        }
        break;

      case 'batchDisable':
        if (Array.isArray(msg.emails)) {
          for (const email of msg.emails) {
            accountStore.setDisabled(email, true);
          }
          this._pushAccounts();
          this._view?.webview.postMessage({ type: 'toast', status: 'success', message: t('accountsDisabled', msg.emails.length) });
        }
        break;

      case 'syncTagColors':
        if (msg.colors && typeof msg.colors === 'object') {
          this._context.globalState.update('tagColors', msg.colors);
        }
        break;

      case 'webviewReady':
        // webview script 执行完毕后主动报到：此刻 message 监听器已注册，
        // 推送才不会因 CSS 等资源加载慢于消息投递而丢失（空账号竞态的根因）
        this._webviewReady = true;
        this._pushAccounts();
        this._pushSettings();
        this._syncWebviewState();
        this._flushOutbox();
        break;

      case 'askResult': {
        const settle = this._askResolvers.get(String(msg.id));
        if (settle) settle(msg.ok === true);
        break;
      }

      case 'webviewError':
        notifyUi('error', `Webview Error: ${msg.message} (Line ${msg.line}, Col ${msg.col})\n${msg.stack || ''}`);
        break;

      default:
        // 未处理的消息类型必须留痕：静默丢弃会让"点了没反应"无法排查
        logWarn('msg.unknown', { type: msg.type });
        break;
    }
  }

  private _getHtmlForWebview(webview: vscode.Webview) {
    const cssUri = webview.asWebviewUri(vscode.Uri.joinPath(this._extensionUri, 'resources', 'webview', 'main.css'));
    return `<!DOCTYPE html>
<html lang="${getLang() === 'zh' ? 'zh-CN' : 'en'}">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src ${webview.cspSource} data: blob:; script-src ${webview.cspSource} 'unsafe-inline'; style-src ${webview.cspSource} 'unsafe-inline'; font-src ${webview.cspSource} data:;">
<meta name="viewport" content="width=device-width,initial-scale=1">
<link rel="stylesheet" href="${cssUri}?v=${Date.now()}">
</head>
<body>
<div class="app">
<!-- 账号页 -->
<div class="tab-page active" id="tabAccounts">
  <div class="list-body">
      <!-- 账号区标题与操作 -->
      <div class="accounts-section-header list-summary">
        <svg class="list-icon" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/></svg>
        <h3 data-i18n="myAccounts">我的账号</h3>
        <span class="list-arrow"></span>
        <div style="flex:1"></div>
        <span class="grid-count" id="gridCount"></span>
        <button class="add-account-btn" id="addAccountBtn" data-i18n="addAccount">添加账号</button>
      </div>
      <div class="panel-divider"></div>
      <!-- 搜索栏 -->
      <div class="search-bar">
        <svg class="search-icon" width="13" height="13" viewBox="0 0 24 24" fill="currentColor" stroke="none"><path d="M10.8 4a6.8 6.8 0 1 0 4.25 12.12l3.42 3.42a1.2 1.2 0 0 0 1.7-1.7l-3.42-3.42A6.8 6.8 0 0 0 10.8 4Zm0 2.4a4.4 4.4 0 1 1 0 8.8 4.4 4.4 0 0 1 0-8.8Z"/></svg>
        <input type="text" class="search-input" id="searchInput" placeholder="搜索账号..." autocomplete="off" data-i18n-ph="searchPh">
        <button class="search-clear" id="searchClear" hidden>×</button>
      </div>
      <!-- 过滤器（已并入下方工具栏下拉） -->
      <!-- 工具栏（windsurf-pool 风格） -->
      <div class="toolbar-bar" id="toolbarBar">
        <div class="filter-wrap" id="filterWrap">
          <button class="filter-trigger" id="filterTrigger" data-i18n-title="filter" title="过滤">
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polygon points="22 3 2 3 10 12.46 10 19 14 21 14 12.46 22 3"/></svg>
            <span id="filterLabel">ALL</span>
            <span class="filter-count" id="filterTriggerCount"></span>
          </button>
          <div class="filter-dropdown" id="filterDropdown" hidden>
            <div class="filter-section" id="filterPlanSection">
              <div class="filter-section-title" data-i18n="plan">套餐</div>
              <div class="filter-options" id="filterPlanList"></div>
            </div>
            <div class="filter-section" id="filterTagSection">
              <div class="filter-section-title" data-i18n="tags">标签</div>
              <div class="filter-options" id="filterTagList"></div>
            </div>
            <div class="filter-section" id="filterStatusSection">
              <div class="filter-section-title" data-i18n="status">状态</div>
              <div class="filter-options" id="filterStatusList"></div>
            </div>
            <div class="filter-actions">
              <button class="filter-clear-btn" id="filterClearBtn" data-i18n="clearFilters">清空筛选</button>
            </div>
          </div>
        </div>
        <select class="group-select" id="sortSelect" data-i18n-title="sortBy" title="排序方式">
          <option value="default" data-i18n="sortDefault">默认排序</option>
          <option value="recommend" data-i18n="sortRecommend">推荐</option>
          <option value="email" data-i18n="sortEmail">邮箱 A-Z</option>
          <option value="time" data-i18n="sortTime">导入时间</option>
        </select>
        <button class="sort-direction-btn" id="sortDirectionBtn" data-i18n-title="sortDir" title="切换排序方向">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <line x1="12" y1="5" x2="12" y2="19"/>
            <polyline points="19 12 12 19 5 12"/>
          </svg>
        </button>
        <button class="toolbar-icon-btn" id="refreshAllBtn" data-i18n-title="refreshAll" title="刷新全部">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 12a9 9 0 0 1 9-9 9.75 9.75 0 0 1 6.74 2.74L21 8"/><path d="M21 3v5h-5"/><path d="M21 12a9 9 0 0 1-9 9 9.75 9.75 0 0 1-6.74-2.74L3 16"/><path d="M8 16H3v5"/></svg>
        </button>
        <button class="toolbar-icon-btn" id="exportAccountsBtn" data-i18n-title="exportAll" title="导出账号设置">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>
        </button>
        <button class="toolbar-icon-btn" id="privacyModeBtn" data-i18n-title="privacyOff" title="隐私模式：隐藏邮箱">
          <svg class="privacy-eye" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M1 12s4-7 11-7 11 7 11 7-4 7-11 7S1 12 1 12z"/><circle cx="12" cy="12" r="3"/></svg>
        </button>
        <div style="flex:1"></div>
        <select class="page-size-select" id="pageSizeSelect" data-i18n-title="pageSize" title="每页显示">
          <option value="10" data-i18n="pageSize10">10/页</option>
          <option value="20" selected data-i18n="pageSize20">20/页</option>
          <option value="50" data-i18n="pageSize50">50/页</option>
          <option value="0" data-i18n="showAll">全部</option>
        </select>
        <button class="group-select-mode-btn" id="selectModeBtn" data-i18n-title="selectModeTitle" title="多选模式">
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="9 11 12 14 22 4"/><path d="M21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11"/></svg>
          <span data-i18n="selectMode">多选</span>
        </button>
        <button class="toolbar-icon-btn" id="settingsBtn" data-i18n-title="settings" title="设置">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z"/></svg>
        </button>
      </div>
      <!-- 批量操作栏 -->
      <div class="batch-bar" id="batchBar" hidden>
        <label class="batch-check-all"><input type="checkbox" id="batchCheckAll"><span data-i18n="selectAll">全选</span></label>
        <div style="flex:1"></div>
        <span class="batch-count" id="batchCount"></span>
        <button class="batch-action-btn" id="batchTagBtn" data-i18n-title="batchTagTitle" data-i18n="batchTag" title="为选中账号设置标签">加标签</button>
        <button class="batch-action-btn" id="batchEnableBtn" data-i18n-title="batchEnableTitle" data-i18n="batchEnable" title="启用选中账号">启用</button>
        <button class="batch-action-btn" id="batchDisableBtn" data-i18n-title="batchDisableTitle" data-i18n="batchDisable" title="禁用选中账号">禁用</button>
        <button class="batch-action-btn" id="batchExportBtn" data-i18n-title="batchExportTitle" data-i18n="batchExport" title="导出选中账号">导出</button>
        <button class="batch-action-btn batch-action-delete" id="batchDeleteBtn" data-i18n-title="batchDeleteTitle" data-i18n="batchDelete" title="删除选中账号">删除</button>
        <button class="batch-action-btn" id="batchCancelBtn" data-i18n="cancel">取消</button>
      </div>
      <!-- 标签栏已移除（导入无需标签；标签筛选保留在工具栏下拉中） -->
      <!-- 添加账号模态框 -->
      <div class="add-account-modal" id="addAccountModal" style="display:none">
        <div class="add-modal-content">
          <div class="add-modal-header">
            <span class="add-modal-title" data-i18n="addModalTitle">添加账号</span>
            <button class="add-modal-close" id="closeAddModal">×</button>
          </div>
          <div class="add-modal-body">
            <button class="add-modal-option" id="btnOAuth">
              <span class="add-option-icon"><svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/></svg></span>
              <div class="add-option-info">
                <span class="add-option-title" data-i18n="oauthTitle">Google 登录</span>
                <span class="add-option-desc" data-i18n="oauthDesc">通过浏览器授权登录</span>
              </div>
            </button>
            <button class="add-modal-option" id="btnImport">
              <span class="add-option-icon"><svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/></svg></span>
              <div class="add-option-info">
                <span class="add-option-title" data-i18n="importLocalTitle">从本地数据库导入</span>
                <span class="add-option-desc" data-i18n="importLocalDesc">读取本机 Antigravity IDE 客户端登录账号</span>
              </div>
            </button>
            <button class="add-modal-option" id="btnImportCockpit">
              <span class="add-option-icon"><svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="23 4 23 10 17 10"/><polyline points="1 20 1 14 7 14"/><path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15"/></svg></span>
              <div class="add-option-info">
                <span class="add-option-title" data-i18n="importCockpitTitle">从 Cockpit Tools 导入</span>
                <span class="add-option-desc" data-i18n="importCockpitDesc">同步 Cockpit Tools 中的账号</span>
              </div>
            </button>
            <button class="add-modal-option" id="btnImportManager">
              <span class="add-option-icon"><svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg></span>
              <div class="add-option-info">
                <span class="add-option-title" data-i18n="importManagerTitle">从 Antigravity Manager 导入</span>
                <span class="add-option-desc" data-i18n="importManagerDesc">同步 Antigravity Manager 中的账号</span>
              </div>
            </button>
            <button class="add-modal-option" id="btnImportJson">
              <span class="add-option-icon"><svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="12" y1="18" x2="12" y2="12"/><polyline points="9 15 12 12 15 15"/></svg></span>
              <div class="add-option-info">
                <span class="add-option-title" data-i18n="importJsonTitle">从本地文件导入</span>
                <span class="add-option-desc" data-i18n="importJsonDesc">选择 JSON 文件导入账号（支持多种格式）</span>
              </div>
            </button>
          </div>
        </div>
      </div>
      <!-- 账号网格 -->
      <div id="accountGrid" class="account-grid"></div>
      <!-- 分页 -->
      <div id="pagination" class="pagination"></div>
      <div id="emptyState" class="empty-card">
        <div class="empty-title" data-i18n="emptyTitle">还没有账号</div>
        <div class="empty-sub" data-i18n="emptySub">点击上方「添加账号」按钮</div>
      </div>
  </div>
</div>

</div><!-- /.app -->

<!-- 标签编辑弹窗 -->
<div id="tagEditOverlay" class="modal-overlay" hidden>
  <div class="modal-box" style="width:min(400px,90vw)">
    <div class="modal-header">
      <h3 id="tagEditTitle" data-i18n="tagEditTitle">编辑标签</h3>
      <button class="modal-close" id="tagEditClose" data-i18n-title="close" title="关闭">×</button>
    </div>
    <div class="modal-body">
      <div id="tagEditSelected" class="tag-edit-selected" style="display:flex;flex-wrap:wrap;gap:4px;min-height:28px;margin-bottom:8px;padding:4px 0"></div>
      <div style="display:flex;gap:6px;align-items:center">
        <input type="text" id="tagEditInput" placeholder="输入标签名称，回车添加" style="flex:1 1 auto;min-width:0;width:100%;box-sizing:border-box" data-i18n-ph="tagInputPh">
        <button id="tagEditAddBtn" style="flex:0 0 auto;padding:5px 14px;font-size:12px;white-space:nowrap;border-radius:6px;border:1px solid var(--accent,#10b981);background:var(--accent,#10b981);color:#fff;cursor:pointer" data-i18n="add">添加</button>
      </div>
      <div style="margin-top:8px">
        <label style="font-size:11px;opacity:0.7" data-i18n="existingTags">已有标签（点击添加/移除）</label>
        <div id="tagEditExisting" class="tag-edit-existing" style="display:flex;flex-wrap:wrap;gap:4px;margin-top:4px;max-height:120px;overflow-y:auto"></div>
      </div>
      <div style="display:flex;gap:8px;margin-top:12px;justify-content:flex-end">
        <button class="modal-cancel-btn" id="tagEditCancel" style="min-width:72px;padding:6px 20px" data-i18n="cancel">取消</button>
        <button class="primary" id="tagEditSave" style="width:auto;min-width:72px;padding:6px 20px" data-i18n="save">保存</button>
      </div>
    </div>
  </div>
</div>

<!-- 通用确认框（showConfirm 驱动） -->
<div id="confirmOverlay" class="modal-overlay" hidden>
  <div class="modal-box">
    <div class="modal-header">
      <h3 id="confirmTitle" data-i18n="confirmTitle">确认操作</h3>
      <button class="modal-close" id="confirmClose" data-i18n-title="close" title="关闭">×</button>
    </div>
    <div class="modal-body">
      <div class="confirm-message" id="confirmMessage"></div>
      <div class="confirm-actions">
        <button class="modal-cancel-btn" id="confirmCancel" style="min-width:72px;padding:6px 20px" data-i18n="cancel">取消</button>
        <button class="confirm-danger-btn" id="confirmOk" data-i18n="ok">确认</button>
      </div>
    </div>
  </div>
</div>

<!-- 通用询问弹窗（宿主 askUi 驱动，替代 VS Code 原生 showXxxMessage） -->
<div id="askOverlay" class="modal-overlay" hidden>
  <div class="modal-box" style="width:min(440px,92vw)">
    <div class="modal-header">
      <h3 id="askTitle"></h3>
      <button class="modal-close" id="askClose" data-i18n-title="close" title="关闭">×</button>
    </div>
    <div class="modal-body">
      <div class="ask-meta" id="askMeta"></div>
      <div class="ask-message" id="askMessage"></div>
    </div>
    <div class="modal-footer">
      <button class="modal-cancel-btn" id="askCancel" data-i18n="askCancelBtn">取消</button>
      <button class="primary" id="askOk" style="min-width:96px"></button>
    </div>
  </div>
</div>

<!-- 设置弹窗（工具栏齿轮入口） -->
<div id="settingsOverlay" class="modal-overlay" hidden>
  <div class="modal-box">
    <div class="modal-header">
      <h3 data-i18n="settings">设置</h3>
      <span class="settings-live-tag" data-i18n="sbLiveTag">实时生效</span>
      <button class="modal-close" id="settingsClose" data-i18n-title="close" title="关闭">×</button>
    </div>
    <div class="modal-body">

      <div class="settings-group">
        <div class="settings-group-head">
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12a9 9 0 1 1-2.64-6.36"/><polyline points="21 3 21 9 15 9"/></svg>
          <span data-i18n="autoUpdate">自动更新</span>
        </div>
        <div class="v2-opt-row">
          <span class="v2-opt-label" data-i18n="autoCheckRow">启动时检查更新</span>
          <label class="as-switch"><input type="checkbox" id="setUpdateAutoCheck"><span class="as-switch-track"><span class="as-switch-thumb"></span></span></label>
        </div>
        <div class="v2-opt-row">
          <span class="v2-opt-label" data-i18n="autoInstallRow">静默安装新版</span>
          <label class="as-switch"><input type="checkbox" id="setUpdateAutoInstall"><span class="as-switch-track"><span class="as-switch-thumb"></span></span></label>
        </div>
      </div>

      <div class="settings-group">
        <div class="settings-group-head">
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/></svg>
          <span data-i18n="switchDebug">切号与调试</span>
        </div>
        <div class="v2-opt-row">
          <span class="v2-opt-label" data-i18n="autoConfirmRow">自动确认安全声明</span>
          <label class="as-switch"><input type="checkbox" id="setAutoConfirm"><span class="as-switch-track"><span class="as-switch-thumb"></span></span></label>
        </div>
        <div class="v2-opt-row">
          <span class="v2-opt-label" data-i18n="syncGeminiRow">切号同步 Gemini 配置</span>
          <label class="as-switch"><input type="checkbox" id="setSyncGemini"><span class="as-switch-track"><span class="as-switch-thumb"></span></span></label>
        </div>
        <div class="v2-opt-row">
          <span class="v2-opt-label" data-i18n="cdpPortRow">调试端口</span>
          <input type="number" class="v2-sel sb-port-input" id="setCdpPort" min="1024" max="65535" placeholder="9333">
        </div>
        <div class="v2-opt-row">
          <span class="v2-opt-label" data-i18n="heartbeatRow">CDP 心跳间隔</span>
          <div class="sb-num-row">
            <input type="number" class="v2-param-val" id="setCdpHeartbeat" min="200" max="5000" placeholder="500">
            <span class="v2-param-unit" data-i18n="unitMs">毫秒</span>
          </div>
        </div>
        <div class="settings-hint" data-i18n="heartbeatHint">切号后探测 IDE 就绪的心跳节奏。数值越小切号越快、占用越高；200–5000 毫秒。</div>
        <div class="settings-hint" data-i18n="cdpPortHint">切号时通过该端口与 IDE 通信，9222 会作为兜底自动尝试。</div>
        <div class="cdp-status-row">
          <span class="cdp-dot is-unknown" id="cdpStatusDot"></span>
          <span class="cdp-status-text" id="cdpStatusText" data-i18n="cdpStatusChecking">检测中…</span>
        </div>
        <div class="cdp-actions-row">
          <button class="modal-cancel-btn" id="cdpRecheckBtn" data-i18n="cdpRecheck">重新检测</button>
          <button class="primary cdp-enable-btn" id="cdpEnableBtn" data-i18n="cdpEnableRestart">开启并重启</button>
        </div>
        <div class="settings-hint" data-i18n="cdpEnableHint">开启后会修好桌面 / 开始菜单 / 任务栏快捷方式，并自动重启一次 IDE（约 10 秒），之后切号不再弹安全声明。失败可以在这里重新开启。</div>
      </div>

      <div class="settings-group">
        <div class="settings-group-head">
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><line x1="2" y1="12" x2="22" y2="12"/><path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z"/></svg>
          <span data-i18n="appearance">界面</span>
        </div>
        <div class="v2-opt-row">
          <span class="v2-opt-label" data-i18n="localeRow">提示语言</span>
          <select class="v2-sel" id="setLocale">
            <option value="auto" data-i18n="localeAuto">跟随 IDE</option>
            <option value="zh-CN" data-i18n="localeZh">中文</option>
            <option value="en" data-i18n="localeEn">English</option>
          </select>
        </div>
      </div>

      <div class="settings-group">
        <div class="settings-group-head">
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="18" height="18" rx="2"/><line x1="3" y1="15" x2="21" y2="15"/></svg>
          <span data-i18n="quotaGroup">额度与刷新</span>
        </div>
        <div class="v2-opt-row">
          <span class="v2-opt-label" data-i18n="quotaPoolRow">全池后台刷新间隔</span>
          <div class="sb-num-row">
            <input type="number" class="v2-param-val" id="setQuotaRefresh" min="5" max="120" placeholder="15">
            <span class="v2-param-unit" data-i18n="unitMin">分钟</span>
          </div>
        </div>
        <div class="settings-hint" data-i18n="quotaPoolHint">驱动号池卡片、统计面板与底栏的全量刷新（保存即时生效）。底栏"当前号"另有短周期增量刷新，在状态栏组单独配置。</div>
      </div>

      <div class="settings-group">
        <div class="settings-group-head">
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="18" height="18" rx="2"/><line x1="3" y1="15" x2="21" y2="15"/></svg>
          <span data-i18n="statusBar">状态栏</span>
        </div>
        <div class="v2-opt-row">
          <span class="v2-opt-label" data-i18n="sbEnabledRow">显示状态栏</span>
          <label class="as-switch"><input type="checkbox" id="setStatusEnabled" data-sb="enabled"><span class="as-switch-track"><span class="as-switch-thumb"></span></span></label>
        </div>
        <div class="v2-opt-row">
          <span class="v2-opt-label" data-i18n="sbPositionRow">位置</span>
          <select class="v2-sel" id="setStatusPosition" data-sb="position">
            <option value="left" data-i18n="sbPositionLeft">← 左侧</option>
            <option value="right" data-i18n="sbPositionRight">→ 右侧（默认）</option>
          </select>
        </div>
        <div class="v2-opt-col">
          <span class="v2-opt-label" data-i18n="sbStyleRow">样式</span>
          <div class="sb-style-grid" id="sbStyleGrid"></div>
          <select class="v2-sel" id="setStatusStyle" data-sb="style" hidden>
            <option value="smart" data-i18n="sbStyleSmart">账号 + 最紧额度 — 聚合（推荐）</option>
            <option value="dot" data-i18n="sbStyleDot">状态灯 — 仅图标</option>
            <option value="percent" data-i18n="sbStylePercent">75% — 仅最低百分比</option>
            <option value="compact" data-i18n="sbStyleCompact">状态灯 75% — 图标 + 最低百分比</option>
            <option value="dual" data-i18n="sbStyleDual">状态灯 75% + AI 积分 — 双指标</option>
            <option value="labeled" data-i18n="sbStyleLabeled">账号 + 各模型额度 — 标签式</option>
            <option value="full" data-i18n="sbStyleFull">账号 + 各模型额度 + AI 积分 — 完整</option>
          </select>
        </div>
        <div class="v2-opt-row">
          <span class="v2-opt-label" data-i18n="sbContentRow">显示内容</span>
          <div class="sb-tag-row">
            <span class="v2-tag is-on" id="setStatusAccount" data-sb="showAccount" data-i18n="sbTagAccount">账号</span>
            <span class="v2-tag is-on" id="setStatusModels" data-sb="showModels" data-i18n="sbTagModels">模型额度</span>
            <span class="v2-tag is-on" id="setStatusCredits" data-sb="showCredits" data-i18n="sbTagCredits">AI 积分</span>
            <span class="v2-tag is-on" id="setStatusPool" data-sb="showPool" data-i18n="sbTagPool">号池</span>
            <span class="v2-tag is-on" id="setStatusTier" data-sb="showTier" data-i18n="sbTagTier">会员级别</span>
            <span class="v2-tag is-on" id="setStatusReset" data-sb="showResetCountdown" data-i18n="sbTagReset">重置倒计时</span>
          </div>
        </div>
        <div class="v2-opt-row">
          <span class="v2-opt-label" data-i18n="sbFamilyRow">配额池</span>
          <div class="sb-tag-row">
            <span class="v2-tag is-on" id="setStatusFamClaude" data-family="claude">Claude</span>
            <span class="v2-tag is-on" id="setStatusFamGemini" data-family="gemini">Gemini</span>
            <span class="v2-tag is-on" id="setStatusFamArgon" data-family="argon">Gemini 4</span>
          </div>
        </div>
        <div class="v2-opt-row">
          <span class="v2-opt-label" data-i18n="sbRefreshRow">刷新间隔</span>
          <div class="sb-num-row">
            <input type="number" class="v2-param-val" id="setStatusRefresh" data-sb="refreshSeconds" min="10" max="600" placeholder="30">
            <span class="v2-param-unit" data-i18n="unitSec">秒</span>
          </div>
        </div>
        <div class="settings-hint" data-i18n="sbRefreshHint">以上改动即时生效，无需点保存。极简样式只显示最低额度，标签式逐项列出各模型。</div>
      </div>

    </div>
    <div class="modal-footer">
      <button class="modal-cancel-btn" id="settingsReset" type="button" data-i18n="resetDefaults">恢复默认</button>
      <div style="display:flex;gap:8px;">
        <button class="modal-cancel-btn" id="settingsCancel" type="button" data-i18n="cancel">取消</button>
        <button class="primary" id="settingsSave" type="button" style="min-width:80px;" data-i18n="saveSettings">保存设置</button>
      </div>
    </div>
  </div>
</div>

<div id="toastContainer" class="toast-container"></div>

<script>
window.onerror = function(msg, url, line, col, err) {
  document.title = 'ERR: ' + msg + ' @L' + line;
  const d = document.createElement('pre');
  d.style.cssText = 'position:fixed;top:0;left:0;right:0;z-index:99999;background:red;color:white;font-size:11px;padding:8px;white-space:pre-wrap;';
  d.textContent = msg + '\\nLine: ' + line + ', Col: ' + col + '\\n' + (err && err.stack || '');
  document.body.prepend(d);
  try {
    vscode.postMessage({ type: 'webviewError', message: String(msg), line: line, col: col, stack: err && err.stack || '' });
  } catch(e) {}
};
const vscode = acquireVsCodeApi();
// ── i18n：宿主按当前语言注入的语言包 + 静态 DOM 文案应用 ──
const L = ${JSON.stringify(localeBundle('ui.'))};
function tl(key) {
  let s = L[key] || key;
  for (let i = 1; i < arguments.length; i++) {
    s = s.split('{' + (i - 1) + '}').join(String(arguments[i]));
  }
  return s;
}
(function applyI18n() {
  // L 缺键时保留 HTML 里的中文兜底文案，绝不把键名裸奔给用户
  document.querySelectorAll('[data-i18n]').forEach(el => { const v = L[el.getAttribute('data-i18n')]; if (v !== undefined) el.textContent = v; });
  document.querySelectorAll('[data-i18n-ph]').forEach(el => { el.placeholder = tl(el.getAttribute('data-i18n-ph')); });
  document.querySelectorAll('[data-i18n-title]').forEach(el => { el.title = tl(el.getAttribute('data-i18n-title')); });
  // 两个计数带参数，静态 HTML 不写死中文，交给 tl() 按当前语言填
  const gridCount = document.getElementById('gridCount');
  if (gridCount) gridCount.textContent = tl('accountsCount', 0);
  const batchCount = document.getElementById('batchCount');
  if (batchCount) batchCount.textContent = tl('selectedCount', 0);
})();
let accounts = [];
let currentEmail = '';
let searchTerm = '';
let activeFilter = 'all'; // all, active, disabled
let filterTags = new Set(); // 多选标签过滤
let sortBy = 'default';
let pageSize = 20;
let currentPage = 1;
let privacyMode = false;
let tagColors = {}; // tag → color hex
let tagEditMode = null; // null | 'edit' | 'batch'
let tagEditEmail = null;
let tagEditBatchEmails = null;
let tagEditPendingTags = [];
let selectMode = false;
const selectedEmails = new Set();

// ── 标签颜色系统 ──
const TAG_PALETTE = ['#8b5cf6','#3b82f6','#10b981','#f59e0b','#ef4444','#ec4899','#06b6d4','#84cc16','#f97316','#6366f1'];
try { tagColors = JSON.parse(localStorage.getItem('kite-tag-colors') || '{}'); } catch(e) { tagColors = {}; }
// 恢复过滤器状态
try { const st = vscode.getState() || {}; if (st._filterTags) filterTags = new Set(st._filterTags); } catch {}

function saveTagColors() {
  try { localStorage.setItem('kite-tag-colors', JSON.stringify(tagColors)); } catch(e) {}
  vscode.postMessage({ type: 'syncTagColors', colors: tagColors });
}
function getTagColor(tag) {
  if (!tag) return TAG_PALETTE[0];
  if (tagColors[tag]) return tagColors[tag];
  let hash = 0;
  for (let i = 0; i < tag.length; i++) hash = ((hash << 5) - hash + tag.charCodeAt(i)) | 0;
  return TAG_PALETTE[Math.abs(hash) % TAG_PALETTE.length];
}
function getAccTags(a) {
  if (a.tags && a.tags.length > 0) return a.tags;
  if (a.tag) return [a.tag];
  return [];
}
function getTagList() {
  const tags = new Set();
  accounts.forEach(a => { getAccTags(a).forEach(t => tags.add(t)); });
  return [...tags].sort();
}
function persistTagFilters() {
  try { const st = vscode.getState() || {}; st._filterTags = [...filterTags]; vscode.setState(st); } catch {}
}
const _escDiv = document.createElement('div');
function escHtml(text) { _escDiv.textContent = text; return _escDiv.innerHTML; }

function maskEmail(email) {
  if (!email) return '';
  const at = email.indexOf('@');
  if (at <= 0) return email.slice(0, 2) + '***';
  const name = email.slice(0, at);
  const domain = email.slice(at + 1);
  const maskedName = name.length <= 2 ? name[0] + '***' : name.slice(0, 2) + '***' + name.slice(-1);
  return maskedName + '@***';
}
function displayEmail(email) {
  return privacyMode ? maskEmail(email) : email;
}

function formatResetTime(isoTime) {
  if (!isoTime) return '';
  const reset = new Date(isoTime);
  const now = new Date();
  const diffMs = reset - now;
  if (diffMs <= 0) return tl('resetDone');
  const hours = Math.floor(diffMs / 3600000);
  const mins = Math.floor((diffMs % 3600000) / 60000);
  const days = Math.floor(hours / 24);
  if (days > 0) return tl('resetDays', days, hours % 24);
  if (hours > 0) return tl('resetHours', hours, mins);
  if (mins > 0) return tl('resetMinutes', mins);
  return tl('resetSoon');
}

function pctClass(pct) {
  if (pct <= 10) return 'is-danger';
  if (pct <= 30) return 'is-warn';
  if (pct < 50) return 'is-info';
  return 'is-ok';
}

// 档位分类：与 Manager normalize_subscription_tier 关键词表对齐（quota.rs 实测：
// loadCodeAssist UserTier.id ∈ free-tier / standard-tier / g1-pro-tier / g1-ultra-tier，
// helium 是 Ultra 内部代号 GDP_HELIUM；Plus 为 2026 新档 $4.99，Manager v5.0.3 尚未收录）
function planTierClass(tierId) {
  if (!tierId) return 'tier-unknown';
  const t = String(tierId).toLowerCase();
  if (t.includes('ultra') || t.includes('helium')) return 'tier-ultra';
  if (t.includes('plus')) return 'tier-plus';
  if (t.includes('free') || t.includes('starter')) return 'tier-free';
  if (t.includes('pro') || t.includes('premium') || t.includes('advanced')) return 'tier-pro';
  if (t.includes('trial')) return 'tier-trial';
  if (t.includes('enterprise') || t.includes('standard') || t.includes('business') || t.startsWith('gcp_') || t.includes('vertex')) return 'tier-enterprise';
  return 'tier-unknown';
}

// 会员级别徽章图标：逐字复制 lucide diamond/gem/circle 路径（对齐 Antigravity Manager
// AccountRow.tsx 的 Diamond/Gem/Circle + fill-current；svg-icon-untested-asset 禁手写）
function planChipIcon(tierClass) {
  if (tierClass === 'tier-pro') {
    return '<svg width="10" height="10" viewBox="0 0 24 24" fill="currentColor" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M2.7 10.3a2.41 2.41 0 0 0 0 3.41l7.59 7.59a2.41 2.41 0 0 0 3.41 0l7.59-7.59a2.41 2.41 0 0 0 0-3.41l-7.59-7.59a2.41 2.41 0 0 0-3.41 0Z"/></svg>';
  }
  if (tierClass === 'tier-ultra') {
    return '<svg width="10" height="10" viewBox="0 0 24 24" fill="currentColor" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M10.5 3 8 9l4 13 4-13-2.5-6"/><path d="M17 3a2 2 0 0 1 1.6.8l3 4a2 2 0 0 1 .013 2.382l-7.99 10.986a2 2 0 0 1-3.247 0l-7.99-10.986A2 2 0 0 1 2.4 7.8l2.998-3.997A2 2 0 0 1 7 3z"/><path d="M2 9h20"/></svg>';
  }
  if (tierClass === 'tier-plus') {
    // Plus 档：lucide circle-dot（Free 空心圆 → Plus 圆点 → Pro 菱形 → Ultra 宝石 的阶梯递进）
    return '<svg width="10" height="10" viewBox="0 0 24 24" fill="currentColor" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="1"/><circle cx="12" cy="12" r="10"/></svg>';
  }
  if (tierClass === 'tier-free' || tierClass === 'tier-unknown') {
    return '<svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/></svg>';
  }
  return '';
}

// 会员级别文案：大驼峰，Ultra 保留官方倍数后缀（Ultra 5x / Ultra 20x，小写 x）。
// 与 statusBar.ts displayTierLabel 同 spec 双载（宿主/webview 各一份，maskEmailStr 同款套路）
function planTierLabel(tierId) {
  if (!tierId) return '...';
  const s = String(tierId);
  const t = s.toLowerCase();
  // 模板字面量内必须 \\d 双转义——单写 \d 会被 cook 成 'd'，倍数提取静默失灵
  const mult = /(\\d+x)/i.exec(s);
  if (t.includes('ultra') || t.includes('helium')) return 'Ultra' + (mult ? ' ' + mult[1] : '');
  if (t.includes('plus')) return 'Plus';
  if (t.includes('free') || t.includes('starter')) return 'Free';
  if (t.includes('pro') || t.includes('premium') || t.includes('advanced')) return 'Pro';
  if (t.includes('trial')) return 'Trial';
  if (t.includes('enterprise') || t.includes('standard') || t.includes('business') || t.startsWith('gcp_') || t.includes('vertex')) return 'Enterprise';
  if (t.includes('team')) return 'Team';
  return s;
}

// ── 刷新按钮旋转态：点击即转，收到宿主 refreshDone 才停（60s 兜底并在控制台留痕） ──
const REFRESH_SPIN_SELECTOR = '#refreshAllBtn, .icon-btn.is-refresh';
function startRefreshSpin(el) {
  if (!el) return;
  el.classList.add('is-spinning');
  if (el.__kiteRefreshTimer) clearTimeout(el.__kiteRefreshTimer);
  el.__kiteRefreshTimer = setTimeout(() => {
    el.classList.remove('is-spinning');
    el.__kiteRefreshTimer = null;
    console.warn('[kite] 60s 未收到 refreshDone，已停止旋转');
  }, 60000);
}
function stopRefreshSpin(el) {
  if (!el) return;
  el.classList.remove('is-spinning');
  if (el.__kiteRefreshTimer) { clearTimeout(el.__kiteRefreshTimer); el.__kiteRefreshTimer = null; }
}
function setRefreshSpinning(selector, on) {
  document.querySelectorAll(selector).forEach(el => { if (on) startRefreshSpin(el); else stopRefreshSpin(el); });
}
function refreshUsage(btn, email) {
  startRefreshSpin(btn);
  vscode.postMessage({ type: 'refreshUsage', email: email });
}

function showAddModal() {
  document.getElementById('addAccountModal').style.display = 'flex';
}
function hideAddModal() {
  document.getElementById('addAccountModal').style.display = 'none';
}

document.getElementById('addAccountBtn').onclick = showAddModal;
document.getElementById('closeAddModal').onclick = hideAddModal;
document.getElementById('addAccountModal').onclick = (e) => { if (e.target.id === 'addAccountModal') hideAddModal(); };
document.getElementById('btnOAuth').onclick = () => { hideAddModal(); vscode.postMessage({ type: 'oauthLogin' }); };
document.getElementById('btnImport').onclick = () => { hideAddModal(); vscode.postMessage({ type: 'importLocal' }); };
document.getElementById('btnImportCockpit').onclick = () => { hideAddModal(); vscode.postMessage({ type: 'importFromCockpitTools' }); };
document.getElementById('btnImportManager').onclick = () => { hideAddModal(); vscode.postMessage({ type: 'importFromAntigravityManager' }); };
document.getElementById('btnImportJson').onclick = () => { hideAddModal(); vscode.postMessage({ type: 'importFromJsonFile' }); };

// 搜索功能
document.getElementById('searchInput').oninput = (e) => {
  searchTerm = e.target.value.toLowerCase();
  currentPage = 1;
  document.getElementById('searchClear').hidden = !searchTerm;
  renderAccounts();
};
document.getElementById('searchClear').onclick = () => {
  document.getElementById('searchInput').value = '';
  searchTerm = '';
  document.getElementById('searchClear').hidden = true;
  renderAccounts();
};

// 过滤器（状态筛选按钮已移除，统一并入工具栏下拉）

// 排序
document.getElementById('sortSelect').onchange = (e) => {
  sortBy = e.target.value;
  currentPage = 1;
  renderAccounts();
};

// 分页大小
document.getElementById('pageSizeSelect').onchange = (e) => {
  pageSize = parseInt(e.target.value) || 0;
  currentPage = 1;
  renderAccounts();
};

// 刷新全部：按钮与各卡刷新图标一起转，直到宿主回报完成
document.getElementById('refreshAllBtn').onclick = () => {
  setRefreshSpinning(REFRESH_SPIN_SELECTOR, true);
  vscode.postMessage({ type: 'refreshAll' });
};

// 隐私模式（eye / eye-off 双态图标，BuddyRelay 同款路径）
const PRIVACY_EYE_SVG = '<svg class="privacy-eye" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M1 12s4-7 11-7 11 7 11 7-4 7-11 7S1 12 1 12z"/><circle cx="12" cy="12" r="3"/></svg>';
const PRIVACY_EYE_OFF_SVG = '<svg class="privacy-eye" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M17.94 17.94A10.94 10.94 0 0 1 12 19C5 19 1 12 1 12a20.29 20.29 0 0 1 5.06-5.94"/><path d="M9.9 4.24A10.84 10.84 0 0 1 12 4c7 0 11 8 11 8a20.88 20.88 0 0 1-2.16 3.19"/><path d="M14.12 14.12A3 3 0 0 1 9.88 9.88"/><line x1="1" y1="1" x2="23" y2="23"/></svg>';
document.getElementById('privacyModeBtn').onclick = () => {
  privacyMode = !privacyMode;
  const btn = document.getElementById('privacyModeBtn');
  btn.classList.toggle('is-active', privacyMode);
  btn.innerHTML = privacyMode ? PRIVACY_EYE_OFF_SVG : PRIVACY_EYE_SVG;
  btn.title = privacyMode ? tl('privacyOn') : tl('privacyOff');
  // 权威源在宿主 globalState（G22）：上报后由宿主广播回推，底栏/tooltip/QuickPick 同步脱敏
  vscode.postMessage({ type: 'privacyChanged', enabled: privacyMode });
  renderAccounts();
};
// 隐私开关初值：以宿主 accounts payload 的 privacyMode 为权威（多窗口一致）；
// 本地 getState 仅作 webview 先于首刷渲染时的兜底，宿主 payload 到达后覆盖
(function initPrivacyMode() {
  let saved = false;
  try { saved = !!(vscode.getState() && vscode.getState()._privacy); } catch (e) {}
  if (!saved) return;
  privacyMode = true;
  const btn = document.getElementById('privacyModeBtn');
  if (btn) {
    btn.classList.add('is-active');
    btn.innerHTML = PRIVACY_EYE_OFF_SVG;
    btn.title = tl('privacyOn');
  }
})();

// 导出按钮
const _exportBtn = document.getElementById('exportAccountsBtn');
if (_exportBtn) _exportBtn.onclick = () => vscode.postMessage({ type: 'exportAccounts' });

// 排序方向
let sortDir = 'desc';
const _sortDirBtn = document.getElementById('sortDirectionBtn');
if (_sortDirBtn) _sortDirBtn.onclick = () => {
  sortDir = sortDir === 'desc' ? 'asc' : 'desc';
  const svg = _sortDirBtn.querySelector('svg polyline');
  if (svg) {
    const wrap = _sortDirBtn.querySelector('svg');
    if (wrap) wrap.style.transform = sortDir === 'asc' ? 'rotate(180deg)' : 'rotate(0deg)';
  }
  currentPage = 1;
  renderAccounts();
};

// 筛选下拉（套餐 / 标签 / 状态三组，接活过滤逻辑）
let filterPlans = new Set(); // 套餐（tierId 大写）
const _filterTrigger = document.getElementById('filterTrigger');
const _filterDropdown = document.getElementById('filterDropdown');
const _filterClearBtn = document.getElementById('filterClearBtn');

function filterCheckRow(kind, value, count, checked, label) {
  return '<label class="filter-option-check"><input type="checkbox" data-kind="' + kind + '" data-value="' + escHtml(value) + '"' + (checked ? ' checked' : '') + '><span>' + escHtml(label || value) + '</span><span style="margin-left:auto;opacity:0.55;font-size:10px">' + count + '</span></label>';
}
function renderFilterDropdown() {
  const planSec = document.getElementById('filterPlanSection');
  const tagSec = document.getElementById('filterTagSection');
  const planList = document.getElementById('filterPlanList');
  const tagList = document.getElementById('filterTagList');
  const statusList = document.getElementById('filterStatusList');
  if (!planList || !tagList || !statusList) return;
  const plans = {};
  accounts.forEach(a => {
    const t = ((a.usage && a.usage.tierId) || tl('unknown')).toUpperCase();
    plans[t] = (plans[t] || 0) + 1;
  });
  const planKeys = Object.keys(plans).sort();
  if (planSec) planSec.style.display = planKeys.length ? '' : 'none';
  planList.innerHTML = planKeys.map(p => filterCheckRow('plan', p, plans[p], filterPlans.has(p), planTierLabel(p))).join('');
  const tags = getTagList();
  if (tagSec) tagSec.style.display = tags.length ? '' : 'none';
  tagList.innerHTML = tags.map(t => filterCheckRow('tag', t, accounts.filter(a => getAccTags(a).includes(t)).length, filterTags.has(t))).join('');
  statusList.innerHTML = [
    ['all', tl('filterAll')],
    ['active', tl('active')],
    ['disabled', tl('disabled')]
  ].map(s => filterCheckRow('status', s[0],
    s[0] === 'all' ? accounts.length : accounts.filter(a => s[0] === 'active' ? !a.disabled : a.disabled).length,
    activeFilter === s[0], s[1])).join('');
}
function updateFilterTriggerLabel() {
  const n = filterPlans.size + filterTags.size + (activeFilter !== 'all' ? 1 : 0);
  const label = document.getElementById('filterLabel');
  if (label) label.textContent = n > 0 ? tl('filteredCount', n) : tl('filterAll');
}
if (_filterTrigger && _filterDropdown) {
  _filterTrigger.onclick = (e) => {
    e.stopPropagation();
    if (_filterDropdown.hidden) renderFilterDropdown();
    _filterDropdown.hidden = !_filterDropdown.hidden;
  };
  document.addEventListener('click', (e) => {
    if (!_filterDropdown.hidden && !_filterDropdown.contains(e.target) && e.target !== _filterTrigger) {
      _filterDropdown.hidden = true;
    }
  });
  _filterDropdown.addEventListener('change', (e) => {
    const cb = e.target.closest('input[type="checkbox"]');
    if (!cb) return;
    const kind = cb.dataset.kind;
    const value = cb.dataset.value;
    if (kind === 'plan') {
      if (cb.checked) filterPlans.add(value); else filterPlans.delete(value);
    } else if (kind === 'tag') {
      if (cb.checked) filterTags.add(value); else filterTags.delete(value);
      persistTagFilters();
    } else if (kind === 'status') {
      activeFilter = value;
      _filterDropdown.querySelectorAll('input[data-kind="status"]').forEach(x => { if (x !== cb) x.checked = false; });
    }
    currentPage = 1;
    updateFilterTriggerLabel();
    renderAccounts();
  });
}
if (_filterClearBtn) _filterClearBtn.onclick = () => {
  // 清空全部筛选条件
  activeFilter = 'all';
  filterTags.clear();
  filterPlans.clear();
  renderFilterDropdown();
  updateFilterTriggerLabel();
  currentPage = 1;
  renderAccounts();
  if (_filterDropdown) _filterDropdown.hidden = true;
};

// ── 多选模式 ──
document.getElementById('selectModeBtn').onclick = () => {
  selectMode = !selectMode;
  document.getElementById('selectModeBtn').classList.toggle('is-active', selectMode);
  document.getElementById('batchBar').hidden = !selectMode;
  if (!selectMode) { selectedEmails.clear(); }
  updateBatchCount();
  renderAccounts();
};

function updateBatchCount() {
  const el = document.getElementById('batchCount');
  if (el) el.textContent = tl('selectedCount', selectedEmails.size);
  const allCb = document.getElementById('batchCheckAll');
  const visible = getVisibleAccounts();
  if (allCb) allCb.checked = visible.length > 0 && visible.every(a => selectedEmails.has(a.email));
}

function getVisibleAccounts() {
  let list = accounts.slice();
  if (searchTerm) list = list.filter(a => a.email.toLowerCase().includes(searchTerm));
  if (activeFilter === 'active') list = list.filter(a => !a.disabled);
  else if (activeFilter === 'disabled') list = list.filter(a => a.disabled);
  if (filterTags.size > 0) {
    list = list.filter(a => {
      const at = getAccTags(a);
      if (at.length > 0) return at.some(t => filterTags.has(t));
      return filterTags.has(tl('untagged'));
    });
  }
  if (filterPlans.size > 0) {
    list = list.filter(a => filterPlans.has(((a.usage && a.usage.tierId) || tl('unknown')).toUpperCase()));
  }
  return list;
}

// 全选/取消
document.getElementById('batchCheckAll').onchange = (e) => {
  const visible = getVisibleAccounts();
  if (e.target.checked) {
    visible.forEach(a => selectedEmails.add(a.email));
  } else {
    visible.forEach(a => selectedEmails.delete(a.email));
  }
  updateBatchCount();
  renderAccounts();
};

// 批量打标签
document.getElementById('batchTagBtn').onclick = () => {
  if (selectedEmails.size === 0) { showToast(tl('pickFirst'), 'warning'); return; }
  openTagEditModalBatch([...selectedEmails]);
};

// 批量启用
document.getElementById('batchEnableBtn').onclick = () => {
  if (selectedEmails.size === 0) return;
  vscode.postMessage({ type: 'batchEnable', emails: [...selectedEmails] });
};

// 批量禁用
document.getElementById('batchDisableBtn').onclick = () => {
  if (selectedEmails.size === 0) return;
  vscode.postMessage({ type: 'batchDisable', emails: [...selectedEmails] });
};

// 批量删除
document.getElementById('batchDeleteBtn').onclick = () => {
  if (selectedEmails.size === 0) return;
  showConfirm(tl('confirmBatchDelete', selectedEmails.size), {
    title: tl('batchDeleteTitle'),
    okText: tl('batchDelete'),
    onConfirm: () => {
      vscode.postMessage({ type: 'batchDelete', emails: [...selectedEmails] });
      selectedEmails.clear();
      updateBatchCount();
    }
  });
};

// 批量导出
const _batchExportBtn = document.getElementById('batchExportBtn');
if (_batchExportBtn) _batchExportBtn.onclick = () => {
  if (selectedEmails.size === 0) { showToast(tl('pickFirst'), 'warning'); return; }
  vscode.postMessage({ type: 'batchExport', emails: [...selectedEmails] });
};

// 取消多选
const _batchCancelBtn = document.getElementById('batchCancelBtn');
if (_batchCancelBtn) _batchCancelBtn.onclick = () => {
  selectMode = false;
  selectedEmails.clear();
  const sm = document.getElementById('selectModeBtn');
  if (sm) sm.classList.remove('is-active');
  const bb = document.getElementById('batchBar');
  if (bb) bb.hidden = true;
  updateBatchCount();
  renderAccounts();
};

// ── 标签颜色选择器 ──
function openTagColorPicker(tag, anchorEl) {
  const existing = document.getElementById('tagColorPicker');
  if (existing) existing.remove();
  const picker = document.createElement('div');
  picker.id = 'tagColorPicker';
  picker.className = 'tag-color-picker';
  const currentColor = getTagColor(tag);
  picker.innerHTML = '<div class="tag-color-picker-title">' + tl('tagColorTitle', tag) + '</div>'
    + '<div class="tag-color-picker-grid">'
    + TAG_PALETTE.map(c => '<span class="tag-color-dot' + (c === currentColor ? ' is-active' : '') + '" data-color="' + c + '" style="background:' + c + '"></span>').join('')
    + '</div>'
    + '<div class="tag-color-picker-custom"><input type="color" class="tag-color-input" value="' + currentColor + '"><span class="tag-color-reset" title="' + tl('colorResetTitle') + '">↺</span></div>';
  const rect = anchorEl.getBoundingClientRect();
  picker.style.position = 'fixed';
  picker.style.left = rect.left + 'px';
  picker.style.top = (rect.bottom + 4) + 'px';
  picker.style.zIndex = '9999';
  document.body.appendChild(picker);
  function applyColorChange() { renderAccounts(); }
  picker.querySelectorAll('.tag-color-dot').forEach(dot => {
    dot.addEventListener('click', () => { tagColors[tag] = dot.dataset.color; saveTagColors(); picker.remove(); applyColorChange(); });
  });
  const colorInput = picker.querySelector('.tag-color-input');
  colorInput.addEventListener('input', () => { tagColors[tag] = colorInput.value; saveTagColors(); applyColorChange(); });
  picker.querySelector('.tag-color-reset').addEventListener('click', () => { delete tagColors[tag]; saveTagColors(); picker.remove(); applyColorChange(); });
  setTimeout(() => {
    document.addEventListener('click', function closePicker(e) {
      if (!picker.contains(e.target)) { picker.remove(); document.removeEventListener('click', closePicker); }
    });
  }, 0);
}

// ── 标签编辑弹窗 ──
function openTagEditModal(email) {
  tagEditMode = 'edit';
  tagEditEmail = email;
  tagEditBatchEmails = null;
  const acc = accounts.find(a => a.email === email);
  tagEditPendingTags = acc ? [...getAccTags(acc)] : [];
  document.getElementById('tagEditOverlay').hidden = false;
  document.getElementById('tagEditTitle').textContent = tl('editTagsFor', email.split('@')[0]);
  renderTagEditUI();
}
function openTagEditModalBatch(emails) {
  tagEditMode = 'batch';
  tagEditEmail = null;
  tagEditBatchEmails = [...emails];
  // 预填所有选中账号的共有标签
  const batchAccounts = emails.map(e => accounts.find(a => a.email === e)).filter(Boolean);
  if (batchAccounts.length > 0) {
    const first = new Set(getAccTags(batchAccounts[0]));
    tagEditPendingTags = [...first].filter(t => batchAccounts.every(a => getAccTags(a).includes(t)));
  } else {
    tagEditPendingTags = [];
  }
  document.getElementById('tagEditOverlay').hidden = false;
  document.getElementById('tagEditTitle').textContent = tl('tagBatchTitle', emails.length);
  renderTagEditUI();
}
function renderTagEditUI() {
  const selectedEl = document.getElementById('tagEditSelected');
  const existingEl = document.getElementById('tagEditExisting');
  if (!selectedEl || !existingEl) return;
  if (tagEditPendingTags.length === 0) {
    selectedEl.innerHTML = '<span style="color:var(--muted);font-size:11px">' + tl('noTags') + '</span>';
  } else {
    selectedEl.innerHTML = tagEditPendingTags.map(t => {
      const tc = getTagColor(t);
      return '<span class="tag-edit-chip" style="background:' + tc + '18;border:1px solid ' + tc + '60;color:' + tc + ';padding:2px 10px;border-radius:10px;font-size:11px;cursor:pointer;display:inline-flex;align-items:center;gap:4px" data-tag="' + escHtml(t) + '"><span class="tag-edit-color-dot" data-tag="' + escHtml(t) + '" style="width:10px;height:10px;border-radius:50%;background:' + tc + ';cursor:pointer;flex-shrink:0;border:2px solid #fff;box-shadow:0 0 0 1px ' + tc + '" title="' + tl('changeColor') + '"></span>' + escHtml(t) + ' <span style="opacity:0.5;font-size:13px;margin-left:2px" class="tag-edit-remove">×</span></span>';
    }).join('');
  }
  selectedEl.querySelectorAll('.tag-edit-chip').forEach(chip => {
    const removeBtn = chip.querySelector('.tag-edit-remove');
    if (removeBtn) removeBtn.addEventListener('click', (e) => { e.stopPropagation(); tagEditPendingTags = tagEditPendingTags.filter(x => x !== chip.dataset.tag); renderTagEditUI(); });
    const colorDot = chip.querySelector('.tag-edit-color-dot');
    if (colorDot) colorDot.addEventListener('click', (e) => { e.stopPropagation(); openTagColorPicker(colorDot.dataset.tag, colorDot); });
  });
  const allTags = getTagList();
  const pending = new Set(tagEditPendingTags);
  existingEl.innerHTML = allTags.map(t => {
    const tc = getTagColor(t);
    const selected = pending.has(t);
    return '<span class="tag-edit-opt" style="padding:2px 8px;border-radius:10px;font-size:11px;cursor:pointer;display:inline-flex;align-items:center;gap:4px;border:1px solid ' + tc + '60;background:' + (selected ? tc : tc + '20') + ';color:' + (selected ? '#fff' : tc) + '" data-tag="' + escHtml(t) + '"><span class="tag-edit-color-dot" data-tag="' + escHtml(t) + '" style="width:10px;height:10px;border-radius:50%;background:' + (selected ? '#fff' : tc) + ';cursor:pointer;flex-shrink:0;border:1px solid ' + (selected ? '#fff8' : tc + '80') + '" title="' + tl('changeColor') + '"></span>' + escHtml(t) + '</span>';
  }).join('') || '<span style="color:var(--muted);font-size:11px">' + tl('noTags') + '</span>';
  existingEl.querySelectorAll('.tag-edit-opt').forEach(opt => {
    const colorDot = opt.querySelector('.tag-edit-color-dot');
    if (colorDot) colorDot.addEventListener('click', (e) => { e.stopPropagation(); openTagColorPicker(colorDot.dataset.tag, colorDot); });
    opt.addEventListener('click', () => {
      const t = opt.dataset.tag;
      if (tagEditPendingTags.includes(t)) tagEditPendingTags = tagEditPendingTags.filter(x => x !== t);
      else tagEditPendingTags.push(t);
      renderTagEditUI();
    });
  });
}
function addTagFromInput() {
  const input = document.getElementById('tagEditInput');
  if (!input) return;
  const newTag = input.value.trim();
  if (!newTag) return;
  if (!tagEditPendingTags.includes(newTag)) {
    if (!tagColors[newTag] && !getTagList().includes(newTag)) {
      tagColors[newTag] = TAG_PALETTE[Math.floor(Math.random() * TAG_PALETTE.length)];
      saveTagColors();
    }
    tagEditPendingTags.push(newTag);
    renderTagEditUI();
  }
  input.value = '';
  input.focus();
}
function closeTagEditModal() {
  document.getElementById('tagEditOverlay').hidden = true;
  tagEditMode = null;
  tagEditEmail = null;
  tagEditBatchEmails = null;
  tagEditPendingTags = [];
}
function saveTagEdit() {
  if (tagEditMode === 'edit' && tagEditEmail) {
    vscode.postMessage({ type: 'updateTag', email: tagEditEmail, tags: [...tagEditPendingTags] });
  } else if (tagEditMode === 'batch' && tagEditBatchEmails && tagEditBatchEmails.length > 0) {
    vscode.postMessage({ type: 'batchTag', emails: tagEditBatchEmails, tags: [...tagEditPendingTags] });
  }
  closeTagEditModal();
}

window.addEventListener('message', e => {
  const msg = e.data;
  if (msg.type === 'privacyMode') {
    // 宿主广播（本窗切换回推 / 其他窗口同步）：统一按钮态与渲染
    privacyMode = !!msg.enabled;
    const btn = document.getElementById('privacyModeBtn');
    if (btn) {
      btn.classList.toggle('is-active', privacyMode);
      btn.innerHTML = privacyMode ? PRIVACY_EYE_OFF_SVG : PRIVACY_EYE_SVG;
      btn.title = privacyMode ? tl('privacyOn') : tl('privacyOff');
    }
    try { const st = vscode.getState() || {}; st._privacy = privacyMode; vscode.setState(st); } catch (e) {}
    renderAccounts();
  }
  if (msg.type === 'accounts') {
    accounts = msg.accounts || [];
    currentEmail = msg.currentEmail || '';
    // 隐私态以宿主为权威（G22）：payload 带来的值覆盖本地，多窗口一致
    if (typeof msg.privacyMode === 'boolean' && msg.privacyMode !== privacyMode) {
      privacyMode = msg.privacyMode;
      const btn = document.getElementById('privacyModeBtn');
      if (btn) {
        btn.classList.toggle('is-active', privacyMode);
        btn.innerHTML = privacyMode ? PRIVACY_EYE_OFF_SVG : PRIVACY_EYE_SVG;
        btn.title = privacyMode ? tl('privacyOn') : tl('privacyOff');
      }
      try { const st = vscode.getState() || {}; st._privacy = privacyMode; vscode.setState(st); } catch (e) {}
    }
    renderAccounts();
    updateSummary();
  }
  if (msg.type === 'tagColorsSync') {
    if (msg.colors) { tagColors = msg.colors; try { localStorage.setItem('kite-tag-colors', JSON.stringify(tagColors)); } catch(e) {} renderAccounts(); }
  }
  if (msg.type === 'usage') {
    const idx = accounts.findIndex(a => a.email === msg.email);
    if (idx >= 0) {
      if (msg.snapshot) {
        accounts[idx].usage = msg.snapshot;
        accounts[idx]._usageError = msg.snapshot.loadError || null;
      } else if (msg.error) {
        accounts[idx]._usageError = msg.error;
      }
      renderAccounts();
      updateSummary();
    }
  }
  if (msg.type === 'health') {
    // 后台探针推送：只更新卡片，不弹 toast（避免每小时骚扰）
    const idx = accounts.findIndex(a => a.email === msg.email);
    if (idx >= 0 && msg.health) accounts[idx].health = msg.health;
    renderAccounts();
    updateSummary();
  }
  if (msg.type === 'healthResult') {
    // 人工点击药丸的检测结果：给结论反馈；封禁/失效才弹，正常不刷屏
    healthCheckingEmail = null;
    const idx = accounts.findIndex(a => a.email === msg.email);
    if (idx >= 0 && msg.health) accounts[idx].health = msg.health;
    renderAccounts();
    updateSummary();
    if (msg.health && msg.health.status === 'banned') {
      showToast(tl('healthBannedToast', msg.email), 'error');
    } else if (msg.health && msg.health.status === 'auth_invalid') {
      showToast(tl('healthAuthToast', msg.email), 'warning');
    }
  }
  if (msg.type === 'localImportPreview') {
    showImportConfirmModal(msg.email, msg.exists, msg.tokenExpired);
  }
  if (msg.type === 'importStatus') {
    handleImportStatus(msg);
  }
  if (msg.type === 'toast') {
    showToast(msg.message, msg.status);
  }
  if (msg.type === 'settings') {
    fillSettingsForm(msg.settings);
  }
  if (msg.type === 'openSettings') {
    // 底栏 QuickPick"打开设置"入口：聚焦侧栏后弹出设置模态框
    openSettingsModal();
  }
  if (msg.type === 'switchResult') {
    switchingEmail = null;
    renderAccounts();
  }
  if (msg.type === 'cdpStatus') {
    renderCdpStatus(msg);
  }
  if (msg.type === 'refreshDone') {
    if (msg.scope === 'all') {
      setRefreshSpinning(REFRESH_SPIN_SELECTOR, false);
    } else {
      stopRefreshSpin(document.getElementById('refreshAllBtn'));
      // 用 dataset 比较而不是拼选择器：邮箱里的特殊字符不会破坏 CSS 选择器
      document.querySelectorAll('.icon-btn.is-refresh').forEach(el => {
        if (el.dataset.refreshEmail === msg.email) stopRefreshSpin(el);
      });
    }
  }
  if (msg.type === 'ask') {
    showAsk(msg);
  }
  if (msg.type === 'askDismiss' && msg.id === askId) {
    closeAskOverlay();
    showNextAsk();
  }
});

// 通用询问弹窗（宿主 askUi 下发；不使用 VS Code 原生模态）
let askId = null;
const askQueue = [];
function showAsk(data) {
  // 同一时刻只显示一个，后来的排队，关掉当前再弹（避免互相覆盖导致前一个永远等不到结果）
  if (askId) { askQueue.push(data); return; }
  renderAsk(data);
}
function renderAsk(data) {
  const ov = document.getElementById('askOverlay');
  if (!ov) return;
  askId = data.id || null;
  document.getElementById('askTitle').textContent = data.title || '';
  const meta = document.getElementById('askMeta');
  meta.textContent = data.meta || '';
  meta.hidden = !data.meta;
  const message = document.getElementById('askMessage');
  message.textContent = data.message || '';
  message.hidden = !data.message;
  const ok = document.getElementById('askOk');
  ok.textContent = data.okText || tl('ok');
  document.getElementById('askCancel').textContent = data.cancelText || tl('askCancelBtn');
  ov.hidden = false;
  // 只在 webview 本来就是焦点时聚焦按钮：启动时的提示不该把光标从编辑器里抢走
  if (document.hasFocus()) ok.focus();
}
function closeAskOverlay() {
  const ov = document.getElementById('askOverlay');
  if (ov) ov.hidden = true;
  askId = null;
}
function showNextAsk() {
  const next = askQueue.shift();
  if (next) renderAsk(next);
}
function answerAsk(ok) {
  const id = askId;
  closeAskOverlay();
  if (id) vscode.postMessage({ type: 'askResult', id: id, ok: ok });
  showNextAsk();
}
(function bindAsk() {
  const ok = document.getElementById('askOk');
  const cancel = document.getElementById('askCancel');
  const close = document.getElementById('askClose');
  if (ok) ok.onclick = () => answerAsk(true);
  if (cancel) cancel.onclick = () => answerAsk(false);
  if (close) close.onclick = () => answerAsk(false);
})();

// Toast 通知（BuddyRelay 同款：图标 + 消息，底部容器统一管理）
const TOAST_ICONS = {
  success: '<svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 8l3 3 7-7"/></svg>',
  error: '<svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="2"><circle cx="8" cy="8" r="6.5"/><line x1="8" y1="5" x2="8" y2="9" stroke-linecap="round"/><circle cx="8" cy="11.5" r="0.6" fill="currentColor" stroke="none"/></svg>',
  warning: '<svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="2"><circle cx="8" cy="8" r="6.5"/><line x1="8" y1="5" x2="8" y2="9" stroke-linecap="round"/><circle cx="8" cy="11.5" r="0.6" fill="currentColor" stroke="none"/></svg>',
  info: '<svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="2"><circle cx="8" cy="8" r="6.5"/><line x1="8" y1="11.5" x2="8" y2="7.5" stroke-linecap="round"/><circle cx="8" cy="4.8" r="0.6" fill="currentColor" stroke="none"/></svg>'
};
function showToast(message, type = 'info', duration = 3000, raw = false) {
  let container = document.getElementById('toastContainer');
  if (!container) {
    container = document.createElement('div');
    container.id = 'toastContainer';
    container.className = 'toast-container';
    document.body.appendChild(container);
  }
  const existing = container.querySelector('.toast');
  if (existing) existing.remove();

  const toast = document.createElement('div');
  toast.className = 'toast toast-' + type;
  const icon = type === 'loading'
    ? '<span class="toast-spinner"></span>'
    : '<span class="toast-icon">' + (TOAST_ICONS[type] || TOAST_ICONS.info) + '</span>';
  // 默认转义：错误文案可能来自服务端返回的 HTML 片段；raw=true 仅用于调用方自建的排版片段
  const body = raw ? String(message) : escHtml(String(message));
  toast.innerHTML = icon + '<span class="toast-msg">' + body + '</span>';
  container.appendChild(toast);

  requestAnimationFrame(() => toast.classList.add('show'));

  if (duration > 0) {
    setTimeout(() => {
      toast.classList.remove('show');
      setTimeout(() => toast.remove(), 300);
    }, duration);
  }
  return toast;
}

// 通用确认框（对齐 BuddyRelay showConfirm 模式，替代原生 confirm）
let _confirmCb = null;
function showConfirm(message, opts) {
  opts = opts || {};
  const titleEl = document.getElementById('confirmTitle');
  const msgEl = document.getElementById('confirmMessage');
  const okBtn = document.getElementById('confirmOk');
  if (!titleEl || !msgEl || !okBtn) return;
  titleEl.textContent = opts.title || tl('confirmTitle');
  msgEl.textContent = message;
  okBtn.textContent = opts.okText || tl('ok');
  okBtn.style.background = opts.danger === false ? 'var(--ac-emerald, #10b981)' : 'var(--gh-red, #f85149)';
  _confirmCb = opts.onConfirm || null;
  document.getElementById('confirmOverlay').hidden = false;
}
function closeConfirm() {
  const ov = document.getElementById('confirmOverlay');
  if (ov) ov.hidden = true;
  _confirmCb = null;
}
(function() {
  const ov = document.getElementById('confirmOverlay');
  if (!ov) return;
  document.getElementById('confirmClose').onclick = closeConfirm;
  document.getElementById('confirmCancel').onclick = closeConfirm;
  document.getElementById('confirmOk').onclick = () => {
    const cb = _confirmCb;
    closeConfirm();
    if (cb) cb();
  };
  ov.addEventListener('click', (e) => { if (e.target === ov) closeConfirm(); });
})();

// ── 设置面板（工具栏齿轮入口） ──
function fillSettingsForm(s) {
  if (!s) s = {};
  const set = (id, val) => { const el = document.getElementById(id); if (el) el.value = val; };
  const chk = (id, val) => {
    const el = document.getElementById(id);
    if (!el) return;
    if (el.classList.contains('v2-tag')) { el.classList.toggle('is-on', !!val); return; }
    el.checked = !!val;
  };
  chk('setUpdateAutoCheck', s.updateAutoCheck !== false);
  chk('setUpdateAutoInstall', s.updateAutoInstall !== false);
  chk('setAutoConfirm', s.autoConfirmDeclaration !== false);
  chk('setSyncGemini', s.syncGeminiFiles !== false);
  set('setCdpPort', s.cdpPort || 9333);
  set('setCdpHeartbeat', s.cdpHeartbeatMs || 500);
  set('setQuotaRefresh', s.quotaRefreshMinutes || 15);
  set('setLocale', s.locale || 'auto');
  chk('setStatusEnabled', s.statusBarEnabled !== false);
  set('setStatusPosition', s.statusBarPosition || 'right');
  set('setStatusStyle', s.statusBarStyle || 'smart');
  chk('setStatusAccount', s.statusBarAccount !== false);
  chk('setStatusModels', s.statusBarModels !== false);
  chk('setStatusCredits', s.statusBarCredits !== false);
  chk('setStatusPool', s.statusBarPool !== false);
  chk('setStatusTier', s.statusBarTier !== false);
  chk('setStatusReset', s.statusBarResetCountdown !== false);
  const fams = Array.isArray(s.statusBarFamilies) ? s.statusBarFamilies : ['claude', 'gemini', 'argon'];
  chk('setStatusFamClaude', fams.indexOf('claude') >= 0);
  chk('setStatusFamGemini', fams.indexOf('gemini') >= 0);
  chk('setStatusFamArgon', fams.indexOf('argon') >= 0);
  set('setStatusRefresh', s.statusBarRefresh || 30);
  if (typeof syncStyleCards === 'function') syncStyleCards();
  if (typeof renderDemos === 'function') renderDemos();
}

function openSettingsModal() {
  const ov = document.getElementById('settingsOverlay');
  if (!ov) return;
  ov.hidden = false;
  vscode.postMessage({ type: 'getSettings' });
  // 每次打开都重新探测一次调试端口，避免显示过期状态
  renderCdpStatus(null);
  vscode.postMessage({ type: 'getCdpStatus' });
}

function closeSettingsModal() {
  const ov = document.getElementById('settingsOverlay');
  if (ov) ov.hidden = true;
}

// CDP 状态：实时显示调试端口是否连上，并提供「重新检测 / 开启并重启」
function renderCdpStatus(s) {
  const dot = document.getElementById('cdpStatusDot');
  const text = document.getElementById('cdpStatusText');
  const enableBtn = document.getElementById('cdpEnableBtn');
  if (!dot || !text) return;
  if (!s) {
    dot.className = 'cdp-dot is-unknown';
    text.textContent = tl('cdpStatusChecking');
    if (enableBtn) enableBtn.disabled = true;
    return;
  }
  dot.className = 'cdp-dot ' + (s.connected ? 'is-ok' : 'is-bad');
  text.textContent = s.connected
    ? tl('cdpStatusConnected', s.port)
    : tl('cdpStatusDisconnected', s.expected);
  if (enableBtn) enableBtn.disabled = !!s.connected;
}
(function bindCdpActions() {
  const recheck = document.getElementById('cdpRecheckBtn');
  const enable = document.getElementById('cdpEnableBtn');
  if (recheck) recheck.onclick = () => {
    renderCdpStatus(null);
    vscode.postMessage({ type: 'getCdpStatus' });
  };
  // 重启会关掉整个 IDE：按钮内两段式确认，不额外弹窗也不打断
  let armed = false;
  let armTimer = null;
  if (enable) enable.onclick = () => {
    if (!armed) {
      armed = true;
      enable.textContent = tl('cdpConfirmRestart');
      enable.classList.add('is-armed');
      armTimer = setTimeout(() => {
        armed = false;
        enable.textContent = tl('cdpEnableRestart');
        enable.classList.remove('is-armed');
      }, 5000);
      return;
    }
    if (armTimer) clearTimeout(armTimer);
    armed = false;
    enable.classList.remove('is-armed');
    const text = document.getElementById('cdpStatusText');
    const dot = document.getElementById('cdpStatusDot');
    if (text) text.textContent = tl('cdpRestarting');
    if (dot) dot.className = 'cdp-dot is-unknown';
    vscode.postMessage({ type: 'enableCdp' });
  };
})();

(function() {
  const ov = document.getElementById('settingsOverlay');
  if (!ov) return;
  const settingsBtn = document.getElementById('settingsBtn');
  if (settingsBtn) settingsBtn.onclick = openSettingsModal;
  const closeBtn = document.getElementById('settingsClose');
  if (closeBtn) closeBtn.onclick = closeSettingsModal;
  const cancelBtn = document.getElementById('settingsCancel');
  if (cancelBtn) cancelBtn.onclick = closeSettingsModal;
  ov.addEventListener('click', (e) => { if (e.target === ov) closeSettingsModal(); });

  // ── 整页实时生效：任何控件变更立即静默保存 ──
  const readSettings = () => {
    const val = (id) => { const el = document.getElementById(id); return el ? el.value : ''; };
    const on = (id) => {
      const el = document.getElementById(id);
      if (!el) return false;
      if (el.classList.contains('v2-tag')) return el.classList.contains('is-on');
      return !!el.checked;
    };
    const num = (id, dft) => { const n = Number(val(id)); return Number.isFinite(n) && n > 0 ? n : dft; };
    return {
      updateAutoCheck: on('setUpdateAutoCheck'),
      updateAutoInstall: on('setUpdateAutoInstall'),
      autoConfirmDeclaration: on('setAutoConfirm'),
      cdpPort: num('setCdpPort', 9333),
      cdpHeartbeatMs: num('setCdpHeartbeat', 500),
      syncGeminiFiles: on('setSyncGemini'),
      quotaRefreshMinutes: num('setQuotaRefresh', 15),
      locale: val('setLocale') || 'auto',
      statusBarEnabled: on('setStatusEnabled'),
      statusBarPosition: val('setStatusPosition') || 'right',
      statusBarStyle: val('setStatusStyle') || 'smart',
      statusBarRefresh: num('setStatusRefresh', 30),
      statusBarAccount: on('setStatusAccount'),
      statusBarModels: on('setStatusModels'),
      statusBarCredits: on('setStatusCredits'),
      statusBarPool: on('setStatusPool'),
      statusBarTier: on('setStatusTier'),
      statusBarResetCountdown: on('setStatusReset'),
      statusBarFamilies: ['setStatusFamClaude', 'setStatusFamGemini', 'setStatusFamArgon']
        .filter(function (id) { return on(id); })
        .map(function (id) { return document.getElementById(id).getAttribute('data-family'); })
    };
  };
  const pushSettings = (silent) => {
    vscode.postMessage({ type: 'saveSettings', silent: !!silent, settings: readSettings() });
  };

  // ── 状态栏样式卡片选择器：每张卡内嵌该档真实形态的迷你状态栏预览（对标 Cockpit 选项内嵌样例 + Devin-Kite 预览区）──
  // 图标体系对齐参考项目：emoji 色点四档（🟢≥50/🟡30-50/🟠10-30/🔴<10），族分格多池多窗口
  // demo 人形图标逐字复制本文件 list-icon 已验证 user 路径（devloop svg-icon-untested-asset 纪律）
  const SB_USER_SVG = '<svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/></svg>';
  // demo 与底栏同一套内容开关：读"显示内容/配额池"tag 的实时状态，点击 tag 立即在预览里见效（双反馈）
  function sbOpts() {
    const on = (id) => { const el = document.getElementById(id); return !el || el.classList.contains('is-on'); };
    return {
      account: on('setStatusAccount'),
      models: on('setStatusModels'),
      credits: on('setStatusCredits'),
      tier: on('setStatusTier'),
      reset: on('setStatusReset'),
      claude: on('setStatusFamClaude'),
      gemini: on('setStatusFamGemini'),
      argon: on('setStatusFamArgon')
    };
  }
  function sbDemoHTML(style) {
    const o = sbOpts();
    const DOT = '🟢';
    const sep = '<span class="sbd-dim">|</span>';
    // 族分格：与 statusBar.formatFamilySegments 同语义——关掉的池不渲染，族内 5h%/周% 斜杠
    const fams = [];
    if (o.claude) fams.push(DOT + ' Claude 96%/100%');
    if (o.gemini) fams.push(DOT + ' Gemini 98%');
    if (o.argon) fams.push(DOT + ' Gemini 4 91%');
    const FAM = fams.join(' · ');
    const acc = o.account ? '<span class="sbd-seg">' + SB_USER_SVG + 'soulvon2501' + (o.tier ? ' ·Pro' : '') + '</span>' : '';
    const pct = o.models ? '<span class="sbd-seg">' + DOT + ' 96%</span>' : '';
    const rst = o.models && o.reset ? '<span class="sbd-seg">🕐 Claude 5h 4h 55m</span>' : '';
    const cred = o.credits ? '<span class="sbd-seg">🪙 87.5</span>' : '';
    const minPct = o.claude && o.gemini ? (o.argon ? 91 : 96) : (o.gemini ? 98 : (o.argon ? 91 : 96));
    const pctStr = o.models ? minPct + '%' : '';
    switch (style) {
      case 'smart':   return [acc, pct, rst, cred].filter(Boolean).join('') || '<span class="sbd-dim">—</span>';
      case 'dot':     return o.models ? '<span class="sbd-seg">' + DOT + '</span>' : (cred || '<span class="sbd-dim">—</span>');
      case 'percent': return o.models ? '<span class="sbd-seg">' + pctStr + '</span>' : '<span class="sbd-dim">—</span>';
      case 'compact': return o.models ? '<span class="sbd-seg">' + DOT + ' ' + pctStr + (rst ? ' 🕐 Claude 5h 4h 55m' : '') + '</span>' : '<span class="sbd-dim">—</span>';
      case 'dual':    return ((o.models ? '<span class="sbd-seg">' + DOT + ' ' + pctStr + '</span>' : '') + (rst ? '<span class="sbd-seg">' + rst + '</span>' : '') + (cred ? sep + cred : '')) || '<span class="sbd-dim">—</span>';
      const famRst = o.models && o.reset ? ' 🕐 5h 4h 55m' : '';
      case 'labeled': return [acc, o.models && FAM ? '<span class="sbd-seg">' + FAM + famRst + '</span>' : ''].filter(Boolean).join(sep) || '<span class="sbd-dim">—</span>';
      case 'full':    return [acc, o.models && FAM ? '<span class="sbd-seg">' + FAM + '</span>' : '', cred].filter(Boolean).join(sep) || '<span class="sbd-dim">—</span>';
    }
    return '';
  }
  function renderDemos() {
    const grid = document.getElementById('sbStyleGrid');
    if (!grid) return;
    grid.querySelectorAll('.sb-style-card').forEach(card => {
      const demo = card.querySelector('.sb-style-demo');
      if (demo) demo.innerHTML = sbDemoHTML(card.getAttribute('data-style'));
    });
  }
  window.syncStyleCards = function() {
    const sel = document.getElementById('setStatusStyle');
    const grid = document.getElementById('sbStyleGrid');
    if (!sel || !grid) return;
    grid.querySelectorAll('.sb-style-card').forEach(c => c.classList.toggle('is-on', c.getAttribute('data-style') === sel.value));
  };
  (function buildStyleCards() {
    const grid = document.getElementById('sbStyleGrid');
    const sel = document.getElementById('setStatusStyle');
    if (!grid || !sel || grid.dataset.built) return;
    grid.dataset.built = '1';
    const NAMES = {
      smart: tl('sbStyleSmartName'),
      dot: tl('sbStyleDotName'),
      percent: tl('sbStylePercentName'),
      compact: tl('sbStyleCompactName'),
      dual: tl('sbStyleDualName'),
      labeled: tl('sbStyleLabeledName'),
      full: tl('sbStyleFullName')
    };
    Object.keys(NAMES).forEach(st => {
      const card = document.createElement('div');
      card.className = 'sb-style-card' + (sel.value === st ? ' is-on' : '');
      card.setAttribute('data-style', st);
      card.innerHTML = '<div class="sb-style-demo">' + sbDemoHTML(st) + '</div><div class="sb-style-name">' + NAMES[st] + '</div>';
      card.onclick = () => {
        sel.value = st;
        window.syncStyleCards();
        pushSettings(true);
      };
      grid.appendChild(card);
    });
  })();
  ov.querySelectorAll('input, select').forEach(el => {
    if (el.type === 'hidden') return;
    el.addEventListener('change', () => pushSettings(true));
  });
  ov.querySelectorAll('.v2-tag').forEach(tag => {
    tag.onclick = () => {
      tag.classList.toggle('is-on');
      pushSettings(true);
      if (typeof renderDemos === 'function') renderDemos();
    };
  });

  const resetBtn = document.getElementById('settingsReset');
  if (resetBtn) resetBtn.onclick = () => {
    fillSettingsForm({
      updateAutoCheck: true,
      updateAutoInstall: true,
      autoConfirmDeclaration: true,
      cdpPort: 9333,
      cdpHeartbeatMs: 500,
      syncGeminiFiles: true,
      quotaRefreshMinutes: 15,
      locale: 'auto',
      statusBarEnabled: true,
      statusBarPosition: 'right',
      statusBarStyle: 'smart',
      statusBarRefresh: 30,
      statusBarAccount: true,
      statusBarModels: true,
      statusBarCredits: true,
      statusBarPool: true,
      statusBarTier: true,
      statusBarResetCountdown: true,
      statusBarFamilies: ['claude', 'gemini', 'argon']
    });
    // 恢复默认后立即落盘生效
    pushSettings(true);
  };

  // 设置已实时落盘，保存按钮只做收尾确认与关闭
  const saveBtn = document.getElementById('settingsSave');
  if (saveBtn) saveBtn.onclick = () => {
    pushSettings(false);
    closeSettingsModal();
  };
})();

// 导入状态处理
let loadingToast = null;
function handleImportStatus(msg) {
  if (msg.status === 'loading') {
    // loading 类型的图标本身就是 spinner，message 里不要再塞一个
    loadingToast = showToast(tl('importingFrom', msg.source), 'loading', 0);
  } else if (msg.status === 'success') {
    if (loadingToast) { loadingToast.remove(); loadingToast = null; }
    const total = msg.imported + msg.skipped;
    let text = tl('importDone', escHtml(msg.source));
    if (msg.imported > 0) text += '<br><span class="toast-detail">' + tl('importAdded', msg.imported) + '</span>';
    if (msg.skipped > 0) text += '<br><span class="toast-detail">' + tl('importSkipped', msg.skipped) + '</span>';
    if (total === 0) text = tl('importNone', escHtml(msg.source));
    showToast(text, msg.imported > 0 ? 'success' : 'warning', 4000, true);
  } else if (msg.status === 'error') {
    if (loadingToast) { loadingToast.remove(); loadingToast = null; }
    showToast(tl('importFailed') + '<br><span class="toast-detail">' + escHtml(msg.message) + '</span>', 'error', 5000, true);
  } else if (msg.status === 'cancelled') {
    if (loadingToast) { loadingToast.remove(); loadingToast = null; }
  }
}

// ── 卡片交互（多选复选框）+ 标签编辑弹窗按钮 ──
(function() {
  const accountGrid = document.getElementById('accountGrid');
  if (accountGrid) {
    accountGrid.addEventListener('click', (e) => {
      // 多选复选框
      const checkbox = e.target.closest('.grid-check-input');
      if (checkbox) {
        const email = checkbox.dataset.email;
        if (email) {
          if (checkbox.checked) selectedEmails.add(email);
          else selectedEmails.delete(email);
          updateBatchCount();
        }
        return;
      }
    });
  }
  // 标签编辑弹窗按钮绑定
  const tagEditClose = document.getElementById('tagEditClose');
  const tagEditCancel = document.getElementById('tagEditCancel');
  const tagEditSave = document.getElementById('tagEditSave');
  const tagEditAddBtn = document.getElementById('tagEditAddBtn');
  const tagEditInput = document.getElementById('tagEditInput');
  const tagEditOverlay = document.getElementById('tagEditOverlay');
  if (tagEditClose) tagEditClose.onclick = closeTagEditModal;
  if (tagEditCancel) tagEditCancel.onclick = closeTagEditModal;
  if (tagEditSave) tagEditSave.onclick = saveTagEdit;
  if (tagEditAddBtn) tagEditAddBtn.onclick = addTagFromInput;
  if (tagEditInput) tagEditInput.onkeydown = (e) => { if (e.key === 'Enter') { e.preventDefault(); addTagFromInput(); } };
  if (tagEditOverlay) tagEditOverlay.onclick = (e) => { if (e.target === tagEditOverlay) closeTagEditModal(); };
})();

// 导入确认弹窗
function showImportConfirmModal(email, exists, tokenExpired) {
  // 移除已存在的 modal
  const old = document.getElementById('importConfirmModal');
  if (old) old.remove();
  
  const modal = document.createElement('div');
  modal.id = 'importConfirmModal';
  modal.className = 'import-modal-overlay';
  
  const maskedEmail = email ? email.replace(/(.{2}).*(@.*)/, '$1***$2') : tl('unknown');
  let title = exists ? tl('inPool') : tl('detectedLocal');
  let desc = exists
    ? tl('overwritePrompt')
    : tl('addPrompt');
  const confirmText = exists ? tl('overwrite') : tl('addToPool');

  // Token 过期提示
  const expiredWarning = tokenExpired
    ? '<div class="import-modal-warning"><svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="2" style="vertical-align:-2px;margin-right:4px"><circle cx="8" cy="8" r="6.5"/><line x1="8" y1="5" x2="8" y2="9" stroke-linecap="round"/><circle cx="8" cy="11.5" r="0.6" fill="currentColor" stroke="none"/></svg>' + tl('expiredWarning') + '</div>'
    : '';
  
  modal.innerHTML = \`
    <div class="import-modal-content">
      <div class="import-modal-header">
        <span class="import-modal-title">\${title}</span>
        <button class="import-modal-close" onclick="closeImportModal()">×</button>
      </div>
      <div class="import-modal-body">
        <div class="import-modal-email">\${escHtml(maskedEmail)}</div>
        <div class="import-modal-desc">\${desc}</div>
        \${expiredWarning}
      </div>
      <div class="import-modal-actions">
        <button class="import-modal-btn cancel" onclick="closeImportModal()">\${tl('cancel')}</button>
        <button class="import-modal-btn confirm" onclick="confirmImportAction()">\${confirmText}</button>
      </div>
    </div>
  \`;
  
  document.body.appendChild(modal);
}

function closeImportModal() {
  const modal = document.getElementById('importConfirmModal');
  if (modal) modal.remove();
  vscode.postMessage({ type: 'cancelImport' });
}

function confirmImportAction() {
  const modal = document.getElementById('importConfirmModal');
  if (modal) modal.remove();
  vscode.postMessage({ type: 'confirmImport' });
}

function updateSummary() {
  document.getElementById('gridCount').textContent = tl('accountsCount', accounts.length);
}

function renderAccounts() {
  const grid = document.getElementById('accountGrid');
  const empty = document.getElementById('emptyState');
  
  let filtered = accounts;
  
  // 搜索过滤
  if (searchTerm) {
    filtered = filtered.filter(a => a.email.toLowerCase().includes(searchTerm));
  }
  
  // 状态过滤
  if (activeFilter === 'active') {
    filtered = filtered.filter(a => !a.disabled);
  } else if (activeFilter === 'disabled') {
    filtered = filtered.filter(a => a.disabled);
  }
  
  // 标签过滤（多选）
  if (filterTags.size > 0) {
    filtered = filtered.filter(a => {
      const at = getAccTags(a);
      if (at.length > 0) return at.some(t => filterTags.has(t));
      return filterTags.has(tl('untagged'));
    });
  }

  // 套餐过滤
  if (filterPlans.size > 0) {
    filtered = filtered.filter(a => filterPlans.has(((a.usage && a.usage.tierId) || tl('unknown')).toUpperCase()));
  }

  // 排序
  filtered = filtered.slice().sort((a, b) => {
    // 当前账户始终在第一位
    if (a.email === currentEmail) return -1;
    if (b.email === currentEmail) return 1;

    let cmp = 0;
    if (sortBy === 'email') {
      cmp = a.email.localeCompare(b.email);
    } else if (sortBy === 'time') {
      const ta = a.importMeta?.importedAt || '';
      const tb = b.importMeta?.importedAt || '';
      cmp = tb.localeCompare(ta); // 新的在前
    } else if (sortBy === 'recommend') {
      // 推荐:按可用度(取各模型最低值)降序
      const aMin = a.usage?.models?.length ? Math.min(...a.usage.models.map(m => m.remainingPercent)) : -1;
      const bMin = b.usage?.models?.length ? Math.min(...b.usage.models.map(m => m.remainingPercent)) : -1;
      cmp = bMin - aMin;
    }
    if (cmp === 0) cmp = a.email.localeCompare(b.email);
    return typeof sortDir !== 'undefined' && sortDir === 'asc' ? -cmp : cmp;
  });
  
  // 更新筛选计数
  const totalFiltered = filtered.length;
  
  // 分页处理
  const totalPages = pageSize > 0 ? Math.ceil(totalFiltered / pageSize) : 1;
  if (currentPage > totalPages) currentPage = Math.max(1, totalPages);
  
  const startIdx = pageSize > 0 ? (currentPage - 1) * pageSize : 0;
  const endIdx = pageSize > 0 ? startIdx + pageSize : totalFiltered;
  const paged = filtered.slice(startIdx, endIdx);
  
  // filterCount 徽标已移除
  
  if (totalFiltered === 0) {
    grid.innerHTML = '';
    empty.style.display = 'block';
    empty.querySelector('.empty-title').textContent = searchTerm ? tl('noMatchTitle') : tl('emptyTitle');
    renderPagination(0, 0);
    return;
  }
  empty.style.display = 'none';

  const cards = paged.map(a => {
    const isCurrent = a.email === currentEmail;
    const rawEmail = a.email;
    // 邮箱 local-part 可合法含引号，内联 onclick 里必须一并转义，否则可破坏内联 JS
    const safeEmail = rawEmail.replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/'/g,'&#39;').replace(/"/g,'&quot;');
    const showEmail = displayEmail(rawEmail).replace(/</g,'&lt;').replace(/>/g,'&gt;');
    // 隐私模式连 title 一起遮：否则 hover 一下就漏了完整邮箱
    const emailTitle = showEmail.replace(/'/g,'&#39;').replace(/"/g,'&quot;');
    // tags 由卡片内 getAccTags+getTagColor 动态渲染
    const isDisabled = a.disabled;
    
    // 从 usage 读取配额数据
    const usage = a.usage;
    const tierId = usage?.tierId || '';
    const tierClass = planTierClass(tierId);
    const tierLabel = planTierLabel(tierId);
    
    // 模型配额：单列竖排（Claude 5h / Claude 周额度 / Gemini 5h / Gemini 周额度 / Gemini 4 周额度[有则出现]）
    const models = usage?.models || [];
    const quotaItemHtml = (label, pct, resetStr) => {
      const cls = pctClass(pct);
      return '<div class="grid-quota-item">'
        + '<div class="grid-quota-head">'
          + '<span class="grid-quota-label">' + escHtml(label) + '</span>'
          + '<span class="grid-quota-val ' + cls + '">' + pct + '%</span>'
        + '</div>'
        + '<div class="quota-bar">'
          + '<div class="quota-bar-fill ' + cls + '" style="width:' + Math.max(0, Math.min(100, pct)) + '%"></div>'
        + '</div>'
        + (resetStr ? '<div class="grid-quota-reset">' + escHtml(resetStr) + '</div>' : '')
      + '</div>';
    };

    let quotasHtml;
    if (models.length > 0) {
      // 排序规则：Claude 5h -> Claude 周额度 -> Gemini 5h -> Gemini 周额度 -> Gemini 4 5h -> Gemini 4 周额度 -> 其他
      const sortOrder = {
        'claude:5h': 1,
        'claude:weekly': 2,
        'gemini:5h': 3,
        'gemini:weekly': 4,
        'argon:5h': 5,
        'argon:weekly': 6,
      };
      const sortedModels = [...models].sort((a, b) => {
        const orderA = sortOrder[a.modelId] || 99;
        const orderB = sortOrder[b.modelId] || 99;
        return orderA - orderB;
      });

      quotasHtml = sortedModels.map(m => {
        const isWeekly = m.modelId?.endsWith(':weekly') || /week/i.test(m.label || '');
        const family = /argon/i.test(m.modelId || '') ? 'Gemini 4'
          : /claude/i.test(m.modelId || m.label || '') ? 'Claude'
          : 'Gemini';
        const displayLabel = family + ' ' + (isWeekly ? tl('quotaWeekly') : tl('quota5h'));
        const resetStr = m.resetTime ? formatResetTime(m.resetTime) : '';
        return quotaItemHtml(displayLabel, m.remainingPercent, resetStr);
      }).join('');
    } else {
      // 无数据占位骨架：默认 4 项（双语自适应，无 Gemini 4 时不占位）
      const phLabels = [
        'Claude ' + tl('quota5h'),
        'Claude ' + tl('quotaWeekly'),
        'Gemini ' + tl('quota5h'),
        'Gemini ' + tl('quotaWeekly'),
      ];
      const loadErrorHtml = a._usageError
        ? '<div class="quota-load-error">' + escHtml(String(a._usageError)) + '</div>'
        : '';
      const phHtml = phLabels.map(label => {
        return '<div class="grid-quota-item" style="opacity:0.45;">'
          + '<div class="grid-quota-head">'
            + '<span class="grid-quota-label">' + label + '</span>'
            + '<span class="grid-quota-val">—</span>'
          + '</div>'
          + '<div class="quota-bar">'
            + '<div class="quota-bar-fill" style="width:0%"></div>'
          + '</div>'
        + '</div>';
      }).join('');
      quotasHtml = phHtml + loadErrorHtml;
    }

    const sig = cardSig(a);
    const html = '<div class="grid-card ' + (isCurrent ? 'is-active' : '') + ' ' + (isDisabled ? 'is-disabled' : '') + (a.health && a.health.status === 'banned' ? ' is-banned' : '') + (selectMode ? ' is-select-mode' : '') + '" data-email="' + safeEmail + '" data-sig="' + sig + '">'
      + (selectMode ? '<div class="grid-check-col"><input type="checkbox" class="grid-check-input" data-email="' + safeEmail + '" ' + (selectedEmails.has(rawEmail) ? 'checked' : '') + '></div>' : '')
      + '<div class="grid-card-head">'
        + '<div class="grid-card-email" title="' + emailTitle + '">' + showEmail + '</div>'
        + (isCurrent ? '<span class="grid-active-tag">' + tl('current') + '</span>' : '')
        + (isDisabled ? '<span class="grid-disabled-tag">' + tl('disabledTag') + '</span>' : '')
      + '</div>'
      + '<div class="grid-card-meta">'
        + '<span class="grid-plan-chip ' + tierClass + '">' + planChipIcon(tierClass) + tierLabel + '</span>'
      + '</div>'
      + '<div class="grid-card-quotas">' + quotasHtml + '</div>'
      + '<div class="grid-card-actions">'
        + (isCurrent
          ? '<span class="grid-current-label"><span style="color:#3fb950">●</span> ' + tl('inUse') + '</span>'
          : (switchingEmail === rawEmail
            ? '<button class="grid-switch-btn is-loading" disabled><span class="btn-spinner"></span>' + tl('switching') + '</button>'
            : '<button class="grid-switch-btn" onclick="setCurrent(\\x27' + safeEmail + '\\x27)">' + tl('switch') + '</button>'))
        + healthPillHtml(a, safeEmail)
        + '<div class="grid-actions-right">'
          + '<button class="icon-btn" onclick="openTagEditModal(\\x27' + safeEmail + '\\x27)" title="' + tl('editTagsT') + '"><svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/></svg></button>'
          + '<button class="icon-btn is-refresh" data-refresh-email="' + safeEmail + '" onclick="refreshUsage(this, \\x27' + safeEmail + '\\x27)" title="' + tl('refreshQuotaT') + '"><svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 12a9 9 0 0 1 9-9 9.75 9.75 0 0 1 6.74 2.74L21 8"/><path d="M21 3v5h-5"/><path d="M21 12a9 9 0 0 1-9 9 9.75 9.75 0 0 1-6.74-2.74L3 16"/><path d="M8 16H3v5"/></svg></button>'
          + '<button class="icon-btn danger" onclick="removeAccount(\\x27' + safeEmail + '\\x27)" title="' + tl('removeT') + '"><svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg></button>'
          + '<button class="status-switch ' + (isDisabled ? 'is-off' : 'is-on') + '" onclick="toggleDisabled(\\x27' + safeEmail + '\\x27)" title="' + (isDisabled ? tl('disabledOnT') : tl('enabledOnT')) + '" aria-label="' + (isDisabled ? tl('ariaEnable') : tl('ariaDisable')) + '"><span class="status-switch-thumb"></span></button>'
        + '</div>'
      + '</div>'
    + '</div>';
    return { email: safeEmail, sig: sig, html: html };
  });
  applyCards(cards);

  renderPagination(totalFiltered, totalPages);
}

/** 卡片内容签名：只有签变化的卡片才重绘，刷新时不会整屏闪 */
function cardSig(a) {
  const u = a.usage || {};
  const models = (u.models || []).map(m => (m.modelId || '') + ':' + m.remainingPercent + ':' + (m.resetTime || '')).join(',');
  return [
    a.email,
    a.disabled ? '1' : '0',
    a.email === currentEmail ? '1' : '0',
    privacyMode ? '1' : '0',
    switchingEmail === a.email ? '1' : '0',
    selectedEmails.has(a.email) ? '1' : '0',
    selectMode ? '1' : '0',
    u.tierId || '',
    u.loadError || '',
    a._usageError || '',
    a.health ? a.health.status + ':' + (a.health.checkedAt || '') : '',
    healthCheckingEmail === a.email ? '1' : '0',
    models,
    getAccTags(a).join('|'),
    JSON.stringify(tagColors || {}),
    a.name || '',
    (a.importMeta && a.importMeta.importedAt) || '',
  ].join('#');
}

/** 增量应用卡片：顺序不变时逐卡替换（只动变了的），否则全量重建并跳过入场动画 */
function applyCards(cards) {
  const grid = document.getElementById('accountGrid');
  if (!grid) return;
  const sameOrder = grid.children.length === cards.length
    && cards.every((c, i) => grid.children[i].getAttribute('data-email') === c.email);

  grid.classList.add('no-card-anim');
  if (sameOrder) {
    for (let i = 0; i < cards.length; i++) {
      const el = grid.children[i];
      if (el.getAttribute('data-sig') === cards[i].sig) continue;
      el.outerHTML = cards[i].html;
    }
  } else {
    grid.innerHTML = cards.map(c => c.html).join('');
  }
  requestAnimationFrame(() => requestAnimationFrame(() => grid.classList.remove('no-card-anim')));
}

function renderPagination(total, totalPages) {
  const pg = document.getElementById('pagination');
  if (!pg || pageSize === 0 || totalPages <= 1) {
    if (pg) pg.innerHTML = '';
    return;
  }
  
  let html = '<button class="page-btn" ' + (currentPage <= 1 ? 'disabled' : '') + ' onclick="goPage(' + (currentPage - 1) + ')">‹</button>';
  
  // 显示页码
  const maxShow = 5;
  let start = Math.max(1, currentPage - 2);
  let end = Math.min(totalPages, start + maxShow - 1);
  if (end - start < maxShow - 1) start = Math.max(1, end - maxShow + 1);
  
  if (start > 1) html += '<span class="page-ellipsis">1 ...</span>';
  for (let i = start; i <= end; i++) {
    html += '<button class="page-btn ' + (i === currentPage ? 'is-active' : '') + '" onclick="goPage(' + i + ')">' + i + '</button>';
  }
  if (end < totalPages) html += '<span class="page-ellipsis">... ' + totalPages + '</span>';
  
  html += '<button class="page-btn" ' + (currentPage >= totalPages ? 'disabled' : '') + ' onclick="goPage(' + (currentPage + 1) + ')">›</button>';
  
  pg.innerHTML = html;
}

function goPage(page) {
  currentPage = page;
  renderAccounts();
}

let switchingEmail = null; // 正在切换的账号（按钮加载态）
function setCurrent(email) {
  switchingEmail = email;
  renderAccounts();
  vscode.postMessage({ type: 'setCurrentAccount', email });
}
function removeAccount(email) {
  showConfirm(tl('confirmRemove', email), {
    title: tl('deleteTitle'),
    okText: tl('batchDelete'),
    onConfirm: () => vscode.postMessage({ type: 'removeAccount', email })
  });
}
function toggleDisabled(email) { vscode.postMessage({ type: 'toggleDisabled', email }); }

// ── 健康药丸（异常才亮牌：封禁/登录失效/未知；正常与未检测不占底栏，默认零打扰）──
let healthCheckingEmail = null; // 正在单号检测的账号（按钮加载态）
const HEALTH_LABEL_KEYS = { banned: 'healthBanned', auth_invalid: 'healthAuthInvalid', unknown: 'healthUnknown' };

/** 属性值转义：escHtml 不转义引号，detail 里带引号的错误 JSON 会击穿 title 属性 */
function attrEsc(text) {
  return escHtml(String(text)).replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

/** 健康药丸：正常/未检测返回空串；封禁/失效/未知带检测结果悬停明细，点击复检 */
function healthPillHtml(a, safeEmail) {
  const recheckAttr = 'onclick="recheckHealth(\\x27' + safeEmail + '\\x27)"';
  if (healthCheckingEmail === a.email) {
    return '<button class="health-pill is-checking" disabled title="' + attrEsc(tl('healthChecking')) + '"><span class="health-dot"></span>' + escHtml(tl('healthChecking')) + '</button>';
  }
  const h = a.health;
  // 正常与未检测不显示：没消息就是好消息，复检靠每小时自动探针
  if (!h || h.status === 'ok') return '';
  const label = tl(HEALTH_LABEL_KEYS[h.status] || 'healthUnknown');
  const tipParts = [tl('healthRecheckT'), h.checkedAt ? new Date(h.checkedAt).toLocaleString() : ''];
  if (h.detail) tipParts.push(h.detail);
  return '<button class="health-pill is-' + h.status + '" ' + recheckAttr + ' title="' + attrEsc(tipParts.filter(Boolean).join(' · ')) + '">'
    + '<span class="health-dot"></span>' + escHtml(label) + '</button>';
}

function recheckHealth(email) {
  if (healthCheckingEmail) return;
  healthCheckingEmail = email;
  renderAccounts();
  vscode.postMessage({ type: 'checkHealth', email });
}

// ── 就绪信号：至此 message 监听器已全部注册。宿主收到 webviewReady 后才推数据，
// 防止推送早于监听器就绪（CSS 等资源加载慢于消息投递时，首屏账号会静默丢失） ──
try { vscode.postMessage({ type: 'webviewReady' }); } catch (e) {}
</script>
</body>
</html>`;
  }
}
