/* eslint-disable */
const ERROR_TOAST_PROTECT_MS = 10000;
const vscode = acquireVsCodeApi();

window.onerror = function (msg, url, line, col, err) {
  document.title = 'ERR: ' + msg + ' @L' + line;
  const d = document.createElement('pre');
  d.style.cssText = 'position:fixed;top:0;left:0;right:0;z-index:99999;background:red;color:white;font-size:12px;padding:8px;white-space:pre-wrap;';
  d.textContent = msg + '\nLine: ' + line + ', Col: ' + col + '\n' + ((err && err.stack) || '');
  document.body.prepend(d);
  try {
    vscode.postMessage({ type: 'webviewError', message: String(msg), line: line, col: col, stack: (err && err.stack) || '' });
  } catch (e) {}
};

// ── i18n：宿主按当前语言注入的语言包 + 静态 DOM 文案应用 ──
const L = window.__KITE_I18N__ || {};
function tl(key) {
  let s = L[key] || key;
  for (let i = 1; i < arguments.length; i++) {
    s = String(s).split('{' + (i - 1) + '}').join(String(arguments[i]));
  }
  return s;
}
(function applyI18n() {
  document.querySelectorAll('[data-i18n]').forEach(el => {
    const v = L[el.getAttribute('data-i18n')];
    if (v !== undefined) el.textContent = v;
  });
  document.querySelectorAll('[data-i18n-ph]').forEach(el => {
    el.placeholder = tl(el.getAttribute('data-i18n-ph'));
  });
  document.querySelectorAll('[data-i18n-title]').forEach(el => {
    el.title = tl(el.getAttribute('data-i18n-title'));
  });
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
let filterPlans = new Set(); // 套餐过滤
let sortBy = 'recommend';
let sortDir = 'desc';
let pageSize = 20;
let currentPage = 1;
let privacyMode = false;
let tagEditMode = null; // null | 'edit' | 'batch'
let tagEditEmail = null;
let tagEditBatchEmails = null;
let tagEditPendingTags = [];
let selectMode = false;
const selectedEmails = new Set();
let statsCollapsed = false;
let cardViewMode = 'classic';
let showCardTokens = true;
let perAccountTokens = {};
let lastTodayStats = null;

// 恢复过滤器与视图排序/分页偏好
try {
  const st = vscode.getState() || {};
  if (st._filterTags) filterTags = new Set(st._filterTags);
  if (st._sortBy && ['default', 'recommend', 'email', 'time'].includes(st._sortBy)) sortBy = st._sortBy;
  if (st._sortDir === 'asc' || st._sortDir === 'desc') sortDir = st._sortDir;
  if (typeof st._pageSize === 'number' && [0, 10, 20, 50].includes(st._pageSize)) pageSize = st._pageSize;
  if (typeof st._statsCollapsed === 'boolean') statsCollapsed = st._statsCollapsed;
} catch (e) {}

function persistViewPrefs() {
  try {
    const st = vscode.getState() || {};
    st._sortBy = sortBy;
    st._sortDir = sortDir;
    st._pageSize = pageSize;
    st._statsCollapsed = statsCollapsed;
    vscode.setState(st);
  } catch (e) {}
}
function syncStatsCollapseUI() {
  const btn = document.getElementById('statsCollapseBtn');
  const drawer = document.getElementById('sidebarStatsDrawer');
  if (btn) {
    btn.classList.toggle('is-collapsed', statsCollapsed);
    btn.setAttribute('aria-expanded', statsCollapsed ? 'false' : 'true');
  }
  if (drawer) {
    drawer.classList.toggle('is-collapsed', statsCollapsed);
  }
}
function applySortDirIcon() {
  const btn = document.getElementById('sortDirectionBtn');
  if (!btn) return;
  const wrap = btn.querySelector('svg');
  if (wrap) wrap.style.transform = sortDir === 'asc' ? 'rotate(180deg)' : 'rotate(0deg)';
}
(function syncInitialViewPrefs() {
  const sEl = document.getElementById('sortSelect');
  if (sEl) sEl.value = sortBy;
  const pEl = document.getElementById('pageSizeSelect');
  if (pEl) pEl.value = String(pageSize);
  applySortDirIcon();
  syncStatsCollapseUI();

  const collapseBtn = document.getElementById('statsCollapseBtn');
  if (collapseBtn) {
    collapseBtn.addEventListener('click', () => {
      statsCollapsed = !statsCollapsed;
      syncStatsCollapseUI();
      persistViewPrefs();
    });
  }
  const todayStrip = document.getElementById('sbTodayStripBtn');
  if (todayStrip) todayStrip.addEventListener('click', () => vscode.postMessage({ type: 'openStatsPanel', tab: 'tokens' }));
  const todayWrap = document.getElementById('sbTodayWrap');
  const todayPop = document.getElementById('sbTodayPopover');
  if (todayWrap && todayPop) {
    const showPop = () => {
      if (statsCollapsed || !lastTodayStats) return;
      todayPop.hidden = false;
    };
    const hidePop = () => { todayPop.hidden = true; };
    todayWrap.addEventListener('mouseenter', showPop);
    todayWrap.addEventListener('mouseleave', hidePop);
    todayWrap.addEventListener('focusin', showPop);
    todayWrap.addEventListener('focusout', hidePop);
  }
})();

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
  try { const st = vscode.getState() || {}; st._filterTags = [...filterTags]; vscode.setState(st); } catch (e) {}
}

const _escDiv = document.createElement('div');
function escHtml(text) {
  _escDiv.textContent = text;
  return _escDiv.innerHTML;
}
function attrEsc(text) {
  return escHtml(String(text)).replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

function maskEmail(email) {
  if (!email) return '';
  const at = email.indexOf('@');
  if (at <= 0) return email.slice(0, 2) + '***';
  const name = email.slice(0, at);
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
  if (pct < 10) return 'is-danger';
  if (pct < 30) return 'is-warn';
  if (pct < 50) return 'is-info';
  return 'is-ok';
}

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

function planChipIcon(tierClass) {
  if (tierClass === 'tier-pro') {
    return '<svg width="10" height="10" viewBox="0 0 24 24" fill="currentColor" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M2.7 10.3a2.41 2.41 0 0 0 0 3.41l7.59 7.59a2.41 2.41 0 0 0 3.41 0l7.59-7.59a2.41 2.41 0 0 0 0-3.41l-7.59-7.59a2.41 2.41 0 0 0-3.41 0Z"/></svg>';
  }
  if (tierClass === 'tier-ultra') {
    return '<svg width="10" height="10" viewBox="0 0 24 24" fill="currentColor" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M10.5 3 8 9l4 13 4-13-2.5-6"/><path d="M17 3a2 2 0 0 1 1.6.8l3 4a2 2 0 0 1 .013 2.382l-7.99 10.986a2 2 0 0 1-3.247 0l-7.99-10.986A2 2 0 0 1 2.4 7.8l2.998-3.997A2 2 0 0 1 7 3z"/><path d="M2 9h20"/></svg>';
  }
  if (tierClass === 'tier-plus') {
    return '<svg width="10" height="10" viewBox="0 0 24 24" fill="currentColor" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="1"/><circle cx="12" cy="12" r="10"/></svg>';
  }
  if (tierClass === 'tier-free' || tierClass === 'tier-unknown') {
    return '<svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/></svg>';
  }
  return '';
}

function planTierLabel(tierId) {
  if (!tierId) return '...';
  const s = String(tierId);
  const t = s.toLowerCase();
  const mult = /(\d+x)/i.exec(s);
  if (t.includes('ultra') || t.includes('helium')) return 'Ultra' + (mult ? ' ' + mult[1] : '');
  if (t.includes('plus')) return 'Plus';
  if (t.includes('free') || t.includes('starter')) return 'Free';
  if (t.includes('pro') || t.includes('premium') || t.includes('advanced')) return 'Pro';
  if (t.includes('trial')) return 'Trial';
  if (t.includes('enterprise') || t.includes('standard') || t.includes('business') || t.startsWith('gcp_') || t.includes('vertex')) return 'Enterprise';
  if (t.includes('team')) return 'Team';
  return s;
}

// ── 刷新按钮旋转态 ──
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
  const modal = document.getElementById('addAccountModal');
  if (modal) modal.hidden = false;
}
function hideAddModal() {
  const modal = document.getElementById('addAccountModal');
  if (modal) modal.hidden = true;
}

const _addBtn = document.getElementById('addAccountBtn');
if (_addBtn) _addBtn.addEventListener('click', showAddModal);
const _closeAddBtn = document.getElementById('closeAddModal');
if (_closeAddBtn) _closeAddBtn.addEventListener('click', hideAddModal);
const _addModal = document.getElementById('addAccountModal');
if (_addModal) {
  _addModal.addEventListener('click', (e) => {
    if (e.target === _addModal) hideAddModal();
  });
}
const _btnOAuth = document.getElementById('btnOAuth');
if (_btnOAuth) _btnOAuth.addEventListener('click', () => { hideAddModal(); vscode.postMessage({ type: 'oauthLogin' }); });
const _btnImport = document.getElementById('btnImport');
if (_btnImport) _btnImport.addEventListener('click', () => { hideAddModal(); vscode.postMessage({ type: 'importLocal' }); });
const _btnImportCockpit = document.getElementById('btnImportCockpit');
if (_btnImportCockpit) _btnImportCockpit.addEventListener('click', () => { hideAddModal(); vscode.postMessage({ type: 'importFromCockpitTools' }); });
const _btnImportManager = document.getElementById('btnImportManager');
if (_btnImportManager) _btnImportManager.addEventListener('click', () => { hideAddModal(); vscode.postMessage({ type: 'importFromAntigravityManager' }); });
const _btnImportJson = document.getElementById('btnImportJson');
if (_btnImportJson) _btnImportJson.addEventListener('click', () => { hideAddModal(); vscode.postMessage({ type: 'importFromJsonFile' }); });

// 搜索功能
const _searchInput = document.getElementById('searchInput');
const _searchClear = document.getElementById('searchClear');
if (_searchInput) {
  _searchInput.addEventListener('input', (e) => {
    searchTerm = e.target.value.toLowerCase();
    currentPage = 1;
    if (_searchClear) _searchClear.hidden = !searchTerm;
    renderAccounts();
  });
}
if (_searchClear) {
  _searchClear.addEventListener('click', () => {
    if (_searchInput) _searchInput.value = '';
    searchTerm = '';
    currentPage = 1;
    _searchClear.hidden = true;
    renderAccounts();
  });
}

// 排序与分页大小
const _sortSelect = document.getElementById('sortSelect');
if (_sortSelect) {
  _sortSelect.addEventListener('change', (e) => {
    sortBy = e.target.value;
    currentPage = 1;
    persistViewPrefs();
    renderAccounts();
  });
}
const _pageSizeSelect = document.getElementById('pageSizeSelect');
if (_pageSizeSelect) {
  _pageSizeSelect.addEventListener('change', (e) => {
    pageSize = parseInt(e.target.value, 10) || 0;
    currentPage = 1;
    persistViewPrefs();
    renderAccounts();
  });
}

// 刷新全部
const _refreshAllBtn = document.getElementById('refreshAllBtn');
if (_refreshAllBtn) {
  _refreshAllBtn.addEventListener('click', () => {
    setRefreshSpinning(REFRESH_SPIN_SELECTOR, true);
    vscode.postMessage({ type: 'refreshAll' });
  });
}

// 隐私模式（eye / eye-off 双态图标，BuddyRelay 同款路径）
const PRIVACY_EYE_SVG = '<svg class="privacy-eye" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M1 12s4-7 11-7 11 7 11 7-4 7-11 7S1 12 1 12z"/><circle cx="12" cy="12" r="3"/></svg>';
const PRIVACY_EYE_OFF_SVG = '<svg class="privacy-eye" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M17.94 17.94A10.94 10.94 0 0 1 12 19C5 19 1 12 1 12a20.29 20.29 0 0 1 5.06-5.94"/><path d="M9.9 4.24A10.84 10.84 0 0 1 12 4c7 0 11 8 11 8a20.88 20.88 0 0 1-2.16 3.19"/><path d="M14.12 14.12A3 3 0 0 1 9.88 9.88"/><line x1="1" y1="1" x2="23" y2="23"/></svg>';

function syncPrivacyBtnUI() {
  const btn = document.getElementById('privacyModeBtn');
  if (!btn) return;
  btn.classList.toggle('is-active', privacyMode);
  btn.innerHTML = privacyMode ? PRIVACY_EYE_OFF_SVG : PRIVACY_EYE_SVG;
  btn.title = privacyMode ? tl('privacyOn') : tl('privacyOff');
}

const _privacyModeBtn = document.getElementById('privacyModeBtn');
if (_privacyModeBtn) {
  _privacyModeBtn.addEventListener('click', () => {
    privacyMode = !privacyMode;
    syncPrivacyBtnUI();
    vscode.postMessage({ type: 'privacyChanged', enabled: privacyMode });
    renderAccounts();
  });
}

(function initPrivacyMode() {
  let saved = false;
  try { saved = !!(vscode.getState() && vscode.getState()._privacy); } catch (e) {}
  if (!saved) return;
  privacyMode = true;
  syncPrivacyBtnUI();
})();

// 导出按钮
const _exportBtn = document.getElementById('exportAccountsBtn');
if (_exportBtn) _exportBtn.addEventListener('click', () => vscode.postMessage({ type: 'exportAccounts' }));

// 排序方向
const _sortDirBtn = document.getElementById('sortDirectionBtn');
if (_sortDirBtn) {
  _sortDirBtn.addEventListener('click', () => {
    sortDir = sortDir === 'desc' ? 'asc' : 'desc';
    applySortDirIcon();
    persistViewPrefs();
    currentPage = 1;
    renderAccounts();
  });
}

// 筛选下拉
const _filterTrigger = document.getElementById('filterTrigger');
const _filterDropdown = document.getElementById('filterDropdown');
const _filterClearBtn = document.getElementById('filterClearBtn');

function filterCheckRow(kind, value, count, checked, label) {
  return '<label class="filter-option-check"><input type="checkbox" data-kind="' + kind + '" data-value="' + attrEsc(value) + '"' + (checked ? ' checked' : '') + '><span>' + escHtml(label || value) + '</span><span style="margin-left:auto;opacity:0.55;font-size:12px">' + count + '</span></label>';
}

function renderFilterDropdown() {
  const planSec = document.getElementById('filterPlanSection');
  const tagSec = document.getElementById('filterTagSection');
  const planList = document.getElementById('filterPlanList');
  const tagList = document.getElementById('filterTagList');
  const statusList = document.getElementById('filterStatusList');
  if (!planList || !tagList || !statusList) return;
  try {
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
  } catch (err) {
    console.error('[kite] renderFilterDropdown failed:', err);
    const errMsg = err && err.message ? err.message : String(err);
    planList.innerHTML = '<div class="panel-render-error">' + escHtml(tl('renderPanelError', errMsg)) + '</div>';
    tagList.innerHTML = '';
    statusList.innerHTML = '';
  }
}

function updateFilterTriggerLabel() {
  const n = filterPlans.size + filterTags.size + (activeFilter !== 'all' ? 1 : 0);
  const label = document.getElementById('filterLabel');
  if (label) label.textContent = n > 0 ? tl('filteredCount', n) : tl('filterAll');
}

if (_filterTrigger && _filterDropdown) {
  _filterTrigger.addEventListener('click', (e) => {
    e.stopPropagation();
    if (_filterDropdown.hidden) renderFilterDropdown();
    _filterDropdown.hidden = !_filterDropdown.hidden;
  });
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

function clearAllFilters() {
  searchTerm = '';
  const searchEl = document.getElementById('searchInput');
  if (searchEl) searchEl.value = '';
  const clearEl = document.getElementById('searchClear');
  if (clearEl) clearEl.hidden = true;
  activeFilter = 'all';
  filterTags.clear();
  filterPlans.clear();
  persistTagFilters();
  renderFilterDropdown();
  updateFilterTriggerLabel();
  currentPage = 1;
  renderAccounts();
}

function toggleTagFilter(tag) {
  if (!tag) return;
  if (filterTags.has(tag)) filterTags.delete(tag);
  else filterTags.add(tag);
  persistTagFilters();
  currentPage = 1;
  updateFilterTriggerLabel();
  renderAccounts();
}

const _activeFilterBar = document.getElementById('activeFilterBar');
if (_activeFilterBar) {
  _activeFilterBar.addEventListener('click', (e) => {
    if (e.target.closest('#activeFilterClearBtn')) {
      clearAllFilters();
      return;
    }
    const pill = e.target.closest('.active-filter-pill');
    if (!pill) return;
    const kind = pill.dataset.clear;
    const val = pill.dataset.val;
    if (kind === 'search') {
      searchTerm = '';
      const searchEl = document.getElementById('searchInput');
      if (searchEl) searchEl.value = '';
      const clearEl = document.getElementById('searchClear');
      if (clearEl) clearEl.hidden = true;
    } else if (kind === 'status') {
      activeFilter = 'all';
    } else if (kind === 'plan' && val) {
      filterPlans.delete(val);
    } else if (kind === 'tag' && val) {
      filterTags.delete(val);
      persistTagFilters();
    }
    currentPage = 1;
    renderFilterDropdown();
    updateFilterTriggerLabel();
    renderAccounts();
  });
}

function renderActiveFilterBar() {
  const bar = document.getElementById('activeFilterBar');
  if (!bar) return;
  const pills = [];
  if (searchTerm) {
    pills.push('<button type="button" class="active-filter-pill" data-clear="search">' + escHtml(searchTerm) + '<span class="pill-x">×</span></button>');
  }
  if (activeFilter !== 'all') {
    const statusTxt = activeFilter === 'active' ? tl('active') : tl('disabled');
    pills.push('<button type="button" class="active-filter-pill" data-clear="status">' + escHtml(statusTxt) + '<span class="pill-x">×</span></button>');
  }
  filterPlans.forEach(p => {
    pills.push('<button type="button" class="active-filter-pill" data-clear="plan" data-val="' + attrEsc(p) + '">' + escHtml(planTierLabel(p)) + '<span class="pill-x">×</span></button>');
  });
  filterTags.forEach(t => {
    pills.push('<button type="button" class="active-filter-pill" data-clear="tag" data-val="' + attrEsc(t) + '">' + escHtml(t) + '<span class="pill-x">×</span></button>');
  });
  if (pills.length === 0) {
    bar.hidden = true;
    bar.innerHTML = '';
    return;
  }
  bar.hidden = false;
  bar.innerHTML = '<span class="active-filter-label">' + escHtml(tl('activeFilters')) + '</span>'
    + pills.join('')
    + '<button type="button" class="active-filter-clear" id="activeFilterClearBtn">' + escHtml(tl('clearFilterShort')) + '</button>';
}

if (_filterClearBtn) {
  _filterClearBtn.addEventListener('click', () => {
    activeFilter = 'all';
    filterTags.clear();
    filterPlans.clear();
    persistTagFilters();
    renderFilterDropdown();
    updateFilterTriggerLabel();
    currentPage = 1;
    renderAccounts();
    if (_filterDropdown) _filterDropdown.hidden = true;
  });
}
updateFilterTriggerLabel();

// ── 多选模式 ──
const _selectModeBtn = document.getElementById('selectModeBtn');
if (_selectModeBtn) {
  _selectModeBtn.addEventListener('click', () => {
    selectMode = !selectMode;
    _selectModeBtn.classList.toggle('is-active', selectMode);
    const bb = document.getElementById('batchBar');
    if (bb) bb.hidden = !selectMode;
    if (!selectMode) selectedEmails.clear();
    updateBatchCount();
    renderAccounts();
  });
}

function updateBatchCount() {
  const el = document.getElementById('batchCount');
  if (el) el.textContent = tl('selectedCount', selectedEmails.size);
  const allCb = document.getElementById('batchCheckAll');
  const visible = getVisibleAccounts();
  if (allCb) allCb.checked = visible.length > 0 && visible.every(a => selectedEmails.has(a.email));
}

function accountMatchesSearch(a, term) {
  if (!term) return true;
  if ((a.email || '').toLowerCase().includes(term)) return true;
  if ((a.name || '').toLowerCase().includes(term)) return true;
  return getAccTags(a).some(t => t.toLowerCase().includes(term));
}

function getVisibleAccounts() {
  let list = accounts.slice();
  if (searchTerm) list = list.filter(a => accountMatchesSearch(a, searchTerm));
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

const _batchCheckAll = document.getElementById('batchCheckAll');
if (_batchCheckAll) {
  _batchCheckAll.addEventListener('change', (e) => {
    const visible = getVisibleAccounts();
    if (e.target.checked) visible.forEach(a => selectedEmails.add(a.email));
    else visible.forEach(a => selectedEmails.delete(a.email));
    updateBatchCount();
    renderAccounts();
  });
}

const _batchTagBtn = document.getElementById('batchTagBtn');
if (_batchTagBtn) {
  _batchTagBtn.addEventListener('click', () => {
    if (selectedEmails.size === 0) { showToast(tl('pickFirst'), 'warning'); return; }
    openTagEditModalBatch([...selectedEmails]);
  });
}
const _batchEnableBtn = document.getElementById('batchEnableBtn');
if (_batchEnableBtn) {
  _batchEnableBtn.addEventListener('click', () => {
    if (selectedEmails.size === 0) return;
    vscode.postMessage({ type: 'batchEnable', emails: [...selectedEmails] });
  });
}
const _batchDisableBtn = document.getElementById('batchDisableBtn');
if (_batchDisableBtn) {
  _batchDisableBtn.addEventListener('click', () => {
    if (selectedEmails.size === 0) return;
    vscode.postMessage({ type: 'batchDisable', emails: [...selectedEmails] });
  });
}
const _batchDeleteBtn = document.getElementById('batchDeleteBtn');
if (_batchDeleteBtn) {
  _batchDeleteBtn.addEventListener('click', () => {
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
  });
}
const _batchExportBtn = document.getElementById('batchExportBtn');
if (_batchExportBtn) {
  _batchExportBtn.addEventListener('click', () => {
    if (selectedEmails.size === 0) { showToast(tl('pickFirst'), 'warning'); return; }
    vscode.postMessage({ type: 'batchExport', emails: [...selectedEmails] });
  });
}
const _batchCancelBtn = document.getElementById('batchCancelBtn');
if (_batchCancelBtn) {
  _batchCancelBtn.addEventListener('click', () => {
    selectMode = false;
    selectedEmails.clear();
    if (_selectModeBtn) _selectModeBtn.classList.remove('is-active');
    const bb = document.getElementById('batchBar');
    if (bb) bb.hidden = true;
    updateBatchCount();
    renderAccounts();
  });
}

// ── 标签编辑弹窗 ──
function openTagEditModal(email) {
  tagEditMode = 'edit';
  tagEditEmail = email;
  tagEditBatchEmails = null;
  const acc = accounts.find(a => a.email === email);
  tagEditPendingTags = acc ? [...getAccTags(acc)] : [];
  document.getElementById('tagEditOverlay').hidden = false;
  document.getElementById('tagEditTitle').textContent = tl('editTagsFor', privacyMode ? maskEmail(email) : email.split('@')[0]);
  renderTagEditUI();
}
function openTagEditModalBatch(emails) {
  tagEditMode = 'batch';
  tagEditEmail = null;
  tagEditBatchEmails = [...emails];
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
  try {
    if (tagEditPendingTags.length === 0) {
      selectedEl.innerHTML = '<span style="color:var(--muted);font-size:12px">' + escHtml(tl('noTags')) + '</span>';
    } else {
      selectedEl.innerHTML = tagEditPendingTags.map(t => {
        return '<span class="tag-edit-chip" data-tag="' + attrEsc(t) + '">' + escHtml(t) + '<span class="tag-edit-remove">×</span></span>';
      }).join('');
    }
    const allTags = getTagList();
    const pending = new Set(tagEditPendingTags);
    existingEl.innerHTML = allTags.map(t => {
      const selected = pending.has(t);
      return '<span class="tag-edit-opt' + (selected ? ' is-selected' : '') + '" data-tag="' + attrEsc(t) + '" role="button" tabindex="0">'
        + '<span class="tag-edit-opt-label">' + escHtml(t) + '</span>'
        + '<button type="button" class="tag-edit-opt-del" data-tag="' + attrEsc(t) + '" title="' + attrEsc(tl('deleteTagTitle')) + '" aria-label="' + attrEsc(tl('deleteTagTitle')) + '">×</button>'
        + '</span>';
    }).join('') || '<span style="color:var(--muted);font-size:12px">' + escHtml(tl('noTags')) + '</span>';
  } catch (err) {
    console.error('[kite] renderTagEditUI failed:', err);
    const errMsg = err && err.message ? err.message : String(err);
    selectedEl.innerHTML = '<div class="panel-render-error">' + escHtml(tl('renderPanelError', errMsg)) + '</div>';
    existingEl.innerHTML = '';
  }
}

(function bindTagEditDelegation() {
  const selectedEl = document.getElementById('tagEditSelected');
  const existingEl = document.getElementById('tagEditExisting');
  if (selectedEl) {
    selectedEl.addEventListener('click', (e) => {
      const rem = e.target.closest('.tag-edit-remove');
      if (!rem) return;
      const chip = rem.closest('.tag-edit-chip');
      if (!chip) return;
      e.stopPropagation();
      tagEditPendingTags = tagEditPendingTags.filter(x => x !== chip.dataset.tag);
      renderTagEditUI();
    });
  }
  const toggleOptTag = (tag) => {
    if (!tag) return;
    if (tagEditPendingTags.includes(tag)) tagEditPendingTags = tagEditPendingTags.filter(x => x !== tag);
    else tagEditPendingTags.push(tag);
    renderTagEditUI();
  };
  if (existingEl) {
    existingEl.addEventListener('click', (e) => {
      const delBtn = e.target.closest('.tag-edit-opt-del');
      if (delBtn) {
        e.stopPropagation();
        const tag = delBtn.dataset.tag;
        if (!tag) return;
        const affected = accounts.filter(a => getAccTags(a).includes(tag)).length;
        showConfirm(tl('confirmDeleteTag', tag, affected), {
          title: tl('deleteTagTitle'),
          okText: tl('deleteTagBtn'),
          onConfirm: () => {
            tagEditPendingTags = tagEditPendingTags.filter(x => x !== tag);
            if (filterTags.has(tag)) {
              filterTags.delete(tag);
              persistTagFilters();
              renderFilterDropdown();
              updateFilterTriggerLabel();
            }
            accounts.forEach(a => {
              if (Array.isArray(a.tags)) a.tags = a.tags.filter(x => x !== tag);
              if (a.tag === tag) delete a.tag;
            });
            renderTagEditUI();
            renderAccounts();
            vscode.postMessage({ type: 'deleteTag', tag });
          }
        });
        return;
      }
      const opt = e.target.closest('.tag-edit-opt');
      if (opt) toggleOptTag(opt.dataset.tag);
    });
    existingEl.addEventListener('keydown', (e) => {
      if (e.target.closest('.tag-edit-opt-del')) return;
      const opt = e.target.closest('.tag-edit-opt');
      if (opt && (e.key === 'Enter' || e.key === ' ')) {
        e.preventDefault();
        toggleOptTag(opt.dataset.tag);
      }
    });
  }
})();

function addTagFromInput() {
  const input = document.getElementById('tagEditInput');
  if (!input) return;
  const newTag = input.value.trim();
  if (!newTag) return;
  if (!tagEditPendingTags.includes(newTag)) {
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
    privacyMode = !!msg.enabled;
    syncPrivacyBtnUI();
    try { const st = vscode.getState() || {}; st._privacy = privacyMode; vscode.setState(st); } catch (err) {}
    renderAccounts();
  }
  if (msg.type === 'sidebarStats') {
    updateSidebarTodayStats(msg);
  }
  if (msg.type === 'accounts') {
    accounts = msg.accounts || [];
    currentEmail = msg.currentEmail || '';
    if (msg.perAccountTokens && typeof msg.perAccountTokens === 'object') {
      perAccountTokens = msg.perAccountTokens;
    }
    if (typeof msg.privacyMode === 'boolean' && msg.privacyMode !== privacyMode) {
      privacyMode = msg.privacyMode;
      syncPrivacyBtnUI();
      try { const st = vscode.getState() || {}; st._privacy = privacyMode; vscode.setState(st); } catch (err) {}
    }
    const validTagSet = new Set(getTagList());
    let filterTagChanged = false;
    for (const ft of [...filterTags]) {
      if (!validTagSet.has(ft)) { filterTags.delete(ft); filterTagChanged = true; }
    }
    if (filterTagChanged) {
      persistTagFilters();
      renderFilterDropdown();
      updateFilterTriggerLabel();
    }
    const tagEditOv = document.getElementById('tagEditOverlay');
    if (tagEditOv && !tagEditOv.hidden) {
      renderTagEditUI();
    }
    renderAccounts();
    updateSummary();
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
    const idx = accounts.findIndex(a => a.email === msg.email);
    if (idx >= 0 && msg.health) accounts[idx].health = msg.health;
    renderAccounts();
    updateSummary();
  }
  if (msg.type === 'healthResult') {
    healthCheckingEmail = null;
    const idx = accounts.findIndex(a => a.email === msg.email);
    if (idx >= 0 && msg.health) accounts[idx].health = msg.health;
    renderAccounts();
    updateSummary();
    if (msg.health && msg.health.status === 'banned') {
      showToast(tl('healthBannedToast', displayEmail(msg.email)), 'error');
    } else if (msg.health && msg.health.status === 'auth_invalid') {
      showToast(tl('healthAuthToast', displayEmail(msg.email)), 'warning');
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
    openSettingsModal(msg.section);
  }
  if (msg.type === 'authWait') {
    setAuthWaitBar(msg.action, !!msg.active);
  }
  if (msg.type === 'switchResult') {
    clearSwitchingState();
    renderAccounts();
  }
  if (msg.type === 'cdpStatus') {
    renderCdpStatus(msg);
  }
  if (msg.type === 'refreshProgress') {
    const badge = document.getElementById('refreshProgressBadge');
    const btn = document.getElementById('refreshAllBtn');
    const total = Number(msg.total) || 0;
    const done = Number(msg.done) || 0;
    if (badge && btn && total > 0) {
      badge.textContent = done + '/' + total;
      badge.hidden = false;
      btn.classList.add('has-progress');
    }
  }
  if (msg.type === 'refreshDone') {
    if (msg.scope === 'all') {
      setRefreshSpinning(REFRESH_SPIN_SELECTOR, false);
      const badge = document.getElementById('refreshProgressBadge');
      const btn = document.getElementById('refreshAllBtn');
      if (badge) { badge.hidden = true; badge.textContent = ''; }
      if (btn) btn.classList.remove('has-progress');
    } else {
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

// 通用询问弹窗（宿主 askUi 下发）
let askId = null;
const askQueue = [];
function showAsk(data) {
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
  if (ok) ok.addEventListener('click', () => answerAsk(true));
  if (cancel) cancel.addEventListener('click', () => answerAsk(false));
  if (close) close.addEventListener('click', () => answerAsk(false));
})();

// Toast 通知
const TOAST_ICONS = {
  success: '<svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 8l3 3 7-7"/></svg>',
  error: '<svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="2"><circle cx="8" cy="8" r="6.5"/><line x1="8" y1="5" x2="8" y2="9" stroke-linecap="round"/><circle cx="8" cy="11.5" r="0.6" fill="currentColor" stroke="none"/></svg>',
  warning: '<svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="2"><circle cx="8" cy="8" r="6.5"/><line x1="8" y1="5" x2="8" y2="9" stroke-linecap="round"/><circle cx="8" cy="11.5" r="0.6" fill="currentColor" stroke="none"/></svg>',
  info: '<svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="2"><circle cx="8" cy="8" r="6.5"/><line x1="8" y1="11.5" x2="8" y2="7.5" stroke-linecap="round"/><circle cx="8" cy="4.8" r="0.6" fill="currentColor" stroke="none"/></svg>'
};

let authWaitTimer = null;
let authWaitStartedAt = 0;
function setAuthWaitBar(action, active) {
  const bar = document.getElementById('authWaitBar');
  if (!bar) return;
  if (authWaitTimer) { clearInterval(authWaitTimer); authWaitTimer = null; }
  if (!active) {
    authWaitStartedAt = 0;
    bar.hidden = true;
    bar.innerHTML = '';
    return;
  }
  authWaitStartedAt = Date.now();
  const label = action === 'oauth' ? tl('oauthWaiting') : tl('detectingLocal');
  const render = () => {
    const sec = Math.max(0, Math.floor((Date.now() - authWaitStartedAt) / 1000));
    bar.innerHTML = '<span class="auth-wait-spinner"></span><span class="auth-wait-text">' + escHtml(label) + '</span><span class="auth-wait-sec">' + sec + 's</span>';
  };
  bar.hidden = false;
  render();
  authWaitTimer = setInterval(render, 1000);
}

function showToast(message, type = 'info', duration, raw = false) {
  const effectiveDuration = (duration === undefined || duration === null)
    ? (type === 'error' ? 10000 : (type === 'warning' ? 6000 : 3000))
    : duration;
  let container = document.getElementById('toastContainer');
  if (!container) {
    container = document.createElement('div');
    container.id = 'toastContainer';
    container.className = 'toast-container';
    document.body.appendChild(container);
  }
  const existing = container.querySelector('.toast');
  if (existing) {
    const until = Number(existing.dataset.protectUntil || 0);
    if (!until || Date.now() >= until) existing.remove();
  }

  const toast = document.createElement('div');
  toast.className = 'toast toast-' + type;
  const icon = type === 'loading'
    ? '<span class="toast-spinner"></span>'
    : '<span class="toast-icon">' + (TOAST_ICONS[type] || TOAST_ICONS.info) + '</span>';
  const body = raw ? String(message) : escHtml(String(message));
  toast.innerHTML = icon + '<span class="toast-msg">' + body + '</span><button type="button" class="toast-close" aria-label="Close">×</button>';
  if (effectiveDuration > 0 && (type === 'error' || type === 'warning' || effectiveDuration >= ERROR_TOAST_PROTECT_MS)) {
    toast.dataset.protectUntil = String(Date.now() + effectiveDuration);
  }
  let hideTimer = null;
  const closeBtn = toast.querySelector('.toast-close');
  if (closeBtn) {
    closeBtn.addEventListener('click', () => {
      if (hideTimer) clearTimeout(hideTimer);
      toast.remove();
    });
  }
  container.appendChild(toast);

  requestAnimationFrame(() => toast.classList.add('show'));

  if (effectiveDuration > 0) {
    hideTimer = setTimeout(() => {
      toast.classList.remove('show');
      setTimeout(() => toast.remove(), 300);
    }, effectiveDuration);
  }
  return toast;
}

// 通用确认框
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
(function () {
  const ov = document.getElementById('confirmOverlay');
  if (!ov) return;
  document.getElementById('confirmClose').addEventListener('click', closeConfirm);
  document.getElementById('confirmCancel').addEventListener('click', closeConfirm);
  document.getElementById('confirmOk').addEventListener('click', () => {
    const cb = _confirmCb;
    closeConfirm();
    if (cb) cb();
  });
  ov.addEventListener('click', (e) => { if (e.target === ov) closeConfirm(); });
})();

// ── 设置面板 ──
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
  chk('setSyncRemoteAuth', s.syncRemoteAuth !== false);
  set('setCdpPort', s.cdpPort || 9333);
  set('setCdpHeartbeat', s.cdpHeartbeatMs || 500);
  set('setQuotaRefresh', s.quotaRefreshMinutes || 15);
  set('setLocale', s.locale || 'auto');
  const nextCardView = s.sidebarCardView === 'compact' ? 'compact' : 'classic';
  const nextShowCardTokens = s.sidebarShowCardTokens !== false;
  set('setCardView', nextCardView);
  chk('setCardTokens', nextShowCardTokens);
  chk('setStatusEnabled', s.statusBarEnabled !== false);
  set('setStatusPosition', s.statusBarPosition || 'right');
  set('setStatusStyle', s.statusBarStyle || 'pulse');
  chk('setStatusAccount', s.statusBarAccount !== false);
  chk('setStatusModels', s.statusBarModels !== false);
  chk('setStatusCredits', s.statusBarCredits !== false);
  chk('setStatusPool', s.statusBarPool !== false);
  chk('setStatusTier', s.statusBarTier !== false);
  chk('setStatusReset', s.statusBarResetCountdown !== false);
  chk('setStatusLiveContext', s.statusBarLiveContext !== false);
  chk('setStatusLiveSpeed', s.statusBarLiveSpeed !== false);
  const fams = Array.isArray(s.statusBarFamilies) ? s.statusBarFamilies : ['claude', 'gemini', 'argon'];
  chk('setStatusFamClaude', fams.indexOf('claude') >= 0);
  chk('setStatusFamGemini', fams.indexOf('gemini') >= 0);
  chk('setStatusFamArgon', fams.indexOf('argon') >= 0);
  if (cardViewMode !== nextCardView || showCardTokens !== nextShowCardTokens) {
    cardViewMode = nextCardView;
    showCardTokens = nextShowCardTokens;
    renderAccounts();
  }
  if (typeof syncStyleCards === 'function') syncStyleCards();
  if (typeof renderDemos === 'function') renderDemos();
}

function openSettingsModal(section) {
  const ov = document.getElementById('settingsOverlay');
  if (!ov) return;
  ov.hidden = false;
  vscode.postMessage({ type: 'getSettings' });
  renderCdpStatus(null);
  vscode.postMessage({ type: 'getCdpStatus' });
  const targetId = section === 'statusBar'
    ? 'settingsStatusBarGroup'
    : (section === 'appearance' ? 'settingsAppearanceGroup' : '');
  if (targetId) {
    const highlightGroup = () => {
      const grp = document.getElementById(targetId);
      if (!grp) return;
      grp.scrollIntoView({ behavior: 'smooth', block: 'start' });
      grp.classList.add('is-spotlight');
      setTimeout(() => grp.classList.remove('is-spotlight'), 1200);
    };
    requestAnimationFrame(highlightGroup);
    setTimeout(highlightGroup, 120);
  }
}

function closeSettingsModal() {
  const ov = document.getElementById('settingsOverlay');
  if (ov) ov.hidden = true;
}

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
  if (recheck) {
    recheck.addEventListener('click', () => {
      renderCdpStatus(null);
      vscode.postMessage({ type: 'getCdpStatus' });
    });
  }
  let armed = false;
  let armTimer = null;
  if (enable) {
    enable.addEventListener('click', () => {
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
    });
  }
})();

const SB_USER_SVG = '<svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/></svg>';

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
  const fams = [];
  if (o.claude) fams.push('<span class="sbd-seg">' + DOT + ' Claude 96%/100%</span>');
  if (o.gemini) fams.push('<span class="sbd-seg">' + DOT + ' Gemini 98%</span>');
  if (o.argon) fams.push('<span class="sbd-seg">' + DOT + ' Gemini 4 91%</span>');
  const FAM = fams.join('<span class="sbd-dim">·</span>');
  const acc = o.account ? '<span class="sbd-seg">' + SB_USER_SVG + 'soulvon2501' + (o.tier ? ' ·Pro' : '') + '</span>' : '';
  const pct = o.models ? '<span class="sbd-seg">' + DOT + ' 96%</span>' : '';
  const rst = o.models && o.reset ? '<span class="sbd-seg">🕐 Claude 5h 4h 55m</span>' : '';
  const cred = o.credits ? '<span class="sbd-seg">🪙 87.5</span>' : '';
  const minPct = o.claude && o.gemini ? (o.argon ? 91 : 96) : (o.gemini ? 98 : (o.argon ? 91 : 96));
  const pctStr = o.models ? minPct + '%' : '';
  const dualLeft = [o.models ? '<span class="sbd-seg">' + DOT + ' ' + pctStr + '</span>' : '', rst].filter(Boolean).join('');
  switch (style) {
    case 'pulse': return [o.account ? '<span class="sbd-seg">' + SB_USER_SVG + 'soulvon2501</span>' : '', o.models ? '<span class="sbd-seg">· ' + DOT + ' ' + minPct + '%</span>' : ''].filter(Boolean).join('') || '<span class="sbd-dim">—</span>';
    case 'smart': return [acc, pct, rst, cred].filter(Boolean).join('') || '<span class="sbd-dim">—</span>';
    case 'dot': return o.models ? '<span class="sbd-seg">' + DOT + '</span>' : (cred || '<span class="sbd-dim">—</span>');
    case 'percent': return o.models ? '<span class="sbd-seg">' + pctStr + '</span>' : '<span class="sbd-dim">—</span>';
    case 'compact': return o.models ? '<span class="sbd-seg">' + DOT + ' ' + pctStr + (rst ? ' 🕐 Claude 5h 4h 55m' : '') + '</span>' : '<span class="sbd-dim">—</span>';
    case 'dual': return [dualLeft, cred].filter(Boolean).join(sep) || '<span class="sbd-dim">—</span>';
    case 'labeled': return [acc, o.models && FAM ? FAM + (o.reset ? '<span class="sbd-seg">🕐 5h 4h 55m</span>' : '') : ''].filter(Boolean).join(sep) || '<span class="sbd-dim">—</span>';
    case 'full': return [acc, o.models && FAM ? FAM : '', cred].filter(Boolean).join(sep) || '<span class="sbd-dim">—</span>';
  }
  return '';
}

function renderDemos() {
  const grid = document.getElementById('sbStyleGrid');
  if (!grid) return;
  try {
    grid.querySelectorAll('.sb-style-card').forEach(card => {
      const demo = card.querySelector('.sb-style-demo');
      if (demo) demo.innerHTML = sbDemoHTML(card.getAttribute('data-style'));
    });
  } catch (err) {
    console.error('[kite] renderDemos failed:', err);
    const errMsg = err && err.message ? err.message : String(err);
    grid.innerHTML = '<div class="panel-render-error">' + escHtml(tl('renderPanelError', errMsg)) + '</div>';
  }
}

function syncStyleCards() {
  const sel = document.getElementById('setStatusStyle');
  const grid = document.getElementById('sbStyleGrid');
  if (!sel || !grid) return;
  grid.querySelectorAll('.sb-style-card').forEach(c => c.classList.toggle('is-on', c.getAttribute('data-style') === sel.value));
}

(function () {
  const ov = document.getElementById('settingsOverlay');
  if (!ov) return;
  const openStatsBtn = document.getElementById('openStatsBtn');
  if (openStatsBtn) openStatsBtn.addEventListener('click', () => vscode.postMessage({ type: 'openStatsPanel' }));
  const settingsBtn = document.getElementById('settingsBtn');
  if (settingsBtn) settingsBtn.addEventListener('click', openSettingsModal);
  const closeBtn = document.getElementById('settingsClose');
  if (closeBtn) closeBtn.addEventListener('click', closeSettingsModal);
  const cancelBtn = document.getElementById('settingsCancel');
  if (cancelBtn) cancelBtn.addEventListener('click', closeSettingsModal);
  ov.addEventListener('click', (e) => { if (e.target === ov) closeSettingsModal(); });

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
      syncRemoteAuth: on('setSyncRemoteAuth'),
      quotaRefreshMinutes: num('setQuotaRefresh', 15),
      locale: val('setLocale') || 'auto',
      sidebarCardView: val('setCardView') === 'compact' ? 'compact' : 'classic',
      sidebarShowCardTokens: on('setCardTokens'),
      statusBarEnabled: on('setStatusEnabled'),
      statusBarPosition: val('setStatusPosition') || 'right',
      statusBarStyle: val('setStatusStyle') || 'pulse',
      statusBarAccount: on('setStatusAccount'),
      statusBarModels: on('setStatusModels'),
      statusBarCredits: on('setStatusCredits'),
      statusBarPool: on('setStatusPool'),
      statusBarTier: on('setStatusTier'),
      statusBarResetCountdown: on('setStatusReset'),
      statusBarLiveContext: on('setStatusLiveContext'),
      statusBarLiveSpeed: on('setStatusLiveSpeed'),
      statusBarFamilies: ['setStatusFamClaude', 'setStatusFamGemini', 'setStatusFamArgon']
        .filter(function (id) { return on(id); })
        .map(function (id) { return document.getElementById(id).getAttribute('data-family'); })
    };
  };
  const pushSettings = (silent) => {
    const nextSettings = readSettings();
    const viewChanged = cardViewMode !== nextSettings.sidebarCardView || showCardTokens !== nextSettings.sidebarShowCardTokens;
    cardViewMode = nextSettings.sidebarCardView;
    showCardTokens = nextSettings.sidebarShowCardTokens;
    if (viewChanged) renderAccounts();
    vscode.postMessage({ type: 'saveSettings', silent: !!silent, settings: nextSettings });
  };

  (function buildStyleCards() {
    const grid = document.getElementById('sbStyleGrid');
    const sel = document.getElementById('setStatusStyle');
    if (!grid || !sel || grid.dataset.built) return;
    grid.dataset.built = '1';
    const NAMES = {
      pulse: tl('sbStylePulseName'),
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
      card.innerHTML = '<div class="sb-style-head"><span class="sb-style-name">' + escHtml(NAMES[st]) + '</span><span class="sb-style-check" aria-hidden="true"></span></div><div class="sb-style-demo">' + sbDemoHTML(st) + '</div>';
      grid.appendChild(card);
    });
    grid.addEventListener('click', (e) => {
      const card = e.target.closest('.sb-style-card');
      if (!card) return;
      const st = card.getAttribute('data-style');
      if (!st) return;
      sel.value = st;
      syncStyleCards();
      pushSettings(true);
    });
  })();

  ov.querySelectorAll('input, select').forEach(el => {
    if (el.type === 'hidden') return;
    el.addEventListener('change', () => pushSettings(true));
  });
  ov.querySelectorAll('.v2-tag').forEach(tag => {
    tag.addEventListener('click', () => {
      tag.classList.toggle('is-on');
      pushSettings(true);
      renderDemos();
    });
  });

  const resetBtn = document.getElementById('settingsReset');
  if (resetBtn) {
    resetBtn.addEventListener('click', () => {
      fillSettingsForm({
        updateAutoCheck: true,
        updateAutoInstall: true,
        autoConfirmDeclaration: true,
        cdpPort: 9333,
        cdpHeartbeatMs: 500,
        syncGeminiFiles: true,
        syncRemoteAuth: true,
        quotaRefreshMinutes: 15,
        locale: 'auto',
        sidebarCardView: 'classic',
        sidebarShowCardTokens: true,
        statusBarEnabled: true,
        statusBarPosition: 'right',
        statusBarStyle: 'pulse',
        statusBarAccount: true,
        statusBarModels: true,
        statusBarCredits: true,
        statusBarPool: true,
        statusBarTier: true,
        statusBarResetCountdown: true,
        statusBarLiveContext: true,
        statusBarLiveSpeed: true,
        statusBarFamilies: ['claude', 'gemini', 'argon']
      });
      pushSettings(true);
    });
  }

  const saveBtn = document.getElementById('settingsSave');
  if (saveBtn) {
    saveBtn.addEventListener('click', () => {
      pushSettings(true);
      closeSettingsModal();
    });
  }
})();

