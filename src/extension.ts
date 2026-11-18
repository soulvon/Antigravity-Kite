import * as vscode from 'vscode';
import * as accountStore from './accountStore';
import { startDeclarationSuppressor, stopDeclarationSuppressor } from './declarationSuppressor';
import { logInfo } from './logger';
import * as logPanel from './logPanelProvider';
import { QuotaOrchestrator } from './quotaOrchestrator';
import { isSupportedRemoteSession } from './remoteAuthSync';
import { SidebarProvider } from './sidebarProvider';
import { StatusBarManager } from './statusBar';
import { disposeSwitchOrchestrator, switchAccount, syncStartupAuthToRemote } from './switchOrchestrator';
import { registerUiPresenter } from './uiChannel';
import { autoCheckOnStartup, checkForUpdates, showUpdateNotesOnStartup } from './updater';
import { UsageTracker } from './usageTracker';

export { SidebarProvider } from './sidebarProvider';

let sidebarProvider: SidebarProvider | undefined;
let statusBarManager: StatusBarManager | undefined;
let quotaOrchestrator: QuotaOrchestrator | undefined;
let usageTracker: UsageTracker | undefined;

/** v1.1.28 一次性样式迁移：将旧默认 smart/labeled 迁至信息全开的 full */
function migrateLegacyStatusBarStyle(context: vscode.ExtensionContext): void {
  const migrationKey = 'styleMigratedFull.v2';
  if (context.globalState.get<boolean>(migrationKey)) return;

  const styleCfg = vscode.workspace.getConfiguration('antigravityKite');
  const curStyle = styleCfg.get<string>('statusBar.style');
  if (curStyle === 'smart' || curStyle === 'labeled') {
    void styleCfg.update('statusBar.style', 'full', vscode.ConfigurationTarget.Global);
    logInfo('migrate.statusBarStyle', { from: curStyle, to: 'full' });
  }
  void context.globalState.update(migrationKey, true);
}

