/**
 * Antigravity Kite 统计中心（Webview Panel 宿主桥接）
 *
 * 汇聚：
 * - 实时上下文构成与生成测速（LiveContextMeter）
 * - 多账号三池实时配额与健康总表（QuotaOrchestrator + statusBar.summarizeAccountPoolQuotas）
 * - 本地离线 Token 账本与 52 周热力图（TokenLedger）
 * - 配额波动轨迹与明细（UsageTracker）
 */
import * as vscode from 'vscode';
import * as crypto from 'crypto';
import * as accountStore from './accountStore';
import { getAccountTimeline } from './accountTimeline';
import { UsageTracker } from './usageTracker';
import { t, localeBundle, getLang } from './i18n';
import { logWarn } from './logger';
import { LiveContextSnapshot } from './liveContextMeter';
import { TokenLedger, TokenLedgerSummary } from './tokenLedger';
import { ModelQuota, UsageSnapshot } from './types';
import { displayTierLabel, formatResetHintIn } from './statusBar';

export function summarizeAccountPoolQuotas(models: ModelQuota[]) {
  const families: { key: 'claude' | 'gemini' | 'argon'; label: string }[] = [
    { key: 'claude', label: 'Claude' },
    { key: 'gemini', label: 'Gemini' },
    { key: 'argon', label: 'Gemini 4' },
  ];
  return families.map((fam) => {
    const five = models.find((m) => m.modelId === fam.key + ':5h');
    const week = models.find((m) => m.modelId === fam.key + ':weekly');
    const pcts = [five?.remainingPercent, week?.remainingPercent].filter((v): v is number => typeof v === 'number');
    return {
      key: fam.key,
      label: fam.label,
      fivePct: typeof five?.remainingPercent === 'number' ? Math.round(five.remainingPercent) : null,
      weeklyPct: typeof week?.remainingPercent === 'number' ? Math.round(week.remainingPercent) : null,
      minPct: pcts.length > 0 ? Math.round(Math.min(...pcts)) : null,
      resetHint: formatResetHintIn(models, fam.key),
    };
  });
}

export interface LogPanelDeps {
  getUsage?: (email: string) => UsageSnapshot | undefined;
  getUsageError?: (email: string) => string | undefined;
  getLiveContext?: () => LiveContextSnapshot | null;
  refreshLiveContext?: () => Promise<LiveContextSnapshot | null>;
  refreshAllPool?: () => Promise<void>;
  refreshOneAccount?: (email: string) => Promise<void>;
  requestSwitch?: (email: string) => Promise<void>;
  openStatusBarSettings?: () => void;
  tokenLedger?: TokenLedger;
}

let _panel: vscode.WebviewPanel | undefined;
let _lastPrivacyCb: ((enabled: boolean) => void) | undefined;
let _lastCtx: vscode.ExtensionContext | undefined;
let _lastTracker: UsageTracker | undefined;
let _deps: LogPanelDeps = {};
let _livePushTimer: NodeJS.Timeout | null = null;
let _ledgerPushToken = 0;
let _pendingOpenNav: { tab?: string; account?: string } | null = null;

export type LogPanelOpenTarget = string | { tab?: string; account?: string };

function normalizeOpenTarget(target?: LogPanelOpenTarget): { tab?: string; account?: string } | null {
  if (!target) return null;
  if (typeof target === 'string') return target ? { tab: target } : null;
  if (target.tab || target.account) return { tab: target.tab, account: target.account };
  return null;
}

export function setLogPanelDeps(deps: LogPanelDeps): void {
  _deps = deps;
}