// 导入状态处理
let loadingToast = null;
function handleImportStatus(msg) {
  if (msg.status === 'loading') {
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

// ── 账号网格事件委托 + 分页事件委托 + 标签编辑弹窗按钮 ──
(function bindGridAndModals() {
  const accountGrid = document.getElementById('accountGrid');
  if (accountGrid) {
    accountGrid.addEventListener('click', (e) => {
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
      const actionEl = e.target.closest('[data-action]');
      if (!actionEl || actionEl.disabled) return;
      const action = actionEl.dataset.action;
      const email = actionEl.dataset.email || '';
      const tag = actionEl.dataset.tag || '';
      switch (action) {
        case 'toggle-tag-filter':
          e.stopPropagation();
          toggleTagFilter(tag);
          break;
        case 'open-account-tokens':
          if (email) vscode.postMessage({ type: 'openStatsPanel', tab: 'tokens', account: email });
          break;
        case 'switch':
          if (email) setCurrent(email);
          break;
        case 'recheck-health':
          if (email) recheckHealth(email);
          break;
        case 'edit-tags':
          if (email) openTagEditModal(email);
          break;
        case 'refresh-one':
          if (email) refreshUsage(actionEl, email);
          break;
        case 'remove':
          if (email) removeAccount(email);
          break;
        case 'toggle-disabled':
          if (email) toggleDisabled(email);
          break;
      }
    });
  }

  const paginationEl = document.getElementById('pagination');
  if (paginationEl) {
    paginationEl.addEventListener('click', (e) => {
      const btn = e.target.closest('button[data-page]');
      if (!btn || btn.disabled) return;
      const page = Number(btn.dataset.page);
      if (Number.isFinite(page) && page >= 1) goPage(page);
    });
  }

  const tagEditClose = document.getElementById('tagEditClose');
  const tagEditCancel = document.getElementById('tagEditCancel');
  const tagEditSave = document.getElementById('tagEditSave');
  const tagEditAddBtn = document.getElementById('tagEditAddBtn');
  const tagEditInput = document.getElementById('tagEditInput');
  const tagEditOverlay = document.getElementById('tagEditOverlay');
  if (tagEditClose) tagEditClose.addEventListener('click', closeTagEditModal);
  if (tagEditCancel) tagEditCancel.addEventListener('click', closeTagEditModal);
  if (tagEditSave) tagEditSave.addEventListener('click', saveTagEdit);
  if (tagEditAddBtn) tagEditAddBtn.addEventListener('click', addTagFromInput);
  if (tagEditInput) {
    tagEditInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { e.preventDefault(); addTagFromInput(); }
    });
  }
  if (tagEditOverlay) {
    tagEditOverlay.addEventListener('click', (e) => {
      if (e.target === tagEditOverlay) closeTagEditModal();
    });
  }
})();

