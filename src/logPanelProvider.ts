import * as vscode from 'vscode';
import { UsageTracker } from './usageTracker';
import * as accountStore from './accountStore';

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
    '统计面板',
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
<html lang="zh-CN"><head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<link rel="stylesheet" href="${cssUri}">
</head>
<body data-initial-tab="${initialTab}">
<div class="lp-app">

  <header class="lp-header">
    <div class="lp-header-left">
      <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="22 12 18 12 15 21 9 3 6 12 2 12"/></svg>
      <span class="lp-title">统计面板</span>
      <span class="lp-version">v${version}</span>
    </div>
    <div class="lp-header-right">
      <button class="lp-btn" id="lpPrivacy" title="隐私模式：隐藏邮箱等敏感信息">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/></svg>
        隐私
      </button>
      <button class="lp-btn" id="lpRefresh">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="23 4 23 10 17 10"/><path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10"/></svg>
        刷新
      </button>
    </div>
  </header>

  <nav class="lp-tabs">
    <button class="lp-tab active" data-tab="overview">
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="3" width="7" height="7"/><rect x="14" y="3" width="7" height="7"/><rect x="14" y="14" width="7" height="7"/><rect x="3" y="14" width="7" height="7"/></svg>
      账号总览
    </button>
    <button class="lp-tab" data-tab="quota">
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="22 12 18 12 15 21 9 3 6 12 2 12"/></svg>
      配额历史
    </button>
  </nav>

  <!-- 账号总览 -->
  <div class="lp-content" id="lpOverview">
    <div class="lp-stats-row" id="lpStatsRow">
      <div class="lp-stat-card"><div class="lp-stat-num" id="lpStatAccounts">0</div><div class="lp-stat-label">总账号</div></div>
      <div class="lp-stat-card"><div class="lp-stat-num" id="lpStatActive">0</div><div class="lp-stat-label">活跃</div></div>
      <div class="lp-stat-card"><div class="lp-stat-num" id="lpStatDisabled">0</div><div class="lp-stat-label">禁用</div></div>
      <div class="lp-stat-card"><div class="lp-stat-num" id="lpStatHigh">0</div><div class="lp-stat-label">满额度</div></div>
      <div class="lp-stat-card"><div class="lp-stat-num" id="lpStatLow">0</div><div class="lp-stat-label">低额度</div></div>
      <div class="lp-stat-card"><div class="lp-stat-num" id="lpStatAvgUsed">—</div><div class="lp-stat-label">平均用量</div></div>
    </div>
    <div class="lp-section-header">
      <span>账号配额一览</span>
      <span class="lp-count" id="lpAccountCount"></span>
    </div>
    <div class="lp-table-wrap">
      <table class="lp-table">
        <thead><tr>
          <th style="width:30px"></th>
          <th>账号</th>
          <th>标签</th>
          <th style="width:90px">已用配额</th>
          <th style="width:90px">状态</th>
        </tr></thead>
        <tbody id="lpAccountBody"></tbody>
      </table>
    </div>
  </div>

  <!-- 配额历史 -->
  <div class="lp-content" id="lpQuota" hidden>
    <div class="lp-quota-filter-bar">
      <input type="text" class="lp-search-input" id="lpEmailSearch" placeholder="搜索账号...">
      <div class="lp-quick-btns">
        <button class="lp-quick-btn" id="lpBtnCurrent">当前</button>
        <button class="lp-quick-btn" id="lpBtnRecent">最近</button>
      </div>
      <div class="lp-time-group">
        <button class="lp-time-btn" data-range="1h">1小时</button>
        <button class="lp-time-btn active" data-range="24h">24h</button>
        <button class="lp-time-btn" data-range="7d">7天</button>
        <button class="lp-time-btn" data-range="30d">30天</button>
        <button class="lp-time-btn" data-range="all">全部</button>
      </div>
    </div>
    <div class="lp-tag-chips" id="lpTagChips"></div>
    <div class="lp-chart-wrap">
      <div class="lp-chart-yaxis">
        <span>100%</span><span>80%</span><span>60%</span><span>40%</span><span>20%</span><span>0%</span>
      </div>
      <svg id="lpChart" class="lp-chart" preserveAspectRatio="none"></svg>
      <div class="lp-chart-legend">
        <span class="lp-legend"><span class="lp-legend-dot" style="background:#5b9aff"></span>配额</span>
        <span class="lp-legend" title="剩余 30% 警戒线"><span class="lp-legend-line lp-line-warn"></span>30% 警戒</span>
        <span class="lp-legend" title="剩余 10% 危险线"><span class="lp-legend-line lp-line-danger"></span>10% 危险</span>
      </div>
    </div>
    <div class="lp-section-header">
      <span>明细</span>
      <span class="lp-count" id="lpQuotaCount"></span>
    </div>
    <div class="lp-table-wrap">
      <table class="lp-table">
        <thead><tr>
          <th>记录时间</th>
          <th>账号</th>
          <th>剩余</th>
          <th>变化</th>
          <th>套餐</th>
        </tr></thead>
        <tbody id="lpQuotaBody"></tbody>
      </table>
    </div>
    <div class="lp-pagination" id="lpQuotaPagination"></div>
  </div>

  <div class="lp-toast" id="lpToast" hidden></div>
</div>
<script>var vscode = acquireVsCodeApi();</script>
<script src="${jsUri}"></script>
</body></html>`;
}