export function openLogPanel(
  ctx: vscode.ExtensionContext,
  tracker: UsageTracker,
  extensionUri: vscode.Uri,
  target?: LogPanelOpenTarget,
  onPrivacyChanged?: (enabled: boolean) => void,
): void {
  _lastCtx = ctx;
  _lastTracker = tracker;
  if (onPrivacyChanged) _lastPrivacyCb = onPrivacyChanged;
  const nav = normalizeOpenTarget(target);

  if (_panel) {
    _panel.reveal(vscode.ViewColumn.One);
    if (nav) {
      void _panel.webview.postMessage({ type: 'switchTab', tab: nav.tab || 'overview', account: nav.account });
    }
    pushLogPanelData(ctx, tracker);
    void pushTokenLedgerData(false);
    return;
  }

  _pendingOpenNav = nav;
  _panel = vscode.window.createWebviewPanel(
    'antigravityKite.logPanel',
    `Antigravity Kite · ${t('lp.title')}`,
    vscode.ViewColumn.One,
    {
      enableScripts: true,
      retainContextWhenHidden: true,
      localResourceRoots: [vscode.Uri.joinPath(extensionUri, 'resources', 'webview')],
    },
  );

  _panel.iconPath = vscode.Uri.joinPath(extensionUri, 'resources', 'icon.svg');
  _panel.webview.html = renderPanelHtml(_panel.webview, extensionUri);

  _panel.webview.onDidReceiveMessage(async (msg: { type: string; [key: string]: unknown }) => {
    await handleWebviewMessage(ctx, tracker, msg);
  });

  const sub = tracker.addHistoryListener(() => {
    pushLogPanelData(ctx, tracker);
  });

  _panel.onDidDispose(() => {
    sub.dispose();
    _pendingOpenNav = null;
    if (_livePushTimer) {
      clearTimeout(_livePushTimer);
      _livePushTimer = null;
    }
    _panel = undefined;
  });
}

async function handleWebviewMessage(
  ctx: vscode.ExtensionContext,
  tracker: UsageTracker,
  msg: { type: string; [key: string]: unknown },
): Promise<void> {
  if (msg.type === 'webviewReady') {
    pushLogPanelData(ctx, tracker);
    void pushTokenLedgerData(false);
    if (_pendingOpenNav) {
      const nav = _pendingOpenNav;
      _pendingOpenNav = null;
      void _panel?.webview.postMessage({ type: 'switchTab', tab: nav.tab || 'overview', account: nav.account });
    }
    return;
  }

  if (msg.type === 'privacyChanged') {
    const enabled = msg.enabled === true;
    await ctx.globalState.update('privacyMode', enabled);
    _lastPrivacyCb?.(enabled);
    void _panel?.webview.postMessage({ type: 'privacyMode', enabled });
    return;
  }

  if (msg.type === 'openStatusBarSettings') {
    _deps.openStatusBarSettings?.();
    return;
  }

  if (msg.type === 'refresh') {
    try {
      await Promise.all([
        _deps.refreshLiveContext ? _deps.refreshLiveContext() : Promise.resolve(null),
        _deps.refreshAllPool ? _deps.refreshAllPool() : Promise.resolve(),
      ]);
      pushLogPanelData(ctx, tracker);
      void _panel?.webview.postMessage({ type: 'actionResult', action: 'refresh', ok: true });
    } catch (err) {
      void _panel?.webview.postMessage({
        type: 'actionResult',
        action: 'refresh',
        ok: false,
        error: err instanceof Error ? err.message : String(err),
      });
    }
    return;
  }

  if (msg.type === 'refreshLiveOnly') {
    try {
      const snap = await (_deps.refreshLiveContext ? _deps.refreshLiveContext() : Promise.resolve(null));
      void _panel?.webview.postMessage({ type: 'liveContextUpdate', liveContext: snap });
      void _panel?.webview.postMessage({ type: 'actionResult', action: 'refreshLiveOnly', ok: true });
    } catch (err) {
      void _panel?.webview.postMessage({
        type: 'actionResult',
        action: 'refreshLiveOnly',
        ok: false,
        error: err instanceof Error ? err.message : String(err),
      });
    }
    return;
  }

  if (msg.type === 'refreshOneAccount' && typeof msg.email === 'string' && msg.email) {
    try {
      await _deps.refreshOneAccount?.(msg.email);
      pushLogPanelData(ctx, tracker);
      void _panel?.webview.postMessage({ type: 'actionResult', action: 'refreshOneAccount', email: msg.email, ok: true });
    } catch (err) {
      void _panel?.webview.postMessage({
        type: 'actionResult',
        action: 'refreshOneAccount',
        email: msg.email,
        ok: false,
        error: err instanceof Error ? err.message : String(err),
      });
    }
    return;
  }

  if (msg.type === 'switchAccount' && typeof msg.email === 'string' && msg.email) {
    try {
      await _deps.requestSwitch?.(msg.email);
      pushLogPanelData(ctx, tracker);
      void _panel?.webview.postMessage({ type: 'actionResult', action: 'switchAccount', email: msg.email, ok: true });
    } catch (err) {
      void _panel?.webview.postMessage({
        type: 'actionResult',
        action: 'switchAccount',
        email: msg.email,
        ok: false,
        error: err instanceof Error ? err.message : String(err),
      });
    }
    return;
  }

  if (msg.type === 'rescanTokens') {
    await pushTokenLedgerData(true);
    void _panel?.webview.postMessage({ type: 'actionResult', action: 'rescanTokens', ok: true });
    return;
  }

  if (msg.type === 'clearHistory') {
    const email = typeof msg.email === 'string' && msg.email ? msg.email : undefined;
    tracker.clearQuotaHistory(email);
    pushLogPanelData(ctx, tracker);
    void _panel?.webview.postMessage({ type: 'actionResult', action: 'clearHistory', ok: true });
  }
}