// 导入确认弹窗
function showImportConfirmModal(email, exists, tokenExpired) {
  const old = document.getElementById('importConfirmModal');
  if (old) old.remove();

  const modal = document.createElement('div');
  modal.id = 'importConfirmModal';
  modal.className = 'import-modal-overlay';

  const maskedEmail = email ? displayEmail(email) : tl('unknown');
  const title = exists ? tl('inPool') : tl('detectedLocal');
  const desc = exists ? tl('overwritePrompt') : tl('addPrompt');
  const confirmText = exists ? tl('overwrite') : tl('addToPool');

  const expiredWarning = tokenExpired
    ? '<div class="import-modal-warning"><svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="2" style="vertical-align:-2px;margin-right:4px"><circle cx="8" cy="8" r="6.5"/><line x1="8" y1="5" x2="8" y2="9" stroke-linecap="round"/><circle cx="8" cy="11.5" r="0.6" fill="currentColor" stroke="none"/></svg>' + escHtml(tl('expiredWarning')) + '</div>'
    : '';

  modal.innerHTML =
    '<div class="import-modal-content">' +
      '<div class="import-modal-header">' +
        '<span class="import-modal-title">' + escHtml(title) + '</span>' +
        '<button type="button" class="import-modal-close" id="importConfirmClose">×</button>' +
      '</div>' +
      '<div class="import-modal-body">' +
        '<div class="import-modal-email">' + escHtml(maskedEmail) + '</div>' +
        '<div class="import-modal-desc">' + escHtml(desc) + '</div>' +
        expiredWarning +
      '</div>' +
      '<div class="import-modal-actions">' +
        '<button type="button" class="import-modal-btn cancel" id="importConfirmCancel">' + escHtml(tl('cancel')) + '</button>' +
        '<button type="button" class="import-modal-btn confirm" id="importConfirmOk">' + escHtml(confirmText) + '</button>' +
      '</div>' +
    '</div>';

  modal.addEventListener('click', (e) => {
    if (e.target === modal || e.target.closest('#importConfirmClose') || e.target.closest('#importConfirmCancel')) {
      closeImportModal();
      return;
    }
    if (e.target.closest('#importConfirmOk')) {
      confirmImportAction();
    }
  });

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

function fmtCompactTok(n) {
  const v = Number(n) || 0;
  if (v < 1000) return String(Math.round(v)) + ' tok';
  if (v < 1e6) return (v / 1e3).toFixed(v >= 100000 ? 0 : 1) + 'K tok';
  if (v < 1e9) return (v / 1e6).toFixed(2) + 'M tok';
  return (v / 1e9).toFixed(2) + 'B tok';
}

function fmtUsdShort(u) {
  const v = Number(u) || 0;
  if (v <= 0) return '$0.00';
  if (v < 0.01) return '<$0.01';
  if (v >= 100) return '$' + v.toFixed(1);
  return '$' + v.toFixed(2);
}

function updateSidebarTodayStats(msg) {
  lastTodayStats = msg || null;
  const tokEl = document.getElementById('sbTodayTokensPill');
  const costEl = document.getElementById('sbTodayCostPill');
  const wVal = document.getElementById('sbPopWeightedVal');
  const rVal = document.getElementById('sbPopRawVal');
  const sVal = document.getElementById('sbPopSplitVal');
  const svVal = document.getElementById('sbPopSavedVal');
  const stVal = document.getElementById('sbPopStepsVal');
  const swVal = document.getElementById('sbPopSwitchVal');
  const tokens = Number(msg.todayTokens) || 0;
  const weighted = msg.todayWeighted !== undefined ? (Number(msg.todayWeighted) || 0) : tokens;
  const costUsd = Number(msg.todayCostUsd) || 0;
  const savedUsd = Number(msg.todaySavedUsd) || 0;
  const desktopTok = Number(msg.todayDesktopTokens) || 0;
  const cliTok = Number(msg.todayCliTokens) || 0;
  const steps = Number(msg.todaySteps) || 0;
  if (tokEl) tokEl.textContent = fmtCompactTok(weighted);
  if (costEl) costEl.textContent = fmtUsdShort(costUsd);
  if (wVal) wVal.textContent = fmtCompactTok(weighted);
  if (rVal) rVal.textContent = fmtCompactTok(tokens);
  if (sVal) sVal.textContent = fmtCompactTok(desktopTok) + ' / ' + fmtCompactTok(cliTok);
  if (svVal) svVal.textContent = '-' + fmtUsdShort(savedUsd);
  if (stVal) stVal.textContent = String(steps);
  if (swVal) swVal.textContent = String(Number(msg.todaySwitches) || 0);
  if (msg.perAccountTokens && typeof msg.perAccountTokens === 'object') {
    perAccountTokens = msg.perAccountTokens;
    renderAccounts();
  }
}

function updateSummary() {
  const el = document.getElementById('gridCount');
  if (el) el.textContent = tl('accountsCount', accounts.length);
}

function renderAccounts() {
  const grid = document.getElementById('accountGrid');
  const empty = document.getElementById('emptyState');
  if (!grid || !empty) return;

  try {
    renderActiveFilterBar();
    let filtered = getVisibleAccounts();
    const hasActiveFilters = Boolean(searchTerm || activeFilter !== 'all' || filterTags.size > 0 || filterPlans.size > 0);

    // 排序
    filtered = filtered.slice().sort((a, b) => {
      if (a.email === currentEmail) return -1;
      if (b.email === currentEmail) return 1;

      let cmp = 0;
      if (sortBy === 'email') {
        cmp = a.email.localeCompare(b.email);
      } else if (sortBy === 'time') {
        const ta = (a.importMeta && a.importMeta.importedAt) || '';
        const tb = (b.importMeta && b.importMeta.importedAt) || '';
        cmp = tb.localeCompare(ta);
      } else if (sortBy === 'recommend') {
        const aMin = a.usage && a.usage.models && a.usage.models.length ? Math.min(...a.usage.models.map(m => m.remainingPercent)) : -1;
        const bMin = b.usage && b.usage.models && b.usage.models.length ? Math.min(...b.usage.models.map(m => m.remainingPercent)) : -1;
        cmp = bMin - aMin;
      }
      if (cmp === 0) cmp = a.email.localeCompare(b.email);
      return sortDir === 'asc' ? -cmp : cmp;
    });

    const totalFiltered = filtered.length;
    const totalPages = pageSize > 0 ? Math.ceil(totalFiltered / pageSize) : 1;
    if (currentPage > totalPages) currentPage = Math.max(1, totalPages);

    const startIdx = pageSize > 0 ? (currentPage - 1) * pageSize : 0;
    const endIdx = pageSize > 0 ? startIdx + pageSize : totalFiltered;
    const paged = filtered.slice(startIdx, endIdx);

    if (totalFiltered === 0) {
      grid.innerHTML = '';
      empty.style.display = 'block';
      const emptyTitle = empty.querySelector('.empty-title');
      if (emptyTitle) emptyTitle.textContent = hasActiveFilters ? tl('noMatchTitle') : tl('emptyTitle');
      const emptySub = empty.querySelector('.empty-sub');
      if (emptySub) emptySub.hidden = hasActiveFilters;
      renderPagination(0, 0);
      return;
    }
    empty.style.display = 'none';
    const emptySubReset = empty.querySelector('.empty-sub');
    if (emptySubReset) emptySubReset.hidden = false;

    const cards = paged.map(a => {
      const isCurrent = a.email === currentEmail;
      const rawEmail = a.email;
      const safeEmail = attrEsc(rawEmail);
      const showEmail = escHtml(displayEmail(rawEmail));
      const emailTitle = attrEsc(displayEmail(rawEmail));
      const isDisabled = a.disabled;

      const usage = a.usage;
      const tierId = (usage && usage.tierId) || '';
      const tierClass = planTierClass(tierId);
      const tierLabel = planTierLabel(tierId);

      // 模型配额：单列竖排
      const models = (usage && usage.models) || [];
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
      if (models.length > 0 && cardViewMode === 'compact') {
        const compactResetShort = (isoTime) => {
          if (!isoTime) return '';
          const diffMs = new Date(isoTime).getTime() - Date.now();
          if (!Number.isFinite(diffMs) || diffMs <= 0) return '';
          const totalMin = Math.max(1, Math.round(diffMs / 60000));
          const h = Math.floor(totalMin / 60);
          const d = Math.floor(h / 24);
          if (d > 0) return d + 'd' + (h % 24) + 'h';
          if (h > 0) return h + 'h' + (totalMin % 60) + 'm';
          return totalMin + 'm';
        };
        const poolDefs = [
          { key: 'claude', name: 'Claude' },
          { key: 'gemini', name: 'Gemini' },
          { key: 'argon', name: 'Gemini 4' },
        ];
        quotasHtml = poolDefs.map(pd => {
          const m5 = models.find(m => m.modelId === pd.key + ':5h');
          const mw = models.find(m => m.modelId === pd.key + ':weekly');
          if (!m5 && !mw) return '';
          const pcts = [m5 ? m5.remainingPercent : null, mw ? mw.remainingPercent : null].filter(v => typeof v === 'number');
          const minPct = Math.min.apply(null, pcts);
          const cls = pctClass(minPct);
          const pairText = pcts.map(v => v + '%').join(' / ');
          const rstSrc = (m5 && m5.resetTime) || (mw && mw.resetTime) || '';
          const rstTitle = rstSrc ? formatResetTime(rstSrc) : '';
          const rstShort = (minPct < 100 && rstSrc) ? compactResetShort(rstSrc) : '';
          return '<div class="grid-quota-compact-row"' + (rstTitle ? ' title="' + attrEsc(rstTitle) + '"' : '') + '>'
            + '<span class="grid-quota-compact-name">' + escHtml(pd.name) + '</span>'
            + '<div class="grid-quota-compact-bar"><div class="quota-bar-fill ' + cls + '" style="width:' + Math.max(0, Math.min(100, minPct)) + '%"></div></div>'
            + '<span class="grid-quota-compact-vals ' + cls + '">' + escHtml(pairText)
            + (rstShort ? '<span class="grid-quota-compact-reset">· ' + escHtml(rstShort) + '</span>' : '')
            + '</span>'
            + '</div>';
        }).join('');
        if (a._usageError) {
          const cachedAt = a.usage && a.usage.updatedAt ? new Date(a.usage.updatedAt).toLocaleTimeString() : '—';
          quotasHtml += '<div class="quota-cache-note" title="' + attrEsc(tl('quotaCacheTip', String(a._usageError))) + '">'
            + '<span class="cache-dot"></span>' + escHtml(tl('quotaCached', cachedAt))
            + '</div>';
        }
      } else if (models.length > 0) {
        const sortOrder = {
          'claude:5h': 1,
          'claude:weekly': 2,
          'gemini:5h': 3,
          'gemini:weekly': 4,
          'argon:5h': 5,
          'argon:weekly': 6,
        };
        const sortedModels = [...models].sort((m1, m2) => {
          const orderA = sortOrder[m1.modelId] || 99;
          const orderB = sortOrder[m2.modelId] || 99;
          return orderA - orderB;
        });

        quotasHtml = sortedModels.map(m => {
          const isWeekly = (m.modelId && m.modelId.endsWith(':weekly')) || /week/i.test(m.label || '');
          const family = /argon/i.test(m.modelId || '') ? 'Gemini 4'
            : /claude/i.test(m.modelId || m.label || '') ? 'Claude'
            : 'Gemini';
          const displayLabel = family + ' ' + (isWeekly ? tl('quotaWeekly') : tl('quota5h'));
          const resetStr = m.resetTime ? formatResetTime(m.resetTime) : '';
          return quotaItemHtml(displayLabel, m.remainingPercent, resetStr);
        }).join('');
        if (a._usageError) {
          const cachedAt = a.usage && a.usage.updatedAt ? new Date(a.usage.updatedAt).toLocaleTimeString() : '—';
          quotasHtml += '<div class="quota-cache-note" title="' + attrEsc(tl('quotaCacheTip', String(a._usageError))) + '">'
            + '<span class="cache-dot"></span>' + escHtml(tl('quotaCached', cachedAt))
            + '</div>';
        }
      } else if (cardViewMode === 'compact') {
        const loadErrorHtml = a._usageError
          ? '<div class="quota-load-error">' + escHtml(String(a._usageError)) + '</div>'
          : '';
        quotasHtml = ['Claude', 'Gemini'].map(name => {
          return '<div class="grid-quota-compact-row" style="opacity:0.45;">'
            + '<span class="grid-quota-compact-name">' + escHtml(name) + '</span>'
            + '<div class="grid-quota-compact-bar"><div class="quota-bar-fill" style="width:0%"></div></div>'
            + '<span class="grid-quota-compact-vals">—</span>'
            + '</div>';
        }).join('') + loadErrorHtml;
      } else {
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
              + '<span class="grid-quota-label">' + escHtml(label) + '</span>'
              + '<span class="grid-quota-val">—</span>'
            + '</div>'
            + '<div class="quota-bar">'
              + '<div class="quota-bar-fill" style="width:0%"></div>'
            + '</div>'
          + '</div>';
        }).join('');
        quotasHtml = phHtml + loadErrorHtml;
      }

      const creditNum = usage && typeof usage.availableAICredits === 'number' && Number.isFinite(usage.availableAICredits) ? usage.availableAICredits : 0;
      const creditChipHtml = creditNum > 0
        ? '<span class="grid-credit-chip"><svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="9"/><path d="M12 7v10"/><path d="M15 9.5c0-1.1-1.3-2-3-2s-3 .9-3 2 1.3 1.8 3 2.2 3 1.1 3 2.3-1.3 2-3 2-3-.9-3-2"/></svg>' + escHtml(Number.isInteger(creditNum) ? String(creditNum) : creditNum.toFixed(1)) + '</span>'
        : '';

      const tokStat = showCardTokens ? perAccountTokens[rawEmail.toLowerCase()] : null;
      let cardTokensHtml = '';
      if (showCardTokens && tokStat && tokStat.totalTokens > 0) {
        const dayShow = tokStat.todayWeighted > 0 ? tokStat.todayWeighted : tokStat.todayTokens;
        const totShow = tokStat.totalWeighted > 0 ? tokStat.totalWeighted : tokStat.totalTokens;
        const tipLines = [
          tokStat.todayTokens > 0 ? tl('cardTokensToday', fmtCompactTok(dayShow), fmtUsdShort(tokStat.todayCostUsd)) : '',
          tl('cardTokensTotal', fmtCompactTok(totShow)) + ' (' + fmtUsdShort(tokStat.totalCostUsd) + ')',
          tl('cardTokensHint'),
        ].filter(Boolean).join(' · ');
        cardTokensHtml = '<button type="button" class="grid-card-tokens" data-action="open-account-tokens" data-email="' + safeEmail + '" title="' + attrEsc(tipLines) + '">'
          + '<span class="grid-card-tokens-main"><svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><line x1="18" y1="20" x2="18" y2="10"/><line x1="12" y1="20" x2="12" y2="4"/><line x1="6" y1="20" x2="6" y2="14"/></svg>'
          + escHtml(tokStat.todayTokens > 0
            ? tl('cardTokensToday', fmtCompactTok(dayShow), fmtUsdShort(tokStat.todayCostUsd))
            : tl('cardTokensTotalOnly', fmtCompactTok(totShow), fmtUsdShort(tokStat.totalCostUsd)))
          + '</span>'
          + (tokStat.todayTokens > 0 ? '<span class="grid-card-tokens-sub">' + escHtml(tl('cardTokensTotal', fmtCompactTok(totShow))) + '</span>' : '')
          + '</button>';
      } else if (showCardTokens && isCurrent) {
        cardTokensHtml = '<div class="grid-card-tokens is-pending"><span>' + escHtml(tl('cardTokensPending')) + '</span></div>';
      }

      const accTags = getAccTags(a);
      const visibleTags = accTags.slice(0, 2);
      const extraTagCount = accTags.length - visibleTags.length;
      const cardTagsHtml = visibleTags.map(t => {
        const safeTagAttr = attrEsc(t);
        const isFiltered = filterTags.has(t);
        return '<button type="button" class="grid-tag-chip' + (isFiltered ? ' is-active' : '') + '" data-action="toggle-tag-filter" data-tag="' + safeTagAttr + '" title="' + safeTagAttr + '">' + escHtml(t) + '</button>';
      }).join('') + (extraTagCount > 0 ? '<span class="grid-tag-more" title="' + attrEsc(accTags.slice(2).join(', ')) + '">+' + extraTagCount + '</span>' : '');

      const sig = cardSig(a);
      const html = '<div class="grid-card ' + (isCurrent ? 'is-active' : '') + ' ' + (isDisabled ? 'is-disabled' : '') + (a.health && a.health.status === 'banned' ? ' is-banned' : '') + (selectMode ? ' is-select-mode' : '') + '" data-email="' + safeEmail + '" data-sig="' + attrEsc(sig) + '">'
        + (selectMode ? '<div class="grid-check-col"><input type="checkbox" class="grid-check-input" data-email="' + safeEmail + '" ' + (selectedEmails.has(rawEmail) ? 'checked' : '') + '></div>' : '')
        + '<div class="grid-card-head">'
          + '<div class="grid-card-email" title="' + emailTitle + '">' + showEmail + '</div>'
          + (isCurrent ? '<span class="grid-active-tag">' + escHtml(tl('current')) + '</span>' : '')
          + (isDisabled ? '<span class="grid-disabled-tag">' + escHtml(tl('disabledTag')) + '</span>' : '')
        + '</div>'
        + '<div class="grid-card-meta">'
          + '<span class="grid-plan-chip ' + tierClass + '">' + planChipIcon(tierClass) + escHtml(tierLabel) + '</span>'
          + creditChipHtml
          + cardTagsHtml
        + '</div>'
        + '<div class="grid-card-quotas">' + quotasHtml + '</div>'
        + cardTokensHtml
        + '<div class="grid-card-actions">'
          + (isCurrent
            ? '<span class="grid-current-label"><span style="color:#3fb950">●</span> ' + escHtml(tl('inUse')) + '</span>'
            : (switchingEmail === rawEmail
              ? '<button type="button" class="grid-switch-btn is-loading" disabled><span class="btn-spinner"></span><span class="switch-elapsed">' + escHtml(tl('switchingElapsed', Math.max(0, Math.floor((Date.now() - switchingStartedAt) / 1000)))) + '</span></button>'
              : (switchingEmail
                ? '<button type="button" class="grid-switch-btn" disabled title="' + attrEsc(tl('switching')) + '">' + escHtml(tl('switch')) + '</button>'
                : '<button type="button" class="grid-switch-btn" data-action="switch" data-email="' + safeEmail + '">' + escHtml(tl('switch')) + '</button>')))
          + healthPillHtml(a, safeEmail)
          + '<div class="grid-actions-right">'
            + '<button type="button" class="icon-btn" data-action="edit-tags" data-email="' + safeEmail + '" title="' + attrEsc(tl('editTagsT')) + '"><svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/></svg></button>'
            + '<button type="button" class="icon-btn is-refresh" data-action="refresh-one" data-email="' + safeEmail + '" data-refresh-email="' + safeEmail + '" title="' + attrEsc(tl('refreshQuotaT')) + '"><svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 12a9 9 0 0 1 9-9 9.75 9.75 0 0 1 6.74 2.74L21 8"/><path d="M21 3v5h-5"/><path d="M21 12a9 9 0 0 1-9 9 9.75 9.75 0 0 1-6.74-2.74L3 16"/><path d="M8 16H3v5"/></svg></button>'
            + '<button type="button" class="icon-btn danger" data-action="remove" data-email="' + safeEmail + '" title="' + attrEsc(tl('removeT')) + '"><svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg></button>'
            + '<button type="button" class="status-switch ' + (isDisabled ? 'is-off' : 'is-on') + '" data-action="toggle-disabled" data-email="' + safeEmail + '" title="' + attrEsc(isDisabled ? tl('disabledOnT') : tl('enabledOnT')) + '" aria-label="' + attrEsc(isDisabled ? tl('ariaEnable') : tl('ariaDisable')) + '"><span class="status-switch-thumb"></span></button>'
          + '</div>'
        + '</div>'
      + '</div>';
      return { email: rawEmail, sig: sig, html: html };
    });
    applyCards(cards);
    renderPagination(totalFiltered, totalPages);
  } catch (err) {
    console.error('[kite] renderAccounts failed:', err);
    const errMsg = err && err.message ? err.message : String(err);
    grid.innerHTML = '<div class="panel-render-error">' + escHtml(tl('renderPanelError', errMsg)) + '</div>';
    empty.style.display = 'none';
    renderPagination(0, 0);
  }
}

