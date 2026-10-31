import * as vscode from 'vscode';
import { UsageTracker } from './usageTracker';
import * as accountStore from './accountStore';
import { t, localeBundle, getLang } from './i18n';

let _panel: vscode.WebviewPanel | undefined;
let _listenerDisposable: { dispose(): void } | undefined;

export function openLogPanel(
  ctx: vscode.ExtensionContext,
  tracker: UsageTracker,
  extensionUri: vscode.Uri,
  tab?: string
): void {
  if (_panel) {
    _panel.reveal(vscode.ViewColumn.One);
    if (tab) _panel.webview.postMessage({ type: 'switchTab', tab });
    pushAllData(ctx, tracker, _panel.webview);
    return;
  }

  _panel = vscode.window.createWebviewPanel(
    'antigravityKite.logPanel',
    t('lp.title'),
    vscode.ViewColumn.One,
    {
      enableScripts: true,
      retainContextWhenHidden: true,
      localResourceRoots: [vscode.Uri.joinPath(extensionUri, 'resources')],
    }
  );

  const webview = _panel.webview;
  const ext = vscode.extensions.getExtension('antigravity-kite');
  const ver = ext?.packageJSON?.version || '0.0.0';
  const cssUri = webview.asWebviewUri(vscode.Uri.joinPath(extensionUri, 'resources', 'webview', 'log-panel.css'));
  const jsUri = webview.asWebviewUri(vscode.Uri.joinPath(extensionUri, 'resources', 'webview', 'log-panel.js'));

  webview.html = buildHtml(cssUri.toString(), jsUri.toString(), ver, tab || 'quota');

  setTimeout(() => pushAllData(ctx, tracker, webview), 300);

  webview.onDidReceiveMessage(async (msg: any) => {
    if (msg.type === 'refresh') {
      pushAllData(ctx, tracker, webview);
      webview.postMessage({ type: 'refreshDone' });
    } else if (msg.type === 'clearQuotaHistory') {
      tracker.clearQuotaHistory(msg.email);
      pushAllData(ctx, tracker, webview);
    }
  });

  // 实时推送配额变动（200ms 防抖）
  let _pushDebounceTimer: NodeJS.Timeout | null = null;
  _listenerDisposable = tracker.addHistoryListener(() => {
    if (_pushDebounceTimer) clearTimeout(_pushDebounceTimer);
    _pushDebounceTimer = setTimeout(() => {
      _pushDebounceTimer = null;
      if (_panel) pushAllData(ctx, tracker, _panel.webview);
    }, 200);
  });

  _panel.onDidDispose(() => {
    _listenerDisposable?.dispose();
    _listenerDisposable = undefined;
    if (_pushDebounceTimer) { clearTimeout(_pushDebounceTimer); _pushDebounceTimer = null; }
    _panel = undefined;
  });
}

/** 推送全量数据给面板 */
function pushAllData(ctx: vscode.ExtensionContext, tracker: UsageTracker, webview: vscode.Webview) {
  const currentEmail = ctx.globalState.get<string>('currentEmail') || '';
  const quotaEntries = tracker.getQuotaHistory(undefined, 500);
  const quotaEmails = tracker.getHistoryEmails();
  const summary = tracker.getSummary();

  // 账号总览
  let accountOverview: any[] = [];
  try {
    const accounts = accountStore.getAll();
    accountOverview = accounts.map(a => {
      const stats = summary.perAccount?.[a.email];
      return {
        email: a.email,
        name: a.name || '',
        tags: a.tags || [],
        disabled: !!a.disabled,
        usedPct: stats?.usedPct ?? null,
        lastCheckTs: stats?.lastCheckTs || 0,
        isCurrent: a.email === currentEmail,
      };
    });
  } catch {}

  webview.postMessage({
    type: 'allData',
    currentEmail,
    quotaEntries,
    quotaEmails,
    summary,
    accountOverview,
  });
}

/** 若面板已打开，追加推送 */
export function pushLogPanelData(ctx: vscode.ExtensionContext, tracker: UsageTracker) {
  if (_panel) pushAllData(ctx, tracker, _panel.webview);
}

