// 按顶层规则块切分 Kite main.css，统计 Kite 专有类的规则块行数
const fs = require('fs');
const css = fs.readFileSync('e:/project/Antigravity Kite/resources/webview/main.css', 'utf8');
const lines = css.split('\n');

// 顶层块切分：跟踪花括号深度，深度从 0 -> 1 视为块开始
const blocks = []; // { startLine, endLine, selector }
let depth = 0, blockStart = -1, selectorLines = [];
for (let i = 0; i < lines.length; i++) {
  const line = lines[i];
  // 去掉字符串与注释里的括号干扰（CSS 简单起见，按计数）
  const opens = (line.match(/\{/g) || []).length;
  const closes = (line.match(/\}/g) || []).length;
  if (depth === 0 && opens > 0) {
    blockStart = i;
    selectorLines = [];
  }
  if (depth === 0) selectorLines.push(line);
  depth += opens - closes;
  if (depth === 0 && blockStart >= 0 && closes > 0) {
    const sel = selectorLines.join(' ').replace(/\{[^}]*$/, '').replace(/\s+/g, ' ').trim();
    blocks.push({ startLine: blockStart + 1, endLine: i + 1, selector: sel });
    blockStart = -1;
    selectorLines = [];
  }
}

console.log('顶层规则块总数:', blocks.length);

// Kite 专有类清单（Relay CSS 无定义 + Kite HTML 有使用）
const KITE_ONLY_PREFIXES = [
  'kite-', 'inst-toolbar', 'inst-count-badge', 'inst-cockpit-btn', 'inst-btn',
  'inst-card-dot', 'inst-icon-btn', 'inst-create-hint', 'inst-del', 'inst-start', 'inst-stop',
  'accounts-section-', 'enhance-section', 'enhance-card-header', 'enhance-card-title',
  'enhance-card-desc', 'enhance-card-body', 'enhance-sub-row', 'enhance-sub-row-grid',
  'enhance-sub-col', 'sub-col-label', 'enhance-status-badge', 'enhance-status-msg',
  'enhance-toggle', 'enhance-toggle-slider', 'enhance-desc',
  'add-account-modal', 'add-modal-', 'add-option-',
  'import-modal-', 'quota-grid2', 'q2-', 'quota-load-error',
  'recommend-btn', 'status-dot-btn', 'page-btn', 'page-ellipsis',
  'tag-edit-', 'toast-', 'privacy-eye', 'accept-stats-bar', 'stats-',
  'micro-number-input', 'pill-selector', 'remaining-input-box', 'enhance-textarea',
  'enhance-input', 'enhance-apply-btn', 'enhance-remove-btn', 'enhance-actions',
  'enhance-details-summary', 'enhance-details-desc', 'enhance-details-content',
  'filter-option-check', 'cockpit-item', 'cockpit-imported', 'list-icon', 'list-arrow',
  'panel-divider',
];

function isKiteOnly(sel) {
  return KITE_ONLY_PREFIXES.some(p => sel.includes('.' + p) || sel.includes(p));
}

const kiteBlocks = blocks.filter(b => isKiteOnly(b.selector));
let totalLines = 0;
for (const b of kiteBlocks) totalLines += (b.endLine - b.startLine + 1);

console.log('Kite 专有规则块数:', kiteBlocks.length, '总行数:', totalLines);
console.log('\n--- 前 60 个块 ---');
kiteBlocks.slice(0, 60).forEach(b => {
  console.log(`L${b.startLine}-${b.endLine} (${b.endLine - b.startLine + 1}行) :: ${b.selector.slice(0, 110)}`);
});

// 媒体查询 / 主题变体里是否也含 Kite 专有类
const mediaCount = blocks.filter(b => b.selector.startsWith('@media') || b.selector.startsWith('@supports')).length;
console.log('\n@media/@supports 块数:', mediaCount);

fs.writeFileSync('e:/project/Antigravity Kite/tmp/css_diff/kite_blocks.json', JSON.stringify(kiteBlocks, null, 2), 'utf8');