/** 卡片内容签名：只有签变化的卡片才重绘，刷新时不会整屏闪 */
function cardSig(a) {
  const u = a.usage || {};
  const models = (u.models || []).map(m => (m.modelId || '') + ':' + m.remainingPercent + ':' + (m.resetTime || '')).join(',');
  const cred = typeof u.availableAICredits === 'number' && u.availableAICredits > 0 ? String(u.availableAICredits) : '0';
  const ts = showCardTokens ? perAccountTokens[a.email.toLowerCase()] : null;
  const tokSig = ts ? `${ts.todayTokens}:${ts.todayWeighted || 0}:${ts.totalTokens}:${ts.totalWeighted || 0}:${ts.totalCostUsd}` : '';
  return [
    a.email,
    a.disabled ? '1' : '0',
    a.email === currentEmail ? '1' : '0',
    privacyMode ? '1' : '0',
    cardViewMode,
    showCardTokens ? '1' : '0',
    cred,
    tokSig,
    switchingEmail === a.email ? 'self' : (switchingEmail ? 'busy' : 'idle'),
    selectedEmails.has(a.email) ? '1' : '0',
    selectMode ? '1' : '0',
    u.tierId || '',
    u.loadError || '',
    a._usageError || '',
    a.health ? a.health.status + ':' + (a.health.checkedAt || '') : '',
    healthCheckingEmail === a.email ? '1' : '0',
    models,
    getAccTags(a).join('|'),
    [...filterTags].sort().join(','),
    a.name || '',
    (a.importMeta && a.importMeta.importedAt) || '',
  ].join('#');
}

