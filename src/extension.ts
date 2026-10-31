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
import { ensureCdpGate } from './cdpGate';
import { t, localeBundle, getLang } from './i18n';
import { readIdeCredential, buildIdeCredentialBlob, writeIdeCredentialBlob, syncGeminiAccountFiles } from './winCredential';
import { syncGeminiLocalCreds } from './geminiFiles';
import { getSharedStorageDir } from './storage';
import { StatusBarManager } from './statusBar';
import { fetchUsage } from './usageService';
import * as ideRuntime from './ideRuntime';
import { UsageTracker } from './usageTracker';
import { showUpdateNotesOnStartup, autoCheckOnStartup, checkForUpdates } from './updater';
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

  // 安全声明弹窗自动关闭器：CDP 可用时给 hub 页面注入自动接受（切换账号必弹的那一个）
  startDeclarationSuppressor();

  // 上次切号重启的结果反馈（助手在 IDE 之外执行，结果落盘到共享目录）
  const lastRestart = readSwitchRestartResult();
  if (lastRestart) {
    clearSwitchRestartResult();
    if (!lastRestart.ok) {
      void vscode.window.showErrorMessage(
        t('restartIncomplete', lastRestart.error || t('ui.unknown'))
      );
    } else if (lastRestart.warning) {
      void vscode.window.showWarningMessage(t('restartWarning', lastRestart.warning));
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

  // 初始化侧栏
  sidebarProvider = new SidebarProvider(context.extensionUri, context);
  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider(SidebarProvider.viewType, sidebarProvider)
  );

  // 初始化状态栏（快速切号复用侧栏完整链路；recordSwitch 已在链路内，不在此重复计数）
  statusBarManager = new StatusBarManager(
    context,
    (email) => {
      sidebarProvider?.refresh();
    },
    (email) => sidebarProvider.requestSwitch(email)
  );
  context.subscriptions.push(statusBarManager);

  // 弹出版本更新提示的模态框
  showUpdateNotesOnStartup(context);

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

  // 延迟 2 秒执行首次后台静默全局额度刷新
  setTimeout(() => backgroundRefreshAllUsage(context), 2000);

  // 后台定时刷新（间隔可配置，默认 15 分钟，重启生效）
  const refreshMinutes = Math.max(5, vscode.workspace.getConfiguration('antigravityKite').get<number>('quotaRefreshMinutes', 15));
  const refreshInterval = setInterval(() => backgroundRefreshAllUsage(context), refreshMinutes * 60 * 1000);
  context.subscriptions.push({ dispose: () => clearInterval(refreshInterval) });
}

export function deactivate() {
  accountStore.dispose();
  usageTracker?.dispose();
  statusBarManager?.dispose();
}

/**
 * 后台静默刷新所有账号的额度快照并分发
 */
async function backgroundRefreshAllUsage(context: vscode.ExtensionContext) {
  console.log('[Kite-Background] 正在执行后台定时静默全局额度刷新...');
  const accounts = accountStore.getAll().filter(a => !a.disabled);
  for (const account of accounts) {
    try {
      const snapshot = await fetchUsage(account);
      usageCache.set(account.email, snapshot);

      // 实时同步给状态栏
      statusBarManager?.updateUsage(account.email, snapshot);
      // 实时推送给当前活动的侧栏
      sidebarProvider?.postMessage({ type: 'usage', email: account.email, snapshot });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      console.warn(`[Kite-Background] 刷新账号 ${account.email} 额度失败:`, msg);
      // 失败同步给卡片，杜绝无反馈占位
      sidebarProvider?.postMessage({ type: 'usage', email: account.email, error: msg });
    }
  }
  usageCacheLastRefresh = Date.now();
  saveUsageCache(context);
  console.log('[Kite-Background] 后台定时静默全局额度刷新完成。');
}

/** 切号防连点：调度成功后 IDE 会关闭，无需重置；调度失败时重置 */
let switchInFlight = false;

class SidebarProvider implements vscode.WebviewViewProvider {
  public static readonly viewType = 'antigravityKite.sidebar';
  private _view?: vscode.WebviewView;
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

