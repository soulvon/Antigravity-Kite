(function () {
  'use strict';

  const vscode = acquireVsCodeApi();
  const I18N = window.__KITE_I18N__ || {};

  function l(key, ...args) {
    let s = I18N[key] !== undefined ? I18N[key] : key;
    args.forEach((a, i) => {
      s = s.split('{' + i + '}').join(String(a));
    });
    return s;
  }

  let privacyMode = false;
  let activeTab = 'overview';
  let currentEmail = '';
  let liveContext = null;
  let overviewData = [];
  let poolMetrics = null;
  let quotaHistory = [];
  let switchEvents = [];
  let accountTags = {};
  let ledgerData = null;
  let ledgerError = '';

  // 视图交互状态
  let tokenDisplayMode = 'weighted'; // 'weighted' | 'all' | 'net' | 'usd'
  let tokenSourceFilter = 'all'; // 'all' | 'desktop' | 'cli'
  let tokenProjectFilter = 'all';
  let tokenAccountFilter = 'all';
  let lowCacheOnly = false;
  let sessionSearch = '';
  let sessionSort = 'recent'; // 'recent' | 'heavy'
  const expandedSessionIds = new Set();
  let showUntaggedModels = false;
  let selectedHeatDate = '';
  let quotaRange = '24h';
  let quotaPool = 'min'; // 'min' | 'claude' | 'gemini' | 'argon'
  let quotaDirection = 'all';
  let quotaPage = 1;
  const QUOTA_PAGE_SIZE = 20;
  const enabledSeriesEmails = new Set();
  let seriesInitialized = false;
  let clearConfirmPending = false;
  let clearConfirmTimer = null;

  // 防闪烁指纹与超时句柄
  const fingerprints = { live: '', pool: '', matrix: '', ledger: '', quotaChart: '', quotaTable: '' };
  const busyActions = new Map();
  let toastTimer = null;

  function maskEmail(em) {
    if (!privacyMode || !em) return em || '';
    const at = em.indexOf('@');
    if (at <= 0) return em.slice(0, 2) + '***';
    const name = em.slice(0, at);
    const maskedName = name.length <= 2 ? name[0] + '***' : name.slice(0, 2) + '***' + name.slice(-1);
    return maskedName + '@***';
  }

  function esc(str) {
    return String(str ?? '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  function fmtCompact(n) {
    const num = Number(n);
    if (!Number.isFinite(num) || num < 0) return '0';
    if (num >= 1_000_000_000) return (num / 1_000_000_000).toFixed(2).replace(/\.?0+$/, '') + 'B';
    if (num >= 1_000_000) return (num / 1_000_000).toFixed(1).replace(/\.0$/, '') + 'M';
    if (num >= 1_000) return (num / 1_000).toFixed(1).replace(/\.0$/, '') + 'K';
    return String(Math.round(num));
  }

  function fmtUsd(n) {
    const num = Number(n);
    if (!Number.isFinite(num) || num <= 0) return '$0.00';
    if (num < 0.01) return '<$0.01';
    if (num >= 100) return '$' + num.toFixed(1);
    return '$' + num.toFixed(2);
  }

  function formatTierLabel(tierId) {
    if (!tierId) return '';
    const s = String(tierId);
    const low = s.toLowerCase();
    const mult = /(\d+x)/i.exec(s);
    if (low.includes('ultra') || low.includes('helium')) return 'Ultra' + (mult ? ' ' + mult[1] : '');
    if (low.includes('plus')) return 'Plus';
    if (low.includes('free') || low.includes('starter')) return 'Free';
    if (low.includes('pro') || low.includes('premium') || low.includes('advanced')) return 'Pro';
    if (low.includes('trial')) return 'Trial';
    if (low.includes('enterprise') || low.includes('standard') || low.includes('business') || low.startsWith('gcp_') || low.includes('vertex')) return 'Enterprise';
    if (low.includes('team')) return 'Team';
    return s;
  }

  function fmtShortDateTime(ms) {
    const n = Number(ms);
    if (!Number.isFinite(n) || n <= 0) return '';
    const d = new Date(n);
    const mm = String(d.getMonth() + 1).padStart(2, '0');
    const dd = String(d.getDate()).padStart(2, '0');
    const hh = String(d.getHours()).padStart(2, '0');
    const mi = String(d.getMinutes()).padStart(2, '0');
    return `${mm}-${dd} ${hh}:${mi}`;
  }

  function prettifyModelName(raw) {
    const s = String(raw || '').trim();
    if (!s || s === 'untagged') return s;
    if (/[A-Z]/.test(s) && !s.startsWith('MODEL_')) return s;
    return s
      .replace(/^models\//i, '')
      .replace(/^MODEL_(GOOGLE_|ANTHROPIC_|VERTEX_)?/i, '')
      .split(/[-_]+/)
      .filter(Boolean)
      .map((w) => (w === 'gpt' ? 'GPT' : w === 'oss' ? 'OSS' : w.charAt(0).toUpperCase() + w.slice(1)))
      .join(' ');
  }

  function getEntryPoolVal(entry, pool) {
    if (pool === 'min') return entry.remaining;
    if (entry.pools && typeof entry.pools[pool] === 'number') return entry.pools[pool];
    return entry.remaining;
  }

  function formatPoolLabel(pool) {
    if (pool === 'claude') return 'Claude';
    if (pool === 'gemini') return 'Gemini';
    if (pool === 'argon') return 'Gemini 4';
    return l('poolMin');
  }

  function showToast(msg, durationMs = 2600) {
    const el = document.getElementById('lpToast');
    if (!el) return;
    el.textContent = msg;
    el.hidden = false;
    if (toastTimer) clearTimeout(toastTimer);
    toastTimer = setTimeout(() => {
      el.hidden = true;
    }, durationMs);
  }

  function showFloatingTip(x, y, title, rows) {
    const tip = document.getElementById('lpFloatingTip');
    if (!tip) return;
    tip.replaceChildren();
    const tEl = document.createElement('div');
    tEl.className = 'lp-tip-title';
    tEl.textContent = title;
    tip.appendChild(tEl);
    for (const r of rows) {
      const rEl = document.createElement('div');
      rEl.className = 'lp-tip-row';
      rEl.textContent = r;
      tip.appendChild(rEl);
    }
    tip.hidden = false;
    const rect = tip.getBoundingClientRect();
    const left = Math.min(window.innerWidth - rect.width - 12, Math.max(12, x + 12));
    const top = y - rect.height - 12 > 8 ? y - rect.height - 12 : Math.min(window.innerHeight - rect.height - 12, y + 16);
    tip.style.left = left + 'px';
    tip.style.top = top + 'px';
  }

  function hideFloatingTip() {
    const tip = document.getElementById('lpFloatingTip');
    if (tip) tip.hidden = true;
  }

  function startBusyAction(actionKey, btn, busyLabel) {
    stopBusyAction(actionKey);
    const origText = btn ? btn.textContent : '';
    if (btn) {
      btn.disabled = true;
      btn.classList.add('lp-is-busy');
      if (busyLabel) btn.textContent = busyLabel;
    }
    const timer = setTimeout(() => {
      stopBusyAction(actionKey);
      showToast(l('actionTimeout'), 5000);
    }, 30_000);
    busyActions.set(actionKey, { btn, origText, timer });
  }

  function stopBusyAction(actionKey) {
    const entry = busyActions.get(actionKey);
    if (!entry) return;
    clearTimeout(entry.timer);
    if (entry.btn) {
      entry.btn.disabled = false;
      entry.btn.classList.remove('lp-is-busy');
      if (entry.origText) entry.btn.textContent = entry.origText;
    }
    busyActions.delete(actionKey);
  }

  function toneByPct(pct) {
    if (pct === null || pct === undefined) return 'dim';
    if (pct >= 50) return 'ok';
    if (pct >= 20) return 'warn';
    return 'danger';
  }

  function safeRender(targetId, fn) {
    try {
      fn();
    } catch (err) {
      const el = document.getElementById(targetId);
      if (el) {
        el.innerHTML = `<div class="lp-error-box">${esc(l('renderErr', err && err.message ? err.message : String(err)))}</div>`;
      }
    }
  }

  function updateCurrentPill() {
    const pill = document.getElementById('lpCurrentAccountPill');
    if (!pill) return;
    if (currentEmail) {
      pill.textContent = maskEmail(currentEmail);
      pill.hidden = false;
    } else {
      pill.hidden = true;
    }
  }

  function updatePrivacyButton() {
    const btn = document.getElementById('lpPrivacyBtn');
    if (btn) btn.classList.toggle('lp-btn-active', privacyMode);
  }

  function switchTab(tabName) {
    if (!['overview', 'tokens', 'quota'].includes(tabName)) tabName = 'overview';
    activeTab = tabName;
    document.querySelectorAll('.lp-tab').forEach((el) => {
      el.classList.toggle('active', el.getAttribute('data-tab') === tabName);
    });
    const panes = {
      overview: document.getElementById('lpOverviewPane'),
      tokens: document.getElementById('lpTokensPane'),
      quota: document.getElementById('lpQuotaPane'),
    };
    Object.entries(panes).forEach(([k, p]) => {
      if (p) p.hidden = k !== tabName;
    });
    hideFloatingTip();
    renderVisibleTab();
  }

  function renderVisibleTab(force = false) {
    if (activeTab === 'overview') {
      safeRender('lpLiveBody', () => renderLiveSection(force));
      safeRender('lpPoolKpis', () => renderPoolSummarySection(force));
      safeRender('lpOverviewBody', () => renderPoolMatrixSection(force));
    } else if (activeTab === 'tokens') {
      safeRender('lpTokenKpis', () => renderTokensTab(force));
    } else if (activeTab === 'quota') {
      safeRender('lpQuotaChartBox', () => renderQuotaChart(force));
      safeRender('lpQuotaBody', () => renderQuotaTable(force));
    }
  }

  // ── Tab 1: 实时对话上下文与测速 ──
  function renderLiveSection(force = false) {
    const body = document.getElementById('lpLiveBody');
    const badge = document.getElementById('lpLiveStatusBadge');
    if (!body || !badge) return;

    const fp = JSON.stringify({ liveContext: liveContext ? { ...liveContext, updatedAt: 0 } : null });
    if (!force && fp === fingerprints.live) return;
    fingerprints.live = fp;

    if (!liveContext) {
      badge.className = 'lp-badge';
      badge.textContent = l('liveIdle');
      body.innerHTML = `<div class="lp-empty-box"><div>${esc(l('liveNoSession'))}</div><div class="lp-meta-text">${esc(l('liveNoSessionSub'))}</div></div>`;
      return;
    }

    badge.className = liveContext.isRunning ? 'lp-badge ok' : 'lp-badge';
    badge.textContent = liveContext.isRunning ? l('liveRunning') : l('liveIdle');

    const pct = liveContext.percent !== null && liveContext.percent !== undefined ? Math.min(100, Math.max(0, liveContext.percent)) : 0;
    const rawPctText = liveContext.percent !== null && liveContext.percent !== undefined ? `${liveContext.percent.toFixed(1).replace(/\.0$/, '')}%` : '--';
    const ringColor = pct >= 90 ? 'var(--lp-danger)' : pct >= 70 ? 'var(--lp-warn)' : 'var(--lp-ok)';
    const r = 62;
    const circ = 2 * Math.PI * r;
    const offset = circ * (1 - pct / 100);

    const usedText = liveContext.usedTokens !== null ? fmtCompact(liveContext.usedTokens) : '--';
    const budgetText = liveContext.budgetTokens !== null ? fmtCompact(liveContext.budgetTokens) : '--';
    const estBadge = liveContext.isEstimated ? `<span class="lp-badge warn">${esc(l('liveEstimated'))}</span>` : '';

    const cCache = Math.max(0, Number(liveContext.cacheReadTokens || 0));
    const cInput = Math.max(0, Number(liveContext.inputTokens || 0));
    const cOutput = Math.max(0, Number(liveContext.outputTokens || 0));
    const cThink = Math.max(0, Number(liveContext.thinkingTokens || 0));
    const cSum = cCache + cInput + cOutput + cThink;

    const segHtml = cSum > 0
      ? `
        <div class="lp-stacked-wrap">
          <div class="lp-stacked-bar">
            ${cCache > 0 ? `<div class="lp-seg-cache" style="width:${(cCache / cSum) * 100}%"></div>` : ''}
            ${cInput > 0 ? `<div class="lp-seg-input" style="width:${(cInput / cSum) * 100}%"></div>` : ''}
            ${cOutput > 0 ? `<div class="lp-seg-output" style="width:${(cOutput / cSum) * 100}%"></div>` : ''}
            ${cThink > 0 ? `<div class="lp-seg-think" style="width:${(cThink / cSum) * 100}%"></div>` : ''}
          </div>
          <div class="lp-legend-row">
            <span class="lp-legend-item"><span class="lp-dot lp-seg-cache"></span>Cache ${fmtCompact(cCache)}</span>
            <span class="lp-legend-item"><span class="lp-dot lp-seg-input"></span>Input ${fmtCompact(cInput)}</span>
            <span class="lp-legend-item"><span class="lp-dot lp-seg-output"></span>Output ${fmtCompact(cOutput)}</span>
            ${cThink > 0 ? `<span class="lp-legend-item"><span class="lp-dot lp-seg-think"></span>Thinking ${fmtCompact(cThink)}</span>` : ''}
          </div>
        </div>`
      : '';

    const streamVal = liveContext.streamingTps !== null ? `${liveContext.streamingTps} tok/s` : '--';
    const overallVal = liveContext.tps !== null ? `${liveContext.tps} tok/s` : '--';
    const ttftVal = liveContext.ttftSec !== null ? `${liveContext.ttftSec}s` : '--';
    const durVal = liveContext.durationSec !== null ? `${liveContext.durationSec}s` : '--';

    const compactRem = liveContext.remainingToCompactTokens;
    const compactBadge = typeof compactRem === 'number'
      ? (compactRem > 0
        ? `<span class="lp-badge ${compactRem < 40000 ? 'warn' : ''}">${esc(l('compactRemainBadge', fmtCompact(compactRem)))}</span>`
        : `<span class="lp-badge danger">${esc(l('compactDueBadge'))}</span>`)
      : '';
    const subBadge = (liveContext.activeSubagents || 0) > 0
      ? `<span class="lp-badge info">${esc(l('subagentsBadge', liveContext.activeSubagents))}</span>`
      : '';
    const turnHtml = (liveContext.turnStepCount || 0) > 1
      ? `<div class="lp-live-turn-bar">${esc(l('turnCompareFmt', liveContext.turnStepCount, fmtCompact(liveContext.turnThinkingTokens || 0), fmtCompact(liveContext.turnResponseTokens || 0), liveContext.turnDurationSec || 0))}</div>`
      : '';
    const bdGroups = Array.isArray(liveContext.breakdownGroups)
      ? liveContext.breakdownGroups.filter((g) => g && Number(g.tokens) > 0).slice(0, 4)
      : [];
    const bdHtml = bdGroups.length > 0
      ? `<div class="lp-live-breakdown"><span class="lp-meta-text">${esc(l('liveBreakdownTitle'))}:</span>${bdGroups.map((g) => `<span class="lp-badge">${esc(g.label)} ${esc(fmtCompact(g.tokens))}</span>`).join('')}</div>`
      : '';

    body.innerHTML = `
      <div class="lp-live-session-meta">
        <span class="lp-live-conv-name" title="${esc(liveContext.title || liveContext.cascadeId)}">${esc(liveContext.title || liveContext.cascadeId.slice(0, 8))}</span>
        <div class="lp-filter-group">
          ${estBadge}
          ${compactBadge}
          ${subBadge}
          ${liveContext.modelName ? `<span class="lp-live-model-chip">${esc(prettifyModelName(liveContext.modelName))}</span>` : ''}
        </div>
      </div>
      <div class="lp-live-split">
        <div class="lp-ring-box" title="${esc(l('liveUsedBudget', usedText, budgetText))}">
          <svg class="lp-ring-svg" width="152" height="152" viewBox="0 0 152 152">
            <circle class="lp-ring-track" cx="76" cy="76" r="${r}"></circle>
            <circle class="lp-ring-fill" cx="76" cy="76" r="${r}" stroke="${ringColor}" stroke-dasharray="${circ.toFixed(2)}" stroke-dashoffset="${offset.toFixed(2)}"></circle>
          </svg>
          <div class="lp-ring-center">
            <div class="lp-ring-pct">${esc(rawPctText)}</div>
            <div class="lp-ring-sub">${esc(usedText)}/${esc(budgetText)}</div>
          </div>
        </div>
        <div class="lp-speed-grid">
          <div class="lp-metric-tile">
            <div class="lp-metric-label">${esc(l('liveStreamingSpeed'))}</div>
            <div class="lp-metric-val lp-c-ok">${esc(streamVal)}</div>
          </div>
          <div class="lp-metric-tile">
            <div class="lp-metric-label">${esc(l('liveOverallSpeed'))}</div>
            <div class="lp-metric-val">${esc(overallVal)}</div>
          </div>
          <div class="lp-metric-tile">
            <div class="lp-metric-label">${esc(l('liveTtft'))}</div>
            <div class="lp-metric-val">${esc(ttftVal)}</div>
          </div>
          <div class="lp-metric-tile">
            <div class="lp-metric-label">${esc(l('liveDuration'))}</div>
            <div class="lp-metric-val">${esc(durVal)}</div>
          </div>
        </div>
      </div>
      ${turnHtml}
      ${bdHtml}
      ${segHtml}
    `;
  }

  // ── Tab 1: 号池摘要与最优补给推荐 ──
  function renderPoolSummarySection(force = false) {
    const kpisEl = document.getElementById('lpPoolKpis');
    const bestEl = document.getElementById('lpBestPicks');
    const dateEl = document.getElementById('lpPoolDateBadge');
    if (!kpisEl || !bestEl) return;

    const fp = JSON.stringify({ poolMetrics, overviewData, privacyMode });
    if (!force && fp === fingerprints.pool) return;
    fingerprints.pool = fp;

    const pm = poolMetrics || { totalAccounts: 0, healthyCount: 0, totalCredits: 0, avgRemainingPct: null, totalSwitches: 0, totalRefreshes: 0, date: '' };
    if (dateEl) dateEl.textContent = pm.date || '';

    const hasCredits = (pm.totalCredits || 0) > 0;
    const secondLabel = hasCredits ? l('poolTotalCredits') : l('poolAvgQuota');
    const secondVal = hasCredits
      ? fmtCompact(pm.totalCredits)
      : (pm.avgRemainingPct !== null && pm.avgRemainingPct !== undefined ? `${pm.avgRemainingPct}%` : '--');
    const secondTone = hasCredits ? '' : (' lp-c-' + toneByPct(pm.avgRemainingPct));

    kpisEl.innerHTML = `
      <div class="lp-metric-tile">
        <div class="lp-metric-label">${esc(l('poolHealthyCount'))}</div>
        <div class="lp-metric-val lp-c-ok">${pm.healthyCount} / ${pm.totalAccounts}</div>
      </div>
      <div class="lp-metric-tile">
        <div class="lp-metric-label">${esc(secondLabel)}</div>
        <div class="lp-metric-val${secondTone}">${esc(secondVal)}</div>
      </div>
      <div class="lp-metric-tile">
        <div class="lp-metric-label">${esc(l('poolSwitchesToday'))}</div>
        <div class="lp-metric-val">${pm.totalSwitches}</div>
      </div>
      <div class="lp-metric-tile">
        <div class="lp-metric-label">${esc(l('poolRefreshesToday'))}</div>
        <div class="lp-metric-val">${pm.totalRefreshes}</div>
      </div>
    `;

    const pools = [
      { key: 'claude', label: 'Claude' },
      { key: 'gemini', label: 'Gemini' },
      { key: 'argon', label: 'Gemini 4' },
    ];
    const usable = overviewData.filter((a) => !a.disabled && a.healthStatus !== 'banned' && a.healthStatus !== 'auth_invalid');

    const rowsHtml = pools.map((p) => {
      let best = null;
      let bestPct = -1;
      for (const a of usable) {
        const val = a.pools && a.pools[p.key] && a.pools[p.key].minPct;
        if (typeof val === 'number' && val > bestPct) {
          bestPct = val;
          best = a;
        }
      }
      if (!best) {
        return `<div class="lp-best-row"><span class="lp-best-pool">${esc(p.label)}</span><span class="lp-meta-text">${esc(l('poolNoPick'))}</span></div>`;
      }
      const cls = 'lp-c-' + toneByPct(bestPct);
      const actionBtn = best.isCurrent
        ? `<span class="lp-badge info">${esc(l('currentTag'))}</span>`
        : `<button class="lp-btn lp-btn-sm lp-switch-trigger" type="button" data-email="${esc(best.email)}">${esc(l('switchBtn'))}</button>`;
      return `
        <div class="lp-best-row">
          <div class="lp-best-info">
            <span class="lp-best-pool">${esc(p.label)}</span>
            <span class="lp-best-email">${esc(maskEmail(best.email))}</span>
          </div>
          <div class="lp-best-right">
            <span class="lp-best-pct ${cls}">${bestPct}%</span>
            ${actionBtn}
          </div>
        </div>
      `;
    }).join('');

    bestEl.innerHTML = `<div class="lp-meta-text">${esc(l('poolBestTitle'))}</div>${rowsHtml}`;
  }

  // ── Tab 1: 号池配额矩阵表 ──
  function renderPoolMatrixSection(force = false) {
    const tbody = document.getElementById('lpOverviewBody');
    const countEl = document.getElementById('lpOverviewCount');
    const creditsTh = document.getElementById('lpColCreditsTh');
    if (!tbody) return;

    const hasAnyCredits = overviewData.some((a) => typeof a.availableAICredits === 'number' && a.availableAICredits > 0);
    if (creditsTh) creditsTh.hidden = !hasAnyCredits;

    const search = (document.getElementById('lpOverviewSearch')?.value || '').trim().toLowerCase();
    const sortBy = document.getElementById('lpOverviewSort')?.value || 'default';

    const fp = JSON.stringify({ overviewData, search, sortBy, privacyMode, hasAnyCredits });
    if (!force && fp === fingerprints.matrix) return;
    fingerprints.matrix = fp;

    let rows = overviewData.filter((a) => {
      if (!search) return true;
      return a.email.toLowerCase().includes(search) || maskEmail(a.email).toLowerCase().includes(search) || (a.tags || []).some((t) => t.toLowerCase().includes(search));
    });

    if (sortBy !== 'default') {
      rows = [...rows].sort((a, b) => {
        if (sortBy === 'credits') return (b.availableAICredits ?? -1) - (a.availableAICredits ?? -1);
        const av = a.pools && a.pools[sortBy] && a.pools[sortBy].minPct !== null ? a.pools[sortBy].minPct : -1;
        const bv = b.pools && b.pools[sortBy] && b.pools[sortBy].minPct !== null ? b.pools[sortBy].minPct : -1;
        return bv - av;
      });
    }

    if (countEl) countEl.textContent = l('countUnit', rows.length);

    if (rows.length === 0) {
      tbody.innerHTML = `<tr><td colspan="${hasAnyCredits ? 8 : 7}"><div class="lp-empty-box">${esc(l('noAccounts'))}</div></td></tr>`;
      return;
    }

    const renderPoolCell = (pool) => {
      if (!pool || pool.minPct === null) return '<span class="lp-c-dim">--</span>';
      const tone = toneByPct(pool.minPct);
      const subParts = [];
      if (pool.fivePct !== null && pool.weeklyPct !== null && pool.fivePct !== pool.weeklyPct) {
        subParts.push(`5h:${pool.fivePct}% / W:${pool.weeklyPct}%`);
      }
      if (pool.resetHint) subParts.push(pool.resetHint);
      return `
        <div class="lp-pool-cell">
          <div class="lp-pool-top">
            <div class="lp-mini-bar"><div class="lp-mini-fill ${tone}" style="width:${pool.minPct}%"></div></div>
            <span class="lp-c-${tone}">${pool.minPct}%</span>
          </div>
          ${subParts.length ? `<div class="lp-meta-text">${esc(subParts.join(' · '))}</div>` : ''}
        </div>
      `;
    };

    const renderHealth = (row) => {
      if (row.disabled) return `<span class="lp-badge">${esc(l('disabledTag'))}</span>`;
      const map = {
        ok: ['ok', l('healthOk')],
        banned: ['danger', l('healthBanned')],
        auth_invalid: ['danger', l('healthAuthInvalid')],
        unreachable: ['warn', l('healthUnreachable')],
      };
      const pair = map[row.healthStatus] || ['', l('healthUnknown')];
      return `<span class="lp-badge ${pair[0]}" title="${esc(row.healthDetail || row.usageError || '')}">${esc(pair[1])}</span>`;
    };

    tbody.innerHTML = rows.map((row) => {
      const prettyTier = formatTierLabel(row.tierId);
      const tierBadge = prettyTier ? `<span class="lp-badge">${esc(prettyTier)}</span>` : '';
      const curBadge = row.isCurrent ? `<span class="lp-badge info">${esc(l('currentTag'))}</span>` : '';
      const switchBtn = row.isCurrent || row.disabled
        ? ''
        : `<button class="lp-btn lp-btn-sm lp-switch-trigger" type="button" data-email="${esc(row.email)}">${esc(l('switchBtn'))}</button>`;
      const refreshBtn = `<button class="lp-btn lp-btn-sm lp-refresh-one-trigger" type="button" data-email="${esc(row.email)}">${esc(l('refreshOneBtn'))}</button>`;
      const creditsTd = hasAnyCredits
        ? `<td>${typeof row.availableAICredits === 'number' && row.availableAICredits > 0 ? esc(l('creditsUnit', fmtCompact(row.availableAICredits))) : '<span class="lp-c-dim">--</span>'}</td>`
        : '';

      return `
        <tr class="${row.isCurrent ? 'lp-row-current' : ''}">
          <td>
            <div class="lp-acct-cell">
              <span class="lp-acct-email" title="${esc(maskEmail(row.email))}">${esc(maskEmail(row.email))}</span>
              ${tierBadge}
              ${curBadge}
            </div>
          </td>
          <td>${renderHealth(row)}</td>
          <td>${renderPoolCell(row.pools && row.pools.claude)}</td>
          <td>${renderPoolCell(row.pools && row.pools.gemini)}</td>
          <td>${renderPoolCell(row.pools && row.pools.argon)}</td>
          ${creditsTd}
          <td>${row.switchCount || 0}</td>
          <td><div class="lp-row-actions">${switchBtn}${refreshBtn}</div></td>
        </tr>
      `;
    }).join('');
  }

  // ── Tab 2: Token 账本与热力图（金字塔：结论与筛选 → 归因热图 → 项目与父子会话下钻）──
  function pickTokenSum(bucket) {
    if (!bucket) return 0;
    if (tokenDisplayMode === 'net') return (bucket.input || 0) + (bucket.output || 0);
    if (tokenDisplayMode === 'weighted') return bucket.weighted ?? Math.round((bucket.input || 0) + 0.1 * (bucket.cacheRead || 0) + 6 * (bucket.output || 0));
    if (tokenDisplayMode === 'usd') return bucket.costUsd || 0;
    return bucket.total ?? ((bucket.input || 0) + (bucket.cacheRead || 0) + (bucket.output || 0));
  }

  function fmtModeVal(bucket) {
    const v = pickTokenSum(bucket);
    return tokenDisplayMode === 'usd' ? fmtUsd(v) : fmtCompact(v);
  }

  function shiftDateStr(dateStr, delta) {
    const [y, m, d] = dateStr.split('-').map(Number);
    const dt = new Date(y, m - 1, d + delta);
    return `${dt.getFullYear()}-${String(dt.getMonth() + 1).padStart(2, '0')}-${String(dt.getDate()).padStart(2, '0')}`;
  }

  function syncTokenFilterDropdowns() {
    if (!ledgerData) return;
    const pSel = document.getElementById('lpProjectFilter');
    const aSel = document.getElementById('lpAccountFilter');
    if (pSel) {
      const projs = ledgerData.projects || [];
      const cur = tokenProjectFilter;
      pSel.innerHTML = `<option value="all">${esc(l('projAll'))}</option>` + projs.map((p) => `<option value="${esc(p)}">${esc(p)}</option>`).join('');
      pSel.value = projs.includes(cur) ? cur : 'all';
      tokenProjectFilter = pSel.value;
    }
    if (aSel) {
      const accts = ledgerData.accounts || [];
      const hasUnattr = (ledgerData.slices || []).some((s) => s.account === 'unattributed');
      const cur = tokenAccountFilter;
      const knownPoolAcct = cur !== 'all' && cur !== 'unattributed' && !accts.includes(cur)
        && overviewData.some((a) => a.email.toLowerCase() === cur.toLowerCase());
      const list = knownPoolAcct ? [...accts, cur] : accts;
      aSel.innerHTML = `<option value="all">${esc(l('acctAll'))}</option>`
        + list.map((em) => `<option value="${esc(em)}">${esc(maskEmail(em))}</option>`).join('')
        + (hasUnattr ? `<option value="unattributed">${esc(l('acctUnattributed'))}</option>` : '');
      aSel.value = (cur === 'unattributed' && hasUnattr) || list.includes(cur) ? cur : 'all';
      tokenAccountFilter = aSel.value;
    }
  }

  function matchesLedgerSliceFilters(s, matchDate) {
    if (tokenSourceFilter !== 'all' && s.source !== tokenSourceFilter) return false;
    if (tokenProjectFilter !== 'all' && s.project !== tokenProjectFilter) return false;
    if (tokenAccountFilter !== 'all' && s.account !== tokenAccountFilter) return false;
    if (matchDate && s.date !== matchDate) return false;
    return true;
  }

  function computeFilteredLedgerView() {
    const todayKey = ledgerData.todayKey;
    const isUnfiltered = tokenSourceFilter === 'all' && tokenProjectFilter === 'all' && tokenAccountFilter === 'all';
    const hasDimensionOrDay = !isUnfiltered || !!selectedHeatDate;

    let totals = ledgerData.totals;
    let heatmapDays = ledgerData.heatmapDays || [];
    let daily30 = ledgerData.daily30 || [];

    if (!isUnfiltered && Array.isArray(ledgerData.slices)) {
      const dayAccMap = new Map();
      for (const s of ledgerData.slices) {
        if (!matchesLedgerSliceFilters(s, '')) continue;
        let d = dayAccMap.get(s.date);
        if (!d) {
          d = { date: s.date, input: 0, cacheRead: 0, output: 0, weighted: 0, total: 0, steps: 0, costUsd: 0, savedByCacheUsd: 0 };
          dayAccMap.set(s.date, d);
        }
        d.input += s.input; d.cacheRead += s.cacheRead; d.output += s.output;
        d.weighted += s.weighted; d.total += (s.input + s.cacheRead + s.output);
        d.steps += s.steps; d.costUsd += s.costUsd; d.savedByCacheUsd += s.savedUsd;
      }

      const key7d = shiftDateStr(todayKey, -6);
      const key30d = shiftDateStr(todayKey, -29);
      const mkBucket = () => ({ input: 0, cacheRead: 0, output: 0, weighted: 0, total: 0, steps: 0, cacheHitPct: 0, costUsd: 0, savedByCacheUsd: 0 });
      const addB = (b, d) => {
        b.input += d.input; b.cacheRead += d.cacheRead; b.output += d.output;
        b.weighted += d.weighted; b.total += d.total; b.steps += d.steps;
        b.costUsd += d.costUsd; b.savedByCacheUsd += d.savedByCacheUsd;
      };
      const finB = (b) => {
        const pt = b.input + b.cacheRead;
        b.cacheHitPct = pt > 0 ? Math.round((b.cacheRead / pt) * 1000) / 10 : 0;
        return b;
      };
      const todayB = mkBucket(), b7 = mkBucket(), b30 = mkBucket(), bAll = mkBucket();
      for (const [dk, d] of dayAccMap.entries()) {
        addB(bAll, d);
        if (dk >= key30d && dk <= todayKey) addB(b30, d);
        if (dk >= key7d && dk <= todayKey) addB(b7, d);
        if (dk === todayKey) addB(todayB, d);
      }
      totals = { today: finB(todayB), last7d: finB(b7), last30d: finB(b30), allTime: finB(bAll) };
      heatmapDays = (ledgerData.heatmapDays || []).map((orig) => {
        const m = dayAccMap.get(orig.date);
        return m ? { ...orig, ...m } : { ...orig, input: 0, cacheRead: 0, output: 0, weighted: 0, total: 0, steps: 0, costUsd: 0 };
      });
      daily30 = (ledgerData.daily30 || []).map((orig) => {
        const m = dayAccMap.get(orig.date);
        return m ? { ...orig, ...m } : { ...orig, input: 0, cacheRead: 0, output: 0, weighted: 0, total: 0, steps: 0, costUsd: 0 };
      });
    }

    // 场景分解跟随来源/项目/账号/日期 + 当前展示口径 sharePct 实时联动
    let rawScenarios = ledgerData.scenarios || [];
    if (hasDimensionOrDay && Array.isArray(ledgerData.scenarioSlices)) {
      const scMap = new Map();
      for (const sl of ledgerData.scenarioSlices) {
        if (!matchesLedgerSliceFilters(sl, selectedHeatDate)) continue;
        let cur = scMap.get(sl.scenario);
        if (!cur) {
          cur = { key: sl.scenario, input: 0, cacheRead: 0, output: 0, weighted: 0, costUsd: 0, steps: 0 };
          scMap.set(sl.scenario, cur);
        }
        cur.input += sl.input; cur.cacheRead += sl.cacheRead; cur.output += sl.output;
        cur.weighted += sl.weighted; cur.costUsd += sl.costUsd; cur.steps += sl.steps;
      }
      rawScenarios = Array.from(scMap.values());
    }
    const scModeSum = rawScenarios.reduce((acc, sc) => acc + pickTokenSum(sc), 0);
    const scenarios = rawScenarios
      .map((sc) => ({
        ...sc,
        sharePct: scModeSum > 0 ? Math.round((pickTokenSum(sc) / scModeSum) * 1000) / 10 : 0,
      }))
      .sort((a, b) => pickTokenSum(b) - pickTokenSum(a));

    // 模型排行跟随来源/项目/账号/日期 + 保留路由及实测速率元数据
    const metaByKey = new Map();
    for (const m of (ledgerData.models || [])) {
      const mk = m.model === 'untagged' ? 'untagged' : String(m.displayName || m.model || '').toLowerCase();
      metaByKey.set(mk, m);
    }
    let rawModels = ledgerData.models || [];
    if (hasDimensionOrDay && Array.isArray(ledgerData.modelSlices)) {
      const mMap = new Map();
      for (const sl of ledgerData.modelSlices) {
        if (!matchesLedgerSliceFilters(sl, selectedHeatDate)) continue;
        let cur = mMap.get(sl.modelKey);
        if (!cur) {
          const base = metaByKey.get(sl.modelKey);
          cur = {
            model: base ? base.model : sl.modelKey,
            displayName: base ? base.displayName : sl.modelKey,
            family: base ? base.family : 'other',
            routes: base ? base.routes : [sl.modelKey],
            input: 0, cacheRead: 0, output: 0, weighted: 0, total: 0, steps: 0, costUsd: 0,
            avgStreamingTps: base ? base.avgStreamingTps : null,
            avgTtftSec: base ? base.avgTtftSec : null,
            speedSamples: base ? base.speedSamples : 0,
          };
          mMap.set(sl.modelKey, cur);
        }
        cur.input += sl.input; cur.cacheRead += sl.cacheRead; cur.output += sl.output;
        cur.weighted += sl.weighted; cur.total += (sl.input + sl.cacheRead + sl.output);
        cur.steps += sl.steps; cur.costUsd += sl.costUsd;
      }
      rawModels = Array.from(mMap.values());
    }
    const mModeSum = rawModels.reduce((acc, m) => acc + pickTokenSum(m), 0);
    const models = rawModels
      .map((m) => ({
        ...m,
        sharePct: mModeSum > 0 ? Math.round((pickTokenSum(m) / mModeSum) * 1000) / 10 : 0,
      }))
      .sort((a, b) => pickTokenSum(b) - pickTokenSum(a));

    return { totals, heatmapDays, daily30, scenarios, models };
  }

  function renderActiveFilterChips() {
    const el = document.getElementById('lpActiveFilterChips');
    if (!el) return;
    const chips = [];
    if (tokenSourceFilter !== 'all') {
      chips.push(`<button type="button" class="lp-filter-chip" data-clear="source">${esc(l('filterTagSource', tokenSourceFilter === 'desktop' ? l('srcDesktop') : 'CLI'))} <span aria-hidden="true">×</span></button>`);
    }
    if (tokenProjectFilter !== 'all') {
      chips.push(`<button type="button" class="lp-filter-chip" data-clear="project">${esc(l('filterTagProject', tokenProjectFilter))} <span aria-hidden="true">×</span></button>`);
    }
    if (tokenAccountFilter !== 'all') {
      const acctLbl = tokenAccountFilter === 'unattributed' ? l('acctUnattributed') : maskEmail(tokenAccountFilter);
      chips.push(`<button type="button" class="lp-filter-chip" data-clear="account">${esc(l('filterTagAccount', acctLbl))} <span aria-hidden="true">×</span></button>`);
    }
    if (selectedHeatDate) {
      chips.push(`<button type="button" class="lp-filter-chip" data-clear="date">${esc(l('filterTagDate', selectedHeatDate))} <span aria-hidden="true">×</span></button>`);
    }
    if (chips.length === 0) {
      el.hidden = true;
      el.innerHTML = '';
      return;
    }
    el.hidden = false;
    el.innerHTML = chips.join('') + `<button type="button" class="lp-btn lp-btn-sm" data-clear="all">${esc(l('filterResetAll'))}</button>`;
  }

  let activeFilteredView = null;

  function renderTokensTab(force = false) {
    const kpiEl = document.getElementById('lpTokenKpis');
    const metaEl = document.getElementById('lpLedgerMeta');
    if (!kpiEl) return;

    if (ledgerError && !ledgerData) {
      kpiEl.innerHTML = `<div class="lp-error-box" style="grid-column:1/-1">${esc(ledgerError)}</div>`;
      return;
    }

    if (!ledgerData) {
      kpiEl.innerHTML = `<div class="lp-skeleton" style="grid-column:1/-1">${esc(l('ledgerLoading'))}</div>`;
      return;
    }

    syncTokenFilterDropdowns();
    renderActiveFilterChips();

    const fp = JSON.stringify({
      scannedAt: ledgerData.scannedAt,
      tokenDisplayMode,
      tokenSourceFilter,
      tokenProjectFilter,
      tokenAccountFilter,
      selectedHeatDate,
      showUntaggedModels,
      lowCacheOnly,
      sessionSearch,
      sessionSort,
      expanded: Array.from(expandedSessionIds),
      privacyMode,
    });
    if (!force && fp === fingerprints.ledger) return;
    fingerprints.ledger = fp;

    if (metaEl) {
      metaEl.textContent = l('ledgerMetaInfo', ledgerData.totalSessions, ledgerData.scanElapsedMs);
    }

    activeFilteredView = computeFilteredLedgerView();
    const t = activeFilteredView.totals;
    const dayRec = selectedHeatDate
      ? (activeFilteredView.heatmapDays || []).find((d) => d.date === selectedHeatDate)
      : null;

    const dayVal = dayRec ? fmtModeVal(dayRec) : fmtModeVal(t.today);
    const daySteps = dayRec ? dayRec.steps : t.today.steps;
    const dayCacheHit = dayRec
      ? (dayRec.input + dayRec.cacheRead > 0 ? Math.round((dayRec.cacheRead / (dayRec.input + dayRec.cacheRead)) * 1000) / 10 : 0)
      : t.today.cacheHitPct;

    const kpis = [
      {
        hero: true,
        label: selectedHeatDate ? l('selectedDayFmt', selectedHeatDate) : l('kpiToday'),
        val: dayVal,
        costUsd: dayRec ? (dayRec.costUsd || 0) : (t.today.costUsd || 0),
        sub: `${l('cacheHitFmt', dayCacheHit)} · ${l('netStepsFmt', daySteps)}`,
      },
      {
        label: l('kpiLast7d'),
        val: fmtModeVal(t.last7d),
        costUsd: t.last7d.costUsd || 0,
        sub: `In ${fmtCompact(t.last7d.input)} · Out ${fmtCompact(t.last7d.output)}`,
      },
      {
        label: l('kpiLast30d'),
        val: fmtModeVal(t.last30d),
        costUsd: t.last30d.costUsd || 0,
        sub: `In ${fmtCompact(t.last30d.input)} · Out ${fmtCompact(t.last30d.output)}${(t.last30d.savedByCacheUsd || 0) > 0.01 ? ' · ' + l('cacheSavedFmt', fmtUsd(t.last30d.savedByCacheUsd)) : ''}`,
      },
      {
        label: l('kpiAllTime'),
        val: fmtModeVal(t.allTime),
        costUsd: t.allTime.costUsd || 0,
        sub: `Cache ${fmtCompact(t.allTime.cacheRead)} · Out ${fmtCompact(t.allTime.output)}${(t.allTime.savedByCacheUsd || 0) > 0.01 ? ' · ' + l('cacheSavedFmt', fmtUsd(t.allTime.savedByCacheUsd)) : ''}`,
      },
    ];

    kpiEl.innerHTML = kpis.map((k) => `
      <div class="lp-kpi-card${k.hero ? ' is-hero' : ''}">
        <div class="lp-kpi-head">
          <div class="lp-kpi-label">${esc(k.label)}</div>
          ${tokenDisplayMode !== 'usd' ? `<span class="lp-kpi-cost">${esc(l('apiEstCostFmt', fmtUsd(k.costUsd)))}</span>` : ''}
        </div>
        <div class="lp-kpi-num">${esc(k.val)}</div>
        <div class="lp-kpi-sub">${esc(k.sub)}</div>
      </div>
    `).join('');

    safeRender('lpHeatmapWrap', renderHeatmapSection);
    safeRender('lpScenarioWrap', renderScenarioSection);
    safeRender('lpDailyBarWrap', renderDailyBarsSection);
    safeRender('lpModelRankWrap', renderModelRankSection);
    safeRender('lpSessionListWrap', renderSessionExplorer);
  }

  function renderHeatmapSection() {
    const wrap = document.getElementById('lpHeatmapWrap');
    const banner = document.getElementById('lpSelectedDayBanner');
    const clearBtn = document.getElementById('lpClearDayBtn');
    if (!wrap || !ledgerData) return;

    const days = (activeFilteredView && activeFilteredView.heatmapDays) || ledgerData.heatmapDays || [];
    if (banner && clearBtn) {
      if (selectedHeatDate) {
        const dRec = days.find((d) => d.date === selectedHeatDate);
        const totalStr = dRec ? fmtModeVal(dRec) : (tokenDisplayMode === 'usd' ? '$0.00' : '0');
        banner.textContent = (tokenDisplayMode === 'usd' ? l('heatDetailUsdFmt', selectedHeatDate, totalStr, dRec ? dRec.steps : 0) : l('heatDetailFmt', selectedHeatDate, totalStr, dRec ? dRec.steps : 0));
        banner.hidden = false;
        clearBtn.hidden = false;
      } else {
        banner.textContent = l('heatWeeksNote');
        banner.hidden = false;
        clearBtn.hidden = true;
      }
    }

    const nonZero = days.filter((d) => !d.isFuture).map((d) => pickTokenSum(d)).filter((v) => v > 0).sort((a, b) => a - b);
    const q1 = nonZero[Math.floor(nonZero.length * 0.25)] || 0.001;
    const q2 = nonZero[Math.floor(nonZero.length * 0.50)] || q1 * 2;
    const q3 = nonZero[Math.floor(nonZero.length * 0.78)] || q2 * 2;

    const getLvl = (v) => {
      if (!v || v <= 0) return 0;
      if (v <= q1) return 1;
      if (v <= q2) return 2;
      if (v <= q3) return 3;
      return 4;
    };

    wrap.replaceChildren();
    const monthsEl = document.createElement('div');
    monthsEl.className = 'lp-heat-months';

    const bodyEl = document.createElement('div');
    bodyEl.className = 'lp-heat-body';

    const wkEl = document.createElement('div');
    wkEl.className = 'lp-heat-weekdays';
    const wkLabels = [l('wkMon'), '', l('wkWed'), '', l('wkFri'), '', l('wkSun')];
    for (const lbl of wkLabels) {
      const s = document.createElement('span');
      s.textContent = lbl;
      wkEl.appendChild(s);
    }

    const colsEl = document.createElement('div');
    colsEl.className = 'lp-heat-cols';

    let lastMonth = '';
    let lastLabelCol = -10;
    for (let c = 0; c < 52; c++) {
      const colEl = document.createElement('div');
      colEl.className = 'lp-heat-col';
      const slice = days.slice(c * 7, (c + 1) * 7);
      if (slice.length > 0) {
        const m = slice[0].date.slice(5, 7);
        if (m !== lastMonth) {
          lastMonth = m;
          if (c - lastLabelCol >= 3 && 52 - c >= 2) {
            lastLabelCol = c;
            const mLbl = document.createElement('span');
            mLbl.className = 'lp-heat-month';
            if (c >= 47) {
              mLbl.style.right = '0';
              mLbl.style.left = 'auto';
            } else {
              mLbl.style.left = `${(c / 52) * 100}%`;
            }
            const mIdx = Math.max(0, Math.min(11, Number(m) - 1));
            const mList = l('monthLabels').split(',');
            mLbl.textContent = mList[mIdx] || String(Number(m));
            monthsEl.appendChild(mLbl);
          }
        }
      }

      for (const d of slice) {
        const val = pickTokenSum(d);
        const lvl = d.isFuture ? 0 : getLvl(val);
        const cell = document.createElement('div');
        cell.className = `lp-heat-cell lvl-${lvl}${d.isFuture ? ' is-future' : ''}${selectedHeatDate === d.date ? ' is-selected' : ''}`;
        if (!d.isFuture) {
          cell.addEventListener('mouseenter', (ev) => {
            const topName = d.topModelDisplay || d.topModel;
            const rows = [
              `Weighted: ${fmtCompact(d.weighted || 0)} · ${l('netStepsFmt', d.steps)}`,
              `In: ${fmtCompact(d.input)} · Out: ${fmtCompact(d.output)}`,
              `Cache: ${fmtCompact(d.cacheRead)} · ${l('apiEstCostFmt', fmtUsd(d.costUsd || 0))}`,
            ];
            if (topName && topName !== 'untagged') rows.push(`${l('topModelLabel')}: ${topName}`);
            showFloatingTip(ev.clientX, ev.clientY, d.date, rows);
          });
          cell.addEventListener('mouseleave', hideFloatingTip);
          cell.addEventListener('click', () => {
            selectedHeatDate = selectedHeatDate === d.date ? '' : d.date;
            renderTokensTab(true);
          });
        }
        colEl.appendChild(cell);
      }
      colsEl.appendChild(colEl);
    }

    bodyEl.appendChild(wkEl);
    bodyEl.appendChild(colsEl);
    wrap.appendChild(monthsEl);
    wrap.appendChild(bodyEl);
  }

  function renderScenarioSection() {
    const wrap = document.getElementById('lpScenarioWrap');
    if (!wrap || !ledgerData) return;
    const list = (activeFilteredView && activeFilteredView.scenarios) || ledgerData.scenarios || [];
    if (list.length === 0) {
      wrap.innerHTML = `<div class="lp-empty-box">${esc(l('noTokenData'))}</div>`;
      return;
    }
    const labelMap = {
      tools: l('scTools'),
      subagent: l('scSubagent'),
      chat: l('scChat'),
      planning: l('scPlanning'),
      memory: l('scMemory'),
      internal: l('scInternal'),
    };
    wrap.innerHTML = list.map((sc) => `
      <div class="lp-scenario-row">
        <div class="lp-scenario-head">
          <span class="lp-scenario-name">${esc(labelMap[sc.key] || sc.key)}</span>
          <span class="lp-scenario-val">${esc(fmtModeVal(sc))} · ${sc.sharePct}%${tokenDisplayMode !== 'usd' ? ` · ${esc(fmtUsd(sc.costUsd || 0))}` : ''}</span>
        </div>
        <div class="lp-scenario-bar"><div class="lp-scenario-fill sc-${esc(sc.key)}" style="width:${Math.max(2, Math.min(100, sc.sharePct))}%"></div></div>
      </div>
    `).join('');
  }

  function renderDailyBarsSection() {
    const box = document.getElementById('lpDailyBarWrap');
    if (!box || !ledgerData) return;

    const list = (activeFilteredView && activeFilteredView.daily30) || ledgerData.daily30 || [];
    let legendHtml = '';
    if (tokenDisplayMode === 'usd') {
      legendHtml = `<div class="lp-mini-legend"><span class="lp-legend-item"><span class="lp-dot lp-seg-output"></span>${esc(l('chartUsdSeries'))}</span></div>`;
    } else if (tokenDisplayMode === 'weighted') {
      legendHtml = `
        <div class="lp-mini-legend">
          <span class="lp-legend-item"><span class="lp-dot lp-seg-input"></span>${esc(l('chartInput'))}</span>
          <span class="lp-legend-item"><span class="lp-dot lp-seg-output"></span>${esc(l('chartOutputWeighted'))}</span>
          <span class="lp-legend-item"><span class="lp-dot lp-seg-cache"></span>${esc(l('chartCacheWeighted'))}</span>
        </div>`;
    } else {
      legendHtml = `
        <div class="lp-mini-legend">
          <span class="lp-legend-item"><span class="lp-dot lp-seg-input"></span>${esc(l('chartInput'))}</span>
          <span class="lp-legend-item"><span class="lp-dot lp-seg-output"></span>${esc(l('chartOutput'))}</span>
          ${tokenDisplayMode === 'all' ? `<span class="lp-legend-item"><span class="lp-dot lp-seg-cache"></span>${esc(l('chartCache'))}</span>` : ''}
        </div>`;
    }

    const metricOfBar = (d) => pickTokenSum(d);
    const maxVal = Math.max(tokenDisplayMode === 'usd' ? 0.01 : 1, ...list.map(metricOfBar));
    if (list.every((d) => metricOfBar(d) <= 0)) {
      box.innerHTML = `<div class="lp-empty-box">${esc(l('noTokenData'))}</div>`;
      return;
    }

    const W = 560;
    const H = 195;
    const padL = 52;
    const padR = 12;
    const padT = 12;
    const padB = 26;
    const plotW = W - padL - padR;
    const plotH = H - padT - padB;
    const colW = plotW / Math.max(1, list.length);
    const barW = Math.max(7, colW * 0.64);

    let yLines = '';
    for (const frac of [0.25, 0.5, 0.75, 1]) {
      const y = (padT + plotH * (1 - frac)).toFixed(1);
      const tickStr = tokenDisplayMode === 'usd' ? fmtUsd(maxVal * frac) : fmtCompact(maxVal * frac);
      yLines += `<line x1="${padL}" y1="${y}" x2="${W - padR}" y2="${y}" stroke="var(--lp-border)" stroke-dasharray="3,3" />`;
      yLines += `<text x="${padL - 8}" y="${Number(y) + 4}" text-anchor="end" fill="var(--lp-muted)" font-size="12">${esc(tickStr)}</text>`;
    }

    let bars = '';
    let xLabels = '';
    list.forEach((d, idx) => {
      const x = padL + idx * colW + (colW - barW) / 2;
      let segs = '';
      if (tokenDisplayMode === 'usd') {
        const hUsd = ((d.costUsd || 0) / maxVal) * plotH;
        if (hUsd > 0) {
          segs = `<rect x="${x.toFixed(1)}" y="${(padT + plotH - hUsd).toFixed(1)}" width="${barW.toFixed(1)}" height="${hUsd.toFixed(1)}" fill="var(--lp-warn)" rx="2" />`;
        }
      } else {
        const vIn = d.input || 0;
        const vOut = tokenDisplayMode === 'weighted' ? 6 * (d.output || 0) : (d.output || 0);
        const vCache = tokenDisplayMode === 'weighted' ? 0.1 * (d.cacheRead || 0) : (tokenDisplayMode === 'all' ? (d.cacheRead || 0) : 0);

        const hCache = (vCache / maxVal) * plotH;
        const hIn = (vIn / maxVal) * plotH;
        const hOut = (vOut / maxVal) * plotH;

        let curY = padT + plotH;
        if (hCache > 0) {
          curY -= hCache;
          segs += `<rect x="${x.toFixed(1)}" y="${curY.toFixed(1)}" width="${barW.toFixed(1)}" height="${hCache.toFixed(1)}" fill="var(--lp-ok)" rx="2" />`;
        }
        if (hIn > 0) {
          curY -= hIn;
          segs += `<rect x="${x.toFixed(1)}" y="${curY.toFixed(1)}" width="${barW.toFixed(1)}" height="${hIn.toFixed(1)}" fill="var(--lp-blue)" rx="2" />`;
        }
        if (hOut > 0) {
          curY -= hOut;
          segs += `<rect x="${x.toFixed(1)}" y="${curY.toFixed(1)}" width="${barW.toFixed(1)}" height="${hOut.toFixed(1)}" fill="var(--lp-warn)" rx="2" />`;
        }
      }

      const highlightStroke = selectedHeatDate === d.date ? 'stroke="var(--lp-fg)" stroke-width="1.5"' : '';
      bars += `<g class="lp-bar-hit" data-idx="${idx}" style="cursor:pointer">${segs}<rect x="${x.toFixed(1)}" y="${padT}" width="${barW.toFixed(1)}" height="${plotH}" fill="transparent" ${highlightStroke} /></g>`;
      if (idx === 0 || idx === 9 || idx === 19 || idx === list.length - 1) {
        xLabels += `<text x="${(x + barW / 2).toFixed(1)}" y="${H - 6}" text-anchor="middle" fill="var(--lp-muted)" font-size="12">${esc(d.date.slice(5))}</text>`;
      }
    });

    const activeDays = list.filter((d) => pickTokenSum(d) > 0).length;
    const sum30 = list.reduce((acc, d) => acc + pickTokenSum(d), 0);
    const avgDaily = activeDays > 0 ? sum30 / activeDays : 0;
    const t30 = activeFilteredView ? activeFilteredView.totals.last30d : ledgerData.totals.last30d;
    const cacheRate30 = t30 ? t30.cacheHitPct : 0;

    box.innerHTML = `
      <div class="lp-chart-subhead-row">
        <div class="lp-chart-subhead">${esc(l('dailyTrend30'))}</div>
        ${legendHtml}
      </div>
      <svg class="lp-svg-chart" viewBox="0 0 ${W} ${H}">${yLines}${bars}${xLabels}</svg>
      <div class="lp-chart-foot-grid">
        <div class="lp-metric-tile">
          <div class="lp-metric-label">${esc(l('activeDays30'))}</div>
          <div class="lp-metric-val">${activeDays} / 30</div>
        </div>
        <div class="lp-metric-tile">
          <div class="lp-metric-label">${esc(l('dailyAvg30'))}</div>
          <div class="lp-metric-val">${esc(tokenDisplayMode === 'usd' ? fmtUsd(avgDaily) : fmtCompact(Math.round(avgDaily)))}</div>
        </div>
        <div class="lp-metric-tile">
          <div class="lp-metric-label">${esc(l('cacheRate30'))}</div>
          <div class="lp-metric-val lp-c-ok">${cacheRate30}%</div>
        </div>
      </div>
    `;
    box.querySelectorAll('.lp-bar-hit').forEach((g) => {
      const idx = Number(g.getAttribute('data-idx'));
      const d = list[idx];
      if (!d) return;
      g.addEventListener('mouseenter', (ev) => {
        const topName = d.topModelDisplay || d.topModel;
        const rows = [
          `Weighted: ${fmtCompact(d.weighted || 0)} · ${l('netStepsFmt', d.steps)}`,
          `In: ${fmtCompact(d.input)} · Out: ${fmtCompact(d.output)} · Cache: ${fmtCompact(d.cacheRead)}`,
          `${l('apiEstCostFmt', fmtUsd(d.costUsd || 0))}${topName && topName !== 'untagged' ? ' · ' + topName : ''}`,
        ];
        showFloatingTip(ev.clientX, ev.clientY, d.date, rows);
      });
      g.addEventListener('mouseleave', hideFloatingTip);
      g.addEventListener('click', () => {
        selectedHeatDate = selectedHeatDate === d.date ? '' : d.date;
        renderTokensTab(true);
      });
    });
  }

  function renderModelRankSection() {
    const wrap = document.getElementById('lpModelRankWrap');
    const toggleBtn = document.getElementById('lpToggleUntaggedBtn');
    if (!wrap || !ledgerData) return;

    const allModels = (activeFilteredView && activeFilteredView.models) || ledgerData.models || [];
    const hasUntagged = allModels.some((m) => m.model === 'untagged' && (m.input + m.cacheRead + m.output) > 0);
    if (toggleBtn) {
      toggleBtn.hidden = !hasUntagged;
      toggleBtn.textContent = showUntaggedModels ? l('hideUntagged') : l('showUntagged');
    }

    let list = allModels.filter((m) => showUntaggedModels || !hasUntagged || m.model !== 'untagged');
    list = list.slice(0, 12);
    if (list.length === 0) {
      wrap.innerHTML = `<div class="lp-empty-box">${esc(l('noTokenData'))}</div>`;
      return;
    }

    const maxVal = Math.max(0.001, ...list.map((m) => pickTokenSum(m)));

    wrap.innerHTML = list.map((m) => {
      const displayName = m.model === 'untagged' ? l('untaggedLabel') : (m.displayName || prettifyModelName(m.model));
      const val = pickTokenSum(m);
      const pctBar = Math.round((val / maxVal) * 100);
      const fam = m.family || 'other';
      const routesTip = Array.isArray(m.routes) && m.routes.length > 1 ? ` · [${m.routes.join(', ')}]` : (m.model && m.model !== displayName ? ` (${m.model})` : '');
      const routeBadge = Array.isArray(m.routes) && m.routes.length > 1
        ? `<span class="lp-badge">${esc(l('mergedRoutes', m.routes.length))}</span>`
        : '';
      const speedBadge = m.avgStreamingTps !== null
        ? `<span class="lp-badge ok">${esc(l('modelSpeedFmt', m.avgStreamingTps))}</span>`
        : '';
      const ttftBadge = m.avgTtftSec !== null
        ? `<span class="lp-badge">${esc(l('modelTtftFmt', m.avgTtftSec))}</span>`
        : '';

      return `
        <div class="lp-model-row">
          <div class="lp-model-head">
            <span class="lp-model-name" title="${esc(displayName + routesTip)}">${esc(displayName)}</span>
            <div class="lp-filter-group">${routeBadge}${speedBadge}${ttftBadge}</div>
          </div>
          <div class="lp-model-bar"><div class="lp-model-bar-fill fam-${esc(fam)}" style="width:${pctBar}%"></div></div>
          <div class="lp-model-stats">
            <span>${esc(tokenDisplayMode === 'usd' ? fmtUsd(val) : fmtCompact(val))} (${m.sharePct ?? 0}%)</span>
            ${tokenDisplayMode !== 'usd' ? `<span>${esc(l('apiEstCostFmt', fmtUsd(m.costUsd || 0)))}</span>` : ''}
            <span>In ${esc(fmtCompact(m.input))}</span>
            <span>Out ${esc(fmtCompact(m.output))}</span>
            <span>Cache ${esc(fmtCompact(m.cacheRead))}</span>
          </div>
        </div>
      `;
    }).join('');
  }

  function renderSessionExplorer() {
    const listEl = document.getElementById('lpSessionListWrap');
    const countEl = document.getElementById('lpSessionCount');
    const lowBtn = document.getElementById('lpLowCacheBtn');
    if (!listEl || !ledgerData) return;

    if (lowBtn) lowBtn.classList.toggle('lp-btn-active', lowCacheOnly);

    const kw = sessionSearch.trim().toLowerCase();
    const filteredList = (ledgerData.sessions || []).filter((s) => {
      if (tokenSourceFilter !== 'all' && s.source !== tokenSourceFilter) return false;
      if (tokenProjectFilter !== 'all' && s.projectName !== tokenProjectFilter) return false;
      if (tokenAccountFilter !== 'all') {
        const acct = s.accountEmail || 'unattributed';
        if (acct !== tokenAccountFilter) return false;
      }
      if (selectedHeatDate && !(Array.isArray(s.activeDates) && s.activeDates.includes(selectedHeatDate))) return false;
      if (lowCacheOnly && !s.isLowCache) return false;
      if (kw) {
        const hay = `${s.title} ${s.projectName} ${s.accountEmail} ${maskEmail(s.accountEmail)} ${s.topModelDisplay}`.toLowerCase();
        if (!hay.includes(kw)) return false;
      }
      return true;
    });

    filteredList.sort((a, b) => (
      sessionSort === 'heavy'
        ? (pickTokenSum(b) - pickTokenSum(a))
        : ((b.lastModifiedMs || 0) - (a.lastModifiedMs || 0))
    ));
    const filtered = filteredList.slice(0, 40);

    if (countEl) countEl.textContent = l('entriesUnit', filteredList.length);
    if (filtered.length === 0) {
      listEl.innerHTML = `<div class="lp-empty-box">${esc(l('noSessions'))}</div>`;
      return;
    }

    listEl.innerHTML = filtered.map((s) => {
      const hasSub = Array.isArray(s.subagents) && s.subagents.length > 0;
      const isExpanded = expandedSessionIds.has(s.conversationId);
      const toggleBtn = hasSub
        ? `<button type="button" class="lp-session-toggle" data-cid="${esc(s.conversationId)}">${isExpanded ? '▾' : '▸'}</button>`
        : '<span class="lp-session-spacer"></span>';
      const cacheTone = s.cacheHitPct >= 75 ? 'ok' : (s.cacheHitPct < 50 ? 'danger' : 'warn');
      const timeTag = s.lastModifiedMs ? `<span class="lp-session-time">${esc(fmtShortDateTime(s.lastModifiedMs))}</span>` : '';
      const projTag = s.projectName
        ? `<button type="button" class="lp-badge lp-proj-filter-btn" data-project="${esc(s.projectName)}">${esc(s.projectName)}</button>`
        : '';
      const subHtml = hasSub && isExpanded
        ? `<div class="lp-subagent-list">${s.subagents.map((sub) => `
            <div class="lp-subagent-row">
              <span class="lp-badge">${esc(sub.agentName || 'subagent')}</span>
              <span class="lp-subagent-title">${esc(sub.title)}</span>
              <span class="lp-session-stats">${esc(fmtModeVal(sub))} · ${esc(fmtUsd(sub.costUsd || 0))} · ${esc(l('netStepsFmt', sub.steps))}</span>
            </div>
          `).join('')}</div>`
        : '';

      return `
        <div class="lp-session-item">
          <div class="lp-session-row${hasSub ? ' is-expandable' : ''}"${hasSub ? ` data-cid="${esc(s.conversationId)}"` : ''}>
            <div class="lp-session-main">
              ${toggleBtn}
              <span class="lp-session-title" title="${esc(s.title)}">${esc(s.title)}</span>
              ${projTag}
              ${s.topModelDisplay ? `<span class="lp-badge">${esc(s.topModelDisplay)}</span>` : ''}
              ${s.source === 'cli' ? '<span class="lp-badge">CLI</span>' : ''}
              ${hasSub ? `<span class="lp-badge info">${esc(l('subagentCountTag', s.subagents.length))}</span>` : ''}
              ${s.compactions > 0 ? `<span class="lp-badge warn">${esc(l('compactCountTag', s.compactions))}</span>` : ''}
            </div>
            <div class="lp-session-meta">
              ${timeTag}
              ${s.accountEmail ? `<span class="lp-session-acct">${esc(maskEmail(s.accountEmail))}</span>` : ''}
              <span class="lp-badge ${cacheTone}">${esc(l('cacheHitFmt', s.cacheHitPct))}</span>
              <span class="lp-session-stats">${esc(fmtModeVal(s))}${tokenDisplayMode !== 'usd' ? ` · ${esc(fmtUsd(s.costUsd || 0))}` : ''}</span>
            </div>
          </div>
          ${subHtml}
        </div>
      `;
    }).join('');
  }

  // ── Tab 3: 配额历史图表与流水 ──
  const CHART_COLORS = ['#3b82f6', '#10b981', '#f59e0b', '#06b6d4', '#f87171', '#ec4899', '#84cc16', '#f97316'];

  function getFilteredQuotaRows() {
    const search = (document.getElementById('lpSearchInput')?.value || '').trim().toLowerCase();
    const cutoffMap = { '1h': 3600_000, '24h': 86400_000, '7d': 7 * 86400_000, '30d': 30 * 86400_000, all: Infinity };
    const cutoff = cutoffMap[quotaRange] === Infinity ? 0 : Date.now() - cutoffMap[quotaRange];

    return quotaHistory.filter((e) => {
      if (e.ts < cutoff) return false;
      if (quotaDirection === 'down' && !(e.delta < 0)) return false;
      if (quotaDirection === 'up' && !(e.delta > 0)) return false;
      if (search) {
        const emailMatch = e.email.toLowerCase().includes(search) || maskEmail(e.email).toLowerCase().includes(search);
        const tagMatch = (accountTags[e.email] || []).some((t) => t.toLowerCase().includes(search));
        if (!emailMatch && !tagMatch) return false;
      }
      return true;
    });
  }

  function renderQuotaChart(force = false) {
    const box = document.getElementById('lpQuotaChartBox');
    const legendEl = document.getElementById('lpSeriesLegend');
    if (!box || !legendEl) return;

    const rows = getFilteredQuotaRows();
    const byEmail = new Map();
    for (const r of rows) {
      if (!byEmail.has(r.email)) byEmail.set(r.email, []);
      byEmail.get(r.email).push(r);
    }

    const emailsList = Array.from(byEmail.keys());
    if (!seriesInitialized && emailsList.length > 0) {
      seriesInitialized = true;
      if (currentEmail) enabledSeriesEmails.add(currentEmail);
      emailsList.slice(0, 4).forEach((em) => enabledSeriesEmails.add(em));
    }

    const fp = JSON.stringify({ quotaRange, quotaPool, quotaDirection, search: document.getElementById('lpSearchInput')?.value || '', len: rows.length, swLen: switchEvents.length, on: Array.from(enabledSeriesEmails), privacyMode });
    if (!force && fp === fingerprints.quotaChart) return;
    fingerprints.quotaChart = fp;

    legendEl.replaceChildren();
    emailsList.forEach((em, idx) => {
      const color = CHART_COLORS[idx % CHART_COLORS.length];
      const chip = document.createElement('button');
      chip.type = 'button';
      chip.className = 'lp-series-chip' + (enabledSeriesEmails.has(em) ? '' : ' is-off');
      chip.innerHTML = `<span class="lp-dot" style="background:${color}"></span><span>${esc(maskEmail(em))}</span>`;
      chip.addEventListener('click', () => {
        if (enabledSeriesEmails.has(em)) enabledSeriesEmails.delete(em);
        else enabledSeriesEmails.add(em);
        renderQuotaChart(true);
      });
      legendEl.appendChild(chip);
    });

    const activeSeries = emailsList.filter((em) => enabledSeriesEmails.has(em));
    const totalPts = activeSeries.reduce((acc, em) => acc + byEmail.get(em).length, 0);
    if (totalPts < 2) {
      box.innerHTML = `<div class="lp-empty-box">${esc(l('noDataPoints'))}</div>`;
      return;
    }

    const W = 960;
    const H = 250;
    const padL = 48;
    const padR = 20;
    const padT = 16;
    const padB = 30;
    const plotW = W - padL - padR;
    const plotH = H - padT - padB;

    const allPts = activeSeries.flatMap((em) => byEmail.get(em));
    const minT = Math.min(...allPts.map((p) => p.ts));
    const maxT = Math.max(...allPts.map((p) => p.ts));
    const spanT = Math.max(1, maxT - minT);

    let grid = '';
    for (const pct of [0, 30, 50, 100]) {
      const y = (padT + plotH * (1 - pct / 100)).toFixed(1);
      const dash = pct === 30 ? 'stroke-dasharray="4,4"' : '';
      const col = pct === 30 ? 'rgba(245,158,11,0.5)' : 'var(--lp-border)';
      grid += `<line x1="${padL}" y1="${y}" x2="${W - padR}" y2="${y}" stroke="${col}" ${dash} />`;
      grid += `<text x="${padL - 10}" y="${Number(y) + 4}" text-anchor="end" fill="var(--lp-muted)" font-size="12">${pct}%</text>`;
    }

    let areas = '';
    let paths = '';
    let dots = '';
    const dotMeta = [];

    activeSeries.forEach((em) => {
      const idx = emailsList.indexOf(em);
      const color = CHART_COLORS[idx % CHART_COLORS.length];
      const pts = [...byEmail.get(em)].sort((a, b) => a.ts - b.ts);
      const coords = pts.map((p) => {
        const yPct = getEntryPoolVal(p, quotaPool);
        return {
          x: padL + ((p.ts - minT) / spanT) * plotW,
          y: padT + (1 - Math.max(0, Math.min(100, yPct)) / 100) * plotH,
          p,
          yPct,
        };
      });
      if (coords.length >= 2) {
        const dStr = coords.map((c, i) => `${i === 0 ? 'M' : 'L'}${c.x.toFixed(1)},${c.y.toFixed(1)}`).join(' ');
        paths += `<path d="${dStr}" fill="none" stroke="${color}" stroke-width="2.2" stroke-linejoin="round" stroke-linecap="round" />`;
        if (activeSeries.length <= 3) {
          const baseY = (padT + plotH).toFixed(1);
          const firstX = coords[0].x.toFixed(1);
          const lastX = coords[coords.length - 1].x.toFixed(1);
          areas += `<path d="${dStr} L${lastX},${baseY} L${firstX},${baseY} Z" fill="${color}" fill-opacity="0.06" />`;
        }
      }
      coords.forEach((c) => {
        const di = dotMeta.length;
        dotMeta.push({ email: em, pt: c.p });
        dots += `<circle class="lp-q-dot" data-di="${di}" cx="${c.x.toFixed(1)}" cy="${c.y.toFixed(1)}" r="4.5" fill="${color}" stroke="var(--lp-bg)" stroke-width="1.8" />`;
      });
    });

    const fmtTick = (ts) => {
      const d = new Date(ts);
      if (spanT > 18 * 3600_000) {
        return `${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')} ${d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`;
      }
      return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    };
    const midT = minT + spanT / 2;
    const xLbls = `
      <text x="${padL}" y="${H - 8}" fill="var(--lp-muted)" font-size="12">${esc(fmtTick(minT))}</text>
      <text x="${(padL + plotW / 2).toFixed(1)}" y="${H - 8}" text-anchor="middle" fill="var(--lp-muted)" font-size="12">${esc(fmtTick(midT))}</text>
      <text x="${W - padR}" y="${H - 8}" text-anchor="end" fill="var(--lp-muted)" font-size="12">${esc(fmtTick(maxT))}</text>
    `;

    let switchMarks = '';
    const swMeta = [];
    for (const sw of switchEvents) {
      if (!sw || sw.ts < minT || sw.ts > maxT) continue;
      const sxNum = padL + ((sw.ts - minT) / spanT) * plotW;
      const sx = sxNum.toFixed(1);
      const si = swMeta.length;
      swMeta.push(sw);
      switchMarks += `<g class="lp-sw-mark" data-si="${si}">`
        + `<rect x="${(sxNum - 5).toFixed(1)}" y="${padT}" width="10" height="${plotH}" fill="transparent" />`
        + `<line x1="${sx}" y1="${padT}" x2="${sx}" y2="${padT + plotH}" stroke="var(--lp-warn)" stroke-width="1.4" stroke-dasharray="3,3" stroke-opacity="0.72" />`
        + `<circle cx="${sx}" cy="${padT + 4}" r="3.5" fill="var(--lp-warn)" />`
        + `</g>`;
    }

    if (swMeta.length > 0) {
      const swLeg = document.createElement('span');
      swLeg.className = 'lp-sw-legend';
      swLeg.innerHTML = `<span class="lp-sw-legend-line"></span><span>${esc(l('switchLegend'))}</span>`;
      legendEl.appendChild(swLeg);
    }

    box.innerHTML = `<svg class="lp-svg-chart" viewBox="0 0 ${W} ${H}">${grid}${switchMarks}${areas}${paths}${dots}${xLbls}</svg>`;
    box.querySelectorAll('.lp-sw-mark').forEach((el) => {
      const sw = swMeta[Number(el.getAttribute('data-si'))];
      if (!sw) return;
      el.addEventListener('mouseenter', (ev) => {
        const rowsTip = [new Date(sw.ts).toLocaleString()];
        if (sw.fromEmail) rowsTip.push(l('switchMarkerFrom', maskEmail(sw.fromEmail)));
        showFloatingTip(ev.clientX, ev.clientY, l('switchMarkerTitle', maskEmail(sw.email)), rowsTip);
      });
      el.addEventListener('mouseleave', hideFloatingTip);
    });
    box.querySelectorAll('.lp-q-dot').forEach((el) => {
      const m = dotMeta[Number(el.getAttribute('data-di'))];
      if (!m) return;
      el.addEventListener('mouseenter', (ev) => {
        const sign = m.pt.delta > 0 ? `+${m.pt.delta}%` : (m.pt.delta < 0 ? `${m.pt.delta}%` : '—');
        const val = getEntryPoolVal(m.pt, quotaPool);
        const rows = [
          `${new Date(m.pt.ts).toLocaleString()}`,
          `${formatPoolLabel(quotaPool)}: ${val}% (${sign})`,
        ];
        if (m.pt.pools) {
          const p = m.pt.pools;
          rows.push(`Claude ${p.claude ?? '--'}% · Gemini ${p.gemini ?? '--'}% · G4 ${p.argon ?? '--'}%`);
        }
        showFloatingTip(ev.clientX, ev.clientY, maskEmail(m.email), rows);
      });
      el.addEventListener('mouseleave', hideFloatingTip);
    });
  }

  function formatPoolsCell(e) {
    if (!e.pools) return '<span class="lp-c-dim">--</span>';
    const parts = [];
    if (typeof e.pools.claude === 'number') parts.push(`C ${e.pools.claude}%`);
    if (typeof e.pools.gemini === 'number') parts.push(`G ${e.pools.gemini}%`);
    if (typeof e.pools.argon === 'number') parts.push(`G4 ${e.pools.argon}%`);
    return parts.length > 0 ? `<span class="lp-pool-mini">${esc(parts.join(' · '))}</span>` : '<span class="lp-c-dim">--</span>';
  }

  function renderQuotaTable(force = false) {
    const tbody = document.getElementById('lpQuotaBody');
    const countEl = document.getElementById('lpQuotaCount');
    const infoEl = document.getElementById('lpQuotaPageInfo');
    const prevBtn = document.getElementById('lpQuotaPrev');
    const nextBtn = document.getElementById('lpQuotaNext');
    if (!tbody) return;

    const rows = [...getFilteredQuotaRows()].reverse();
    const fp = JSON.stringify({ len: rows.length, quotaPage, quotaRange, quotaPool, quotaDirection, search: document.getElementById('lpSearchInput')?.value || '', privacyMode });
    if (!force && fp === fingerprints.quotaTable) return;
    fingerprints.quotaTable = fp;

    if (countEl) countEl.textContent = l('entriesUnit', rows.length);

    if (rows.length === 0) {
      tbody.innerHTML = `<tr><td colspan="6"><div class="lp-empty-box">${esc(l('noHistory'))}</div></td></tr>`;
      if (infoEl) infoEl.textContent = '';
      if (prevBtn) prevBtn.disabled = true;
      if (nextBtn) nextBtn.disabled = true;
      return;
    }

    const totalPages = Math.max(1, Math.ceil(rows.length / QUOTA_PAGE_SIZE));
    if (quotaPage > totalPages) quotaPage = totalPages;
    const start = (quotaPage - 1) * QUOTA_PAGE_SIZE;
    const slice = rows.slice(start, start + QUOTA_PAGE_SIZE);

    tbody.innerHTML = slice.map((e) => {
      const deltaStr = e.delta > 0 ? `+${e.delta}%` : e.delta < 0 ? `${e.delta}%` : '—';
      const deltaCls = e.delta > 0 ? 'lp-c-ok' : e.delta < 0 ? 'lp-c-danger' : 'lp-c-dim';
      const showRem = getEntryPoolVal(e, quotaPool);
      const remCls = 'lp-c-' + toneByPct(showRem);
      const prettyTier = formatTierLabel(e.tierId);
      return `
        <tr>
          <td>${esc(new Date(e.ts).toLocaleString())}</td>
          <td class="lp-acct-email">${esc(maskEmail(e.email))}</td>
          <td class="${remCls}">${showRem}%</td>
          <td class="${deltaCls}">${esc(deltaStr)}</td>
          <td>${formatPoolsCell(e)}</td>
          <td>${prettyTier ? `<span class="lp-badge">${esc(prettyTier)}</span>` : '<span class="lp-c-dim">--</span>'}</td>
        </tr>
      `;
    }).join('');

    if (infoEl) infoEl.textContent = l('pageInfo', quotaPage, totalPages, rows.length);
    if (prevBtn) prevBtn.disabled = quotaPage <= 1;
    if (nextBtn) nextBtn.disabled = quotaPage >= totalPages;
  }

  // ── 绑定 DOM 事件 ──
  function bindEvents() {
    document.querySelectorAll('.lp-tab').forEach((btn) => {
      btn.addEventListener('click', () => {
        const t = btn.getAttribute('data-tab');
        if (t) switchTab(t);
      });
    });

    const privBtn = document.getElementById('lpPrivacyBtn');
    if (privBtn) {
      privBtn.addEventListener('click', () => {
        privacyMode = !privacyMode;
        updatePrivacyButton();
        updateCurrentPill();
        vscode.postMessage({ type: 'privacyChanged', enabled: privacyMode });
        showToast(privacyMode ? l('privacyOn') : l('privacyOff'));
        renderVisibleTab(true);
      });
    }

    const settingsBtn = document.getElementById('lpSettingsBtn');
    if (settingsBtn) {
      settingsBtn.addEventListener('click', () => vscode.postMessage({ type: 'openStatusBarSettings' }));
    }

    const refreshBtn = document.getElementById('lpRefreshBtn');
    if (refreshBtn) {
      refreshBtn.addEventListener('click', () => {
        startBusyAction('refresh', refreshBtn, l('refreshing'));
        vscode.postMessage({ type: 'refresh' });
      });
    }

    const liveSyncBtn = document.getElementById('lpLiveSyncBtn');
    if (liveSyncBtn) {
      liveSyncBtn.addEventListener('click', () => {
        startBusyAction('refreshLiveOnly', liveSyncBtn, l('refreshing'));
        vscode.postMessage({ type: 'refreshLiveOnly' });
      });
    }

    const rescanBtn = document.getElementById('lpRescanBtn');
    if (rescanBtn) {
      rescanBtn.addEventListener('click', () => {
        startBusyAction('rescanTokens', rescanBtn, l('refreshing'));
        vscode.postMessage({ type: 'rescanTokens' });
      });
    }

    const ovSearch = document.getElementById('lpOverviewSearch');
    if (ovSearch) ovSearch.addEventListener('input', () => renderPoolMatrixSection(true));
    const ovSort = document.getElementById('lpOverviewSort');
    if (ovSort) ovSort.addEventListener('change', () => renderPoolMatrixSection(true));

    // 号池直操事件委托（切号 / 单号刷新）
    document.getElementById('lpOverviewPane')?.addEventListener('click', (ev) => {
      const target = ev.target instanceof Element ? ev.target.closest('button') : null;
      if (!target) return;
      const email = target.getAttribute('data-email');
      if (!email) return;
      if (target.classList.contains('lp-switch-trigger')) {
        startBusyAction(`switch:${email}`, target, l('switchingBtn'));
        vscode.postMessage({ type: 'switchAccount', email });
      } else if (target.classList.contains('lp-refresh-one-trigger')) {
        startBusyAction(`refreshOne:${email}`, target, l('refreshing'));
        vscode.postMessage({ type: 'refreshOneAccount', email });
      }
    });

    document.getElementById('lpActiveFilterChips')?.addEventListener('click', (ev) => {
      const btn = ev.target instanceof Element ? ev.target.closest('[data-clear]') : null;
      if (!btn) return;
      const clearKey = btn.getAttribute('data-clear');
      if (clearKey === 'all' || clearKey === 'source') {
        tokenSourceFilter = 'all';
        document.querySelectorAll('#lpSourceFilter .lp-seg-btn').forEach((b) => {
          b.classList.toggle('active', b.getAttribute('data-source') === 'all');
        });
      }
      if (clearKey === 'all' || clearKey === 'project') tokenProjectFilter = 'all';
      if (clearKey === 'all' || clearKey === 'account') tokenAccountFilter = 'all';
      if (clearKey === 'all' || clearKey === 'date') selectedHeatDate = '';
      renderTokensTab(true);
    });

    document.getElementById('lpSourceFilter')?.addEventListener('click', (ev) => {
      const btn = ev.target instanceof Element ? ev.target.closest('.lp-seg-btn') : null;
      if (!btn) return;
      const src = btn.getAttribute('data-source');
      if (!src || src === tokenSourceFilter) return;
      tokenSourceFilter = src;
      document.querySelectorAll('#lpSourceFilter .lp-seg-btn').forEach((b) => {
        b.classList.toggle('active', b.getAttribute('data-source') === src);
      });
      renderTokensTab(true);
    });

    document.getElementById('lpProjectFilter')?.addEventListener('change', (ev) => {
      tokenProjectFilter = ev.target.value || 'all';
      renderTokensTab(true);
    });

    document.getElementById('lpAccountFilter')?.addEventListener('change', (ev) => {
      tokenAccountFilter = ev.target.value || 'all';
      renderTokensTab(true);
    });

    document.getElementById('lpSessionSort')?.addEventListener('change', (ev) => {
      sessionSort = ev.target.value === 'heavy' ? 'heavy' : 'recent';
      renderTokensTab(true);
    });

    document.getElementById('lpLowCacheBtn')?.addEventListener('click', () => {
      lowCacheOnly = !lowCacheOnly;
      renderTokensTab(true);
    });

    document.getElementById('lpSessionSearch')?.addEventListener('input', (ev) => {
      sessionSearch = ev.target.value || '';
      renderTokensTab(true);
    });

    document.getElementById('lpSessionListWrap')?.addEventListener('click', (ev) => {
      const projBtn = ev.target instanceof Element ? ev.target.closest('.lp-proj-filter-btn') : null;
      if (projBtn) {
        ev.stopPropagation();
        const proj = projBtn.getAttribute('data-project') || 'all';
        tokenProjectFilter = tokenProjectFilter === proj ? 'all' : proj;
        renderTokensTab(true);
        return;
      }
      const btn = ev.target instanceof Element ? ev.target.closest('.lp-session-toggle') : null;
      const row = ev.target instanceof Element ? ev.target.closest('.lp-session-row.is-expandable') : null;
      const cid = (btn || row)?.getAttribute('data-cid');
      if (!cid) return;
      if (expandedSessionIds.has(cid)) expandedSessionIds.delete(cid);
      else expandedSessionIds.add(cid);
      renderTokensTab(true);
    });

    const modeTips = {
      weighted: l('modeWeightedTip'),
      all: l('modeAllTip'),
      net: l('modeNetTip'),
      usd: l('modeUsdTip'),
    };
    document.querySelectorAll('#lpTokenModeSeg .lp-seg-btn').forEach((b) => {
      const m = b.getAttribute('data-mode');
      if (m && modeTips[m]) b.title = modeTips[m];
    });
    document.getElementById('lpTokenModeSeg')?.addEventListener('click', (ev) => {
      const btn = ev.target instanceof Element ? ev.target.closest('.lp-seg-btn') : null;
      if (!btn) return;
      const mode = btn.getAttribute('data-mode');
      if (!mode || mode === tokenDisplayMode) return;
      tokenDisplayMode = mode;
      document.querySelectorAll('#lpTokenModeSeg .lp-seg-btn').forEach((b) => {
        b.classList.toggle('active', b.getAttribute('data-mode') === mode);
      });
      renderTokensTab(true);
    });

    document.getElementById('lpClearDayBtn')?.addEventListener('click', () => {
      selectedHeatDate = '';
      renderTokensTab(true);
    });

    document.getElementById('lpToggleUntaggedBtn')?.addEventListener('click', () => {
      showUntaggedModels = !showUntaggedModels;
      renderModelRankSection();
    });

    document.getElementById('lpTimeFilter')?.addEventListener('click', (ev) => {
      const btn = ev.target instanceof Element ? ev.target.closest('.lp-seg-btn') : null;
      if (!btn) return;
      const range = btn.getAttribute('data-range');
      if (!range) return;
      quotaRange = range;
      quotaPage = 1;
      document.querySelectorAll('#lpTimeFilter .lp-seg-btn').forEach((b) => {
        b.classList.toggle('active', b.getAttribute('data-range') === range);
      });
      renderQuotaChart(true);
      renderQuotaTable(true);
    });

    document.getElementById('lpQuotaPoolSeg')?.addEventListener('click', (ev) => {
      const btn = ev.target instanceof Element ? ev.target.closest('.lp-seg-btn') : null;
      if (!btn) return;
      const pool = btn.getAttribute('data-pool');
      if (!pool) return;
      quotaPool = pool;
      document.querySelectorAll('#lpQuotaPoolSeg .lp-seg-btn').forEach((b) => {
        b.classList.toggle('active', b.getAttribute('data-pool') === pool);
      });
      renderQuotaChart(true);
      renderQuotaTable(true);
    });

    document.getElementById('lpDirectionFilter')?.addEventListener('change', (ev) => {
      quotaDirection = ev.target.value || 'all';
      quotaPage = 1;
      renderQuotaChart(true);
      renderQuotaTable(true);
    });

    document.getElementById('lpSearchInput')?.addEventListener('input', () => {
      quotaPage = 1;
      renderQuotaChart(true);
      renderQuotaTable(true);
    });

    document.getElementById('lpQuotaPrev')?.addEventListener('click', () => {
      if (quotaPage > 1) {
        quotaPage--;
        renderQuotaTable(true);
      }
    });

    document.getElementById('lpQuotaNext')?.addEventListener('click', () => {
      quotaPage++;
      renderQuotaTable(true);
    });

    const clearBtn = document.getElementById('lpClearHistoryBtn');
    if (clearBtn) {
      clearBtn.addEventListener('click', () => {
        if (!clearConfirmPending) {
          clearConfirmPending = true;
          clearBtn.textContent = l('confirmClear');
          clearBtn.classList.add('lp-btn-danger-confirm');
          clearConfirmTimer = setTimeout(() => {
            clearConfirmPending = false;
            clearBtn.textContent = l('clearHistory');
            clearBtn.classList.remove('lp-btn-danger-confirm');
          }, 3500);
          return;
        }
        clearConfirmPending = false;
        if (clearConfirmTimer) clearTimeout(clearConfirmTimer);
        clearBtn.textContent = l('clearHistory');
        clearBtn.classList.remove('lp-btn-danger-confirm');
        vscode.postMessage({ type: 'clearHistory' });
      });
    }
  }

  // ── 接收宿主消息 ──
  window.addEventListener('message', (ev) => {
    const msg = ev.data;
    if (!msg || typeof msg !== 'object') return;

    if (msg.type === 'switchTab' && msg.tab) {
      if (typeof msg.account === 'string' && msg.account) {
        tokenAccountFilter = msg.account.toLowerCase();
        fingerprints.ledger = '';
      }
      switchTab(msg.tab);
      return;
    }

    if (msg.type === 'privacyMode') {
      privacyMode = msg.enabled === true;
      updatePrivacyButton();
      updateCurrentPill();
      renderVisibleTab(true);
      return;
    }

    if (msg.type === 'liveContextUpdate') {
      liveContext = msg.liveContext || null;
      if (activeTab === 'overview') safeRender('lpLiveBody', () => renderLiveSection());
      return;
    }

    if (msg.type === 'tokenLedgerData') {
      ledgerError = '';
      ledgerData = msg.ledger || null;
      if (activeTab === 'tokens') safeRender('lpTokenKpis', () => renderTokensTab(true));
      return;
    }

    if (msg.type === 'tokenLedgerError') {
      ledgerError = msg.error || l('actionFailed');
      if (activeTab === 'tokens') safeRender('lpTokenKpis', () => renderTokensTab(true));
      return;
    }

    if (msg.type === 'actionResult') {
      const action = msg.action || '';
      const key = msg.email
        ? (action === 'switchAccount' ? `switch:${msg.email}` : `refreshOne:${msg.email}`)
        : action;
      stopBusyAction(key);
      if (msg.ok === false) {
        showToast(msg.error || l('actionFailed'), 5000);
      } else if (action === 'refresh' || action === 'refreshLiveOnly' || action === 'rescanTokens') {
        showToast(l('refreshed'));
      } else if (action === 'switchAccount') {
        showToast(l('switchDone', maskEmail(msg.email || '')));
      } else if (action === 'clearHistory') {
        showToast(l('historyCleared'));
      }
      return;
    }

    if (msg.type === 'logData') {
      if (typeof msg.privacyMode === 'boolean') privacyMode = msg.privacyMode;
      currentEmail = msg.currentEmail || '';
      if ('liveContext' in msg) liveContext = msg.liveContext || null;
      overviewData = Array.isArray(msg.overview) ? msg.overview : [];
      poolMetrics = msg.poolMetrics || null;
      quotaHistory = Array.isArray(msg.quotaHistory) ? msg.quotaHistory : [];
      switchEvents = Array.isArray(msg.switchEvents) ? msg.switchEvents : [];
      accountTags = msg.accountTags || {};

      updatePrivacyButton();
      updateCurrentPill();
      renderVisibleTab();
    }
  });

  bindEvents();
  vscode.postMessage({ type: 'webviewReady' });
})();