/** 增量应用卡片：顺序不变时逐卡替换，否则全量重建 */
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
  const pgRow = document.getElementById('paginationRow');
  const pg = document.getElementById('pagination');
  if (pgRow) pgRow.hidden = total <= 0;
  if (!pg || pageSize === 0 || totalPages <= 1) {
    if (pg) pg.innerHTML = '';
    return;
  }

  let html = '<button type="button" class="page-btn" ' + (currentPage <= 1 ? 'disabled' : '') + ' data-page="' + (currentPage - 1) + '">‹</button>';

  const maxShow = 5;
  let start = Math.max(1, currentPage - 2);
  let end = Math.min(totalPages, start + maxShow - 1);
  if (end - start < maxShow - 1) start = Math.max(1, end - maxShow + 1);

  if (start > 1) html += '<span class="page-ellipsis">1 ...</span>';
  for (let i = start; i <= end; i++) {
    html += '<button type="button" class="page-btn ' + (i === currentPage ? 'is-active' : '') + '" data-page="' + i + '">' + i + '</button>';
  }
  if (end < totalPages) html += '<span class="page-ellipsis">... ' + totalPages + '</span>';

  html += '<button type="button" class="page-btn" ' + (currentPage >= totalPages ? 'disabled' : '') + ' data-page="' + (currentPage + 1) + '">›</button>';

  pg.innerHTML = html;
}

