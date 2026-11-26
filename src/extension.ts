import * as vscode from 'vscode';
import * as accountStore from './accountStore';
import { getAccountTimeline } from './accountTimeline';
import { startDeclarationSuppressor, stopDeclarationSuppressor } from './declarationSuppressor';
import { logInfo } from './logger';
import * as logPanel from './logPanelProvider';
import { QuotaOrchestrator } from './quotaOrchestrator';
import { LiveContextMeter } from './liveContextMeter';
import { isSupportedRemoteSession } from './remoteAuthSync';
import { SidebarProvider } from './sidebarProvider';
import { StatusBarManager } from './statusBar';
import { disposeSwitchOrchestrator, switchAccount, syncStartupAuthToRemote } from './switchOrchestrator';
import { TokenLedger } from './tokenLedger';
import { registerUiPresenter } from './uiChannel';
import { autoCheckOnStartup, checkForUpdates, showUpdateNotesOnStartup } from './updater';
import { UsageTracker } from './usageTracker';

export { SidebarProvider } from './sidebarProvider';

let sidebarProvider: SidebarProvider | undefined;
let statusBarManager: StatusBarManager | undefined;
let quotaOrchestrator: QuotaOrchestrator | undefined;
let usageTracker: UsageTracker | undefined;
let tokenLedger: TokenLedger | undefined;

/** 一次性样式迁移：将旧默认迁至默认最佳视图 pulse（之后尊重用户手动选择） */
function migrateLegacyStatusBarStyle(context: vscode.ExtensionContext): void {
  const pulseMigKey = 'styleMigratedPulse.v3';
  if (context.globalState.get<boolean>(pulseMigKey)) return;

  const styleCfg = vscode.workspace.getConfiguration('antigravityKite');
  const explicit = styleCfg.inspect<string>('statusBar.style')?.globalValue;
  if (!explicit || explicit === 'full' || explicit === 'smart') {
    void styleCfg.update('statusBar.style', 'pulse', vscode.ConfigurationTarget.Global);
    logInfo('migrate.statusBarStyle', { from: explicit || 'unset', to: 'pulse' });
  }
  void context.globalState.update(pulseMigKey, true);
}

export function activate(context: vscode.ExtensionContext): void {
  logInfo('activate.start', {
    version: context.extension.packageJSON.version,
    extensionId: context.extension.id,
    extensionPath: context.extensionPath,
    globalStorage: context.globalStorageUri.fsPath,
  });

  accountStore.init(context);
  const bootEmail = context.globalState.get<string>('currentEmail') || '';
  if (bootEmail) getAccountTimeline().recordActiveAccount(bootEmail);
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
      sidebarProvider?.refreshStatsSummary(false);
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

  const ledger = new TokenLedger();
  tokenLedger = ledger;

  const sidebar = new SidebarProvider(context.extensionUri, context, {
    requestSwitch: (email) =>
      switchAccount(context, email, {
        usageTracker: tracker,
        refreshAfterSwitch: (switchedEmail) => {
          void orchestrator.refreshOneAccountUsage(switchedEmail);
        },
        pushAccounts: () => sidebar.refresh(),
        postMessage: (msg) => sidebar.postMessage(msg),
        onLogPanelUpdate: () => {
          ledger.invalidateSummaryCache();
          sidebar.refreshStatsSummary(false);
          logPanel.pushLogPanelData(context, tracker);
        },
      }),
    refreshOneUsage: (email) => orchestrator.refreshOneAccountUsage(email).then(() => undefined),
    refreshAllWithProgress: (onProgress) => orchestrator.refreshAllWithProgress(onProgress),
    isRefreshInFlight: () => orchestrator.isRefreshInFlight(),
    getUsageSnapshot: (email) => orchestrator.getUsage(email),
    getUsageError: (email) => orchestrator.getUsageError(email),
    probeOneHealth: (email) => orchestrator.probeOneHealth(email),
    onQuotaRefreshMinutesChanged: () => orchestrator.applyRefreshInterval(),
    onPrivacyChanged: (enabled) => broadcastPrivacyAcrossHosts(enabled, 'sidebar'),
    getTrackerSummary: () => tracker.getSummary(),
    getLedgerSummary: (force) => ledger.getSummary(force),
  });
  sidebarProvider = sidebar;
  registerUiPresenter(sidebar);

  migrateLegacyStatusBarStyle(context);

  const liveContextMeter = new LiveContextMeter();
  logPanel.setLogPanelDeps({
    getUsage: (email) => orchestrator.getUsage(email),
    getUsageError: (email) => orchestrator.getUsageError(email),
    getLiveContext: () => liveContextMeter.getSnapshot(),
    refreshLiveContext: () => liveContextMeter.refreshNow(),
    refreshAllPool: () => orchestrator.refreshAllInteractive().then(() => undefined),
    refreshOneAccount: (email) => orchestrator.refreshOneAccountUsage(email).then(() => undefined),
    requestSwitch: (email) => sidebar.requestSwitch(email),
    openStatusBarSettings: () => {
      void vscode.commands.executeCommand('antigravityKite.openSidebar');
      sidebar.openSettingsUi('statusBar');
    },
    tokenLedger: ledger,
  });

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
      openAppearanceSettings: () => sidebar.openSettingsUi('appearance'),
      getPrivacy: () => context.globalState.get<boolean>('privacyMode', false),
      getUsageError: (email) => orchestrator.getUsageError(email),
      getLiveContext: () => liveContextMeter.getSnapshot(),
      refreshLiveContext: () => liveContextMeter.refreshNow(),
      setLiveContextEnabled: (enabled) => liveContextMeter.setEnabled(enabled),
      openLogPanel: () => void vscode.commands.executeCommand('antigravityKite.openLogPanel'),
    },
  );
  statusBarManager = statusBar;
  statusBar.updateLiveContext();

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
    liveContextMeter,
    liveContextMeter.onDidChange(() => {
      const snap = liveContextMeter.getSnapshot();
      if (ledger.recordSpeedSample(snap)) {
        sidebar.refreshStatsSummary(true);
      }
      statusBar.updateLiveContext();
      logPanel.pushLiveContextToLogPanel(snap);
    }),
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
      if (e.affectsConfiguration('antigravityKite.quotaRefreshMinutes') || e.affectsConfiguration('antigravityKite.quotaRefreshScope')) {
        orchestrator.applyRefreshInterval();
      }
      sidebar.onExternalConfigurationChanged(e);
    }),
    vscode.commands.registerCommand('antigravityKite.checkForUpdates', async () => {
      await checkForUpdates(false);
    }),
    vscode.commands.registerCommand('antigravityKite.openLogPanel', (target?: logPanel.LogPanelOpenTarget) => {
      logPanel.openLogPanel(context, tracker, context.extensionUri, target, (enabled) => {
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
    vscode.commands.registerCommand('antigravityKite.openAppearanceSettings', () => {
      sidebar.openSettingsUi('appearance');
    }),
  );
}

export function deactivate(): void {
  stopDeclarationSuppressor();
  disposeSwitchOrchestrator();
  logPanel.disposeLogPanel();
  tokenLedger?.dispose();
  quotaOrchestrator?.dispose();
  sidebarProvider?.dispose();
  accountStore.dispose();
  usageTracker?.dispose();
  statusBarManager?.dispose();
}
