import * as vscode from 'vscode';
import * as accountStore from './accountStore';
import { startOAuth } from './oauthService';
import { previewLocalAccount, confirmImport, cancelImport } from './localReader';
import * as importService from './importService';
import { WebviewMessage, UsageSnapshot, StoredAccount } from './types';
import { seamlessSwitch, isSeamlessSwitchAvailable, autoSwitchInstanceBoundAccount } from './seamlessSwitcher';
import { StatusBarManager } from './statusBar';
import { fetchUsage } from './usageService';
import * as enhancer from './enhancementInjector';
import * as instanceMgr from './instanceManager';
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

  accountStore.init(context);
  instanceMgr.init(context);

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

  // 初始化状态栏
  statusBarManager = new StatusBarManager(context, (email) => {
    usageTracker.recordSwitch(email);
    sidebarProvider?.refresh();
  });
  context.subscriptions.push(statusBarManager);

  // 分身实例冷启动绑定账号自动无感切换
  void autoSwitchInstanceBoundAccount({
    context,
    onSwitched: async (email) => {
      usageTracker.recordSwitch(email);
      sidebarProvider?.refresh();
      statusBarManager?.update();
      await statusBarManager?.refreshUsage();
    },
  });

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

  // 每 15 分钟后台低优先级定时刷新
  const refreshInterval = setInterval(() => backgroundRefreshAllUsage(context), 15 * 60 * 1000);
  context.subscriptions.push({ dispose: () => clearInterval(refreshInterval) });
}