export function pushLiveContextToLogPanel(snapshot: LiveContextSnapshot | null): void {
  if (!_panel) return;
  if (_livePushTimer) return;
  _livePushTimer = setTimeout(() => {
    _livePushTimer = null;
    if (!_panel) return;
    void _panel.webview.postMessage({ type: 'liveContextUpdate', liveContext: snapshot });
  }, 450);
}

async function pushTokenLedgerData(forceRescan: boolean): Promise<void> {
  if (!_panel || !_deps.tokenLedger) return;
  const reqId = ++_ledgerPushToken;
  try {
    const ledger: TokenLedgerSummary = await _deps.tokenLedger.getSummary(forceRescan);
    if (!_panel || reqId !== _ledgerPushToken) return;
    void _panel.webview.postMessage({ type: 'tokenLedgerData', ledger });
  } catch (err) {
    logWarn('logPanel.tokenLedger.fail', err instanceof Error ? err.message : String(err));
    void _panel?.webview.postMessage({
      type: 'tokenLedgerError',
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

export function pushLogPanelData(ctx: vscode.ExtensionContext, tracker: UsageTracker): void {
  _lastCtx = ctx;
  _lastTracker = tracker;
  if (!_panel) return;

  try {
    const currentEmail = (ctx.globalState.get<string>('currentEmail', '') || '').toLowerCase();
    const accounts = accountStore.getAll();
    const summary = tracker.getSummary();
    const privacyMode = ctx.globalState.get<boolean>('privacyMode', false);

    let healthyCount = 0;
    let totalCredits = 0;
    let unknownOrIssueCount = 0;
    let disabledCount = 0;
    let quotaPctSum = 0;
    let quotaPctCount = 0;

    const overview = accounts.map((a) => {
      const st = summary.perAccount[a.email];
      const snap = _deps.getUsage?.(a.email) ?? a.usage;
      const usageError = _deps.getUsageError?.(a.email) ?? snap?.loadError;
      const pools = snap?.models ? summarizeAccountPoolQuotas(snap.models) : [];
      const healthStatus = a.health?.status || 'unknown';
      const isDisabled = !!a.disabled;
      const minRemainingPct = typeof snap?.minRemainingPercent === 'number'
        ? Math.round(snap.minRemainingPercent)
        : (st && st.lastCheckTs > 0 ? Math.max(0, 100 - st.usedPct) : null);

      if (isDisabled) {
        disabledCount++;
      } else if (healthStatus === 'banned' || healthStatus === 'auth_invalid') {
        unknownOrIssueCount++;
      } else {
        healthyCount++;
        if (minRemainingPct !== null) {
          quotaPctSum += minRemainingPct;
          quotaPctCount++;
        }
      }
      if (!isDisabled && typeof snap?.availableAICredits === 'number' && Number.isFinite(snap.availableAICredits)) {
        totalCredits += snap.availableAICredits;
      }

      const poolMap: Record<string, { minPct: number | null; fivePct: number | null; weeklyPct: number | null; resetHint: string }> = {};
      for (const p of pools) {
        poolMap[p.key] = {
          minPct: p.minPct,
          fivePct: p.fivePct,
          weeklyPct: p.weeklyPct,
          resetHint: p.resetHint,
        };
      }
      const rawTier = snap?.tierId || st?.tierId || '';

      return {
        email: a.email,
        tags: a.tags || [],
        disabled: isDisabled,
        isCurrent: a.email.toLowerCase() === currentEmail,
        healthStatus,
        healthDetail: a.health?.detail || '',
        tierId: rawTier ? displayTierLabel(String(rawTier)) : '',
        availableAICredits: typeof snap?.availableAICredits === 'number' ? snap.availableAICredits : null,
        minRemainingPct,
        pools: poolMap,
        switchCount: st ? st.switchToCount : 0,
        lastCheckTs: snap?.updatedAt || (st ? st.lastCheckTs : 0),
        usageError: usageError || '',
      };
    });

    const poolMetrics = {
      totalAccounts: accounts.length,
      healthyCount,
      issueCount: unknownOrIssueCount,
      disabledCount,
      totalCredits,
      avgRemainingPct: quotaPctCount > 0 ? Math.round(quotaPctSum / quotaPctCount) : null,
      totalSwitches: summary.totalSwitches,
      totalRefreshes: summary.totalRefreshes,
      date: summary.date,
    };

    const quotaHistory = tracker.getQuotaHistory(undefined, 200);
    const emails = tracker.getHistoryEmails();
    const switchEvents = getAccountTimeline().getSwitchEvents();
    const accountTags: Record<string, string[]> = {};
    for (const a of accounts) {
      if (a.tags?.length) accountTags[a.email] = a.tags;
    }

    void _panel.webview.postMessage({
      type: 'logData',
      privacyMode: privacyMode,
      currentEmail,
      liveContext: _deps.getLiveContext ? _deps.getLiveContext() : null,
      overview,
      poolMetrics,
      quotaHistory,
      switchEvents,
      emails,
      accountTags,
    });
  } catch (e) {
    logWarn('logPanel.overview.fail', e);
  }
}

export function broadcastPrivacyToLogPanel(enabled: boolean): void {
  _panel?.webview.postMessage({ type: 'privacyMode', enabled });
}

export function reloadLogPanelForLocale(extensionUri: vscode.Uri): void {
  if (!_panel) return;
  _panel.title = `Antigravity Kite · ${t('lp.title')}`;
  _panel.webview.html = renderPanelHtml(_panel.webview, extensionUri);
  if (_lastCtx && _lastTracker) {
    pushLogPanelData(_lastCtx, _lastTracker);
  }
  void pushTokenLedgerData(false);
}

export function disposeLogPanel(): void {
  if (_livePushTimer) {
    clearTimeout(_livePushTimer);
    _livePushTimer = null;
  }
  _panel?.dispose();
  _panel = undefined;
}

function renderPanelHtml(webview: vscode.Webview, extensionUri: vscode.Uri): string {
  const cssUri = webview.asWebviewUri(vscode.Uri.joinPath(extensionUri, 'resources', 'webview', 'log-panel.css'));
  const jsUri = webview.asWebviewUri(vscode.Uri.joinPath(extensionUri, 'resources', 'webview', 'log-panel.js'));
  return buildHtml(cssUri, jsUri, webview.cspSource);
}

function buildHtml(cssUri: vscode.Uri, jsUri: vscode.Uri, cspSource: string): string {
  const nonce = crypto.randomBytes(16).toString('hex');
  const htmlLang = getLang() === 'zh' ? 'zh-CN' : 'en';
  const lpI18n = JSON.stringify(localeBundle('lp.'));

  return `<!DOCTYPE html>
<html lang="${htmlLang}">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src ${cspSource} data: blob:; script-src 'nonce-${nonce}'; style-src ${cspSource} 'unsafe-inline'; font-src ${cspSource} data:;">
<link rel="stylesheet" href="${cssUri}">
</head>
<body>
<div class="lp-shell">
  <header class="lp-topbar">
    <div class="lp-brand">
      <div class="lp-brand-mark" aria-hidden="true">
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M18 20V10"/><path d="M12 20V4"/><path d="M6 20v-6"/></svg>
      </div>
      <div class="lp-brand-info">
        <h1 class="lp-title" data-i18n="title">${t('lp.title')}</h1>
        <span class="lp-current-pill" id="lpCurrentAccountPill" hidden></span>
      </div>
    </div>

    <nav class="lp-tabs" role="tablist">
      <button class="lp-tab active" type="button" role="tab" data-tab="overview" data-i18n="tabOverview">${t('lp.tabOverview')}</button>
      <button class="lp-tab" type="button" role="tab" data-tab="tokens" data-i18n="tabTokens">${t('lp.tabTokens')}</button>
      <button class="lp-tab" type="button" role="tab" data-tab="quota" data-i18n="tabQuota">${t('lp.tabQuota')}</button>
    </nav>

    <div class="lp-actions">
      <button class="lp-btn" id="lpPrivacyBtn" type="button" data-i18n-title="privacyTitle" title="${t('lp.privacyTitle')}">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/></svg>
        <span data-i18n="privacy">${t('lp.privacy')}</span>
      </button>
      <button class="lp-btn" id="lpSettingsBtn" type="button" data-i18n-title="statusBarSettings" title="${t('lp.statusBarSettings')}">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/></svg>
        <span data-i18n="barSettings">${t('lp.barSettings')}</span>
      </button>
      <button class="lp-btn lp-btn-primary" id="lpRefreshBtn" type="button">
        <svg class="lp-refresh-ico" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="23 4 23 10 17 10"/><path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10"/></svg>
        <span id="lpRefreshText" data-i18n="refresh">${t('lp.refresh')}</span>
      </button>
    </div>
  </header>

  <main class="lp-main">
    <!-- Tab 1: 实时与号池 -->
    <section class="lp-pane active" id="lpOverviewPane" role="tabpanel">
      <div class="lp-hero-grid">
        <div class="lp-card lp-live-card" id="lpLiveCard">
          <div class="lp-card-head">
            <div class="lp-card-title-group">
              <h2 class="lp-card-title" data-i18n="liveSession">${t('lp.liveSession')}</h2>
              <span class="lp-badge" id="lpLiveStatusBadge" data-i18n="liveIdle">${t('lp.liveIdle')}</span>
            </div>
            <button class="lp-btn lp-btn-sm" id="lpLiveSyncBtn" type="button" data-i18n="syncNow">${t('lp.syncNow')}</button>
          </div>
          <div class="lp-live-body" id="lpLiveBody"></div>
        </div>

        <div class="lp-card lp-pool-card" id="lpPoolCard">
          <div class="lp-card-head">
            <h2 class="lp-card-title" data-i18n="poolCommand">${t('lp.poolCommand')}</h2>
            <span class="lp-meta-text" id="lpPoolDateBadge"></span>
          </div>
          <div class="lp-pool-kpis" id="lpPoolKpis"></div>
          <div class="lp-best-picks" id="lpBestPicks"></div>
        </div>
      </div>

      <div class="lp-card lp-matrix-card">
        <div class="lp-card-head lp-card-head-wrap">
          <div class="lp-card-title-group">
            <h2 class="lp-card-title" data-i18n="accountQuotas">${t('lp.accountQuotas')}</h2>
            <span class="lp-count-pill" id="lpOverviewCount"></span>
          </div>
          <div class="lp-filter-group">
            <input type="text" class="lp-input" id="lpOverviewSearch" placeholder="${t('lp.searchPh')}" data-i18n-ph="searchPh">
            <select class="lp-select" id="lpOverviewSort">
              <option value="default" data-i18n="sortDefault">${t('lp.sortDefault')}</option>
              <option value="claude" data-i18n="sortClaude">${t('lp.sortClaude')}</option>
              <option value="gemini" data-i18n="sortGemini">${t('lp.sortGemini')}</option>
              <option value="argon" data-i18n="sortArgon">${t('lp.sortArgon')}</option>
              <option value="credits" data-i18n="sortCredits">${t('lp.sortCredits')}</option>
            </select>
          </div>
        </div>
        <div class="lp-table-wrap">
          <table class="lp-table">
            <thead>
              <tr>
                <th data-i18n="colAccount">${t('lp.colAccount')}</th>
                <th data-i18n="colHealth">${t('lp.colHealth')}</th>
                <th>Claude</th>
                <th>Gemini</th>
                <th>Gemini 4</th>
                <th id="lpColCreditsTh" data-i18n="colCredits">${t('lp.colCredits')}</th>
                <th data-i18n="colSwitch">${t('lp.colSwitch')}</th>
                <th data-i18n="colAction">${t('lp.colAction')}</th>
              </tr>
            </thead>
            <tbody id="lpOverviewBody"></tbody>
          </table>
        </div>
      </div>
    </section>

    <!-- Tab 2: Token 账本与热力图（金字塔：结论与筛选 → 归因热图 → 项目与父子会话下钻） -->
    <section class="lp-pane" id="lpTokensPane" role="tabpanel" hidden>
      <div class="lp-tokens-toolbar">
        <div class="lp-filter-group">
          <div class="lp-seg-group" id="lpSourceFilter">
            <button class="lp-seg-btn active" type="button" data-source="all" data-i18n="srcAll">${t('lp.srcAll')}</button>
            <button class="lp-seg-btn" type="button" data-source="desktop" data-i18n="srcDesktop">${t('lp.srcDesktop')}</button>
            <button class="lp-seg-btn" type="button" data-source="cli">CLI</button>
          </div>
          <select class="lp-select" id="lpProjectFilter"><option value="all" data-i18n="projAll">${t('lp.projAll')}</option></select>
          <select class="lp-select" id="lpAccountFilter"><option value="all" data-i18n="acctAll">${t('lp.acctAll')}</option></select>
        </div>
        <div class="lp-filter-group">
          <div class="lp-seg-group" id="lpTokenModeSeg">
            <button class="lp-seg-btn active" type="button" data-mode="weighted" data-i18n="modeWeighted">${t('lp.modeWeighted')}</button>
            <button class="lp-seg-btn" type="button" data-mode="all" data-i18n="modeAllTokens">${t('lp.modeAllTokens')}</button>
            <button class="lp-seg-btn" type="button" data-mode="net" data-i18n="modeNetTokens">${t('lp.modeNetTokens')}</button>
            <button class="lp-seg-btn" type="button" data-mode="usd" data-i18n="modeUsd">${t('lp.modeUsd')}</button>
          </div>
          <button class="lp-btn lp-btn-sm" id="lpRescanBtn" type="button" data-i18n="rescanLogs">${t('lp.rescanLogs')}</button>
        </div>
      </div>
      <div class="lp-meta-text" id="lpLedgerMeta"></div>
      <div class="lp-active-filters" id="lpActiveFilterChips" hidden></div>

      <div class="lp-kpi-grid" id="lpTokenKpis"></div>

      <div class="lp-card lp-heatmap-card">
        <div class="lp-card-head lp-card-head-wrap">
          <div class="lp-card-title-group">
            <h2 class="lp-card-title" data-i18n="activityHeatmap">${t('lp.activityHeatmap')}</h2>
            <span class="lp-meta-text" id="lpSelectedDayBanner" hidden></span>
            <button class="lp-btn lp-btn-sm" id="lpClearDayBtn" type="button" hidden data-i18n="clearDayFilter">${t('lp.clearDayFilter')}</button>
          </div>
          <div class="lp-heat-legend">
            <span class="lp-meta-text" data-i18n="heatLess">${t('lp.heatLess')}</span>
            <span class="lp-heat-swatch lvl-0"></span>
            <span class="lp-heat-swatch lvl-1"></span>
            <span class="lp-heat-swatch lvl-2"></span>
            <span class="lp-heat-swatch lvl-3"></span>
            <span class="lp-heat-swatch lvl-4"></span>
            <span class="lp-meta-text" data-i18n="heatMore">${t('lp.heatMore')}</span>
          </div>
        </div>
        <div class="lp-heatmap-scroll">
          <div class="lp-heatmap-wrap" id="lpHeatmapWrap"></div>
        </div>
      </div>

      <div class="lp-two-col">
        <div class="lp-card">
          <div class="lp-card-head lp-card-head-wrap">
            <h2 class="lp-card-title" data-i18n="scenarioSplit">${t('lp.scenarioSplit')}</h2>
          </div>
          <div class="lp-scenario-list" id="lpScenarioWrap"></div>
          <div class="lp-chart-box lp-chart-sub" id="lpDailyBarWrap"></div>
        </div>

        <div class="lp-card">
          <div class="lp-card-head lp-card-head-wrap">
            <h2 class="lp-card-title" data-i18n="modelSpeedRank">${t('lp.modelSpeedRank')}</h2>
            <button class="lp-btn lp-btn-sm" id="lpToggleUntaggedBtn" type="button" data-i18n="toggleUntagged">${t('lp.toggleUntagged')}</button>
          </div>
          <div class="lp-model-list" id="lpModelRankWrap"></div>
        </div>
      </div>

      <div class="lp-card lp-session-card" id="lpSessionExplorer">
        <div class="lp-card-head lp-card-head-wrap">
          <div class="lp-card-title-group">
            <h2 class="lp-card-title" data-i18n="sessionExplorer">${t('lp.sessionExplorer')}</h2>
            <span class="lp-count-pill" id="lpSessionCount"></span>
          </div>
          <div class="lp-filter-group">
            <select class="lp-select" id="lpSessionSort">
              <option value="recent" data-i18n="sessSortRecent">${t('lp.sessSortRecent')}</option>
              <option value="heavy" data-i18n="sessSortHeavy">${t('lp.sessSortHeavy')}</option>
            </select>
            <button class="lp-btn lp-btn-sm" id="lpLowCacheBtn" type="button" data-i18n="lowCacheOnly">${t('lp.lowCacheOnly')}</button>
            <input type="text" class="lp-input" id="lpSessionSearch" placeholder="${t('lp.sessionSearchPh')}" data-i18n-ph="sessionSearchPh">
          </div>
        </div>
        <div class="lp-session-list" id="lpSessionListWrap"></div>
      </div>
    </section>

    <!-- Tab 3: 配额轨迹与明细 -->
    <section class="lp-pane" id="lpQuotaPane" role="tabpanel" hidden>
      <div class="lp-card lp-quota-chart-card">
        <div class="lp-card-head lp-card-head-wrap">
          <div class="lp-card-title-group">
            <h2 class="lp-card-title" data-i18n="quotaTrendTitle">${t('lp.quotaTrendTitle')}</h2>
            <div class="lp-seg-group" id="lpTimeFilter">
              <button class="lp-seg-btn" type="button" data-range="1h" data-i18n="range1h">${t('lp.range1h')}</button>
              <button class="lp-seg-btn active" type="button" data-range="24h" data-i18n="range24h">${t('lp.range24h')}</button>
              <button class="lp-seg-btn" type="button" data-range="7d" data-i18n="range7d">${t('lp.range7d')}</button>
              <button class="lp-seg-btn" type="button" data-range="30d" data-i18n="range30d">${t('lp.range30d')}</button>
              <button class="lp-seg-btn" type="button" data-range="all" data-i18n="rangeAll">${t('lp.rangeAll')}</button>
            </div>
            <div class="lp-seg-group" id="lpQuotaPoolSeg">
              <button class="lp-seg-btn active" type="button" data-pool="min" data-i18n="poolMin">${t('lp.poolMin')}</button>
              <button class="lp-seg-btn" type="button" data-pool="claude">Claude</button>
              <button class="lp-seg-btn" type="button" data-pool="gemini">Gemini</button>
              <button class="lp-seg-btn" type="button" data-pool="argon">Gemini 4</button>
            </div>
          </div>
          <div class="lp-filter-group">
            <select class="lp-select" id="lpDirectionFilter">
              <option value="all" data-i18n="dirAll">${t('lp.dirAll')}</option>
              <option value="down" data-i18n="dirDown">${t('lp.dirDown')}</option>
              <option value="up" data-i18n="dirUp">${t('lp.dirUp')}</option>
            </select>
            <input type="text" class="lp-input" id="lpSearchInput" placeholder="${t('lp.searchPh')}" data-i18n-ph="searchPh">
            <button class="lp-btn lp-btn-danger-outline" id="lpClearHistoryBtn" type="button" data-i18n="clearHistory">${t('lp.clearHistory')}</button>
          </div>
        </div>

        <div class="lp-series-legend" id="lpSeriesLegend"></div>
        <div class="lp-svg-stage" id="lpQuotaChartBox"></div>
      </div>

      <div class="lp-card">
        <div class="lp-card-head">
          <div class="lp-card-title-group">
            <h2 class="lp-card-title" data-i18n="details">${t('lp.details')}</h2>
            <span class="lp-count-pill" id="lpQuotaCount"></span>
          </div>
        </div>
        <div class="lp-table-wrap">
          <table class="lp-table">
            <thead>
              <tr>
                <th data-i18n="colTime">${t('lp.colTime')}</th>
                <th data-i18n="colAccount">${t('lp.colAccount')}</th>
                <th data-i18n="colRemaining">${t('lp.colRemaining')}</th>
                <th data-i18n="colChange">${t('lp.colChange')}</th>
                <th data-i18n="colPools">${t('lp.colPools')}</th>
                <th data-i18n="colPlan">${t('lp.colPlan')}</th>
              </tr>
            </thead>
            <tbody id="lpQuotaBody"></tbody>
          </table>
        </div>
        <div class="lp-pagination">
          <span class="lp-meta-text" id="lpQuotaPageInfo"></span>
          <button class="lp-btn lp-btn-sm" id="lpQuotaPrev" type="button" data-i18n="prevPage">${t('lp.prevPage')}</button>
          <button class="lp-btn lp-btn-sm" id="lpQuotaNext" type="button" data-i18n="nextPage">${t('lp.nextPage')}</button>
        </div>
      </div>
    </section>
  </main>

  <div class="lp-floating-tip" id="lpFloatingTip" hidden></div>
  <div class="lp-toast" id="lpToast" hidden></div>
</div>
<script nonce="${nonce}">window.__KITE_I18N__ = ${lpI18n};</script>
<script nonce="${nonce}" src="${jsUri}"></script>
</body>
</html>`;
}