  public resolveWebviewView(
    webviewView: vscode.WebviewView,
    _context: vscode.WebviewViewResolveContext,
    _token: vscode.CancellationToken,
  ) {
    this._view = webviewView;
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
    const payload = { type: 'accounts', accounts: accountsWithUsage, currentEmail };
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
        locale: cfg.get<string>('locale', 'auto'),
        statusBarEnabled: cfg.get<boolean>('statusBar.enabled', true),
        statusBarPosition: cfg.get<string>('statusBar.position', 'right'),
        statusBarStyle: cfg.get<string>('statusBar.style', 'full'),
        statusBarAccount: cfg.get<boolean>('statusBar.showAccount', true),
        statusBarModels: cfg.get<boolean>('statusBar.showModels', true),
        statusBarCredits: cfg.get<boolean>('statusBar.showCredits', true),
        statusBarPool: cfg.get<boolean>('statusBar.showPool', true),
        statusBarRefresh: cfg.get<number>('statusBar.refreshSeconds', 30),
      },
    });
  }

  /** 保存设置到全局配置（用户级 settings.json） */
  private async _saveSettings(s: Record<string, unknown>) {
    const cfg = vscode.workspace.getConfiguration('antigravityKite');
    const target = vscode.ConfigurationTarget.Global;
    const port = Number(s.cdpPort);
    const prevLocale = cfg.get<string>('locale', 'auto');
    const nextLocale = String(s.locale ?? 'auto');
    await cfg.update('update.autoCheck', s.updateAutoCheck !== false, target);
    await cfg.update('update.autoInstall', s.updateAutoInstall !== false, target);
    await cfg.update('autoConfirmDeclaration', s.autoConfirmDeclaration !== false, target);
    await cfg.update('cdpPort', Number.isFinite(port) && port > 0 ? port : 9333, target);
    await cfg.update('locale', nextLocale, target);
    await cfg.update('statusBar.enabled', s.statusBarEnabled !== false, target);
    const sbPosition = String(s.statusBarPosition ?? 'right');
    const sbStyle = String(s.statusBarStyle ?? 'full');
    const sbRefresh = Number(s.statusBarRefresh);
    await cfg.update('statusBar.position', sbPosition === 'left' ? 'left' : 'right', target);
    await cfg.update('statusBar.style', ['dot', 'percent', 'compact', 'dual', 'labeled', 'full'].includes(sbStyle) ? sbStyle : 'full', target);
    await cfg.update('statusBar.refreshSeconds', Number.isFinite(sbRefresh) ? Math.min(600, Math.max(10, Math.round(sbRefresh))) : 30, target);
    await cfg.update('statusBar.showAccount', s.statusBarAccount !== false, target);
    await cfg.update('statusBar.showModels', s.statusBarModels !== false, target);
    await cfg.update('statusBar.showCredits', s.statusBarCredits !== false, target);
    await cfg.update('statusBar.showPool', s.statusBarPool !== false, target);
    logInfo('settings.saved', { ...s });
    // 语言切换：重建 webview 使界面文案立即生效，并补推全部状态
    if (nextLocale !== prevLocale && this._view) {
      statusBarManager?.update();
      this._view.webview.html = this._getHtmlForWebview(this._view.webview);
      this._pushAccounts();
      this._pushSettings();
      this._syncWebviewState();
      return;
    }
    this._view?.webview.postMessage({ type: 'toast', status: 'success', message: t('settingsSaved') });
    this._pushSettings();
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

  /** 刷新单个账号配额 */
  private async _refreshUsage(email: string) {
    const account = accountStore.getAll().find(a => a.email === email);
    if (!account) return;
    try {
      const snapshot = await fetchUsage(account);
      usageCache.set(email, snapshot);
      saveUsageCache(this._context);
      usageTracker.recordRefresh();
      usageTracker.recordUsage(email, snapshot.minRemainingPercent, snapshot.tierId);
      this._view?.webview.postMessage({ type: 'usage', email, snapshot });
      logPanel.pushLogPanelData(this._context, usageTracker);
    } catch (err) {
      this._view?.webview.postMessage({ type: 'usage', email, error: String(err) });
    }
  }

  /** 批量刷新所有账号配额 */
  private async _refreshAllUsage() {
    const accounts = accountStore.getAll().filter(a => !a.disabled);
    let successCount = 0;
    let errorCount = 0;
    let lastError = '';
    for (const account of accounts) {
      try {
        const snapshot = await fetchUsage(account);
        usageCache.set(account.email, snapshot);
        usageTracker.recordRefresh();
        usageTracker.recordUsage(account.email, snapshot.minRemainingPercent, snapshot.tierId);
        this._view?.webview.postMessage({ type: 'usage', email: account.email, snapshot });
        successCount++;
      } catch (err) {
        errorCount++;
        lastError = err instanceof Error ? err.message : String(err);
        this._view?.webview.postMessage({ type: 'usage', email: account.email, error: lastError });
      }
    }
    usageCacheLastRefresh = Date.now();
    saveUsageCache(this._context);
    this._pushAccounts();
    logPanel.pushLogPanelData(this._context, usageTracker);
    if (errorCount === 0) {
      this._view?.webview.postMessage({ type: 'toast', status: 'success', message: t('refreshedQuota', successCount) });
    } else if (successCount === 0) {
      this._view?.webview.postMessage({ type: 'toast', status: 'error', message: t('refreshAllFailed', errorCount, lastError) });
    } else {
      this._view?.webview.postMessage({ type: 'toast', status: 'warning', message: t('refreshPartial', successCount, errorCount) });
    }
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
          vscode.window.showInformationMessage(t('accountAdded', account.email));
          this._refreshUsage(account.email);
        } catch (err) {
          vscode.window.showErrorMessage(t('loginFailed', err instanceof Error ? err.message : String(err)));
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
          vscode.window.showErrorMessage(t('detectFailed', err instanceof Error ? err.message : String(err)));
        }
        break;

      case 'confirmImport':
        try {
          const account = confirmImport();
          if (account) {
            accountStore.add(account);
            this._context.globalState.update('currentEmail', account.email);
            this._pushAccounts();
            vscode.window.showInformationMessage(t('accountImported', account.email));
            this._refreshUsage(account.email);
          }
        } catch (err) {
          vscode.window.showErrorMessage(t('importFailed', err instanceof Error ? err.message : String(err)));
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

            // 备份当前凭据（可回滚），并取出 writer_id / auth_method / userName 保持一致
            const credBackup = await readIdeCredential();
            let writerId = '';
            let authMethod = 'consumer';
            let credUser = 'antigravity';
            if (credBackup.ok && credBackup.blobBase64 && credBackup.parsed) {
              const backupPath = path.join(getSharedStorageDir(), 'credential-backup.json');
              fs.writeFileSync(backupPath, JSON.stringify({
                savedAt: Date.now(),
                user: credBackup.user,
                blob: credBackup.parsed,
              }, null, 2), 'utf8');
              writerId = credBackup.parsed.writer_id || '';
              authMethod = credBackup.parsed.auth_method || 'consumer';
              credUser = credBackup.user || 'antigravity';
              logInfo('switch.cred.backup', { path: backupPath, prevEmail: credBackup.parsed.id_token_email });
            } else {
              logWarn('switch.cred.backup.unavailable', { error: credBackup.error });
            }

            // 构造目标凭据（AT 过期无妨：IDE 启动后用 RT 自刷新）
            const expiryMs = switchToken.expiryDateSeconds > Math.floor(Date.now() / 1000)
              ? switchToken.expiryDateSeconds * 1000
              : Date.now() + 3600000;
            const blob = buildIdeCredentialBlob({
              email: account.email,
              accessToken: switchToken.accessToken,
              refreshToken: switchToken.refreshToken,
              expiryMs,
              authMethod,
              writerId,
            });
            logInfo('switch.cred.build', { email: account.email, expiryMs, writerId: blob.parsed.writer_id.slice(0, 10) });

            // ── 热切（不重启 IDE）——机制经真机实验证实 ──
            // 1) 运行中写凭据管理器（IDE 不覆盖；下次 agy 拉起即用新身份）
            const cw = await writeIdeCredentialBlob(blob.blobBase64, credUser);
            logInfo('switch.hot.cred', { ok: cw.ok, error: cw.error });
            if (!cw.ok) {
              switchInFlight = false;
              this._view?.webview.postMessage({ type: 'toast', status: 'error', message: t('switchCredFail', cw.error || '') });
              this._view?.webview.postMessage({ type: 'switchResult', ok: false });
              break;
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

            // 4) 会话层 token 热切 + 总线身份推送（尽力而为，失败不阻塞）
            const hot = await seamlessSwitch(account);
            logInfo('switch.hot.session', { success: hot.success, message: hot.message });
            const identity = await pushLiveIdentityUpdate(account.email);
            logInfo('switch.hot.identity', { ok: identity.ok, error: identity.error });

            // 5) 热重载 agent 引擎（agy 重建时读凭据管理器，即时切到新号）
            const agyReload = await ideRuntime.killAgyEngine();
            logInfo('switch.hot.agyReload', { killed: agyReload.killed, agyWasRunning: agyReload.agyWasRunning, error: agyReload.error });

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

      case 'saveSettings':
        await this._saveSettings(msg.settings || {});
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
        this._pushAccounts();
        this._pushSettings();
        this._syncWebviewState();
        break;

      case 'webviewError':
        vscode.window.showErrorMessage(`Webview Error: ${msg.message} (Line ${msg.line}, Col ${msg.col})\n${msg.stack || ''}`);
        break;
    }
  }

  private _getHtmlForWebview(webview: vscode.Webview) {
    const cssUri = webview.asWebviewUri(vscode.Uri.joinPath(this._extensionUri, 'resources', 'webview', 'main.css'));
    return `<!DOCTYPE html>
<html lang="${getLang() === 'zh' ? 'zh-CN' : 'en'}">
<head>
<meta charset="UTF-8">
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
        <span class="grid-count" id="gridCount">0 个</span>
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
        <span class="batch-count" id="batchCount">已选 0</span>
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

<!-- 设置弹窗（工具栏齿轮入口） -->
<div id="settingsOverlay" class="modal-overlay" hidden>
  <div class="modal-box">
    <div class="modal-header">
      <h3 data-i18n="settings">设置</h3>
      <button class="modal-close" id="settingsClose" data-i18n-title="close" title="关闭">×</button>
    </div>
    <div class="modal-body">

      <div class="settings-group">
        <div class="settings-group-head">
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12a9 9 0 1 1-2.64-6.36"/><polyline points="21 3 21 9 15 9"/></svg>
          <span data-i18n="autoUpdate">自动更新</span>
        </div>
        <div class="settings-row">
          <span class="settings-row-label" data-i18n="autoCheckRow">启动时检查更新</span>
          <label class="as-switch"><input type="checkbox" id="setUpdateAutoCheck"><span class="as-switch-track"><span class="as-switch-thumb"></span></span></label>
        </div>
        <div class="settings-row">
          <span class="settings-row-label" data-i18n="autoInstallRow">发现新版本时静默安装</span>
          <label class="as-switch"><input type="checkbox" id="setUpdateAutoInstall"><span class="as-switch-track"><span class="as-switch-thumb"></span></span></label>
        </div>
      </div>

      <div class="settings-group">
        <div class="settings-group-head">
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/></svg>
          <span data-i18n="switchDebug">切号与调试</span>
        </div>
        <div class="settings-row">
          <span class="settings-row-label" data-i18n="autoConfirmRow">切换账号时自动确认安全声明</span>
          <label class="as-switch"><input type="checkbox" id="setAutoConfirm"><span class="as-switch-track"><span class="as-switch-thumb"></span></span></label>
        </div>
        <div class="settings-row">
          <span class="settings-row-label" data-i18n="cdpPortRow">调试端口</span>
          <input type="number" class="settings-input" id="setCdpPort" min="1024" max="65535" placeholder="9333">
        </div>
        <div class="settings-hint" data-i18n="cdpPortHint">切号时通过该端口与 IDE 通信，9222 会作为兜底自动尝试。</div>
      </div>

      <div class="settings-group">
        <div class="settings-group-head">
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><line x1="2" y1="12" x2="22" y2="12"/><path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z"/></svg>
          <span data-i18n="appearance">界面</span>
        </div>
        <div class="settings-row">
          <span class="settings-row-label" data-i18n="localeRow">提示语言</span>
          <select class="settings-select" id="setLocale">
            <option value="auto" data-i18n="localeAuto">跟随 IDE</option>
            <option value="zh-CN" data-i18n="localeZh">中文</option>
            <option value="en" data-i18n="localeEn">English</option>
          </select>
        </div>
      </div>

      <div class="settings-group">
        <div class="settings-group-head">
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="18" height="18" rx="2"/><line x1="3" y1="15" x2="21" y2="15"/></svg>
          <span data-i18n="statusBar">状态栏</span>
        </div>
        <div class="settings-row">
          <span class="settings-row-label" data-i18n="sbEnabledRow">显示状态栏</span>
          <label class="as-switch"><input type="checkbox" id="setStatusEnabled"><span class="as-switch-track"><span class="as-switch-thumb"></span></span></label>
        </div>
        <div class="settings-row">
          <span class="settings-row-label" data-i18n="sbPositionRow">位置</span>
          <select class="settings-select" id="setStatusPosition">
            <option value="left" data-i18n="sbPositionLeft">左侧</option>
            <option value="right" data-i18n="sbPositionRight">右侧</option>
          </select>
        </div>
        <div class="settings-row">
          <span class="settings-row-label" data-i18n="sbStyleRow">样式</span>
          <select class="settings-select" id="setStatusStyle">
            <option value="dot" data-i18n="sbStyleDot">状态灯 — 仅图标</option>
            <option value="percent" data-i18n="sbStylePercent">75% — 仅最低百分比</option>
            <option value="compact" data-i18n="sbStyleCompact">状态灯 75% — 图标 + 最低百分比</option>
            <option value="dual" data-i18n="sbStyleDual">状态灯 75% + AI 积分 — 双指标</option>
            <option value="labeled" data-i18n="sbStyleLabeled">账号 + 各模型额度 — 标签式</option>
            <option value="full" data-i18n="sbStyleFull">账号 + 各模型额度 + AI 积分 — 完整</option>
          </select>
        </div>
        <div class="settings-row">
          <span class="settings-row-label" data-i18n="sbAccountRow">显示当前账号</span>
          <label class="as-switch"><input type="checkbox" id="setStatusAccount"><span class="as-switch-track"><span class="as-switch-thumb"></span></span></label>
        </div>
        <div class="settings-row">
          <span class="settings-row-label" data-i18n="sbModelsRow">显示模型额度</span>
          <label class="as-switch"><input type="checkbox" id="setStatusModels"><span class="as-switch-track"><span class="as-switch-thumb"></span></span></label>
        </div>
        <div class="settings-row">
          <span class="settings-row-label" data-i18n="sbCreditsRow">显示 AI 积分</span>
          <label class="as-switch"><input type="checkbox" id="setStatusCredits"><span class="as-switch-track"><span class="as-switch-thumb"></span></span></label>
        </div>
        <div class="settings-row">
          <span class="settings-row-label" data-i18n="sbPoolRow">显示号池统计</span>
          <label class="as-switch"><input type="checkbox" id="setStatusPool"><span class="as-switch-track"><span class="as-switch-thumb"></span></span></label>
        </div>
        <div class="settings-row">
          <span class="settings-row-label" data-i18n="sbRefreshRow">额度刷新间隔</span>
          <input type="number" class="settings-input" id="setStatusRefresh" min="10" max="600" placeholder="30">
        </div>
        <div class="settings-hint" data-i18n="sbRefreshHint">极简样式只显示最低额度，标签式逐项列出各模型；改动即时生效。</div>
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
  document.querySelectorAll('[data-i18n]').forEach(el => { el.textContent = tl(el.getAttribute('data-i18n')); });
  document.querySelectorAll('[data-i18n-ph]').forEach(el => { el.placeholder = tl(el.getAttribute('data-i18n-ph')); });
  document.querySelectorAll('[data-i18n-title]').forEach(el => { el.title = tl(el.getAttribute('data-i18n-title')); });
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
  if (diffMs <= 0) return '已重置';
  const hours = Math.floor(diffMs / 3600000);
  const mins = Math.floor((diffMs % 3600000) / 60000);
  const days = Math.floor(hours / 24);
  if (days > 0) return days + '天' + (hours % 24) + '时后重置';
  if (hours > 0) return hours + '时' + mins + '分后重置';
  if (mins > 0) return mins + '分钟后重置';
  return '即将重置';
}

function pctClass(pct) {
  if (pct <= 10) return 'is-danger';
  if (pct <= 30) return 'is-warn';
  if (pct < 50) return 'is-info';
  return 'is-ok';
}

function planTierClass(tierId) {
  if (!tierId) return 'tier-unknown';
  const t = tierId.toLowerCase();
  if (t.includes('ultra')) return 'tier-ultra';
  if (t.includes('pro')) return 'tier-pro';
  if (t.includes('free')) return 'tier-free';
  if (t.includes('trial')) return 'tier-trial';
  return 'tier-unknown';
}

function refreshUsage(email) {
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

// 刷新按钮
document.getElementById('refreshAllBtn').onclick = () => {
  const btn = document.getElementById('refreshAllBtn');
  btn.classList.add('is-spinning');
  setTimeout(() => btn.classList.remove('is-spinning'), 1000);
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
  renderAccounts();
};

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
  planList.innerHTML = planKeys.map(p => filterCheckRow('plan', p, plans[p], filterPlans.has(p))).join('');
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
      return filterTags.has('未分类');
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
  if (msg.type === 'accounts') {
    accounts = msg.accounts || [];
    currentEmail = msg.currentEmail || '';
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
  if (msg.type === 'switchResult') {
    switchingEmail = null;
    renderAccounts();
  }
});

// Toast 通知（BuddyRelay 同款：图标 + 消息，底部容器统一管理）
const TOAST_ICONS = {
  success: '<svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 8l3 3 7-7"/></svg>',
  error: '<svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="2"><circle cx="8" cy="8" r="6.5"/><line x1="8" y1="5" x2="8" y2="9" stroke-linecap="round"/><circle cx="8" cy="11.5" r="0.6" fill="currentColor" stroke="none"/></svg>',
  warning: '<svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="2"><circle cx="8" cy="8" r="6.5"/><line x1="8" y1="5" x2="8" y2="9" stroke-linecap="round"/><circle cx="8" cy="11.5" r="0.6" fill="currentColor" stroke="none"/></svg>',
  info: '<svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="2"><circle cx="8" cy="8" r="6.5"/><line x1="8" y1="11.5" x2="8" y2="7.5" stroke-linecap="round"/><circle cx="8" cy="4.8" r="0.6" fill="currentColor" stroke="none"/></svg>'
};
function showToast(message, type = 'info', duration = 3000) {
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
  toast.innerHTML = icon + '<span class="toast-msg">' + message + '</span>';
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
  const chk = (id, val) => { const el = document.getElementById(id); if (el) el.checked = !!val; };
  chk('setUpdateAutoCheck', s.updateAutoCheck !== false);
  chk('setUpdateAutoInstall', s.updateAutoInstall !== false);
  chk('setAutoConfirm', s.autoConfirmDeclaration !== false);
  set('setCdpPort', s.cdpPort || 9333);
  set('setLocale', s.locale || 'auto');
  chk('setStatusEnabled', s.statusBarEnabled !== false);
  chk('setStatusAccount', s.statusBarAccount !== false);
  chk('setStatusModels', s.statusBarModels !== false);
  chk('setStatusCredits', s.statusBarCredits !== false);
  chk('setStatusPool', s.statusBarPool !== false);
}

function openSettingsModal() {
  const ov = document.getElementById('settingsOverlay');
  if (!ov) return;
  ov.hidden = false;
  vscode.postMessage({ type: 'getSettings' });
}

function closeSettingsModal() {
  const ov = document.getElementById('settingsOverlay');
  if (ov) ov.hidden = true;
}

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

  const resetBtn = document.getElementById('settingsReset');
  if (resetBtn) resetBtn.onclick = () => fillSettingsForm({
    updateAutoCheck: true,
    updateAutoInstall: true,
    autoConfirmDeclaration: true,
    cdpPort: 9333,
    locale: 'auto',
    statusBarEnabled: true,
    statusBarPosition: 'right',
    statusBarStyle: 'full',
    statusBarRefresh: 30,
    statusBarAccount: true,
    statusBarModels: true,
    statusBarCredits: true,
    statusBarPool: true
  });

  const saveBtn = document.getElementById('settingsSave');
  if (saveBtn) saveBtn.onclick = () => {
    const val = (id) => { const el = document.getElementById(id); return el ? el.value : ''; };
    const on = (id) => { const el = document.getElementById(id); return !!(el && el.checked); };
    const num = (id, dft) => { const n = Number(val(id)); return Number.isFinite(n) && n > 0 ? n : dft; };
    vscode.postMessage({
      type: 'saveSettings',
      settings: {
        updateAutoCheck: on('setUpdateAutoCheck'),
        updateAutoInstall: on('setUpdateAutoInstall'),
        autoConfirmDeclaration: on('setAutoConfirm'),
        cdpPort: num('setCdpPort', 9333),
        locale: val('setLocale') || 'auto',
        statusBarEnabled: on('setStatusEnabled'),
        statusBarAccount: on('setStatusAccount'),
        statusBarModels: on('setStatusModels'),
        statusBarCredits: on('setStatusCredits'),
        statusBarPool: on('setStatusPool')
      }
    });
    closeSettingsModal();
  };
})();

// 导入状态处理
let loadingToast = null;
function handleImportStatus(msg) {
  if (msg.status === 'loading') {
    loadingToast = showToast(
      '<span class="toast-spinner"></span> ' + tl('importingFrom', escHtml(msg.source)),
      'loading',
      0
    );
  } else if (msg.status === 'success') {
    if (loadingToast) { loadingToast.remove(); loadingToast = null; }
    const total = msg.imported + msg.skipped;
    let text = tl('importDone', escHtml(msg.source));
    if (msg.imported > 0) text += '<br><span class="toast-detail">' + tl('importAdded', msg.imported) + '</span>';
    if (msg.skipped > 0) text += '<br><span class="toast-detail">' + tl('importSkipped', msg.skipped) + '</span>';
    if (total === 0) text = tl('importNone', escHtml(msg.source));
    showToast(text, msg.imported > 0 ? 'success' : 'warning', 4000);
  } else if (msg.status === 'error') {
    if (loadingToast) { loadingToast.remove(); loadingToast = null; }
    showToast(tl('importFailed') + '<br><span class="toast-detail">' + escHtml(msg.message) + '</span>', 'error', 5000);
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
        <div class="import-modal-email">\${maskedEmail}</div>
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
      return filterTags.has('未分类');
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

  grid.innerHTML = paged.map(a => {
    const isCurrent = a.email === currentEmail;
    const rawEmail = a.email;
    // 邮箱 local-part 可合法含引号，内联 onclick 里必须一并转义，否则可破坏内联 JS
    const safeEmail = rawEmail.replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/'/g,'&#39;').replace(/"/g,'&quot;');
    const showEmail = displayEmail(rawEmail).replace(/</g,'&lt;').replace(/>/g,'&gt;');
    // tags 由卡片内 getAccTags+getTagColor 动态渲染
    const isDisabled = a.disabled;
    
    // 从 usage 读取配额数据
    const usage = a.usage;
    const tierId = usage?.tierId || '';
    const tierClass = planTierClass(tierId);
    const tierLabel = tierId ? tierId.toUpperCase() : '...';
    
    // 模型配额（BuddyRelay 同款 2×2：Claude 5h/Weekly · Gemini 5h/Weekly）
    const models = usage?.models || [];
    const fam = { claude: [], gemini: [] };
    for (const m of models) {
      const isClaude = /claude/i.test(m.label || '');
      const bucket = isClaude ? fam.claude : fam.gemini;
      const isWeekly = /周|week/i.test(m.label || '');
      bucket.push({ label: isWeekly ? 'Weekly' : '5h', pct: m.remainingPercent, reset: m.resetTime ? formatResetTime(m.resetTime) : '' });
    }
    const q2Cell = (x) => {
      const cls = pctClass(x.pct);
      return '<div class="q2-cell">'
        + '<div class="q2-head"><span class="q2-name">' + x.label + '</span><span class="q2-val ' + cls + '">' + x.pct + '%</span></div>'
        + '<div class="quota-bar"><div class="quota-bar-fill ' + cls + '" style="width:' + x.pct + '%"></div></div>'
        + (x.reset ? '<div class="q2-reset">' + x.reset + '</div>' : '')
        + '</div>';
    };
    const q2Col = (title, list) =>
      '<div class="q2-col"><div class="q2-title">' + title + '</div>'
      + (list.length ? list.map(q2Cell).join('') : '<div class="q2-cell"><div class="q2-head"><span class="q2-name">—</span></div></div>')
      + '</div>';
    let quotasHtml;
    if (models.length > 0) {
      quotasHtml = '<div class="quota-grid2">' + q2Col('Claude', fam.claude) + q2Col('Gemini', fam.gemini) + '</div>';
    } else {
      // 无数据占位：四窗骨架；错误可见，绝不让占位符吞掉失败
      const ph = (title) => '<div class="q2-col"><div class="q2-title">' + title + '</div>'
        + ['5h', 'Weekly'].map(w => '<div class="q2-cell"><div class="q2-head"><span class="q2-name">' + w + '</span><span class="q2-val" style="opacity:.4">—</span></div><div class="quota-bar"><div class="quota-bar-fill" style="width:0%"></div></div><div class="q2-reset" style="opacity:.3">&nbsp;</div></div>').join('')
        + '</div>';
      const loadErrorHtml = a._usageError
        ? '<div class="quota-load-error">' + escHtml(String(a._usageError)) + '</div>'
        : '';
      quotasHtml = '<div class="quota-grid2">' + ph('Claude') + ph('Gemini') + '</div>' + loadErrorHtml;
    }

    return '<div class="grid-card ' + (isCurrent ? 'is-active' : '') + ' ' + (isDisabled ? 'is-disabled' : '') + (selectMode ? ' is-select-mode' : '') + '" data-email="' + safeEmail + '">'
      + (selectMode ? '<div class="grid-check-col"><input type="checkbox" class="grid-check-input" data-email="' + safeEmail + '" ' + (selectedEmails.has(rawEmail) ? 'checked' : '') + '></div>' : '')
      + '<div class="grid-card-head">'
        + '<div class="grid-card-email" title="' + safeEmail + '">' + showEmail + '</div>'
        + (isCurrent ? '<span class="grid-active-tag">' + tl('current') + '</span>' : '')
        + (isDisabled ? '<span class="grid-disabled-tag">' + tl('disabledTag') + '</span>' : '')
      + '</div>'
      + '<div class="grid-card-meta">'
        + '<span class="grid-plan-chip ' + tierClass + '">' + tierLabel + '</span>'
      + '</div>'
      + '<div class="grid-card-quotas">' + quotasHtml + '</div>'
      + '<div class="grid-card-actions">'
        + (isCurrent
          ? '<span class="grid-current-label"><span style="color:#3fb950">●</span> ' + tl('inUse') + '</span>'
          : (switchingEmail === rawEmail
            ? '<button class="grid-switch-btn is-loading" disabled><span class="btn-spinner"></span>' + tl('switching') + '</button>'
            : '<button class="grid-switch-btn" onclick="setCurrent(\\x27' + safeEmail + '\\x27)">' + tl('switch') + '</button>'))
        + '<div class="grid-actions-right">'
          + '<button class="icon-btn" onclick="openTagEditModal(\\x27' + safeEmail + '\\x27)" title="' + tl('editTagsT') + '"><svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/></svg></button>'
          + '<button class="icon-btn" onclick="refreshUsage(\\x27' + safeEmail + '\\x27)" title="' + tl('refreshQuotaT') + '"><svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 12a9 9 0 0 1 9-9 9.75 9.75 0 0 1 6.74 2.74L21 8"/><path d="M21 3v5h-5"/><path d="M21 12a9 9 0 0 1-9 9 9.75 9.75 0 0 1-6.74-2.74L3 16"/><path d="M8 16H3v5"/></svg></button>'
          + '<button class="icon-btn danger" onclick="removeAccount(\\x27' + safeEmail + '\\x27)" title="' + tl('removeT') + '"><svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg></button>'
          + '<button class="status-switch ' + (isDisabled ? 'is-off' : 'is-on') + '" onclick="toggleDisabled(\\x27' + safeEmail + '\\x27)" title="' + (isDisabled ? tl('disabledOnT') : tl('enabledOnT')) + '" aria-label="' + (isDisabled ? tl('ariaEnable') : tl('ariaDisable')) + '"><span class="status-switch-thumb"></span></button>'
        + '</div>'
      + '</div>'
    + '</div>';
  }).join('');
  
  renderPagination(totalFiltered, totalPages);
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

// ── 就绪信号：至此 message 监听器已全部注册。宿主收到 webviewReady 后才推数据，
// 防止推送早于监听器就绪（CSS 等资源加载慢于消息投递时，首屏账号会静默丢失） ──
try { vscode.postMessage({ type: 'webviewReady' }); } catch (e) {}
</script>
</body>
</html>`;
  }
}