function goPage(page) {
  currentPage = page;
  renderAccounts();
}

let switchingEmail = null;
let switchingStartedAt = 0;
let switchingTimer = null;
let switchingTimeoutId = null;
function clearSwitchingState() {
  if (switchingTimer) { clearInterval(switchingTimer); switchingTimer = null; }
  if (switchingTimeoutId) { clearTimeout(switchingTimeoutId); switchingTimeoutId = null; }
  switchingEmail = null;
  switchingStartedAt = 0;
}
function setCurrent(email) {
  if (switchingEmail) return;
  clearSwitchingState();
  switchingEmail = email;
  switchingStartedAt = Date.now();
  renderAccounts();
  switchingTimer = setInterval(() => {
    const el = document.querySelector('.grid-switch-btn.is-loading .switch-elapsed');
    if (el && switchingStartedAt) {
      const sec = Math.max(0, Math.floor((Date.now() - switchingStartedAt) / 1000));
      el.textContent = tl('switchingElapsed', sec);
    }
  }, 1000);
  switchingTimeoutId = setTimeout(() => {
    if (!switchingEmail) return;
    clearSwitchingState();
    renderAccounts();
    showToast(tl('switchTimeout', 30), 'error');
  }, 30000);
  vscode.postMessage({ type: 'setCurrentAccount', email });
}
function removeAccount(email) {
  showConfirm(tl('confirmRemove', displayEmail(email)), {
    title: tl('deleteTitle'),
    okText: tl('batchDelete'),
    onConfirm: () => vscode.postMessage({ type: 'removeAccount', email })
  });
}
function toggleDisabled(email) { vscode.postMessage({ type: 'toggleDisabled', email }); }

