/* eslint-disable */
(function () {
  const vscode = window.vscode || acquireVsCodeApi();

  // ── i18n：宿主注入的语言包（window.LP_L）──
  const LP_L = window.LP_L || {};
  function l(key) {
    let s = LP_L[key] || key;
    for (let i = 1; i < arguments.length; i++) {
      s = String(s).split('{' + (i - 1) + '}').join(String(arguments[i]));
    }
    return s;
  }
  (function applyI18n() {
    document.querySelectorAll('[data-i18n]').forEach(el => { el.textContent = l(el.getAttribute('data-i18n')); });
    document.querySelectorAll('[data-i18n-ph]').forEach(el => { el.placeholder = l(el.getAttribute('data-i18n-ph')); });
    document.querySelectorAll('[data-i18n-title]').forEach(el => { el.title = l(el.getAttribute('data-i18n-title')); });
  })();

  let allQuotaEntries = [];
  let allQuotaEmails = [];
  let allAccountOverview = [];
  let allSummary = {};
  let currentEmail = '';
  let filterEmail = '';
  let timeRange = '24h';
  let searchQuery = '';
  let activeTag = '';
  let allTags = [];
  let emailTagMap = {};
  let quotaPage = 1;
  const PAGE_SIZE = 30;
  let privacyMode = false;
  let refreshCooldown = 0;

  const TAG_PALETTE = [
    '#8b5cf6', '#3b82f6', '#10b981', '#f59e0b', '#ef4444',
    '#ec4899', '#14b8a6', '#06b6d4', '#84cc16', '#f97316', '#6366f1',
  ];
  const tagColorsMap = {};
  function getTagColor(tag) {
    if (!tag) return TAG_PALETTE[0];
    if (tagColorsMap[tag]) return tagColorsMap[tag];
    let hash = 0;
    for (let i = 0; i < tag.length; i++) hash = ((hash << 5) - hash + tag.charCodeAt(i)) | 0;
    tagColorsMap[tag] = TAG_PALETTE[Math.abs(hash) % TAG_PALETTE.length];
    return tagColorsMap[tag];
  }

  function escHtml(s) { return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;'); }
  function shortEmail(em) { const at = em ? em.indexOf('@') : -1; return at > 0 ? em.slice(0, at) : em; }
  function maskEmail(em) {
    if (!privacyMode || !em) return em;
    const at = em.indexOf('@');
    if (at <= 0) return '***';
    return em[0] + '***' + em.slice(at);
  }
  function maskEmailShort(em) { return privacyMode ? maskEmail(em) : shortEmail(em); }

  function showToast(msg, dur) {
    const el = document.getElementById('lpToast');
    if (!el) return;
    el.textContent = msg; el.hidden = false; el.classList.add('lp-toast-show');
    setTimeout(() => { el.classList.remove('lp-toast-show'); el.hidden = true; }, dur || 2000);
  }

  // Tab 切换
  const tabs = document.querySelectorAll('.lp-tab');
  const contents = document.querySelectorAll('.lp-content');
  let activeTab = '';
  function switchTab(name) {
    activeTab = name;
    tabs.forEach(t => t.classList.toggle('active', t.getAttribute('data-tab') === name));
    contents.forEach(c => { c.hidden = c.id !== 'lp' + name.charAt(0).toUpperCase() + name.slice(1); });
    if (name === 'quota') renderQuota();
    if (name === 'overview') renderOverview();
  }
  tabs.forEach(t => t.addEventListener('click', () => switchTab(t.getAttribute('data-tab'))));
  const initialTab = document.body.getAttribute('data-initial-tab') || 'quota';
  switchTab(initialTab);

  window.addEventListener('message', ev => {
    const msg = ev.data;
    if (msg.type === 'switchTab' && msg.tab) switchTab(msg.tab);
    if (msg.type === 'allData') {
      allQuotaEntries = msg.quotaEntries || [];
      allQuotaEmails = msg.quotaEmails || [];
      allAccountOverview = msg.accountOverview || [];
      allSummary = msg.summary || {};
      currentEmail = msg.currentEmail || '';
      rebuildTagMeta();
      if (activeTab === 'overview') renderOverview();
      if (activeTab === 'quota') renderQuota();
    }
    if (msg.type === 'refreshDone') showToast(l('refreshed'));
  });

  // 隐私模式
  const privacyBtn = document.getElementById('lpPrivacy');
  if (privacyBtn) {
    privacyBtn.querySelector('svg').style.opacity = '0.6';
    privacyBtn.addEventListener('click', () => {
      privacyMode = !privacyMode;
      privacyBtn.classList.toggle('lp-btn-active', privacyMode);
      privacyBtn.querySelector('svg').style.opacity = privacyMode ? '1' : '0.6';
      renderOverview(); renderQuota();
      showToast(privacyMode ? l('privacyOn') : l('privacyOff'));
    });
  }

  // 刷新按钮
  const refreshBtn = document.getElementById('lpRefresh');
  let refreshTimer = null;
  if (refreshBtn) refreshBtn.addEventListener('click', () => {
    if (refreshCooldown > 0) return;
    vscode.postMessage({ type: 'refresh' });
    refreshCooldown = 10;
    refreshBtn.classList.add('lp-btn-cooling');
    refreshBtn.setAttribute('disabled', '');
    const tick = () => {
      refreshCooldown--;
      if (refreshCooldown <= 0) {
        refreshBtn.classList.remove('lp-btn-cooling');
        refreshBtn.removeAttribute('disabled');
        refreshBtn.innerHTML = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="23 4 23 10 17 10"/><path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10"/></svg> ' + l('refresh');
        clearInterval(refreshTimer); refreshTimer = null;
      } else {
        refreshBtn.innerHTML = '<svg class="lp-spin" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="23 4 23 10 17 10"/><path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10"/></svg> ' + refreshCooldown + 's';
      }
    };
    tick(); refreshTimer = setInterval(tick, 1000);
    showToast(l('refreshing'));
  });

  // 时间范围
  document.querySelectorAll('.lp-time-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.lp-time-btn').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      timeRange = btn.getAttribute('data-range');
      quotaPage = 1; renderQuota();
    });
  });

  // 搜索
  const emailSearch = document.getElementById('lpEmailSearch');
  if (emailSearch) {
    emailSearch.addEventListener('input', () => {
      searchQuery = emailSearch.value.toLowerCase().trim();
      quotaPage = 1; renderQuota();
    });
    emailSearch.addEventListener('keydown', e => {
      if (e.key === 'Escape') { emailSearch.value = ''; searchQuery = ''; quotaPage = 1; renderQuota(); }
    });
  }

  // 标签 chips
  const tagChipsEl = document.getElementById('lpTagChips');
  function rebuildTagMeta() {
    allTags = [];
    emailTagMap = {};
    const tagSet = new Set();
    allAccountOverview.forEach(a => {
      const tags = a.tags || [];
      emailTagMap[a.email] = tags;
      tags.forEach(t => tagSet.add(t));
    });
    allTags = Array.from(tagSet).sort();
  }
  function buildTagChips() {
    if (!tagChipsEl) return;
    const tagCounts = {};
    allTags.forEach(t => tagCounts[t] = 0);
    allAccountOverview.forEach(a => {
      (a.tags || []).forEach(t => { if (tagCounts[t] !== undefined) tagCounts[t]++; });
    });
    let html = '<span class="lp-tag-chip' + (!activeTag ? ' active' : '') + '" data-tag="">' + l('rangeAll') + '<span class="lp-tag-count">(' + allAccountOverview.length + ')</span></span>';
    allTags.forEach(t => {
      const isActive = activeTag === t;
      const tc = getTagColor(t);
      const chipStyle = isActive ? 'background:' + tc + ';color:#fff;border-color:' + tc : 'background:' + tc + '20;color:' + tc + ';border-color:' + tc + '60';
      html += '<span class="lp-tag-chip' + (isActive ? ' active' : '') + '" data-tag="' + escHtml(t) + '" style="' + chipStyle + '">' + escHtml(t) + '<span class="lp-tag-count">(' + (tagCounts[t] || 0) + ')</span></span>';
    });
    tagChipsEl.innerHTML = html;
    tagChipsEl.querySelectorAll('.lp-tag-chip').forEach(el => {
      el.addEventListener('click', () => { activeTag = el.dataset.tag || ''; buildTagChips(); quotaPage = 1; renderQuota(); });
    });
  }

  // 快捷筛选
  const btnCurrent = document.getElementById('lpBtnCurrent');
  const btnRecent = document.getElementById('lpBtnRecent');
  function setQuickFilter(val) {
    if (val === '_recent_') {
      filterEmail = '_recent_';
      searchQuery = '';
      if (emailSearch) emailSearch.value = '';
    } else if (val) {
      filterEmail = val;
      searchQuery = val.toLowerCase();
      if (emailSearch) emailSearch.value = val;
    } else {
      filterEmail = ''; searchQuery = '';
      if (emailSearch) emailSearch.value = '';
    }
    quotaPage = 1;
    if (btnCurrent) btnCurrent.classList.toggle('lp-quick-btn-active', val === currentEmail && !!currentEmail);
    if (btnRecent) btnRecent.classList.toggle('lp-quick-btn-active', val === '_recent_');
    renderQuota();
  }
  if (btnCurrent) btnCurrent.addEventListener('click', () => {
    if (!currentEmail) { showToast(l('noCurrentRecords')); return; }
    setQuickFilter(currentEmail);
  });
  if (btnRecent) btnRecent.addEventListener('click', () => setQuickFilter('_recent_'));

  // 过滤逻辑
  function isInTimeRange(ts) {
    if (timeRange === 'all') return true;
    const now = Date.now();
    const ms = { '1h': 3600e3, '24h': 86400e3, '7d': 7 * 86400e3, '30d': 30 * 86400e3 }[timeRange];
    return ms ? (now - ts) <= ms : true;
  }
  function passesFilters(entry) {
    if (!isInTimeRange(entry.ts)) return false;
    if (filterEmail) {
      if (filterEmail === '_recent_') {
        const recentEmails = allQuotaEntries.slice(-20).map(e => e.email);
        if (!recentEmails.includes(entry.email)) return false;
      } else if (entry.email !== filterEmail) return false;
    }
    if (searchQuery && !entry.email.toLowerCase().includes(searchQuery)) return false;
    if (activeTag) {
      const tags = emailTagMap[entry.email] || [];
      if (!tags.includes(activeTag)) return false;
    }
    return true;
  }

  // 渲染账号总览
  function renderOverview() {
    const accounts = allAccountOverview.slice().sort((a, b) => (a.disabled ? 1 : 0) - (b.disabled ? 1 : 0));
    const total = accounts.length;
    const active = accounts.filter(a => !a.disabled).length;
    const disabled = accounts.filter(a => a.disabled).length;
    const high = accounts.filter(a => !a.disabled && (a.usedPct === null ? false : (100 - a.usedPct) >= 80)).length;
    const low = accounts.filter(a => !a.disabled && (a.usedPct === null ? false : (100 - a.usedPct) <= 30)).length;
    const avg = allSummary.avgUsedPct || 0;

    document.getElementById('lpStatAccounts').textContent = total;
    document.getElementById('lpStatActive').textContent = active;
    document.getElementById('lpStatDisabled').textContent = disabled;
    document.getElementById('lpStatHigh').textContent = high;
    document.getElementById('lpStatLow').textContent = low;
    document.getElementById('lpStatAvgUsed').textContent = avg + '%';
    document.getElementById('lpAccountCount').textContent = l('countUnit', total);

    const tbody = document.getElementById('lpAccountBody');
    if (!accounts.length) { tbody.innerHTML = '<tr><td colspan="5" class="lp-empty">' + l('noAccounts') + '</td></tr>'; return; }
    tbody.innerHTML = accounts.map(a => {
      const remaining = a.usedPct === null ? null : (100 - a.usedPct);
      const pctText = remaining === null ? '—' : remaining + '%';
      const fillClass = remaining === null ? '' : remaining <= 10 ? 'lp-fill-danger' : remaining <= 30 ? 'lp-fill-warn' : 'lp-fill-ok';
      const statusText = a.disabled ? l('disabled') : remaining === null ? l('statusUnchecked') : remaining <= 10 ? l('statusDanger') : remaining <= 30 ? l('statusWarn') : l('statusNormal');
      const statusClass = a.disabled ? 'lp-c-dim' : remaining === null ? 'lp-c-dim' : remaining <= 10 ? 'lp-c-red' : remaining <= 30 ? 'lp-c-yellow' : 'lp-c-green';
      const tagsHtml = (a.tags || []).map(t => '<span class="lp-tag" style="background:' + getTagColor(t) + '20;color:' + getTagColor(t) + ';border-color:' + getTagColor(t) + '60">' + escHtml(t) + '</span>').join('');
      return '<tr class="' + (a.isCurrent ? 'lp-row-current' : '') + '">' +
        '<td>' + (a.isCurrent ? '<span class="lp-cur-dot">●</span>' : '') + '</td>' +
        '<td class="lp-email-cell" title="' + escHtml(a.email) + '">' + escHtml(maskEmail(a.email)) + '</td>' +
        '<td>' + tagsHtml + '</td>' +
        '<td><div class="lp-pct-cell"><span>' + pctText + '</span>' + (remaining !== null ? '<div class="lp-mini-bar"><div class="lp-mini-fill ' + fillClass + '" style="width:' + remaining + '%"></div></div>' : '') + '</div></td>' +
        '<td class="' + statusClass + '">' + statusText + '</td>' +
      '</tr>';
    }).join('');
  }

  // 渲染配额历史
  function renderQuota() {
    buildTagChips();
    const filtered = allQuotaEntries.filter(passesFilters);
    const countEl = document.getElementById('lpQuotaCount');
    if (countEl) countEl.textContent = l('entriesUnit', filtered.length);

    renderChart(filtered);
    renderQuotaTable(filtered);
  }

  function renderChart(entries) {
    const svg = document.getElementById('lpChart');
    if (!svg) return;
    const W = svg.clientWidth || 600;
    const H = 200;
    const PAD_L = 0, PAD_R = 0, PAD_T = 4, PAD_B = 20;
    const gw = W - PAD_L - PAD_R;
    const gh = H - PAD_T - PAD_B;

    function buildGrid() {
      let g = '';
      for (let i = 0; i <= 5; i++) {
        const y = PAD_T + gh * (i / 5);
        g += '<line x1="' + PAD_L + '" y1="' + y + '" x2="' + (W - PAD_R) + '" y2="' + y + '" stroke="var(--lp-chart-grid)" stroke-width="1"' + (i === 0 || i === 5 ? '' : ' stroke-dasharray="3,3"') + '/>';
      }
      // 警戒线和危险线（剩余 30% / 10%）
      [30, 10].forEach(pct => {
        const y = PAD_T + gh * ((100 - pct) / 100);
        g += '<line x1="' + PAD_L + '" y1="' + y + '" x2="' + (W - PAD_R) + '" y2="' + y + '" stroke="' + (pct === 30 ? 'rgba(255,200,50,0.4)' : 'rgba(255,80,80,0.4)') + '" stroke-width="1" stroke-dasharray="4,4"/>';
      });
      return g;
    }

    if (entries.length < 2) {
      const cx = W / 2, cy = H / 2;
      svg.innerHTML = buildGrid() + '<text x="' + cx + '" y="' + cy + '" text-anchor="middle" fill="var(--lp-fg-dim)" font-size="13" font-weight="500">' + escHtml(l('noDataPoints')) + '</text>';
      return;
    }

    const sorted = entries.slice().sort((a, b) => a.ts - b.ts);
    const minTs = sorted[0].ts;
    const maxTs = sorted[sorted.length - 1].ts;
    const span = Math.max(1, maxTs - minTs);

    function point(e) {
      const x = PAD_L + gw * ((e.ts - minTs) / span);
      const y = PAD_T + gh * ((100 - e.remaining) / 100);
      return [x, y];
    }

    // 按账号分组绘制线条
    const byEmail = {};
    sorted.forEach(e => { (byEmail[e.email] = byEmail[e.email] || []).push(e); });
    const colors = ['#5b9aff', '#ff9a5b', '#3fb950', '#ec4899', '#8b5cf6', '#f59e0b', '#06b6d4', '#84cc16'];
    let colorIdx = 0;
    let paths = '';
    Object.keys(byEmail).forEach(email => {
      const pts = byEmail[email].map(point);
      if (pts.length < 1) return;
      const color = colors[colorIdx++ % colors.length];
      let d = 'M ' + pts[0][0] + ' ' + pts[0][1];
      for (let i = 1; i < pts.length; i++) d += ' L ' + pts[i][0] + ' ' + pts[i][1];
      paths += '<path d="' + d + '" fill="none" stroke="' + color + '" stroke-width="1.5" opacity="0.85"/>';
      pts.forEach(p => { paths += '<circle cx="' + p[0] + '" cy="' + p[1] + '" r="2.5" fill="' + color + '" opacity="0.9"/>'; });
    });

    svg.innerHTML = buildGrid() + paths;
  }

  function renderQuotaTable(entries) {
    const tbody = document.getElementById('lpQuotaBody');
    const pagination = document.getElementById('lpQuotaPagination');
    if (!entries.length) {
      tbody.innerHTML = '<tr><td colspan="5" class="lp-empty">' + l('noHistory') + '</td></tr>';
      pagination.innerHTML = '';
      return;
    }

    const total = entries.length;
    const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));
    quotaPage = Math.min(quotaPage, totalPages);
    const start = (quotaPage - 1) * PAGE_SIZE;
    const pageItems = entries.slice().reverse().slice(start, start + PAGE_SIZE);

    tbody.innerHTML = pageItems.map(entry => {
      const time = new Date(entry.ts).toLocaleString(LP_L.__lang === 'en' ? 'en' : 'zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });
      const deltaStr = entry.delta > 0 ? '<span class="lp-c-green">+' + entry.delta + '%</span>'
        : entry.delta < 0 ? '<span class="lp-c-red">' + entry.delta + '%</span>'
        : '<span class="lp-c-dim">0</span>';
      const tierBadge = entry.tierId ? '<span class="lp-tag">' + escHtml(entry.tierId) + '</span>' : '';
      return '<tr>' +
        '<td>' + time + '</td>' +
        '<td class="lp-email-cell" title="' + escHtml(entry.email) + '">' + escHtml(maskEmailShort(entry.email)) + '</td>' +
        '<td>' + entry.remaining + '%</td>' +
        '<td>' + deltaStr + '</td>' +
        '<td>' + tierBadge + '</td>' +
      '</tr>';
    }).join('');

    // 分页
    let pgHtml = '<span class="lp-page-info">' + escHtml(l('pageInfo', quotaPage, totalPages, total)) + '</span>';
    pgHtml += '<button class="lp-page-btn" ' + (quotaPage <= 1 ? 'disabled' : '') + ' data-page="prev">' + l('prevPage') + '</button>';
    pgHtml += '<button class="lp-page-btn" ' + (quotaPage >= totalPages ? 'disabled' : '') + ' data-page="next">' + l('nextPage') + '</button>';
    pagination.innerHTML = pgHtml;
    pagination.querySelectorAll('.lp-page-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        const dir = btn.getAttribute('data-page');
        if (dir === 'prev') quotaPage--; else if (dir === 'next') quotaPage++;
        renderQuotaTable(entries);
      });
    });
  }

  // 图表 resize 自适应
  let resizeDebounce = null;
  const chartWrap = document.querySelector('.lp-chart-wrap');
  if (chartWrap && typeof ResizeObserver !== 'undefined') {
    new ResizeObserver(() => {
      if (resizeDebounce) clearTimeout(resizeDebounce);
      resizeDebounce = setTimeout(() => { if (activeTab === 'quota') renderQuota(); }, 120);
    }).observe(chartWrap);
  }

  // 初始请求数据
  vscode.postMessage({ type: 'refresh' });
})();