function buildHtml(cssUri: string, jsUri: string, version: string, initialTab: string): string {
  return `<!DOCTYPE html>
<html lang="${getLang() === 'zh' ? 'zh-CN' : 'en'}"><head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<link rel="stylesheet" href="${cssUri}">
</head>
<body data-initial-tab="${initialTab}">
<div class="lp-app">

  <header class="lp-header">
    <div class="lp-header-left">
      <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="22 12 18 12 15 21 9 3 6 12 2 12"/></svg>
      <span class="lp-title" data-i18n="title">${t('lp.title')}</span>
      <span class="lp-version">v${version}</span>
    </div>
    <div class="lp-header-right">
      <button class="lp-btn" id="lpPrivacy" data-i18n-title="privacyTitle" title="隐私模式：隐藏邮箱等敏感信息">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/></svg>
        <span data-i18n="privacy">${t('lp.privacy')}</span>
      </button>
      <button class="lp-btn" id="lpRefresh">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="23 4 23 10 17 10"/><path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10"/></svg>
        <span data-i18n="refresh">${t('lp.refresh')}</span>
      </button>
    </div>
  </header>

  <nav class="lp-tabs">
    <button class="lp-tab active" data-tab="overview">
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="3" width="7" height="7"/><rect x="14" y="3" width="7" height="7"/><rect x="14" y="14" width="7" height="7"/><rect x="3" y="14" width="7" height="7"/></svg>
      <span data-i18n="tabOverview">${t('lp.tabOverview')}</span>
    </button>
    <button class="lp-tab" data-tab="quota">
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="22 12 18 12 15 21 9 3 6 12 2 12"/></svg>
      <span data-i18n="tabQuota">${t('lp.tabQuota')}</span>
    </button>
  </nav>

  <!-- 账号总览 -->
  <div class="lp-content" id="lpOverview">
    <div class="lp-stats-row" id="lpStatsRow">
      <div class="lp-stat-card"><div class="lp-stat-num" id="lpStatAccounts">0</div><div class="lp-stat-label" data-i18n="totalAccounts">${t('lp.totalAccounts')}</div></div>
      <div class="lp-stat-card"><div class="lp-stat-num" id="lpStatActive">0</div><div class="lp-stat-label" data-i18n="active">${t('lp.active')}</div></div>
      <div class="lp-stat-card"><div class="lp-stat-num" id="lpStatDisabled">0</div><div class="lp-stat-label" data-i18n="disabled">${t('lp.disabled')}</div></div>
      <div class="lp-stat-card"><div class="lp-stat-num" id="lpStatHigh">0</div><div class="lp-stat-label" data-i18n="full">${t('lp.full')}</div></div>
      <div class="lp-stat-card"><div class="lp-stat-num" id="lpStatLow">0</div><div class="lp-stat-label" data-i18n="low">${t('lp.low')}</div></div>
      <div class="lp-stat-card"><div class="lp-stat-num" id="lpStatAvgUsed">—</div><div class="lp-stat-label" data-i18n="avgUsed">${t('lp.avgUsed')}</div></div>
    </div>
    <div class="lp-section-header">
      <span data-i18n="accountQuotas">${t('lp.accountQuotas')}</span>
      <span class="lp-count" id="lpAccountCount"></span>
    </div>
    <div class="lp-table-wrap">
      <table class="lp-table">
        <thead><tr>
          <th style="width:30px"></th>
          <th data-i18n="colAccount">${t('lp.colAccount')}</th>
          <th data-i18n="colTags">${t('lp.colTags')}</th>
          <th style="width:90px" data-i18n="colUsed">${t('lp.colUsed')}</th>
          <th style="width:90px" data-i18n="colStatus">${t('lp.colStatus')}</th>
        </tr></thead>
        <tbody id="lpAccountBody"></tbody>
      </table>
    </div>
  </div>

  <!-- 配额历史 -->
  <div class="lp-content" id="lpQuota" hidden>
    <div class="lp-quota-filter-bar">
      <input type="text" class="lp-search-input" id="lpEmailSearch" placeholder="搜索账号..." data-i18n-ph="searchPh">
      <div class="lp-quick-btns">
        <button class="lp-quick-btn" id="lpBtnCurrent" data-i18n="current">${t('lp.current')}</button>
        <button class="lp-quick-btn" id="lpBtnRecent" data-i18n="recent">${t('lp.recent')}</button>
      </div>
      <div class="lp-time-group">
        <button class="lp-time-btn" data-range="1h" data-i18n="range1h">${t('lp.range1h')}</button>
        <button class="lp-time-btn active" data-range="24h" data-i18n="range24h">${t('lp.range24h')}</button>
        <button class="lp-time-btn" data-range="7d" data-i18n="range7d">${t('lp.range7d')}</button>
        <button class="lp-time-btn" data-range="30d" data-i18n="range30d">${t('lp.range30d')}</button>
        <button class="lp-time-btn" data-range="all" data-i18n="rangeAll">${t('lp.rangeAll')}</button>
      </div>
    </div>
    <div class="lp-tag-chips" id="lpTagChips"></div>
    <div class="lp-chart-wrap">
      <div class="lp-chart-yaxis">
        <span>100%</span><span>80%</span><span>60%</span><span>40%</span><span>20%</span><span>0%</span>
      </div>
      <svg id="lpChart" class="lp-chart" preserveAspectRatio="none"></svg>
      <div class="lp-chart-legend">
        <span class="lp-legend"><span class="lp-legend-dot" style="background:#5b9aff"></span><span data-i18n="legendQuota">${t('lp.legendQuota')}</span></span>
        <span class="lp-legend" data-i18n-title="warnTitle" title="剩余 30% 警戒线"><span class="lp-legend-line lp-line-warn"></span><span data-i18n="legendWarn">${t('lp.legendWarn')}</span></span>
        <span class="lp-legend" data-i18n-title="dangerTitle" title="剩余 10% 危险线"><span class="lp-legend-line lp-line-danger"></span><span data-i18n="legendDanger">${t('lp.legendDanger')}</span></span>
      </div>
    </div>
    <div class="lp-section-header">
      <span data-i18n="details">${t('lp.details')}</span>
      <span class="lp-count" id="lpQuotaCount"></span>
    </div>
    <div class="lp-table-wrap">
      <table class="lp-table">
        <thead><tr>
          <th data-i18n="colTime">${t('lp.colTime')}</th>
          <th data-i18n="colAccount">${t('lp.colAccount')}</th>
          <th data-i18n="colRemaining">${t('lp.colRemaining')}</th>
          <th data-i18n="colChange">${t('lp.colChange')}</th>
          <th data-i18n="colPlan">${t('lp.colPlan')}</th>
        </tr></thead>
        <tbody id="lpQuotaBody"></tbody>
      </table>
    </div>
    <div class="lp-pagination" id="lpQuotaPagination"></div>
  </div>

  <div class="lp-toast" id="lpToast" hidden></div>
</div>
<script>var vscode = acquireVsCodeApi(); window.LP_L = ${JSON.stringify({ __lang: getLang(), ...localeBundle('lp.') })};</script>
<script src="${jsUri}"></script>
</body></html>`;
}
