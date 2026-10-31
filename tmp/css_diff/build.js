// 组装：Relay 底座（ID 重映射） + Kite 专有规则块抽取
const fs = require('fs');

const RELAY_CSS = 'E:/project/BuddyRelay/resources/webview/main.css';
const KITE_CSS = 'e:/project/Antigravity Kite/resources/webview/main.css';
const OUT_DIR = 'e:/project/Antigravity Kite/tmp/css_diff';

const relayRaw = fs.readFileSync(RELAY_CSS, 'utf8');
const kiteRaw = fs.readFileSync(KITE_CSS, 'utf8');

/* ---------- 1. ID 重映射：Relay 的 tab 容器 ID -> Kite 的 ---------- */
const ID_MAP = [
  ['#tab-account', '#tabAccounts'],
  ['#tab-instance', '#tabInstances'],
  ['#tab-enhance', '#tabEnhance'],
];
let base = relayRaw;
for (const [from, to] of ID_MAP) base = base.split(from).join(to);

/* ---------- 2. 从 Kite 旧 CSS 抽取 Kite 专有规则块 ---------- */
const KITE_ONLY = [
  'accept-pattern-cb', 'accept-stats-bar', 'accounts-section-header', 'accounts-section-title',
  'accounts-section-actions', 'add-account-modal', 'add-modal-body', 'add-modal-close',
  'add-modal-content', 'add-modal-header', 'add-modal-option', 'add-modal-title',
  'add-option-desc', 'add-option-icon', 'add-option-info', 'add-option-title',
  'cockpit-imported', 'cockpit-item', 'confirm-actions', 'confirm-danger-btn', 'confirm-message',
  'enhance-actions', 'enhance-apply-btn', 'enhance-card-body', 'enhance-card-desc',
  'enhance-card-header', 'enhance-card-title', 'enhance-card-title-group', 'enhance-desc',
  'enhance-details-content', 'enhance-details-desc', 'enhance-details-summary',
  'enhance-input', 'enhance-remove-btn', 'enhance-section', 'enhance-status-badge',
  'enhance-status-msg', 'enhance-sub-col', 'enhance-sub-row', 'enhance-sub-row-grid',
  'enhance-textarea', 'enhance-toggle', 'enhance-toggle-slider',
  'filter-option-check', 'import-modal-actions', 'import-modal-body', 'import-modal-btn',
  'import-modal-close', 'import-modal-content', 'import-modal-desc', 'import-modal-email',
  'import-modal-header', 'import-modal-title', 'import-modal-warning',
  'inst-btn', 'inst-card-dot', 'inst-cockpit-btn', 'inst-count-badge', 'inst-create-hint',
  'inst-focus', 'inst-icon-btn', 'inst-start', 'inst-stop', 'inst-toolbar', 'inst-toolbar-title',
  'kite-tab', 'kite-brand-mark-inline', 'micro-number-input', 'page-btn', 'page-ellipsis',
  'pill-selector', 'pill-selectors-container', 'privacy-eye', 'q2-cell', 'q2-col', 'q2-head',
  'q2-name', 'q2-reset', 'q2-title', 'q2-val', 'quota-grid2', 'quota-load-error',
  'recommend-btn', 'remaining-input-box', 'stats-reset-link', 'stats-text', 'status-dot-btn',
  'sub-col-label', 'tag-edit-chip', 'tag-edit-color-dot', 'tag-edit-existing', 'tag-edit-opt',
  'tag-edit-remove', 'tag-edit-selected', 'toast-container', 'toast-detail', 'toast-icon',
  'toast-spinner',
];

const kiteLines = kiteRaw.split('\n');

function matchKiteOnly(text) {
  for (const k of KITE_ONLY) {
    if (text.includes('.' + k)) {
      // 确认后面不是类名字符（避免 .kite-tab 命中 .kite-tab-bar 时也算，其实也算，放宽）
      return true;
    }
  }
  return false;
}

// 顶层块切分（@media 整块作为一个顶层块）
const blocks = [];
let depth = 0, start = -1, selLines = [];
for (let i = 0; i < kiteLines.length; i++) {
  const opens = (kiteLines[i].match(/\{/g) || []).length;
  const closes = (kiteLines[i].match(/\}/g) || []).length;
  if (depth === 0 && opens > 0) { start = i; selLines = []; }
  if (depth === 0) selLines.push(kiteLines[i]);
  depth += opens - closes;
  if (depth === 0 && start >= 0 && closes > 0) {
    const sel = selLines.join(' ').replace(/\s+/g, ' ').trim().replace(/\{$/, '');
    blocks.push({ s: start, e: i, sel });
    start = -1; selLines = [];
  }
}

const kept = [];
for (const b of blocks) {
  if (b.sel.startsWith('@')) {
    const bodyText = kiteLines.slice(b.s, b.e + 1).join('\n');
    if (matchKiteOnly(bodyText)) kept.push({ ...b, kind: 'media' });
    continue;
  }
  if (matchKiteOnly(b.sel)) kept.push({ ...b, kind: 'rule' });
}

let adaptLines = 0;
kept.forEach(b => adaptLines += (b.e - b.s + 1));

/* ---------- 3. 输出 ---------- */
const HEADER = [
  '/*',
  ' * Antigravity Kite — 侧栏样式',
  ' * 视觉底座：E:/project/BuddyRelay/resources/webview/main.css（原样搬入，仅做 tab 容器 ID 重映射）',
  ' * 适配层：Kite 专有布局（tab 栏 / 多实例 / 增强面板 / 配额 2x2 / 弹窗 / Toast）',
  ' *',
  ' * 分层：PART 1 = BuddyRelay 全量底座；PART 2 = Kite 独有组件，加载在后可覆盖底座。',
  ' */',
  '',
  '/* ═══════════════════════════════════════════════════════════════',
  '   PART 1 · BASE — BuddyRelay 样式底座',
  '   ═══════════════════════════════════════════════════════════════ */',
  '',
  '',
].join('\n');

const ADAPT_HEADER = [
  '',
  '',
  '/* ═══════════════════════════════════════════════════════════════',
  '   PART 2 · ADAPT — Kite 专有布局与组件',
  '   ═══════════════════════════════════════════════════════════════ */',
  '',
  '',
].join('\n');

const adaptBody = kept.map(b => kiteLines.slice(b.s, b.e + 1).join('\n')).join('\n\n');
const merged = HEADER + base + ADAPT_HEADER + adaptBody + '\n';

fs.writeFileSync(`${OUT_DIR}/part1_base.css`, base, 'utf8');
fs.writeFileSync(`${OUT_DIR}/part2_adapt_raw.css`, adaptBody, 'utf8');
fs.writeFileSync(`${OUT_DIR}/merged.css`, merged, 'utf8');

console.log('Relay 底座行数:', base.split('\n').length);
console.log('Kite 适配抽取块:', kept.length, '个 /', adaptLines, '行');
console.log('  @media 块:', kept.filter(k => k.kind === 'media').length);
console.log('合并后行数:', merged.split('\n').length);
console.log('合并后字节:', Buffer.byteLength(merged));