export function deactivate() {
  accountStore.dispose();
  instanceMgr.dispose();
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

    webviewView.webview.options = {
      enableScripts: true,
      localResourceRoots: [this._extensionUri]
    };

    webviewView.webview.html = this._getHtmlForWebview(webviewView.webview);

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

    // 推送增强功能状态和设置
    // 推送增强功能状态和设置
    const savedEnhSettings = this._context.globalState.get<any>('enhancementSettings');
    const settings = { ...enhancer.DEFAULT_SETTINGS, ...savedEnhSettings };
    const customPath = settings.customIdePath || '';
    webviewView.webview.postMessage({ type: 'enhancementStatus', injected: enhancer.isInjected(customPath) });
    webviewView.webview.postMessage({ type: 'enhancementSettings', settings });

    // 推送自定义主程序 exe 路径
    const config = vscode.workspace.getConfiguration('antigravityKite');
    const customExePath = config.get<string>('customIdeExePath') || '';
    webviewView.webview.postMessage({ type: 'customIdeExePathSync', path: customExePath });

    // 推送切号预检开关状态
    webviewView.webview.postMessage({ type: 'preflightSync', enabled: this._context.globalState.get<boolean>('preflightEnabled') || false });

    // 推送扩展版本号（侧栏头部胶囊展示）
    const extVersion = vscode.extensions.getExtension('soulvon.antigravity-kite')?.packageJSON?.version
      || vscode.extensions.getExtension('antigravity-kite')?.packageJSON?.version || '';
    webviewView.webview.postMessage({ type: 'versionSync', version: extVersion });
  }

  private async _promptRestart(message: string) {
    const pick = await vscode.window.showInformationMessage(message, '立即重启', '稍后');
    if (pick === '立即重启') {
      vscode.commands.executeCommand('workbench.action.reloadWindow');
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
    this._view?.webview.postMessage({ type: 'accounts', accounts: accountsWithUsage, currentEmail });
  }

  /** 导出账号（全部或指定邮箱集合）：完整含 Token / 脱敏仅邮箱标签 */
  private async _exportAccounts(onlyEmails?: string[]) {
    const all = accountStore.getAll();
    const picked = onlyEmails ? all.filter(a => onlyEmails.includes(a.email)) : all;
    if (picked.length === 0) {
      this._view?.webview.postMessage({ type: 'toast', status: 'warning', message: '没有可导出的账号' });
      return;
    }
    let masked = false;
    if (!onlyEmails) {
      const mode = await vscode.window.showQuickPick(['完整导出（含授权 Token）', '脱敏导出（仅邮箱与标签）'], {
        placeHolder: `选择导出方式（共 ${picked.length} 个账号）`
      });
      if (!mode) return;
      masked = !mode.startsWith('完整');
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
      title: '导出 Antigravity Kite 账号',
      filters: { 'JSON': ['json'] },
    });
    if (!uri) return;
    try {
      await vscode.workspace.fs.writeFile(uri, Buffer.from(JSON.stringify(payload, null, 2), 'utf8'));
      this._view?.webview.postMessage({ type: 'toast', status: 'success', message: `已导出 ${picked.length} 个账号到 ${uri.fsPath}` });
    } catch (err) {
      this._view?.webview.postMessage({ type: 'toast', status: 'error', message: '导出失败: ' + (err instanceof Error ? err.message : String(err)) });
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
      this._view?.webview.postMessage({ type: 'toast', status: 'success', message: `已刷新 ${successCount} 个账号配额` });
    } else if (successCount === 0) {
      this._view?.webview.postMessage({ type: 'toast', status: 'error', message: `全部失败(${errorCount}个): ${lastError}` });
    } else {
      this._view?.webview.postMessage({ type: 'toast', status: 'warning', message: `成功${successCount}个，失败${errorCount}个` });
    }
  }

  private async _handleMessage(msg: WebviewMessage) {
    switch (msg.type) {
      case 'oauthLogin':
        try {
          const account = await startOAuth();
          accountStore.add(account);
          this._context.globalState.update('currentEmail', account.email);
          this._pushAccounts();
          vscode.window.showInformationMessage(`已添加账号: ${account.email}`);
          this._refreshUsage(account.email);
        } catch (err) {
          vscode.window.showErrorMessage(`登录失败: ${err instanceof Error ? err.message : err}`);
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
          vscode.window.showErrorMessage(`检测失败: ${err instanceof Error ? err.message : err}`);
        }
        break;

      case 'confirmImport':
        try {
          const account = confirmImport();
          if (account) {
            accountStore.add(account);
            this._context.globalState.update('currentEmail', account.email);
            this._pushAccounts();
            vscode.window.showInformationMessage(`已导入账号: ${account.email}`);
            this._refreshUsage(account.email);
          }
        } catch (err) {
          vscode.window.showErrorMessage(`导入失败: ${err instanceof Error ? err.message : err}`);
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
        this._view?.webview.postMessage({ type: 'importStatus', status: 'loading', source: '本地文件' });
        try {
          const result3 = await importService.importFromJsonFile();
          this._pushAccounts();
          this._view?.webview.postMessage({
            type: 'importStatus',
            status: 'success',
            source: '本地文件',
            imported: result3.imported,
            skipped: result3.skipped
          });
          if (result3.imported > 0) this._refreshAllUsage();
        } catch (err) {
          if ((err as Error).message !== '未选择文件') {
            this._view?.webview.postMessage({
              type: 'importStatus',
              status: 'error',
              source: '本地文件',
              message: err instanceof Error ? err.message : String(err)
            });
          } else {
            this._view?.webview.postMessage({ type: 'importStatus', status: 'cancelled' });
          }
        }
        break;

      case 'getImportSources':
        const sources = importService.getAvailableImportSources();
        this._view?.webview.postMessage({ type: 'importSources', sources });
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
            // 切号预检：先验证目标账号 Token 可用性（401/网络失败即拦截）
            const preflightEnabled = this._context.globalState.get<boolean>('preflightEnabled') || false;
            if (preflightEnabled && isSeamlessSwitchAvailable()) {
              try {
                const snap = await fetchUsage(account);
                usageCache.set(account.email, snap);
              } catch (err) {
                this._view?.webview.postMessage({
                  type: 'toast',
                  status: 'error',
                  message: '切号预检未通过：目标账号额度检测失败（Token 可能已失效），已取消切换'
                });
                break;
              }
            }
            // 尝试无感换号
            if (isSeamlessSwitchAvailable()) {
              const result = await seamlessSwitch(account);
              if (result.success) {
                this._view?.webview.postMessage({ type: 'toast', status: 'success', message: '无感切号成功' });
                await this._context.globalState.update('currentEmail', msg.email);
                usageTracker.recordSwitch(msg.email);
                this._pushAccounts();
                statusBarManager?.refreshUsage();
                logPanel.pushLogPanelData(this._context, usageTracker);
                // 补全切号协议：触发 authentication 层重读 session（身份/凭证缓存刷新）
                try {
                  await vscode.commands.executeCommand('antigravity.handleAuthRefresh');
                } catch (e) {
                  console.warn('[Kite] handleAuthRefresh failed:', e instanceof Error ? e.message : e);
                }
                // 联动规则：切号后优先刷新目标号额度
                this._refreshUsage(msg.email);
              } else {
                this._view?.webview.postMessage({ type: 'toast', status: 'warning', message: result.message || '切号失败' });
              }
            } else {
              this._view?.webview.postMessage({ type: 'toast', status: 'warning', message: '无感切号 API 不可用，未切换当前宿主账号' });
            }
          }
        }
        break;

      case 'setPreflight':
        if (typeof msg.enabled === 'boolean') {
          await this._context.globalState.update('preflightEnabled', msg.enabled);
        }
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
        this._view?.webview.postMessage({ type: 'toast', status: 'info', message: '正在刷新配额...' });
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
          this._view?.webview.postMessage({ type: 'toast', status: 'success', message: `已为 ${msg.emails.length} 个账号更新标签` });
        }
        break;

      case 'batchDelete':
        if (Array.isArray(msg.emails)) {
          for (const email of msg.emails) {
            accountStore.remove(email);
          }
          this._pushAccounts();
          this._view?.webview.postMessage({ type: 'toast', status: 'success', message: `已删除 ${msg.emails.length} 个账号` });
        }
        break;

      case 'batchEnable':
        if (Array.isArray(msg.emails)) {
          for (const email of msg.emails) {
            accountStore.setDisabled(email, false);
          }
          this._pushAccounts();
          this._view?.webview.postMessage({ type: 'toast', status: 'success', message: `已启用 ${msg.emails.length} 个账号` });
        }
        break;

      case 'batchDisable':
        if (Array.isArray(msg.emails)) {
          for (const email of msg.emails) {
            accountStore.setDisabled(email, true);
          }
          this._pushAccounts();
          this._view?.webview.postMessage({ type: 'toast', status: 'success', message: `已禁用 ${msg.emails.length} 个账号` });
        }
        break;

      case 'syncTagColors':
        if (msg.colors && typeof msg.colors === 'object') {
          this._context.globalState.update('tagColors', msg.colors);
        }
        break;

      case 'applyEnhancement':
        if (msg.settings) {
          const customPath = msg.settings.customIdePath || '';
          // 保存设置
          this._context.globalState.update('enhancementSettings', msg.settings);
          // 执行注入
          const applyResult = await enhancer.inject(msg.settings, customPath);
          this._view?.webview.postMessage({ type: 'enhancementResult', ...applyResult });
          this._view?.webview.postMessage({ type: 'enhancementStatus', injected: enhancer.isInjected(customPath) });
          if (applyResult.success) this._promptRestart('增强已应用，需要重启 IDE 才能生效。');
        }
        break;

      case 'removeEnhancement':
        const rPath = msg.customIdePath || '';
        const removeResult = await enhancer.remove(rPath);
        this._view?.webview.postMessage({ type: 'enhancementResult', ...removeResult });
        this._view?.webview.postMessage({ type: 'enhancementStatus', injected: enhancer.isInjected(rPath) });
        if (removeResult.success) this._promptRestart('增强已移除，需要重启 IDE 才能生效。');
        break;

      case 'checkEnhancementStatus':
        this._view?.webview.postMessage({ 
          type: 'enhancementStatus', 
          injected: enhancer.isInjected(msg.customIdePath || '') 
        });
        break;

      case 'selectIdePath':
        try {
          const folderUri = await vscode.window.showOpenDialog({
            canSelectFiles: false,
            canSelectFolders: true,
            canSelectMany: false,
            openLabel: '选择 IDE 安装路径'
          });
          if (folderUri && folderUri[0]) {
            this._view?.webview.postMessage({
              type: 'selectedIdePath',
              path: folderUri[0].fsPath
            });
          }
        } catch (err) {
          vscode.window.showErrorMessage('选择路径失败: ' + err);
        }
        break;

      case 'selectExePath':
        try {
          const files = await vscode.window.showOpenDialog({
            canSelectFiles: true,
            canSelectFolders: false,
            canSelectMany: false,
            filters: { 'Executables': ['exe', 'app', 'sh'] },
            openLabel: '选择 Antigravity 主程序'
          });
          if (files && files[0]) {
            const selectedPath = files[0].fsPath;
            await vscode.workspace.getConfiguration('antigravityKite').update('customIdeExePath', selectedPath, vscode.ConfigurationTarget.Global);
            this._view?.webview.postMessage({ type: 'customIdeExePathSync', path: selectedPath });
            vscode.window.showInformationMessage(`已设置自定义主程序路径: ${selectedPath}`);
          }
        } catch (err) {
          vscode.window.showErrorMessage('选择主程序失败: ' + err);
        }
        break;

      case 'clearExePath':
        try {
          await vscode.workspace.getConfiguration('antigravityKite').update('customIdeExePath', '', vscode.ConfigurationTarget.Global);
          this._view?.webview.postMessage({ type: 'customIdeExePathSync', path: '' });
          vscode.window.showInformationMessage('已恢复自动探测主程序路径');
        } catch (err) {
          vscode.window.showErrorMessage('清除自定义主程序路径失败: ' + err);
        }
        break;

      case 'restartIde':
        vscode.commands.executeCommand('workbench.action.reloadWindow');
        break;

      case 'webviewError':
        vscode.window.showErrorMessage(`Webview Error: ${msg.message} (Line ${msg.line}, Col ${msg.col})\n${msg.stack || ''}`);
        break;

      // ─── 多实例操作 ─────────────────────────────────
      case 'listInstances':
        try {
          const instances = await instanceMgr.listInstances();
          this._view?.webview.postMessage({ type: 'instanceList', instances });
        } catch (e) {
          this._view?.webview.postMessage({ type: 'instanceError', message: (e as Error).message });
        }
        break;

      case 'createInstance':
        try {
          await instanceMgr.createInstance({
            name: msg.name || '新实例',
            bindEmail: msg.bindEmail || '',
            onProgress: (progress: string) => {
              this._view?.webview.postMessage({ type: 'instanceProgress', message: progress });
            },
          });
          const listAfterCreate = await instanceMgr.listInstances();
          this._view?.webview.postMessage({ type: 'instanceList', instances: listAfterCreate });
          this._view?.webview.postMessage({ type: 'instanceResult', success: true, message: '实例创建成功' });
        } catch (e) {
          this._view?.webview.postMessage({ type: 'instanceResult', success: false, message: (e as Error).message });
        }
        break;

      case 'deleteInstance':
        try {
          instanceMgr.deleteInstance(msg.instanceId);
          const listAfterDelete = await instanceMgr.listInstances();
          this._view?.webview.postMessage({ type: 'instanceList', instances: listAfterDelete });
          this._view?.webview.postMessage({ type: 'instanceResult', success: true, message: '实例已删除' });
        } catch (e) {
          this._view?.webview.postMessage({ type: 'instanceResult', success: false, message: (e as Error).message });
        }
        break;

      case 'startInstance':
        try {
          await instanceMgr.startInstance(msg.instanceId, (log: string) => {
            this._view?.webview.postMessage({ type: 'instanceProgress', message: log });
          });
          const listAfterStart = await instanceMgr.listInstances();
          this._view?.webview.postMessage({ type: 'instanceList', instances: listAfterStart });
          this._view?.webview.postMessage({ type: 'instanceResult', success: true, message: '实例已启动' });
        } catch (e) {
          this._view?.webview.postMessage({ type: 'instanceResult', success: false, message: (e as Error).message });
        }
        break;

      case 'stopInstance':
        try {
          await instanceMgr.stopInstance(msg.instanceId);
          const listAfterStop = await instanceMgr.listInstances();
          this._view?.webview.postMessage({ type: 'instanceList', instances: listAfterStop });
          this._view?.webview.postMessage({ type: 'instanceResult', success: true, message: '实例已停止' });
        } catch (e) {
          this._view?.webview.postMessage({ type: 'instanceResult', success: false, message: (e as Error).message });
        }
        break;

      case 'focusInstance':
        try {
          await instanceMgr.focusInstance(msg.instanceId);
        } catch (e) {
          this._view?.webview.postMessage({ type: 'instanceResult', success: false, message: (e as Error).message });
        }
        break;

      case 'renameInstance':
        try {
          instanceMgr.updateInstanceName(msg.instanceId, msg.newName);
          const listAfterRename = await instanceMgr.listInstances();
          this._view?.webview.postMessage({ type: 'instanceList', instances: listAfterRename });
        } catch (e) {
          this._view?.webview.postMessage({ type: 'instanceResult', success: false, message: (e as Error).message });
        }
        break;

      case 'listCockpitInstances':
        try {
          const cockpitInstances = instanceMgr.listCockpitInstances(true);
          this._view?.webview.postMessage({ type: 'cockpitList', instances: cockpitInstances });
        } catch (e) {
          this._view?.webview.postMessage({ type: 'instanceResult', success: false, message: (e as Error).message });
        }
        break;

      case 'importCockpitInstance':
        try {
          await instanceMgr.importCockpitInstance(msg.cockpitId, msg.name, msg.bindEmail || '');
          const listAfterImport = await instanceMgr.listInstances();
          this._view?.webview.postMessage({ type: 'instanceList', instances: listAfterImport });
          const cockpitAfter = instanceMgr.listCockpitInstances(true);
          this._view?.webview.postMessage({ type: 'cockpitList', instances: cockpitAfter });
          this._view?.webview.postMessage({ type: 'instanceResult', success: true, message: 'Cockpit 实例导入成功' });
        } catch (e) {
          this._view?.webview.postMessage({ type: 'instanceResult', success: false, message: (e as Error).message });
        }
        break;

      case 'checkForUpdates':
        try {
          await checkForUpdates(false);
        } catch (err) {
          vscode.window.showErrorMessage('检查更新失败: ' + err);
        }
        break;

      case 'openLogPanel':
        logPanel.openLogPanel(this._context, usageTracker, this._extensionUri, msg.tab);
        break;

      // ─── 用量统计 ─────────────────────────────────
      case 'getUsageStats':
        this._view?.webview.postMessage({ type: 'usageStats', summary: usageTracker.getSummary() });
        break;

      case 'getQuotaHistory':
        this._view?.webview.postMessage({
          type: 'quotaHistory',
          history: usageTracker.getQuotaHistory(msg.email, msg.limit || 200),
          emails: usageTracker.getHistoryEmails(),
        });
        break;

      case 'clearQuotaHistory':
        usageTracker.clearQuotaHistory(msg.email);
        this._view?.webview.postMessage({ type: 'quotaHistory', history: [], emails: usageTracker.getHistoryEmails() });
        break;
    }
  }

  private _getHtmlForWebview(webview: vscode.Webview) {
    const cssUri = webview.asWebviewUri(vscode.Uri.joinPath(this._extensionUri, 'resources', 'webview', 'main.css'));
    return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<link rel="stylesheet" href="${cssUri}">
</head>
<body>
<div class="app">
<!-- 顶部控制台 -->
<div class="kite-tab-bar app-tabs" id="appTabs" role="tablist" aria-label="Kite sections">
  <button type="button" class="kite-tab app-tab is-active active" data-tab="accounts" role="tab" aria-selected="true" title="账号管理">
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/></svg>
    <span>账户</span>
    <span class="kite-tab-count tab-count" id="tabAccountCount">0</span>
  </button>
  <button type="button" class="kite-tab app-tab" data-tab="instances" role="tab" aria-selected="false" title="多实例分身">
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><rect x="2" y="3" width="20" height="14" rx="2"/><line x1="8" y1="21" x2="16" y2="21"/><line x1="12" y1="17" x2="12" y2="21"/></svg>
    <span>实例</span>
    <span class="kite-tab-count tab-count" id="tabInstanceCount">0</span>
  </button>
  <button type="button" class="kite-tab app-tab" data-tab="enhance" role="tab" aria-selected="false" title="增强功能">
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2"/></svg>
    <span>增强</span>
  </button>
</div>

<!-- Tab: 账号 -->
<div class="kite-tab-content tab-page is-active active" id="tabAccounts" data-tab="accounts" data-tab-page="accounts" role="tabpanel">
  <div class="list-body">
      <!-- 账号区标题与操作 -->
      <div class="accounts-section-header list-summary">
        <svg class="list-icon" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/></svg>
        <h3>我的账号</h3>
        <span class="list-arrow"></span>
        <div style="flex:1"></div>
        <span class="version-tag-pill" id="versionPill" hidden></span>
        <span class="kite-tab-badge grid-count" id="gridCount">0 个</span>
        <button class="add-account-btn" id="addAccountBtn">添加账号</button>
      </div>
      <!-- 汇总统计 -->
      <div id="summaryCard">
        <div class="summary-stats">
          <div class="summary-stat" id="summaryDailyStat">
            <div class="summary-stat-head">
              <svg class="summary-stat-icon" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.93 4.93l1.41 1.41M17.66 17.66l1.41 1.41M2 12h2M20 12h2M6.34 17.66l-1.41 1.41M19.07 4.93l-1.41 1.41"/></svg>
              <span class="summary-stat-label">本日</span>
              <span class="summary-stat-pct" id="summaryDailyPct">0%</span>
            </div>
            <div class="summary-bar"><div class="summary-bar-fill" id="summaryDailyBar" style="width:0%"></div></div>
            <div class="summary-stat-footer">
              <span class="summary-stat-num" id="summaryDailyNum">0</span>
              <span class="summary-stat-max" id="summaryDailyMax">/ 0</span>
            </div>
          </div>
          <div class="summary-stat" id="summaryWeeklyStat">
            <div class="summary-stat-head">
              <svg class="summary-stat-icon" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="4" width="18" height="18" rx="2" ry="2"/><line x1="16" y1="2" x2="16" y2="6"/><line x1="8" y1="2" x2="8" y2="6"/><line x1="3" y1="10" x2="21" y2="10"/></svg>
              <span class="summary-stat-label">本周</span>
              <span class="summary-stat-pct" id="summaryWeeklyPct">0%</span>
            </div>
            <div class="summary-bar"><div class="summary-bar-fill" id="summaryWeeklyBar" style="width:0%"></div></div>
            <div class="summary-stat-footer">
              <span class="summary-stat-num" id="summaryWeeklyNum">0</span>
              <span class="summary-stat-max" id="summaryWeeklyMax">/ 0</span>
            </div>
          </div>
        </div>
        <!-- 统计抽屉（BuddyRelay 同款：默认折叠，徽标常显） -->
        <details class="usage-stats-details" id="usageStatsDetails">
          <summary class="usage-drawer-summary">
            <span class="usage-drawer-title">
              <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="20" x2="18" y2="10"/><line x1="12" y1="20" x2="12" y2="4"/><line x1="6" y1="20" x2="6" y2="14"/></svg>
              <span>统计</span>
            </span>
            <span class="usage-summary-badges">
              <span class="usage-badge-pill is-plus" id="usagePillSwitches">+0 切</span>
              <span class="usage-badge-pill is-neutral" id="usagePillRefreshes">0 检</span>
            </span>
            <button class="as-open-panel-btn" id="openLogPanelBtn" title="打开统计面板" style="margin-left:auto;display:inline-flex;align-items:center;gap:3px;padding:2px 8px;font-size:11px;border-radius:4px;border:1px solid var(--border-subtle);background:transparent;color:var(--muted);cursor:pointer">
              <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/><polyline points="15 3 21 3 21 9"/><line x1="10" y1="14" x2="21" y2="3"/></svg>
              统计面板
            </button>
            <span class="usage-drawer-arrow"><svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="6 9 12 15 18 9"/></svg></span>
          </summary>
          <div class="usage-drawer-body">
            <div class="summary-status-grid">
              <div class="summary-status-row"><span class="summary-status-label">活跃 / 禁用</span><span class="summary-status-val" id="summaryActiveDisabled">0 / 0</span></div>
              <div class="summary-status-row"><span class="summary-status-label">满额度账号</span><span class="summary-status-val ok" id="summaryHighQuota">0 个（≥ 80%）</span></div>
              <div class="summary-status-row"><span class="summary-status-label">低额度账号</span><span class="summary-status-val warn" id="summaryLowQuota">0 个（≤ 30%）</span></div>
              <div class="summary-status-row"><span class="summary-status-label">最近刷新</span><span class="summary-status-val off" id="summaryLastRefresh">--</span></div>
            </div>
            <div class="usage-stats-grid">
              <div class="usage-stat-cell">
                <div class="usage-stat-num" id="statSwitches">0</div>
                <div class="usage-stat-label">切号次数</div>
              </div>
              <div class="usage-stat-cell">
                <div class="usage-stat-num" id="statRefreshes">0</div>
                <div class="usage-stat-label">配额检查</div>
              </div>
              <div class="usage-stat-cell">
                <div class="usage-stat-num" id="statAvgUsed">0%</div>
                <div class="usage-stat-label">平均用量</div>
              </div>
              <div class="usage-stat-cell">
                <div class="usage-stat-num" id="statAccountCount">0</div>
                <div class="usage-stat-label">统计账号</div>
              </div>
            </div>
            <div class="usage-stats-bar-section">
              <div class="usage-stats-bar-row">
                <span class="usage-stats-bar-label">总用量</span>
                <div class="usage-stats-bar"><div class="usage-stats-bar-fill daily" id="statUsedBar" style="width:0%"></div></div>
                <span class="usage-stats-bar-val" id="statUsedVal">0</span>
              </div>
              <div class="usage-stats-bar-row">
                <span class="usage-stats-bar-label">本次运行</span>
                <span class="usage-stats-bar-val" id="statUptime" style="margin-left:auto">--</span>
              </div>
            </div>
            <span class="usage-stats-date" id="usageStatsDate" style="font-size:10px;color:var(--muted);align-self:flex-end"></span>
            <div style="margin-top:10px;padding:8px 10px;background:var(--vscode-textBlockQuote-background,rgba(127,127,127,.08));border-radius:6px;font-size:11px;color:var(--vscode-descriptionForeground,#888);display:flex;align-items:center;justify-content:space-between;gap:8px">
              <span>配额变动已迁移到统计面板</span>
              <button class="as-open-panel-btn" id="openLogPanelHintBtn" style="padding:2px 10px;font-size:11px;border-radius:4px;border:1px solid var(--border-subtle);background:transparent;color:inherit;cursor:pointer">查看详情 →</button>
            </div>
          </div>
        </details>
      </div>
      <div class="panel-divider"></div>
      <!-- 搜索栏 -->
      <div class="search-bar">
        <svg class="search-icon" width="13" height="13" viewBox="0 0 24 24" fill="currentColor" stroke="none"><path d="M10.8 4a6.8 6.8 0 1 0 4.25 12.12l3.42 3.42a1.2 1.2 0 0 0 1.7-1.7l-3.42-3.42A6.8 6.8 0 0 0 10.8 4Zm0 2.4a4.4 4.4 0 1 1 0 8.8 4.4 4.4 0 0 1 0-8.8Z"/></svg>
        <input type="text" class="search-input" id="searchInput" placeholder="搜索账号..." autocomplete="off">
        <button class="search-clear" id="searchClear" hidden>×</button>
      </div>
      <!-- 过滤器（按风格化按钮） -->
      <div class="tag-bar">
        <button class="tag-chip is-active" id="filterAll">全部</button>
        <button class="tag-chip" id="filterActive">● 活跃</button>
        <button class="tag-chip" id="filterDisabled">○ 禁用</button>
      </div>
      <!-- 工具栏（windsurf-pool 风格） -->
      <div class="toolbar-bar" id="toolbarBar">
        <div class="filter-wrap" id="filterWrap">
          <button class="filter-trigger" id="filterTrigger" title="过滤">
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polygon points="22 3 2 3 10 12.46 10 19 14 21 14 12.46 22 3"/></svg>
            <span id="filterLabel">ALL</span>
            <span class="filter-count" id="filterTriggerCount"></span>
          </button>
          <div class="filter-dropdown" id="filterDropdown" hidden>
            <div class="filter-section" id="filterPlanSection">
              <div class="filter-section-title">套餐</div>
              <div class="filter-options" id="filterPlanList"></div>
            </div>
            <div class="filter-section" id="filterTagSection">
              <div class="filter-section-title">标签</div>
              <div class="filter-options" id="filterTagList"></div>
            </div>
            <div class="filter-section" id="filterStatusSection">
              <div class="filter-section-title">状态</div>
              <div class="filter-options" id="filterStatusList"></div>
            </div>
            <div class="filter-actions">
              <button class="filter-clear-btn" id="filterClearBtn">清空筛选</button>
            </div>
          </div>
        </div>
        <button class="recommend-btn" id="recommendBtn" title="推荐排序：按可用度综合排序">
          <svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor" stroke="none"><polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"/></svg>
          推荐
        </button>
        <select class="group-select" id="sortSelect" title="排序方式">
          <option value="default">默认排序</option>
          <option value="recommend">推荐</option>
          <option value="email">邮箱 A-Z</option>
          <option value="time">导入时间</option>
        </select>
        <button class="sort-direction-btn" id="sortDirectionBtn" title="切换排序方向">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <line x1="12" y1="5" x2="12" y2="19"/>
            <polyline points="19 12 12 19 5 12"/>
          </svg>
        </button>
        <button class="toolbar-icon-btn" id="refreshAllBtn" title="刷新全部">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 12a9 9 0 0 1 9-9 9.75 9.75 0 0 1 6.74 2.74L21 8"/><path d="M21 3v5h-5"/><path d="M21 12a9 9 0 0 1-9 9 9.75 9.75 0 0 1-6.74-2.74L3 16"/><path d="M8 16H3v5"/></svg>
        </button>
        <button class="toolbar-icon-btn" id="exportAccountsBtn" title="导出账号设置">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>
        </button>
        <button class="toolbar-icon-btn" id="privacyModeBtn" title="隐私模式：隐藏邮箱">
          <svg class="privacy-eye" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M1 12s4-7 11-7 11 7 11 7-4 7-11 7S1 12 1 12z"/><circle cx="12" cy="12" r="3"/></svg>
        </button>
        <div style="flex:1"></div>
        <select class="page-size-select" id="pageSizeSelect" title="每页显示">
          <option value="10">10/页</option>
          <option value="20" selected>20/页</option>
          <option value="50">50/页</option>
          <option value="0">全部</option>
        </select>
        <button class="group-select-mode-btn" id="selectModeBtn" title="多选模式">
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="9 11 12 14 22 4"/><path d="M21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11"/></svg>
          多选
        </button>
        <span class="filter-count" id="filterCount">0 个</span>
      </div>
      <!-- 批量操作栏 -->
      <div class="batch-bar" id="batchBar" hidden>
        <label class="batch-check-all"><input type="checkbox" id="batchCheckAll"><span>全选</span></label>
        <div style="flex:1"></div>
        <span class="batch-count" id="batchCount">已选 0</span>
        <button class="batch-action-btn" id="batchTagBtn" title="为选中账号设置标签">加标签</button>
        <button class="batch-action-btn" id="batchEnableBtn" title="启用选中账号">启用</button>
        <button class="batch-action-btn" id="batchDisableBtn" title="禁用选中账号">禁用</button>
        <button class="batch-action-btn" id="batchExportBtn" title="导出选中账号">导出</button>
        <button class="batch-action-btn batch-action-delete" id="batchDeleteBtn" title="删除选中账号">删除</button>
        <button class="batch-action-btn" id="batchCancelBtn">取消</button>
      </div>
      <!-- 标签栏 -->
      <div class="tag-bar" id="tagBar">
        <span class="tag-bar-label">标签:</span>
        <div class="tag-list" id="tagList"></div>
      </div>
      <!-- 添加账号模态框 -->
      <div class="add-account-modal" id="addAccountModal" style="display:none">
        <div class="add-modal-content">
          <div class="add-modal-header">
            <span class="add-modal-title">添加账号</span>
            <button class="add-modal-close" id="closeAddModal">×</button>
          </div>
          <div class="add-modal-body">
            <button class="add-modal-option" id="btnOAuth">
              <span class="add-option-icon"><svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/></svg></span>
              <div class="add-option-info">
                <span class="add-option-title">Google 登录</span>
                <span class="add-option-desc">通过浏览器授权登录</span>
              </div>
            </button>
            <button class="add-modal-option" id="btnImport">
              <span class="add-option-icon"><svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/></svg></span>
              <div class="add-option-info">
                <span class="add-option-title">从本地数据库导入</span>
                <span class="add-option-desc">读取本机 Antigravity IDE 客户端登录账号</span>
              </div>
            </button>
            <button class="add-modal-option" id="btnImportCockpit">
              <span class="add-option-icon"><svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="23 4 23 10 17 10"/><polyline points="1 20 1 14 7 14"/><path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15"/></svg></span>
              <div class="add-option-info">
                <span class="add-option-title">从 Cockpit Tools 导入</span>
                <span class="add-option-desc">同步 Cockpit Tools 中的账号</span>
              </div>
            </button>
            <button class="add-modal-option" id="btnImportManager">
              <span class="add-option-icon"><svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg></span>
              <div class="add-option-info">
                <span class="add-option-title">从 Antigravity Manager 导入</span>
                <span class="add-option-desc">同步 Antigravity Manager 中的账号</span>
              </div>
            </button>
            <button class="add-modal-option" id="btnImportJson">
              <span class="add-option-icon"><svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="12" y1="18" x2="12" y2="12"/><polyline points="9 15 12 12 15 15"/></svg></span>
              <div class="add-option-info">
                <span class="add-option-title">从本地文件导入</span>
                <span class="add-option-desc">选择 JSON 文件导入账号（支持多种格式）</span>
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
        <div class="empty-title">还没有账号</div>
        <div class="empty-sub">点击上方「添加账号」按钮</div>
      </div>
  </div>
</div>

<!-- Tab: 增强 -->
<div class="kite-tab-content tab-page" id="tabEnhance" data-tab="enhance" data-tab-page="enhance" role="tabpanel">
  <div class="list-body">
    <div class="enhance-section" style="padding-top:2px;">
      <div style="display:flex;align-items:center;justify-content:space-between;gap:6px;margin-bottom:8px;">
        <span class="enhance-status-badge" id="enhanceStatusBadge">未注入</span>
        <span class="enhance-desc" style="margin:0;padding:0;font-size:11px;">向 IDE 注入增强模块以启用高级功能</span>
      </div>

      <!-- Card: LaTeX -->
      <div class="enhance-card">
        <div class="enhance-card-header">
          <div class="enhance-card-title-group">
            <span class="enhance-card-title">LaTeX 公式渲染</span>
            <span class="enhance-card-desc">自动渲染 AI 回复中的数学公式</span>
          </div>
          <label class="enhance-toggle"><input type="checkbox" id="enhLatex" checked><span class="enhance-toggle-slider"></span></label>
        </div>
      </div>

      <!-- Card: 建议气泡 -->
      <div class="enhance-card">
        <div class="enhance-card-header">
          <div class="enhance-card-title-group">
            <span class="enhance-card-title">回复建议气泡</span>
            <span class="enhance-card-desc">解析 :::bubbles 标记为交互式选项卡</span>
          </div>
          <label class="enhance-toggle"><input type="checkbox" id="enhBubbles" checked><span class="enhance-toggle-slider"></span></label>
        </div>
        <div class="enhance-card-body" id="bubblesSubOptions">
          <div class="enhance-sub-row" style="padding: 2px 0;">
            <span>自动发送</span>
            <label class="enhance-toggle"><input type="checkbox" id="enhBubblesAutoSend" checked><span class="enhance-toggle-slider"></span></label>
          </div>
          <div class="enhance-sub-row-grid">
            <div class="enhance-sub-col">
              <span class="sub-col-label">主题</span>
              <select id="enhBubblesTheme" class="enhance-select" style="text-align-last:left;">
                <option value="emerald">翡翠渐变</option>
                <option value="ocean">海洋蓝</option>
                <option value="sunset">日落橙</option>
                <option value="purple">紫罗兰</option>
                <option value="minimal">极简</option>
              </select>
            </div>
            <div class="enhance-sub-col">
              <span class="sub-col-label">形状</span>
              <select id="enhBubblesShape" class="enhance-select" style="text-align-last:left;">
                <option value="rounded">圆角</option>
                <option value="pill">胶囊</option>
                <option value="square">方角</option>
              </select>
            </div>
          </div>
          <!-- 实时预览 -->
          <div class="bubble-preview" style="margin-top:2px;">
            <div class="bubble-preview-container" id="bubblePreviewContainer" style="padding:6px;min-height:auto;">
              <div class="bubble-preview-item">优化代码</div>
              <div class="bubble-preview-item">添加注释</div>
            </div>
          </div>
        </div>
      </div>

      <!-- Card: 界面汉化 -->
      <div class="enhance-card">
        <div class="enhance-card-header">
          <div class="enhance-card-title-group">
            <span class="enhance-card-title">界面汉化</span>
            <span class="enhance-card-desc">实时翻译 IDE 界面文本为中文</span>
          </div>
          <label class="enhance-toggle"><input type="checkbox" id="enhLocalization" checked><span class="enhance-toggle-slider"></span></label>
        </div>
      </div>

      <!-- Card: 自动同意与继续 -->
      <div class="enhance-card">
        <div class="enhance-card-header">
          <div class="enhance-card-title-group">
            <span class="enhance-card-title">自动同意与继续</span>
            <span class="enhance-card-desc">自动点击 IDE 交互按钮，Cascade 到限时自动继续</span>
          </div>
          <label class="enhance-toggle"><input type="checkbox" id="enhAutoAccept" checked><span class="enhance-toggle-slider"></span></label>
        </div>
        <div class="enhance-card-body" id="autoAcceptSubOptions">
          <!-- 运行统计与重置 -->
          <div class="accept-stats-bar">
            <span class="stats-text">已执行: <strong id="statClicks" class="text-green">0</strong> | 阻断: <strong id="statBlocked" class="text-red">0</strong></span>
            <span id="btnResetAcceptStats" class="stats-reset-link">清零统计</span>
          </div>
          
          <!-- 次数控制 -->
          <div class="enhance-sub-row" style="padding: 2px 0;">
            <span>无限执行次数</span>
            <div style="display:flex;align-items:center;gap:8px;">
              <div id="remainingCountBox" class="remaining-input-box" style="display:none;">
                <span style="font-size:9.5px;opacity:0.6;">剩余</span>
                <input type="number" id="enhAutoAcceptRemaining" class="micro-number-input" value="30">
                <span style="font-size:9.5px;opacity:0.6;">次</span>
              </div>
              <label class="enhance-toggle">
                <input type="checkbox" id="enhAutoAcceptUnlimited" checked>
                <span class="enhance-toggle-slider"></span>
              </label>
            </div>
          </div>
          
          <!-- 胶囊网格选择器 -->
          <div style="display:flex;flex-direction:column;gap:4px;">
            <span class="sub-col-label">拦截与同意以下类型的按钮：</span>
            <div class="pill-selectors-container">
              <span class="pill-selector" data-pattern="accept">Accept</span>
              <span class="pill-selector" data-pattern="accept all">Accept All</span>
              <span class="pill-selector" data-pattern="always allow">Always Allow</span>
              <span class="pill-selector" data-pattern="allow this conversation">Allow Conv</span>
              <span class="pill-selector" data-pattern="retry">Retry</span>
              <span class="pill-selector" data-pattern="run">Run</span>
              <span class="pill-selector" data-pattern="apply">Apply</span>
              <span class="pill-selector" data-pattern="execute">Execute</span>
              <span class="pill-selector" data-pattern="confirm">Confirm</span>
              <span class="pill-selector" data-pattern="allow">Allow</span>
              <span class="pill-selector" data-pattern="continue">Continue</span>
              <span class="pill-selector" data-pattern="continue response">Continue Resp</span>
            </div>
            <!-- 隐藏的传统 checkbox 网格，以便和老 JS 逻辑无缝集成 -->
            <div style="display:none;">
              <input type="checkbox" class="accept-pattern-cb" data-pattern="accept">
              <input type="checkbox" class="accept-pattern-cb" data-pattern="accept all">
              <input type="checkbox" class="accept-pattern-cb" data-pattern="always allow">
              <input type="checkbox" class="accept-pattern-cb" data-pattern="allow this conversation">
              <input type="checkbox" class="accept-pattern-cb" data-pattern="retry">
              <input type="checkbox" class="accept-pattern-cb" data-pattern="run">
              <input type="checkbox" class="accept-pattern-cb" data-pattern="apply">
              <input type="checkbox" class="accept-pattern-cb" data-pattern="execute">
              <input type="checkbox" class="accept-pattern-cb" data-pattern="confirm">
              <input type="checkbox" class="accept-pattern-cb" data-pattern="allow">
              <input type="checkbox" class="accept-pattern-cb" data-pattern="continue">
              <input type="checkbox" class="accept-pattern-cb" data-pattern="continue response">
            </div>
          </div>

          <!-- 安全阻断规则详情 -->
          <details class="enhance-details">
            <summary class="enhance-details-summary">安全命令阻断规则...</summary>
            <div class="enhance-details-content">
              <div class="enhance-details-desc">当匹配到以下特征的危险命令时，自动阻止执行以防引发安全隐患（逗号或换行分隔）</div>
              <textarea id="enhBannedCommands" class="enhance-textarea" placeholder="例如：rm -rf, shutdown, poweroff, format"></textarea>
            </div>
          </details>
        </div>
      </div>

      <!-- Card: 自动重试 -->
      <div class="enhance-card">
        <div class="enhance-card-header">
          <div class="enhance-card-title-group">
            <span class="enhance-card-title">自动重试</span>
            <span class="enhance-card-desc">AI 回复出错时自动点击重试按钮</span>
          </div>
          <label class="enhance-toggle"><input type="checkbox" id="enhAutoRetry" checked><span class="enhance-toggle-slider"></span></label>
        </div>
        <div class="enhance-card-body" id="autoRetrySubOptions">
          <!-- 运行统计 -->
          <div class="accept-stats-bar">
            <span class="stats-text">已重试: <strong id="statRetries" class="text-green">0</strong> 次</span>
            <span id="btnResetRetryStats" class="stats-reset-link">清零</span>
          </div>
          <div class="enhance-sub-row-grid">
            <div class="enhance-sub-col">
              <span class="sub-col-label">最大重试</span>
              <input type="number" id="enhAutoRetryMax" class="micro-number-input" value="5" min="1" max="99" style="width:52px;">
              <span style="font-size:9.5px;opacity:0.6;">次</span>
            </div>
            <div class="enhance-sub-col">
              <span class="sub-col-label">重试间隔</span>
              <input type="number" id="enhAutoRetryDelay" class="micro-number-input" value="3" min="1" max="60" style="width:52px;">
              <span style="font-size:9.5px;opacity:0.6;">秒</span>
            </div>
          </div>
        </div>
      </div>

      <!-- 自定义 IDE 路径 (可选) -->
      <details class="enhance-details" style="margin-top: 8px;">
        <summary class="enhance-details-summary">自定义 IDE 路径 (可选)</summary>
        <div class="enhance-details-content" style="gap: 6px;">
          <div class="enhance-details-desc">默认针对当前运行的 IDE。如需对老版或跨平台（Mac/Linux）上的 Windsurf 注入，请指定其安装路径。</div>
          <div style="display:flex;gap:6px;align-items:center;">
            <input type="text" id="enhCustomIdePath" class="enhance-input" placeholder="留空为当前 IDE，或指定其他路径..." style="flex:1;height:24px;font-size:10.5px;padding:3px 6px;">
            <button class="inst-btn" id="btnSelectIdePath" style="height:24px;padding:0 8px;font-size:10px;white-space:nowrap;">浏览...</button>
          </div>
        </div>
      </details>

      <div class="panel-divider" style="margin:10px 0;opacity:0.3;"></div>
      <!-- 操作按钮 -->
      <div class="enhance-actions">
        <button class="enhance-apply-btn" id="enhApplyBtn">应用增强配置</button>
        <button class="enhance-remove-btn" id="enhRemoveBtn">清除增强</button>
      </div>
      <div class="enhance-status-msg" id="enhStatusMsg"></div>
    </div>
  </div>
</div>

<!-- Tab: 实例 -->
<div class="kite-tab-content tab-page" id="tabInstances" data-tab="instances" data-tab-page="instances" role="tabpanel">
  <div class="list-body">
    <div class="inst-toolbar">
      <span class="inst-toolbar-title" title="同时开多个 IDE 窗口，每个窗口登不同账号">多实例分身</span>
      <span class="inst-count-badge" id="instanceCountBadge">0</span>
      <div style="flex:1"></div>
      <button class="inst-cockpit-btn" id="instImportBtn" title="从 Cockpit Tools 导入">Cockpit</button>
      <button class="inst-add-btn" id="instAddBtn" title="新建实例">+ 新建</button>
      <button class="inst-refresh-btn" id="instRefreshBtn" title="刷新">
        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><polyline points="23 4 23 10 17 10"/><polyline points="1 20 1 14 7 14"/><path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15"/></svg>
      </button>
    </div>
    <div class="enhance-desc" style="padding:0 2px 6px">同时运行多个独立 IDE 实例，每个窗口独立数据目录，互不干扰。</div>
    <!-- 自定义主程序路径 -->
    <div style="display:flex;gap:6px;align-items:center;padding:0 2px 8px;">
      <span style="font-size:11px;opacity:0.8;white-space:nowrap;">主程序路径:</span>
      <input type="text" id="instCustomExePath" placeholder="自动探测(默认)..." readonly style="flex:1;height:24px;font-size:10px;padding:3px 6px;border-radius:4px;border:1px solid rgba(255,255,255,0.15);background:rgba(255,255,255,0.05);color:inherit;">
      <button class="inst-btn" id="btnSelectExePath" style="height:24px;padding:0 8px;font-size:10px;white-space:nowrap;cursor:pointer;">浏览...</button>
      <button class="inst-btn" id="btnClearExePath" style="height:24px;padding:0 8px;font-size:10px;white-space:nowrap;cursor:pointer;" title="恢复自动探测">清除</button>
    </div>
    <div id="instanceList" class="inst-list"></div>
    <div id="instEmpty" class="inst-empty" hidden>暂无实例，点击「+ 新建」</div>
    <div class="enhance-status-msg" id="instanceStatusMsg"></div>
  </div>
</div>

<!-- 新建实例模态框 -->
<div id="instCreateOverlay" class="modal-overlay" hidden>
  <div class="modal-box" style="width:min(380px,92vw)">
    <div class="modal-header">
      <h3>新建实例</h3>
      <button class="modal-close" id="instCreateClose" title="关闭">×</button>
    </div>
    <div class="modal-body">
      <label style="font-size:12px;opacity:0.8">实例名称</label>
      <input type="text" id="newInstanceName" placeholder="例如：工作号、测试号" style="width:100%;box-sizing:border-box;margin-top:4px">
      <div class="inst-create-hint">新实例将复制当前 IDE 环境，启动后独立运行。</div>
      <div style="display:flex;gap:8px;margin-top:12px;justify-content:flex-end">
        <button class="modal-cancel-btn" id="instCreateCancel" style="min-width:72px;padding:6px 20px">取消</button>
        <button class="primary" id="instanceCreateBtn" style="width:auto;min-width:72px;padding:6px 20px">创建</button>
      </div>
    </div>
  </div>
</div>

<!-- Cockpit 导入列表模态框 -->
<div id="cockpitImportOverlay" class="modal-overlay" hidden>
  <div class="modal-box" style="width:min(440px,94vw)">
    <div class="modal-header">
      <h3>从 Cockpit Tools 导入</h3>
      <button class="modal-close" id="cockpitImportClose" title="关闭">×</button>
    </div>
    <div class="modal-body">
      <div class="inst-create-hint" style="margin-top:0">检测到的 Cockpit Tools 实例（导入后直接引用其数据目录，不复制）。</div>
      <div id="cockpitList" class="cockpit-list"></div>
      <div id="cockpitEmpty" class="inst-empty" hidden>未找到 Cockpit Tools 实例</div>
    </div>
  </div>
</div>

<!-- Cockpit 导入填表模态框 -->
<div id="cockpitFormOverlay" class="modal-overlay" hidden>
  <div class="modal-box" style="width:min(380px,92vw)">
    <div class="modal-header">
      <h3>导入 Cockpit 实例</h3>
      <button class="modal-close" id="cockpitFormClose" title="关闭">×</button>
    </div>
    <div class="modal-body">
      <label style="font-size:12px;opacity:0.8">实例名称</label>
      <input type="text" id="cockpitFormName" placeholder="例如：工作号、测试号" style="width:100%;box-sizing:border-box;margin-top:4px">
      <label style="font-size:12px;opacity:0.8;display:block;margin-top:10px">绑定账号（可选）</label>
      <input type="text" id="cockpitFormEmail" placeholder="留空则自动识别" style="width:100%;box-sizing:border-box;margin-top:4px">
      <div class="inst-create-hint">导入后启动该实例时会保留原 Cockpit 数据目录。</div>
      <div style="display:flex;gap:8px;margin-top:12px;justify-content:flex-end">
        <button class="modal-cancel-btn" id="cockpitFormCancel" style="min-width:72px;padding:6px 20px">取消</button>
        <button class="primary" id="cockpitFormSubmit" style="width:auto;min-width:72px;padding:6px 20px">确认导入</button>
      </div>
    </div>
  </div>
</div>

</div><!-- /.app -->

<!-- 标签编辑弹窗 -->
<div id="tagEditOverlay" class="modal-overlay" hidden>
  <div class="modal-box" style="width:min(400px,90vw)">
    <div class="modal-header">
      <h3 id="tagEditTitle">编辑标签</h3>
      <button class="modal-close" id="tagEditClose" title="关闭">×</button>
    </div>
    <div class="modal-body">
      <div id="tagEditSelected" class="tag-edit-selected" style="display:flex;flex-wrap:wrap;gap:4px;min-height:28px;margin-bottom:8px;padding:4px 0"></div>
      <div style="display:flex;gap:6px;align-items:center">
        <input type="text" id="tagEditInput" placeholder="输入标签名称，回车添加" style="flex:1 1 auto;min-width:0;width:100%;box-sizing:border-box">
        <button id="tagEditAddBtn" style="flex:0 0 auto;padding:5px 14px;font-size:12px;white-space:nowrap;border-radius:6px;border:1px solid var(--accent,#10b981);background:var(--accent,#10b981);color:#fff;cursor:pointer">添加</button>
      </div>
      <div style="margin-top:8px">
        <label style="font-size:11px;opacity:0.7">已有标签（点击添加/移除）</label>
        <div id="tagEditExisting" class="tag-edit-existing" style="display:flex;flex-wrap:wrap;gap:4px;margin-top:4px;max-height:120px;overflow-y:auto"></div>
      </div>
      <div style="display:flex;gap:8px;margin-top:12px;justify-content:flex-end">
        <button class="modal-cancel-btn" id="tagEditCancel" style="min-width:72px;padding:6px 20px">取消</button>
        <button class="primary" id="tagEditSave" style="width:auto;min-width:72px;padding:6px 20px">保存</button>
      </div>
    </div>
  </div>
</div>

<!-- 通用确认框（showConfirm 驱动） -->
<div id="confirmOverlay" class="modal-overlay" hidden>
  <div class="modal-box">
    <div class="modal-header">
      <h3 id="confirmTitle">确认操作</h3>
      <button class="modal-close" id="confirmClose" title="关闭">×</button>
    </div>
    <div class="modal-body">
      <div class="confirm-message" id="confirmMessage"></div>
      <div class="confirm-actions">
        <button class="modal-cancel-btn" id="confirmCancel" style="min-width:72px;padding:6px 20px">取消</button>
        <button class="confirm-danger-btn" id="confirmOk">确认</button>
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

// ── Tab 切换逻辑 ──
(function() {
  const tabs = document.querySelectorAll('.kite-tab');
  const contents = document.querySelectorAll('.kite-tab-content');
  tabs.forEach(tab => {
    tab.addEventListener('click', () => {
      const target = tab.dataset.tab;
      tabs.forEach(t => {
        const active = t.dataset.tab === target;
        t.classList.toggle('is-active', active);
        t.classList.toggle('active', active);
        t.setAttribute('aria-selected', active ? 'true' : 'false');
      });
      contents.forEach(c => {
        const active = c.dataset.tab === target;
        c.classList.toggle('is-active', active);
        c.classList.toggle('active', active);
      });
    });
  });
})();

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

function shortModelName(label) {
  if (!label) return '未知模型';
  return label
    .replace(/^models\\//, '')
    .replace(/^gemini-/i, 'Gemini ')
    .replace(/^claude-/i, 'Claude ')
    .replace(/-latest$/i, '')
    .replace(/-\\d{8}$/i, '');
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

// 过滤器
document.getElementById('filterAll').onclick = () => setFilter('all');
document.getElementById('filterActive').onclick = () => setFilter('active');
document.getElementById('filterDisabled').onclick = () => setFilter('disabled');

function setFilter(filter) {
  activeFilter = filter;
  currentPage = 1;
  syncFilterChips();
  renderAccounts();
}

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
  btn.title = privacyMode ? '隐私模式：已隐藏邮箱' : '隐私模式：隐藏邮箱';
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

// 推荐排序
const _recommendBtn = document.getElementById('recommendBtn');
if (_recommendBtn) _recommendBtn.onclick = () => {
  sortBy = 'recommend';
  const sel = document.getElementById('sortSelect');
  if (sel) sel.value = 'recommend';
  _recommendBtn.classList.add('is-active');
  currentPage = 1;
  renderAccounts();
};

// 切号预检（状态保留供后端同步，UI 控件已移除）
let preflightEnabled = false;

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
    const t = ((a.usage && a.usage.tierId) || '未知').toUpperCase();
    plans[t] = (plans[t] || 0) + 1;
  });
  const planKeys = Object.keys(plans).sort();
  if (planSec) planSec.style.display = planKeys.length ? '' : 'none';
  planList.innerHTML = planKeys.map(p => filterCheckRow('plan', p, plans[p], filterPlans.has(p))).join('');
  const tags = getTagList();
  if (tagSec) tagSec.style.display = tags.length ? '' : 'none';
  tagList.innerHTML = tags.map(t => filterCheckRow('tag', t, accounts.filter(a => getAccTags(a).includes(t)).length, filterTags.has(t))).join('');
  statusList.innerHTML = [
    ['all', '全部'],
    ['active', '活跃'],
    ['disabled', '禁用']
  ].map(s => filterCheckRow('status', s[0],
    s[0] === 'all' ? accounts.length : accounts.filter(a => s[0] === 'active' ? !a.disabled : a.disabled).length,
    activeFilter === s[0], s[1])).join('');
}
function syncFilterChips() {
  const a = document.getElementById('filterAll');
  const fa = document.getElementById('filterActive');
  const fd = document.getElementById('filterDisabled');
  if (a) a.classList.toggle('is-active', activeFilter === 'all');
  if (fa) fa.classList.toggle('is-active', activeFilter === 'active');
  if (fd) fd.classList.toggle('is-active', activeFilter === 'disabled');
}
function updateFilterTriggerLabel() {
  const n = filterPlans.size + filterTags.size + (activeFilter !== 'all' ? 1 : 0);
  const label = document.getElementById('filterLabel');
  if (label) label.textContent = n > 0 ? '已筛选 ' + n : 'ALL';
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
      renderTagBar();
    } else if (kind === 'status') {
      activeFilter = value;
      _filterDropdown.querySelectorAll('input[data-kind="status"]').forEach(x => { if (x !== cb) x.checked = false; });
      syncFilterChips();
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
  syncFilterChips();
  renderTagBar();
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
  if (el) el.textContent = '已选 ' + selectedEmails.size;
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
    list = list.filter(a => filterPlans.has(((a.usage && a.usage.tierId) || '未知').toUpperCase()));
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
  if (selectedEmails.size === 0) { showToast('请先选择账号', 'warning'); return; }
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
  showConfirm('确定删除选中的 ' + selectedEmails.size + ' 个账号？此操作不可撤销。', {
    title: '批量删除账号',
    okText: '删除',
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
  if (selectedEmails.size === 0) { showToast('请先选择账号', 'warning'); return; }
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

// ── 标签过滤栏（多选+颜色） ──
function renderTagBar() {
  const tagListEl = document.getElementById('tagList');
  const tagBarEl = document.getElementById('tagBar');
  if (!tagListEl) return;

  const tagCounts = {};
  let untaggedCount = 0;
  accounts.forEach(acc => {
    const at = getAccTags(acc);
    if (at.length > 0) {
      at.forEach(t => { tagCounts[t] = (tagCounts[t] || 0) + 1; });
    } else {
      untaggedCount++;
    }
  });
  const tags = Object.keys(tagCounts);

  if (tags.length === 0 && untaggedCount === 0) {
    tagBarEl.style.display = 'none';
    return;
  }
  tagBarEl.style.display = 'flex';
  tagListEl.innerHTML = '';

  // "全部"按钮
  const allChip = document.createElement('span');
  allChip.className = 'tag-chip' + (filterTags.size === 0 ? ' is-active' : '');
  allChip.textContent = '全部(' + accounts.length + ')';
  allChip.onclick = () => {
    filterTags.clear();
    persistTagFilters();
    currentPage = 1;
    renderTagBar();
    renderAccounts();
  };
  tagListEl.appendChild(allChip);

  // 每个标签 chip（多选）
  tags.forEach(tag => {
    const chip = document.createElement('span');
    const isActive = filterTags.has(tag);
    chip.className = 'tag-chip' + (isActive ? ' is-active' : '');
    chip.textContent = tag + '(' + (tagCounts[tag] || 0) + ')';
    const tc = getTagColor(tag);
    if (isActive) {
      chip.style.background = tc;
      chip.style.borderColor = tc;
      chip.style.color = '#fff';
    } else {
      chip.style.background = tc + '20';
      chip.style.borderColor = tc + '60';
      chip.style.color = tc;
    }
    chip.onclick = () => {
      if (filterTags.has(tag)) filterTags.delete(tag);
      else filterTags.add(tag);
      persistTagFilters();
      currentPage = 1;
      renderTagBar();
      renderAccounts();
    };
    chip.oncontextmenu = (e) => { e.preventDefault(); openTagColorPicker(tag, chip); };
    tagListEl.appendChild(chip);
  });

  // "未分类" chip
  if (untaggedCount > 0) {
    const untaggedChip = document.createElement('span');
    const isActive = filterTags.has('未分类');
    untaggedChip.className = 'tag-chip' + (isActive ? ' is-active' : '');
    untaggedChip.textContent = '未分类(' + untaggedCount + ')';
    if (isActive) {
      untaggedChip.style.background = '#8b8b8b';
      untaggedChip.style.borderColor = '#8b8b8b';
      untaggedChip.style.color = '#fff';
    } else {
      untaggedChip.style.background = '#8b8b8b20';
      untaggedChip.style.borderColor = '#8b8b8b60';
      untaggedChip.style.color = '#8b8b8b';
    }
    untaggedChip.onclick = () => {
      if (filterTags.has('未分类')) filterTags.delete('未分类');
      else filterTags.add('未分类');
      persistTagFilters();
      currentPage = 1;
      renderTagBar();
      renderAccounts();
    };
    tagListEl.appendChild(untaggedChip);
  }
}

// ── 标签颜色选择器 ──
function openTagColorPicker(tag, anchorEl) {
  const existing = document.getElementById('tagColorPicker');
  if (existing) existing.remove();
  const picker = document.createElement('div');
  picker.id = 'tagColorPicker';
  picker.className = 'tag-color-picker';
  const currentColor = getTagColor(tag);
  picker.innerHTML = '<div class="tag-color-picker-title">「' + escHtml(tag) + '」颜色</div>'
    + '<div class="tag-color-picker-grid">'
    + TAG_PALETTE.map(c => '<span class="tag-color-dot' + (c === currentColor ? ' is-active' : '') + '" data-color="' + c + '" style="background:' + c + '"></span>').join('')
    + '</div>'
    + '<div class="tag-color-picker-custom"><input type="color" class="tag-color-input" value="' + currentColor + '"><span class="tag-color-reset" title="重置为默认色">↺</span></div>';
  const rect = anchorEl.getBoundingClientRect();
  picker.style.position = 'fixed';
  picker.style.left = rect.left + 'px';
  picker.style.top = (rect.bottom + 4) + 'px';
  picker.style.zIndex = '9999';
  document.body.appendChild(picker);
  function applyColorChange() { renderTagBar(); renderAccounts(); }
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
  document.getElementById('tagEditTitle').textContent = '编辑标签 - ' + (email.split('@')[0]);
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
  document.getElementById('tagEditTitle').textContent = '为 ' + emails.length + ' 个账号打标签';
  renderTagEditUI();
}
function renderTagEditUI() {
  const selectedEl = document.getElementById('tagEditSelected');
  const existingEl = document.getElementById('tagEditExisting');
  if (!selectedEl || !existingEl) return;
  if (tagEditPendingTags.length === 0) {
    selectedEl.innerHTML = '<span style="color:var(--muted);font-size:11px">暂无标签</span>';
  } else {
    selectedEl.innerHTML = tagEditPendingTags.map(t => {
      const tc = getTagColor(t);
      return '<span class="tag-edit-chip" style="background:' + tc + '18;border:1px solid ' + tc + '60;color:' + tc + ';padding:2px 10px;border-radius:10px;font-size:11px;cursor:pointer;display:inline-flex;align-items:center;gap:4px" data-tag="' + escHtml(t) + '"><span class="tag-edit-color-dot" data-tag="' + escHtml(t) + '" style="width:10px;height:10px;border-radius:50%;background:' + tc + ';cursor:pointer;flex-shrink:0;border:2px solid #fff;box-shadow:0 0 0 1px ' + tc + '" title="点击换色"></span>' + escHtml(t) + ' <span style="opacity:0.5;font-size:13px;margin-left:2px" class="tag-edit-remove">×</span></span>';
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
    return '<span class="tag-edit-opt" style="padding:2px 8px;border-radius:10px;font-size:11px;cursor:pointer;display:inline-flex;align-items:center;gap:4px;border:1px solid ' + tc + '60;background:' + (selected ? tc : tc + '20') + ';color:' + (selected ? '#fff' : tc) + '" data-tag="' + escHtml(t) + '"><span class="tag-edit-color-dot" data-tag="' + escHtml(t) + '" style="width:10px;height:10px;border-radius:50%;background:' + (selected ? '#fff' : tc) + ';cursor:pointer;flex-shrink:0;border:1px solid ' + (selected ? '#fff8' : tc + '80') + '" title="点击换色"></span>' + escHtml(t) + '</span>';
  }).join('') || '<span style="color:var(--muted);font-size:11px">暂无标签</span>';
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
    renderTagBar();
    renderAccounts();
    updateSummary();
    vscode.postMessage({ type: 'getUsageStats' });
  }
  if (msg.type === 'tagColorsSync') {
    if (msg.colors) { tagColors = msg.colors; try { localStorage.setItem('kite-tag-colors', JSON.stringify(tagColors)); } catch(e) {} renderTagBar(); renderAccounts(); }
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
  if (msg.type === 'preflightSync') {
    preflightEnabled = !!msg.enabled;
    const btn = document.getElementById('preflightToggleBtn');
    if (btn) btn.classList.toggle('is-active', preflightEnabled);
  }
  if (msg.type === 'versionSync' && msg.version) {
    const pill = document.getElementById('versionPill');
    if (pill) { pill.textContent = 'v' + msg.version; pill.hidden = false; }
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
  titleEl.textContent = opts.title || '确认操作';
  msgEl.textContent = message;
  okBtn.textContent = opts.okText || '确认';
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

// 导入状态处理
let loadingToast = null;
function handleImportStatus(msg) {
  if (msg.status === 'loading') {
    loadingToast = showToast(
      '<span class="toast-spinner"></span> 正在从 ' + msg.source + ' 导入...', 
      'loading', 
      0
    );
  } else if (msg.status === 'success') {
    if (loadingToast) { loadingToast.remove(); loadingToast = null; }
    const total = msg.imported + msg.skipped;
    let text = '从 ' + msg.source + ' 导入完成';
    if (msg.imported > 0) text += '<br><span class="toast-detail">新增 ' + msg.imported + ' 个账号</span>';
    if (msg.skipped > 0) text += '<br><span class="toast-detail">跳过 ' + msg.skipped + ' 个已存在</span>';
    if (total === 0) text = msg.source + ' 中没有找到账号';
    showToast(text, msg.imported > 0 ? 'success' : 'warning', 4000);
  } else if (msg.status === 'error') {
    if (loadingToast) { loadingToast.remove(); loadingToast = null; }
    showToast('导入失败<br><span class="toast-detail">' + msg.message + '</span>', 'error', 5000);
  } else if (msg.status === 'cancelled') {
    if (loadingToast) { loadingToast.remove(); loadingToast = null; }
  }
}

// ── 标签卡片交互：点击筛选 / 右键改色 / 编辑标签 ──
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
      const chip = e.target.closest('.grid-tag-chip');
      if (chip) {
        const tag = chip.dataset.tag;
        if (tag) {
          if (filterTags.has(tag)) filterTags.delete(tag);
          else filterTags.add(tag);
          persistTagFilters();
          currentPage = 1;
          renderTagBar();
          renderAccounts();
        }
        return;
      }
      const addBtn = e.target.closest('.grid-tag-add');
      if (addBtn) {
        const email = addBtn.dataset.email || addBtn.closest('.grid-card')?.dataset.email;
        if (email) openTagEditModal(email);
        return;
      }
    });
    accountGrid.addEventListener('contextmenu', (e) => {
      const chip = e.target.closest('.grid-tag-chip');
      if (!chip) return;
      e.preventDefault();
      const tag = chip.dataset.tag;
      if (tag) openTagColorPicker(tag, chip);
    });
    accountGrid.addEventListener('dblclick', (e) => {
      const chip = e.target.closest('.grid-tag-chip');
      if (!chip) return;
      e.preventDefault();
      const tag = chip.dataset.tag;
      if (tag) openTagColorPicker(tag, chip);
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
  
  const maskedEmail = email ? email.replace(/(.{2}).*(@.*)/, '$1***$2') : '未知';
  let title = exists ? '账号已在号池中' : '检测到本地账号';
  let desc = exists 
    ? '当前账号已存在于号池中，是否覆盖更新授权信息？'
    : '当前账号不在号池中，是否添加到号池？';
  const confirmText = exists ? '覆盖更新' : '添加到号池';
  
  // Token 过期提示
  const expiredWarning = tokenExpired
    ? '<div class="import-modal-warning"><svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="2" style="vertical-align:-2px;margin-right:4px"><circle cx="8" cy="8" r="6.5"/><line x1="8" y1="5" x2="8" y2="9" stroke-linecap="round"/><circle cx="8" cy="11.5" r="0.6" fill="currentColor" stroke="none"/></svg>授权已失效，导入后需要重新登录授权</div>'
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
        <button class="import-modal-btn cancel" onclick="closeImportModal()">取消</button>
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
  const total = accounts.length;
  const active = accounts.filter(a => !a.disabled).length;
  const disabled = total - active;

  // 计算配额统计（取所有模型的最低值）
  let highQuota = 0, lowQuota = 0;
  for (const a of accounts) {
    if (a.disabled || !a.usage?.models?.length) continue;
    const minPct = Math.min(...a.usage.models.map(m => m.remainingPercent));
    if (minPct >= 80) highQuota++;
    else if (minPct <= 30) lowQuota++;
  }

  // 本日 / 本周 大卡片:取所有账号的 min(本日)/avg(本周)
  const usable = accounts.filter(a => !a.disabled && a.usage?.models?.length);
  const dailyPcts = usable.map(a => Math.min(...a.usage.models.map(m => m.remainingPercent)));
  const weeklyPcts = usable.map(a => a.usage.models.reduce((s, m) => s + m.remainingPercent, 0) / a.usage.models.length);
  const dailyPct = dailyPcts.length ? dailyPcts.reduce((s, v) => s + v, 0) / dailyPcts.length : 0;
  const weeklyPct = weeklyPcts.length ? weeklyPcts.reduce((s, v) => s + v, 0) / weeklyPcts.length : 0;

  document.getElementById('gridCount').textContent = active + ' / ' + total + ' 个';
  setText('tabAccountCount', String(total));
  document.getElementById('summaryActiveDisabled').textContent = active + ' / ' + disabled;
  document.getElementById('summaryHighQuota').textContent = highQuota + ' 个（≥ 80%）';
  document.getElementById('summaryLowQuota').textContent = lowQuota + ' 个（≤ 30%）';
  document.getElementById('summaryLastRefresh').textContent = new Date().toLocaleTimeString().slice(0,5);

  setText('summaryDailyPct', Math.round(dailyPct) + '%');
  setBarWidth('summaryDailyBar', dailyPct);
  setText('summaryDailyNum', Math.round(dailyPct));
  setText('summaryDailyMax', '/ 100');
  setText('summaryWeeklyPct', Math.round(weeklyPct) + '%');
  setBarWidth('summaryWeeklyBar', weeklyPct);
  setText('summaryWeeklyNum', Math.round(weeklyPct));
  setText('summaryWeeklyMax', '/ 100');
}

function setText(id, value) {
  const el = document.getElementById(id);
  if (el) el.textContent = value;
}
function setBarWidth(id, pct) {
  const el = document.getElementById(id);
  if (el) el.style.width = Math.max(0, Math.min(100, pct)) + '%';
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
    filtered = filtered.filter(a => filterPlans.has(((a.usage && a.usage.tierId) || '未知').toUpperCase()));
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
  
  document.getElementById('filterCount').textContent = totalFiltered + ' / ' + accounts.length + ' 个';
  
  if (totalFiltered === 0) {
    grid.innerHTML = '';
    empty.style.display = 'block';
    empty.querySelector('.empty-title').textContent = searchTerm ? '没有匹配的账号' : '还没有账号';
    renderPagination(0, 0);
    return;
  }
  empty.style.display = 'none';

  grid.innerHTML = paged.map(a => {
    const isCurrent = a.email === currentEmail;
    const rawEmail = a.email;
    const safeEmail = rawEmail.replace(/</g,'&lt;').replace(/>/g,'&gt;');
    const showEmail = displayEmail(rawEmail).replace(/</g,'&lt;').replace(/>/g,'&gt;');
    // tags 由卡片内 getAccTags+getTagColor 动态渲染
    const isDisabled = a.disabled;
    
    // 从 usage 读取配额数据
    const usage = a.usage;
    const tierId = usage?.tierId || '';
    const tierClass = planTierClass(tierId);
    const tierLabel = tierId ? tierId.toUpperCase() : '...';
    
    // 模型配额（3 组：Claude / Gemini Pro / Gemini Flash）
    const models = usage?.models || [];
    let quotasHtml;
    if (models.length > 0) {
      const items = models.map(m => {
        const pct = m.remainingPercent;
        const cls = pctClass(pct);
        const resetText = m.resetTime ? formatResetTime(m.resetTime) : '';
        return '<div class="quota-group-item">'
          + '<div class="quota-group-head"><span class="quota-group-name">' + m.label + '</span><span class="quota-group-val ' + cls + '">' + pct + '%</span></div>'
          + '<div class="quota-bar"><div class="quota-bar-fill ' + cls + '" style="width:' + pct + '%"></div></div>'
          + (resetText ? '<div class="quota-group-reset">' + resetText + '</div>' : '')
          + '</div>';
      });
      quotasHtml = '<div class="quota-groups">' + items.join('') + '</div>';
    } else {
      // 无数据时占位：CPA 同款四窗骨架；有错误则错误可见，绝不让占位符吞掉失败
      const placeholderGroups = ['Claude 5h', 'Claude 周额度', 'Gemini 5h', 'Gemini 周额度'];
      const placeholderItems = placeholderGroups.map(name => {
        return '<div class="quota-group-item">'
          + '<div class="quota-group-head"><span class="quota-group-name">' + name + '</span><span class="quota-group-val" style="opacity:0.4">—</span></div>'
          + '<div class="quota-bar"><div class="quota-bar-fill" style="width:0%"></div></div>'
          + '<div class="quota-group-reset" style="opacity:0.3">&nbsp;</div>'
          + '</div>';
      });
      const loadErrorHtml = a._usageError
        ? '<div class="quota-load-error">' + escHtml(String(a._usageError)) + '</div>'
        : '';
      quotasHtml = '<div class="quota-groups">' + placeholderItems.join('') + loadErrorHtml + '</div>';
    }
    
    // 额外信息区（windsurf-pool 风格：AI 积分 / 额外用量余额 / 会员期限 / 今日切号）
    const creditsVal = usage?.availableAICredits;
    const extraHtml = '<div class="grid-card-extra">'
      + '<div class="grid-extra-row"><span>AI 积分</span><span class="grid-extra-val' + (creditsVal ? ' is-balance' : '') + '">' + (creditsVal !== undefined ? creditsVal : '—') + '</span></div>'
      + '<div class="grid-extra-row"><span>额外用量余额</span><span class="grid-extra-val">—</span></div>'
      + '<div class="grid-extra-row"><span>会员期限</span><span class="grid-extra-val">—</span></div>'
      + '<div class="grid-extra-row"><span>今日切号</span><span class="grid-extra-val">0 次</span></div>'
      + '</div>';
    
    return '<div class="grid-card ' + (isCurrent ? 'is-active' : '') + ' ' + (isDisabled ? 'is-disabled' : '') + (selectMode ? ' is-select-mode' : '') + '" data-email="' + safeEmail + '">'
      + (selectMode ? '<div class="grid-check-col"><input type="checkbox" class="grid-check-input" data-email="' + safeEmail + '" ' + (selectedEmails.has(rawEmail) ? 'checked' : '') + '></div>' : '')
      + '<div class="grid-card-head">'
        + '<div class="grid-card-email" title="' + safeEmail + '">' + showEmail + '</div>'
        + (isCurrent ? '<span class="grid-active-tag">当前</span>' : '')
        + (isDisabled ? '<span class="grid-disabled-tag">已禁用</span>' : '')
      + '</div>'
      + '<div class="grid-card-meta">'
        + '<span class="grid-plan-chip ' + tierClass + '">' + tierLabel + '</span>'
      + '</div>'
      + '<div class="grid-card-quotas">' + quotasHtml + '</div>'
      + extraHtml
      + '<div class="grid-card-actions">'
        + (isCurrent
          ? '<span class="grid-current-label"><span style="color:#3fb950">●</span> 使用中</span>'
          : '<button class="grid-switch-btn" onclick="setCurrent(\\x27' + safeEmail + '\\x27)">切换</button>')
        + '<div class="grid-actions-right">'
          + '<button class="status-dot-btn ' + (isDisabled ? 'is-off' : 'is-on') + '" onclick="toggleDisabled(\\x27' + safeEmail + '\\x27)" title="' + (isDisabled ? '账号已禁用，点击启用' : '账号启用中，点击禁用') + '" aria-label="切换账号启用状态"></button>'
          + '<button class="icon-btn" onclick="openTagEditModal(\\x27' + safeEmail + '\\x27)" title="编辑标签"><svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/></svg></button>'
          + '<button class="icon-btn" onclick="refreshUsage(\\x27' + safeEmail + '\\x27)" title="刷新配额"><svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 12a9 9 0 0 1 9-9 9.75 9.75 0 0 1 6.74 2.74L21 8"/><path d="M21 3v5h-5"/><path d="M21 12a9 9 0 0 1-9 9 9.75 9.75 0 0 1-6.74-2.74L3 16"/><path d="M8 16H3v5"/></svg></button>'
          + '<button class="icon-btn danger" onclick="removeAccount(\\x27' + safeEmail + '\\x27)" title="从号池移除"><svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg></button>'
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

function setCurrent(email) { vscode.postMessage({ type: 'setCurrentAccount', email }); }
function removeAccount(email) {
  showConfirm('确定从号池移除 ' + email + ' ？', {
    title: '删除账号',
    okText: '删除',
    onConfirm: () => vscode.postMessage({ type: 'removeAccount', email })
  });
}
function toggleDisabled(email) { vscode.postMessage({ type: 'toggleDisabled', email }); }

// ===== 增强功能面板逻辑 =====
(function() {
  const enhBubblesToggle = document.getElementById('enhBubbles');
  const bubblesSubOptions = document.getElementById('bubblesSubOptions');
  const enhBubblesTheme = document.getElementById('enhBubblesTheme');
  const enhBubblesShape = document.getElementById('enhBubblesShape');

  const enhAutoAcceptToggle = document.getElementById('enhAutoAccept');
  const autoAcceptSubOptions = document.getElementById('autoAcceptSubOptions');
  const enhAutoAcceptUnlimited = document.getElementById('enhAutoAcceptUnlimited');
  const enhAutoAcceptRemaining = document.getElementById('enhAutoAcceptRemaining');
  const remainingCountBox = document.getElementById('remainingCountBox');
  const enhCustomIdePath = document.getElementById('enhCustomIdePath');
  const btnSelectIdePath = document.getElementById('btnSelectIdePath');

  // 当路径改变时，通知后端检查对应路径的注入状态
  const checkStatus = () => {
    const customPath = enhCustomIdePath ? enhCustomIdePath.value.trim() : '';
    vscode.postMessage({ type: 'checkEnhancementStatus', customIdePath: customPath });
  };
  if (enhCustomIdePath) {
    enhCustomIdePath.addEventListener('change', checkStatus);
    enhCustomIdePath.addEventListener('input', checkStatus);
  }

  // 浏览选择路径
  if (btnSelectIdePath) {
    btnSelectIdePath.addEventListener('click', () => {
      vscode.postMessage({ type: 'selectIdePath' });
    });
  }

  // 切换气泡子选项显示
  enhBubblesToggle.addEventListener('change', () => {
    bubblesSubOptions.style.display = enhBubblesToggle.checked ? '' : 'none';
  });

  // 切换自动同意子选项显示
  enhAutoAcceptToggle.addEventListener('change', () => {
    autoAcceptSubOptions.style.display = enhAutoAcceptToggle.checked ? '' : 'none';
  });

  // 切换无限次数显示
  enhAutoAcceptUnlimited.addEventListener('change', () => {
    const unlimited = enhAutoAcceptUnlimited.checked;
    if (remainingCountBox) remainingCountBox.style.display = unlimited ? 'none' : '';
  });

  // 切换自动重试子选项显示
  const enhAutoRetryToggle = document.getElementById('enhAutoRetry');
  const autoRetrySubOptions = document.getElementById('autoRetrySubOptions');
  if (enhAutoRetryToggle && autoRetrySubOptions) {
    enhAutoRetryToggle.addEventListener('change', () => {
      autoRetrySubOptions.style.display = enhAutoRetryToggle.checked ? '' : 'none';
    });
  }

  // 胶囊选择器交互逻辑
  const pillSelectors = document.querySelectorAll('.pill-selector');
  pillSelectors.forEach(pill => {
    pill.addEventListener('click', () => {
      const pattern = pill.dataset.pattern;
      pill.classList.toggle('is-active');
      const cb = document.querySelector('.accept-pattern-cb[data-pattern="' + pattern + '"]');
      if (cb) {
        cb.checked = pill.classList.contains('is-active');
      }
    });
  });

  // 定时从 localStorage 读取自动同意统计数并渲染
  function syncAutoAcceptStats() {
    try {
      const saved = localStorage.getItem('kite-auto-accept-settings');
      if (saved) {
        const ds = JSON.parse(saved);
        if (ds.stats) {
          document.getElementById('statClicks').textContent = ds.stats.clicks || 0;
          document.getElementById('statBlocked').textContent = ds.stats.blocked || 0;
        }
        if (!enhAutoAcceptUnlimited.checked && ds.remaining !== undefined) {
          enhAutoAcceptRemaining.value = ds.remaining;
        }
      }
    } catch(e){}
  }
  setInterval(syncAutoAcceptStats, 1000);
  window.addEventListener('storage', syncAutoAcceptStats);
  syncAutoAcceptStats();
  
  // 清零统计信息
  const btnResetAcceptStats = document.getElementById('btnResetAcceptStats');
  if (btnResetAcceptStats) {
    btnResetAcceptStats.addEventListener('click', () => {
      try {
        const saved = localStorage.getItem('kite-auto-accept-settings') || '{}';
        const ds = JSON.parse(saved);
        ds.stats = { clicks: 0, blocked: 0, verified: 0 };
        localStorage.setItem('kite-auto-accept-settings', JSON.stringify(ds));
        document.getElementById('statClicks').textContent = '0';
        document.getElementById('statBlocked').textContent = '0';
      } catch(e){}
    });
  }

  // 手动修改剩余次数时同步到 localStorage
  enhAutoAcceptRemaining.addEventListener('input', () => {
    try {
      const saved = localStorage.getItem('kite-auto-accept-settings') || '{}';
      const ds = JSON.parse(saved);
      ds.remaining = parseInt(enhAutoAcceptRemaining.value) || 0;
      localStorage.setItem('kite-auto-accept-settings', JSON.stringify(ds));
    } catch(e){}
  });

  // 自动重试统计同步
  function syncAutoRetryStats() {
    try {
      const saved = localStorage.getItem('kite-auto-retry-settings');
      if (saved) {
        const rs = JSON.parse(saved);
        const el = document.getElementById('statRetries');
        if (el) el.textContent = rs.totalRetries || 0;
      }
    } catch(e){}
  }
  setInterval(syncAutoRetryStats, 1000);
  window.addEventListener('storage', syncAutoRetryStats);
  syncAutoRetryStats();

  // 清零重试统计
  const btnResetRetryStats = document.getElementById('btnResetRetryStats');
  if (btnResetRetryStats) {
    btnResetRetryStats.addEventListener('click', () => {
      try {
        localStorage.setItem('kite-auto-retry-settings', JSON.stringify({ totalRetries: 0 }));
        const el = document.getElementById('statRetries');
        if (el) el.textContent = '0';
      } catch(e){}
    });
  }

  // ── 气泡实时预览 ──
  const PREVIEW_THEMES = {
    emerald: 'linear-gradient(135deg, #22c55e, #06b6d4, #3b82f6)',
    ocean:   'linear-gradient(135deg, #0ea5e9, #3b82f6, #6366f1)',
    sunset:  'linear-gradient(135deg, #f59e0b, #f43f5e, #ec4899)',
    purple:  'linear-gradient(135deg, #8b5cf6, #a855f7, #ec4899)',
    minimal: 'rgba(128,128,128,0.18)',
  };
  const PREVIEW_SHAPES = { rounded: '10px', pill: '20px', square: '2px' };
  function updateBubblePreview() {
    const container = document.getElementById('bubblePreviewContainer');
    if (!container) return;
    const themeId = enhBubblesTheme ? enhBubblesTheme.value : 'emerald';
    const shapeId = enhBubblesShape ? enhBubblesShape.value : 'rounded';
    const bg = PREVIEW_THEMES[themeId] || PREVIEW_THEMES.emerald;
    const radius = PREVIEW_SHAPES[shapeId] || PREVIEW_SHAPES.rounded;
    const isMinimal = themeId === 'minimal';
    container.querySelectorAll('.bubble-preview-item').forEach(item => {
      item.style.background = bg;
      item.style.borderRadius = radius;
      item.style.color = isMinimal ? 'var(--vscode-foreground)' : '#fff';
    });
  }
  if (enhBubblesTheme) enhBubblesTheme.addEventListener('change', updateBubblePreview);
  if (enhBubblesShape) enhBubblesShape.addEventListener('change', updateBubblePreview);
  updateBubblePreview();

  // 应用增强
  document.getElementById('enhApplyBtn').addEventListener('click', () => {
    const patterns = {};
    document.querySelectorAll('.accept-pattern-cb').forEach(cb => {
      patterns[cb.dataset.pattern] = cb.checked;
    });

    const settings = {
      latexEnabled: document.getElementById('enhLatex').checked,
      bubblesEnabled: document.getElementById('enhBubbles').checked,
      bubblesAutoSend: document.getElementById('enhBubblesAutoSend').checked,
      bubblesTheme: document.getElementById('enhBubblesTheme').value,
      bubblesShape: document.getElementById('enhBubblesShape').value,
      localizationEnabled: document.getElementById('enhLocalization').checked,
      autoAcceptEnabled: document.getElementById('enhAutoAccept').checked,
      autoAcceptRemaining: parseInt(document.getElementById('enhAutoAcceptRemaining').value) || 0,
      autoAcceptUnlimited: document.getElementById('enhAutoAcceptUnlimited').checked,
      bannedCommands: document.getElementById('enhBannedCommands').value.split(/[\\n,]+/).map(s => s.trim()).filter(Boolean),
      autoAcceptPatterns: patterns,
      autoRetryEnabled: document.getElementById('enhAutoRetry').checked,
      autoRetryMaxAttempts: parseInt(document.getElementById('enhAutoRetryMax').value) || 5,
      autoRetryDelay: parseInt(document.getElementById('enhAutoRetryDelay').value) || 3,
      customIdePath: document.getElementById('enhCustomIdePath').value.trim(),
    };
    vscode.postMessage({ type: 'applyEnhancement', settings });
    showEnhStatus('正在注入...', 'info');
  });

  // 移除增强
  document.getElementById('enhRemoveBtn').addEventListener('click', () => {
    const customPath = document.getElementById('enhCustomIdePath').value.trim();
    vscode.postMessage({ type: 'removeEnhancement', customIdePath: customPath });
    showEnhStatus('正在移除...', 'info');
  });

  function showEnhStatus(msg, level, withRestart) {
    const el = document.getElementById('enhStatusMsg');
    el.className = 'enhance-status-msg ' + (level || '');
    if (withRestart) {
      el.innerHTML = '';
      const span = document.createElement('span');
      span.textContent = msg + ' ';
      const btn = document.createElement('button');
      btn.className = 'enh-restart-btn';
      btn.textContent = '立即重启';
      btn.addEventListener('click', () => vscode.postMessage({ type: 'restartIde' }));
      el.appendChild(span);
      el.appendChild(btn);
    } else {
      el.textContent = msg;
    }
  }

  // 接收状态消息
  window.addEventListener('message', (event) => {
    const msg = event.data;
    if (msg.type === 'enhancementStatus') {
      const badge = document.getElementById('enhanceStatusBadge');
      badge.textContent = msg.injected ? '已注入' : '未注入';
      badge.className = 'enhance-status-badge ' + (msg.injected ? 'is-active' : '');
    } else if (msg.type === 'enhancementResult') {
      showEnhStatus(msg.message, msg.success ? 'success' : 'error', !!msg.success);
    } else if (msg.type === 'enhancementSettings') {
      // 恢复设置
      if (msg.settings) {
        document.getElementById('enhLatex').checked = msg.settings.latexEnabled;
        document.getElementById('enhBubbles').checked = msg.settings.bubblesEnabled;
        document.getElementById('enhBubblesAutoSend').checked = msg.settings.bubblesAutoSend;
        document.getElementById('enhBubblesTheme').value = msg.settings.bubblesTheme || 'emerald';
        document.getElementById('enhBubblesShape').value = msg.settings.bubblesShape || 'rounded';
        document.getElementById('enhLocalization').checked = msg.settings.localizationEnabled !== false;
        bubblesSubOptions.style.display = msg.settings.bubblesEnabled ? '' : 'none';
        updateBubblePreview();

        document.getElementById('enhAutoAccept').checked = msg.settings.autoAcceptEnabled !== false;
        const isUnlimited = msg.settings.autoAcceptUnlimited !== false;
        document.getElementById('enhAutoAcceptUnlimited').checked = isUnlimited;
        document.getElementById('enhAutoAcceptRemaining').value = msg.settings.autoAcceptRemaining !== undefined ? msg.settings.autoAcceptRemaining : 30;
        
        autoAcceptSubOptions.style.display = (msg.settings.autoAcceptEnabled !== false) ? '' : 'none';
        if (remainingCountBox) remainingCountBox.style.display = isUnlimited ? 'none' : '';
        
        if (Array.isArray(msg.settings.bannedCommands)) {
          document.getElementById('enhBannedCommands').value = msg.settings.bannedCommands.join('\\n');
        } else {
          document.getElementById('enhBannedCommands').value = '';
        }

        if (enhCustomIdePath) {
          enhCustomIdePath.value = msg.settings.customIdePath || '';
        }

        const patterns = msg.settings.autoAcceptPatterns || {};
        document.querySelectorAll('.accept-pattern-cb').forEach(cb => {
          const pat = cb.dataset.pattern;
          cb.checked = patterns[pat] !== false; // 默认为 true（除了 accept）
          const pill = document.querySelector('.pill-selector[data-pattern="' + pat + '"]');
          if (pill) {
            pill.classList.toggle('is-active', cb.checked);
          }
        });

        // 恢复自动重试设置
        const enhAutoRetryEl = document.getElementById('enhAutoRetry');
        const autoRetrySubEl = document.getElementById('autoRetrySubOptions');
        if (enhAutoRetryEl) {
          enhAutoRetryEl.checked = msg.settings.autoRetryEnabled !== false;
          if (autoRetrySubEl) autoRetrySubEl.style.display = enhAutoRetryEl.checked ? '' : 'none';
        }
        const enhAutoRetryMaxEl = document.getElementById('enhAutoRetryMax');
        if (enhAutoRetryMaxEl) enhAutoRetryMaxEl.value = msg.settings.autoRetryMaxAttempts !== undefined ? msg.settings.autoRetryMaxAttempts : 5;
        const enhAutoRetryDelayEl = document.getElementById('enhAutoRetryDelay');
        if (enhAutoRetryDelayEl) enhAutoRetryDelayEl.value = msg.settings.autoRetryDelay !== undefined ? msg.settings.autoRetryDelay : 3;
      }
    } else if (msg.type === 'selectedIdePath') {
      if (enhCustomIdePath) {
        enhCustomIdePath.value = msg.path;
        checkStatus();
      }
    }
  });
})();

// ===== 多实例面板逻辑 =====
(function() {
  let instanceData = [];

  function escIns(t) { const d = document.createElement('div'); d.textContent = t == null ? '' : t; return d.innerHTML; }

  function renderInstances(instances) {
    instanceData = instances || [];
    const container = document.getElementById('instanceList');
    const empty = document.getElementById('instEmpty');
    const badge = document.getElementById('instanceCountBadge');
    if (badge) badge.textContent = instanceData.length;
    const tabBadge = document.getElementById('tabInstanceCount');
    if (tabBadge) tabBadge.textContent = String(instanceData.length);

    if (!instanceData.length) {
      container.innerHTML = '';
      if (empty) empty.hidden = false;
      return;
    }
    if (empty) empty.hidden = true;

    container.innerHTML = instanceData.map(inst => {
      const statusClass = inst.running ? 'is-running' : 'is-stopped';
      const stateText = inst.current ? '当前' : (inst.running ? '运行中' : '已停止');
      const stateClass = inst.current ? 'is-current' : statusClass;
      const id = escIns(inst.id);
      const actions = [];
      if (inst.running && !inst.current) {
        actions.push('<button class="inst-icon-btn inst-focus" data-id="' + id + '" title="聚焦"><svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg></button>');
      }
      if (!inst.running && inst.id !== 'default') {
        actions.push('<button class="inst-icon-btn inst-start" data-id="' + id + '" title="启动"><svg width="13" height="13" viewBox="0 0 24 24" fill="currentColor"><polygon points="5 3 19 12 5 21 5 3"/></svg></button>');
      }
      if (inst.running && !inst.current) {
        actions.push('<button class="inst-icon-btn inst-stop" data-id="' + id + '" title="停止"><svg width="13" height="13" viewBox="0 0 24 24" fill="currentColor"><rect x="6" y="6" width="12" height="12" rx="1"/></svg></button>');
      }
      if (inst.id !== 'default' && !inst.running && !inst.current) {
        actions.push('<button class="inst-icon-btn danger inst-del" data-id="' + id + '" title="删除"><svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/><path d="M10 11v6M14 11v6"/></svg></button>');
      }
      const srcBadge = inst.source === 'cockpit' ? '<span class="inst-source-badge">Cockpit</span>' : '';
      return '<div class="inst-card ' + stateClass + '" data-inst-id="' + id + '">' +
        '<div class="inst-card-header">' +
          '<span class="inst-card-dot ' + statusClass + '"></span>' +
          '<div class="inst-card-name">' + escIns(inst.name) + '</div>' +
          srcBadge +
          '<span class="inst-card-state ' + stateClass + '">' + stateText + '</span>' +
        '</div>' +
        (inst.bindEmail ? '<div class="inst-card-email" title="' + escIns(inst.bindEmail) + '">' + escIns(inst.bindEmail) + '</div>' : '<div class="inst-card-email is-none">未绑定账号</div>') +
        '<div class="inst-card-actions">' + actions.join('') + '</div>' +
      '</div>';
    }).join('');

    // 事件绑定
    container.querySelectorAll('.inst-start').forEach(btn => btn.addEventListener('click', () => {
      vscode.postMessage({ type: 'startInstance', instanceId: btn.dataset.id });
      showInstStatus('正在启动...', 'info');
    }));
    container.querySelectorAll('.inst-stop').forEach(btn => btn.addEventListener('click', () => {
      vscode.postMessage({ type: 'stopInstance', instanceId: btn.dataset.id });
      showInstStatus('正在停止...', 'info');
    }));
    container.querySelectorAll('.inst-focus').forEach(btn => btn.addEventListener('click', () => {
      vscode.postMessage({ type: 'focusInstance', instanceId: btn.dataset.id });
    }));
    container.querySelectorAll('.inst-del').forEach(btn => btn.addEventListener('click', () => {
      showConfirm('确定删除此实例？数据将被清除。', {
        title: '删除实例',
        okText: '删除',
        onConfirm: () => {
          vscode.postMessage({ type: 'deleteInstance', instanceId: btn.dataset.id });
          showInstStatus('正在删除...', 'info');
        }
      });
    }));
  }

  function showInstStatus(msg, level) {
    const el = document.getElementById('instanceStatusMsg');
    el.textContent = msg;
    el.className = 'enhance-status-msg ' + (level || '');
    if (level === 'success' || level === 'info') setTimeout(() => { el.textContent = ''; el.className = 'enhance-status-msg'; }, 3000);
  }

  // 新建实例模态框
  const createOverlay = document.getElementById('instCreateOverlay');
  function openCreateModal() {
    createOverlay.hidden = false;
    const ni = document.getElementById('newInstanceName');
    ni.value = '';
    setTimeout(() => ni.focus(), 50);
  }
  function closeCreateModal() { createOverlay.hidden = true; }
  document.getElementById('instAddBtn').addEventListener('click', openCreateModal);
  document.getElementById('instCreateClose').addEventListener('click', closeCreateModal);
  document.getElementById('instCreateCancel').addEventListener('click', closeCreateModal);
  createOverlay.addEventListener('click', (e) => { if (e.target === createOverlay) closeCreateModal(); });

  document.getElementById('instanceCreateBtn').addEventListener('click', () => {
    const nameInput = document.getElementById('newInstanceName');
    const name = nameInput.value.trim();
    if (!name) { nameInput.focus(); return; }
    vscode.postMessage({ type: 'createInstance', name, bindEmail: '' });
    closeCreateModal();
    showInstStatus('正在创建，可能需要一段时间…', 'info');
  });

  // 刷新
  document.getElementById('instRefreshBtn').addEventListener('click', () => {
    vscode.postMessage({ type: 'listInstances' });
  });

  // 自定义主程序 exe 路径事件绑定
  const btnSelectExePath = document.getElementById('btnSelectExePath');
  if (btnSelectExePath) {
    btnSelectExePath.addEventListener('click', () => {
      vscode.postMessage({ type: 'selectExePath' });
    });
  }
  const btnClearExePath = document.getElementById('btnClearExePath');
  if (btnClearExePath) {
    btnClearExePath.addEventListener('click', () => {
      vscode.postMessage({ type: 'clearExePath' });
    });
  }

  // ── Cockpit Tools 导入 ──
  const cockpitOverlay = document.getElementById('cockpitImportOverlay');
  const cockpitFormOverlay = document.getElementById('cockpitFormOverlay');
  let pendingCockpitId = null;
  let pendingCockpitEmail = '';

  document.getElementById('instImportBtn').addEventListener('click', () => {
    cockpitOverlay.hidden = false;
    document.getElementById('cockpitList').innerHTML = '<div class="inst-empty">扫描中…</div>';
    document.getElementById('cockpitEmpty').hidden = true;
    vscode.postMessage({ type: 'listCockpitInstances' });
  });
  function closeCockpit() { cockpitOverlay.hidden = true; }
  document.getElementById('cockpitImportClose').addEventListener('click', closeCockpit);
  cockpitOverlay.addEventListener('click', (e) => { if (e.target === cockpitOverlay) closeCockpit(); });

  function renderCockpitList(instances) {
    const list = document.getElementById('cockpitList');
    const empty = document.getElementById('cockpitEmpty');
    const items = instances || [];
    if (!items.length) { list.innerHTML = ''; empty.hidden = false; return; }
    empty.hidden = true;
    list.innerHTML = items.map(ci => {
      const email = ci.bindEmail ? escIns(ci.bindEmail) : '<span class="is-none">未识别账号</span>';
      const btn = ci.imported
        ? '<span class="cockpit-imported">已导入</span>'
        : '<button class="cockpit-import-btn" data-cid="' + escIns(ci.id) + '" data-email="' + escIns(ci.bindEmail || '') + '">导入</button>';
      return '<div class="cockpit-item">' +
        '<div class="cockpit-item-info"><div class="cockpit-item-name">' + escIns(ci.id) + '</div>' +
        '<div class="cockpit-item-email">' + email + '</div></div>' + btn + '</div>';
    }).join('');
    list.querySelectorAll('.cockpit-import-btn').forEach(b => b.addEventListener('click', () => {
      pendingCockpitId = b.dataset.cid;
      pendingCockpitEmail = b.dataset.email || '';
      cockpitOverlay.hidden = true;
      cockpitFormOverlay.hidden = false;
      const nameInput = document.getElementById('cockpitFormName');
      nameInput.value = pendingCockpitId;
      document.getElementById('cockpitFormEmail').value = pendingCockpitEmail;
      setTimeout(() => nameInput.focus(), 50);
    }));
  }

  function closeCockpitForm() { cockpitFormOverlay.hidden = true; pendingCockpitId = null; }
  document.getElementById('cockpitFormClose').addEventListener('click', closeCockpitForm);
  document.getElementById('cockpitFormCancel').addEventListener('click', closeCockpitForm);
  cockpitFormOverlay.addEventListener('click', (e) => { if (e.target === cockpitFormOverlay) closeCockpitForm(); });
  document.getElementById('cockpitFormSubmit').addEventListener('click', () => {
    if (!pendingCockpitId) return;
    const name = document.getElementById('cockpitFormName').value.trim();
    if (!name) { document.getElementById('cockpitFormName').focus(); return; }
    const bindEmail = document.getElementById('cockpitFormEmail').value.trim() || pendingCockpitEmail;
    vscode.postMessage({ type: 'importCockpitInstance', cockpitId: pendingCockpitId, name, bindEmail });
    closeCockpitForm();
    showInstStatus('正在导入 Cockpit 实例…', 'info');
  });

  // Tab 切换到实例时自动加载（由 tab click 触发）
  document.querySelector('.kite-tab[data-tab="instances"]').addEventListener('click', () => {
    vscode.postMessage({ type: 'listInstances' });
  });

  // 接收消息
  window.addEventListener('message', (event) => {
    const msg = event.data;
    if (msg.type === 'instanceList') {
      renderInstances(msg.instances);
    } else if (msg.type === 'instanceResult') {
      showInstStatus(msg.message, msg.success ? 'success' : 'error');
    } else if (msg.type === 'instanceProgress') {
      showInstStatus(msg.message, 'info');
    } else if (msg.type === 'cockpitList') {
      renderCockpitList(msg.instances);
    } else if (msg.type === 'customIdeExePathSync') {
      const input = document.getElementById('instCustomExePath');
      if (input) {
        input.value = msg.path || '';
        input.title = msg.path || '自动探测(默认)...';
      }
    }
  });
})();

// ===== 用量统计面板逻辑 =====
(function() {
  function renderStats(summary) {
    if (!summary) return;
    const setNum = (id, val) => { const el = document.getElementById(id); if (el) el.textContent = val; };
    setNum('statSwitches', summary.totalSwitches || 0);
    setNum('statRefreshes', summary.totalRefreshes || 0);
    setNum('statAvgUsed', (summary.avgUsedPct || 0) + '%');
    setNum('statAccountCount', summary.accountCount || 0);
    // 抽屉摘要行胶囊徽标（折叠态也可见）
    const pillSwitches = document.getElementById('usagePillSwitches');
    if (pillSwitches) pillSwitches.textContent = '+' + (summary.totalSwitches || 0) + ' 切';
    const pillRefreshes = document.getElementById('usagePillRefreshes');
    if (pillRefreshes) pillRefreshes.textContent = (summary.totalRefreshes || 0) + ' 检';
    const dateEl = document.getElementById('usageStatsDate');
    if (dateEl) dateEl.textContent = summary.date || '';
    const usedPct = Math.min(100, summary.avgUsedPct || 0);
    const bar = document.getElementById('statUsedBar');
    if (bar) bar.style.width = usedPct + '%';
    setNum('statUsedVal', (summary.avgUsedPct || 0) + '%');
    const uptimeEl = document.getElementById('statUptime');
    if (uptimeEl && summary.sessionStartTs) uptimeEl.textContent = formatDuration(Date.now() - summary.sessionStartTs);
  }

  function formatDuration(ms) {
    const s = Math.floor(ms / 1000);
    const h = Math.floor(s / 3600);
    const m = Math.floor((s % 3600) / 60);
    if (h > 0) return h + 'h ' + m + 'm';
    if (m > 0) return m + 'm';
    return s + 's';
  }

  const usageDetails = document.getElementById('usageStatsDetails');
  if (usageDetails) {
    usageDetails.addEventListener('toggle', function() {
      if (this.open) vscode.postMessage({ type: 'getUsageStats' });
    });
    if (usageDetails.open) vscode.postMessage({ type: 'getUsageStats' });
  }

  const openBtn = document.getElementById('openLogPanelBtn');
  if (openBtn) openBtn.addEventListener('click', (e) => { e.stopPropagation(); vscode.postMessage({ type: 'openLogPanel', tab: 'quota' }); });
  const hintBtn = document.getElementById('openLogPanelHintBtn');
  if (hintBtn) hintBtn.addEventListener('click', () => vscode.postMessage({ type: 'openLogPanel', tab: 'quota' }));

  window.addEventListener('message', (event) => {
    const msg = event.data;
    if (msg.type === 'usageStats') renderStats(msg.summary);
  });
})();
</script>
</body>
</html>`;
  }
}
