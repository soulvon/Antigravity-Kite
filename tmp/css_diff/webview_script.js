
window.onerror = function(msg, url, line, col, err) {
  document.title = 'ERR: ' + msg + ' @L' + line;
  const d = document.createElement('pre');
  d.style.cssText = 'position:fixed;top:0;left:0;right:0;z-index:99999;background:red;color:white;font-size:11px;padding:8px;white-space:pre-wrap;';
  d.textContent = msg + '\nLine: ' + line + ', Col: ' + col + '\n' + (err && err.stack || '');
  document.body.prepend(d);
  try {
    vscode.postMessage({ type: 'webviewError', message: String(msg), line: line, col: col, stack: err && err.stack || '' });
  } catch(e) {}
};
const vscode = acquireVsCodeApi();
// ── i18n：宿主按当前语言注入的语言包 + 静态 DOM 文案应用 ──
const L = {};
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
  
  modal.innerHTML = `
    <div class="import-modal-content">
      <div class="import-modal-header">
        <span class="import-modal-title">${title}</span>
        <button class="import-modal-close" onclick="closeImportModal()">×</button>
      </div>
      <div class="import-modal-body">
        <div class="import-modal-email">${maskedEmail}</div>
        <div class="import-modal-desc">${desc}</div>
        ${expiredWarning}
      </div>
      <div class="import-modal-actions">
        <button class="import-modal-btn cancel" onclick="closeImportModal()">${tl('cancel')}</button>
        <button class="import-modal-btn confirm" onclick="confirmImportAction()">${confirmText}</button>
      </div>
    </div>
  `;
  
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
            : '<button class="grid-switch-btn" onclick="setCurrent(\x27' + safeEmail + '\x27)">' + tl('switch') + '</button>'))
        + '<div class="grid-actions-right">'
          + '<button class="icon-btn" onclick="openTagEditModal(\x27' + safeEmail + '\x27)" title="' + tl('editTagsT') + '"><svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/></svg></button>'
          + '<button class="icon-btn" onclick="refreshUsage(\x27' + safeEmail + '\x27)" title="' + tl('refreshQuotaT') + '"><svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 12a9 9 0 0 1 9-9 9.75 9.75 0 0 1 6.74 2.74L21 8"/><path d="M21 3v5h-5"/><path d="M21 12a9 9 0 0 1-9 9 9.75 9.75 0 0 1-6.74-2.74L3 16"/><path d="M8 16H3v5"/></svg></button>'
          + '<button class="icon-btn danger" onclick="removeAccount(\x27' + safeEmail + '\x27)" title="' + tl('removeT') + '"><svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg></button>'
          + '<button class="status-switch ' + (isDisabled ? 'is-off' : 'is-on') + '" onclick="toggleDisabled(\x27' + safeEmail + '\x27)" title="' + (isDisabled ? tl('disabledOnT') : tl('enabledOnT')) + '" aria-label="' + (isDisabled ? tl('ariaEnable') : tl('ariaDisable')) + '"><span class="status-switch-thumb"></span></button>'
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