export function activate(context: vscode.ExtensionContext): void {
  logInfo('activate.start', {
    version: context.extension.packageJSON.version,
    extensionId: context.extension.id,
    extensionPath: context.extensionPath,
    globalStorage: context.globalStorageUri.fsPath,
  });

  accountStore.init(context);
  logInfo('activate.init-done', {
    accounts: accountStore.count(),
    storageDir: accountStore.getStorageDirPath(),
  });

  const tracker = new UsageTracker(context);
  usageTracker = tracker;

  const orchestrator = new QuotaOrchestrator(context, tracker, {
    onUsageUpdated: (email, snapshot) => {
      statusBarManager?.updateUsage(email, snapshot);
      sidebarProvider?.postMessage({ type: 'usage', email, snapshot });
    },
    onUsageError: (email, error) => {
      sidebarProvider?.postMessage({ type: 'usage', email, error });
      statusBarManager?.update();
    },
    onHealthUpdated: (email, health) => {
      sidebarProvider?.postMessage({ type: 'health', email, health });
      statusBarManager?.update();
    },
    onAccountsRefreshNeeded: () => {
      sidebarProvider?.refresh();
    },
    onTrackerChanged: () => {
      logPanel.pushLogPanelData(context, tracker);
    },
  });
  quotaOrchestrator = orchestrator;

  const broadcastPrivacyAcrossHosts = (enabled: boolean, source: 'sidebar' | 'logPanel') => {
    statusBarManager?.update();
    if (source === 'sidebar') {
      logPanel.broadcastPrivacyToLogPanel(enabled);
    } else {
      sidebarProvider?.broadcastPrivacy(enabled);
    }
  };

  const sidebar = new SidebarProvider(context.extensionUri, context, {
    requestSwitch: (email) =>
      switchAccount(context, email, {
        usageTracker: tracker,
        refreshAfterSwitch: (switchedEmail) => {
          void orchestrator.refreshOneAccountUsage(switchedEmail);
        },
        pushAccounts: () => sidebar.refresh(),
        postMessage: (msg) => sidebar.postMessage(msg),
        onLogPanelUpdate: () => logPanel.pushLogPanelData(context, tracker),
      }),
    refreshOneUsage: (email) => orchestrator.refreshOneAccountUsage(email).then(() => undefined),
    refreshAllWithProgress: (onProgress) => orchestrator.refreshAllWithProgress(onProgress),
    isRefreshInFlight: () => orchestrator.isRefreshInFlight(),
    getUsageSnapshot: (email) => orchestrator.getUsage(email),
    getUsageError: (email) => orchestrator.getUsageError(email),
    probeOneHealth: (email) => orchestrator.probeOneHealth(email),
    onQuotaRefreshMinutesChanged: () => orchestrator.applyRefreshInterval(),
    onPrivacyChanged: (enabled) => broadcastPrivacyAcrossHosts(enabled, 'sidebar'),
  });
  sidebarProvider = sidebar;
  registerUiPresenter(sidebar);

  migrateLegacyStatusBarStyle(context);

  const statusBar = new StatusBarManager(
    context,
    () => sidebar.refresh(),
    (email) => sidebar.requestSwitch(email),
    {
      getUsage: (email) => orchestrator.getUsage(email),
      refreshCurrent: (email) => orchestrator.refreshOneAccountUsage(email).then(() => undefined),
      refreshAll: () => orchestrator.refreshAllInteractive().then(() => undefined),
      recheckHealth: () => orchestrator.probeAllHealth(),
      openSettings: () => sidebar.openSettingsUi(),
      getPrivacy: () => context.globalState.get<boolean>('privacyMode', false),
      getUsageError: (email) => orchestrator.getUsageError(email),
    },
  );
  statusBarManager = statusBar;

  startDeclarationSuppressor();

  if (isSupportedRemoteSession()) {
    const remoteSyncTimer = setTimeout(() => {
      void syncStartupAuthToRemote(context);
    }, 800);
    context.subscriptions.push({ dispose: () => clearTimeout(remoteSyncTimer) });
  }

  // StatusBarManager 内部注册 openSidebar 与 quickSwitchAccount；此处装配其余 5 个命令（共 7 个）
  context.subscriptions.push(
    sidebar,
    statusBar,
    orchestrator.scheduleStartupTasks(),
    autoCheckOnStartup(),
    showUpdateNotesOnStartup(context),
    vscode.window.registerWebviewViewProvider(SidebarProvider.viewType, sidebar),
    accountStore.onChange(() => {
      sidebar.refresh();
      statusBar.update();
      logPanel.pushLogPanelData(context, tracker);
    }),
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration('antigravityKite.locale')) {
        statusBar.update();
        logPanel.reloadLogPanelForLocale(context.extensionUri);
      }
      if (e.affectsConfiguration('antigravityKite.quotaRefreshMinutes')) {
        orchestrator.applyRefreshInterval();
      }
      sidebar.onExternalConfigurationChanged(e);
    }),
    vscode.commands.registerCommand('antigravityKite.checkForUpdates', async () => {
      await checkForUpdates(false);
    }),
    vscode.commands.registerCommand('antigravityKite.openLogPanel', (tab?: string) => {
      logPanel.openLogPanel(context, tracker, context.extensionUri, tab, (enabled) => {
        broadcastPrivacyAcrossHosts(enabled, 'logPanel');
      });
    }),
    vscode.commands.registerCommand('antigravityKite.refreshQuota', async () => {
      await orchestrator.refreshAllInteractive();
    }),
    vscode.commands.registerCommand('antigravityKite.healthRecheck', async () => {
      await orchestrator.probeAllHealth();
    }),
    vscode.commands.registerCommand('antigravityKite.openSettings', () => {
      sidebar.openSettingsUi();
    }),
  );
}

export function deactivate(): void {
  stopDeclarationSuppressor();
  disposeSwitchOrchestrator();
  logPanel.disposeLogPanel();
  quotaOrchestrator?.dispose();
  sidebarProvider?.dispose();
  accountStore.dispose();
  usageTracker?.dispose();
  statusBarManager?.dispose();
}