// ── 健康药丸 ──
let healthCheckingEmail = null;
const HEALTH_LABEL_KEYS = { banned: 'healthBanned', auth_invalid: 'healthAuthInvalid', unknown: 'healthUnknown', unreachable: 'healthUnreachable' };

function healthPillHtml(a, safeEmail) {
  if (healthCheckingEmail === a.email) {
    return '<button type="button" class="health-pill is-checking" disabled title="' + attrEsc(tl('healthChecking')) + '"><span class="health-dot"></span>' + escHtml(tl('healthChecking')) + '</button>';
  }
  const h = a.health;
  if (!h || h.status === 'ok') return '';
  const label = tl(HEALTH_LABEL_KEYS[h.status] || 'healthUnknown');
  const tipParts = [tl('healthRecheckT'), h.checkedAt ? new Date(h.checkedAt).toLocaleString() : ''];
  if (h.detail) tipParts.push(h.detail);
  return '<button type="button" class="health-pill is-' + attrEsc(h.status) + '" data-action="recheck-health" data-email="' + safeEmail + '" title="' + attrEsc(tipParts.filter(Boolean).join(' · ')) + '">'
    + '<span class="health-dot"></span>' + escHtml(label) + '</button>';
}

function recheckHealth(email) {
  if (healthCheckingEmail) return;
  healthCheckingEmail = email;
  renderAccounts();
  vscode.postMessage({ type: 'checkHealth', email });
}

// ── 就绪信号 ──
try { vscode.postMessage({ type: 'webviewReady' }); } catch (e) {}
