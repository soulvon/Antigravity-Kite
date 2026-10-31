// 最终生成：Relay 底座原样搬入 + ID 重映射 + Kite 专有适配层（属性级压平）+ 布局修正
const fs = require('fs');

const RELAY_CSS = 'E:/project/BuddyRelay/resources/webview/main.css';
// 必须读迁移前的原始备份：目标文件已被本脚本覆盖过，直接读会自噬
const KITE_CSS = 'e:/project/Antigravity Kite/tmp/backup_css/main.css.bak';
const DIR = 'e:/project/Antigravity Kite/tmp/css_diff';

/* ---------- 1. 底座：Relay 原样 ---------- */
let relay = fs.readFileSync(RELAY_CSS, 'utf8');

/* ---------- 2. ID 重映射 ---------- */
const ID_MAP = [
  ['#tab-account', '#tabAccounts'],
  ['#tab-instance', '#tabInstances'],
  ['#tab-enhance', '#tabEnhance'],
];
for (const [from, to] of ID_MAP) relay = relay.split(from).join(to);

/* ---------- 3. Kite 专有组件清单 ---------- */
// 只列当前 HTML 里真实存在的 Kite 专有类。
// 多实例 inst-* / 增强面板 enhance-* / Cockpit 列表 cockpit-* 等面板已从 HTML 移除，不再抽取。
const KITE_ONLY = [
  'accounts-section-header',
  'add-account-modal', 'add-modal-body', 'add-modal-close', 'add-modal-content',
  'add-modal-header', 'add-modal-option', 'add-modal-title',
  'add-option-desc', 'add-option-icon', 'add-option-info', 'add-option-title',
  'confirm-actions', 'confirm-danger-btn', 'confirm-message',
  'filter-option-check',
  'import-modal-actions', 'import-modal-body', 'import-modal-btn', 'import-modal-close',
  'import-modal-content', 'import-modal-desc', 'import-modal-email', 'import-modal-header',
  'import-modal-title', 'import-modal-warning',
  'page-btn', 'page-ellipsis',
  'privacy-eye',
  'q2-cell', 'q2-col', 'q2-head', 'q2-name', 'q2-reset', 'q2-title', 'q2-val',
  'quota-grid2', 'quota-load-error',
  'tag-edit-chip', 'tag-edit-color-dot', 'tag-edit-existing', 'tag-edit-opt',
  'tag-edit-remove', 'tag-edit-selected',
  'toast-container', 'toast-detail', 'toast-icon', 'toast-spinner',
];

const kiteRaw = fs.readFileSync(KITE_CSS, 'utf8');
const kiteLines = kiteRaw.split('\n');

function parseTopBlocks(css) {
  const lines = css.split('\n');
  const out = [];
  let depth = 0, start = -1, selLines = [];
  for (let i = 0; i < lines.length; i++) {
    const opens = (lines[i].match(/\{/g) || []).length;
    const closes = (lines[i].match(/\}/g) || []).length;
    if (depth === 0 && opens > 0) { start = i; selLines = []; }
    if (depth === 0) selLines.push(lines[i]);
    depth += opens - closes;
    if (depth === 0 && start >= 0 && closes > 0) {
      const raw = lines.slice(start, i + 1).join('\n');
      const braceIdx = raw.indexOf('{');
      // 选择器 = 第一个 { 之前的全部内容（单行规则块也正确切分），去掉混入的注释
      const sel = raw.slice(0, braceIdx)
        .replace(/\/\*[\s\S]*?\*\//g, ' ')
        .replace(/\s+/g, ' ').trim();
      out.push({
        sel, s: start, e: i, index: out.length,
        body: raw.slice(braceIdx + 1, raw.lastIndexOf('}')).replace(/\/\*[\s\S]*?\*\//g, ' '),
      });
      start = -1; selLines = [];
    }
  }
  return out;
}

const hitKite = (t) => KITE_ONLY.some(k => t.includes('.' + k));
const blocks = parseTopBlocks(kiteRaw);
const topRules = blocks.filter(b => !b.sel.startsWith('@') && hitKite(b.sel));
const mediaRules = blocks.filter(b => b.sel.startsWith('@') &&
  hitKite(kiteLines.slice(b.s, b.e + 1).join('\n')));

/* ---------- 4. 属性级合并 ---------- */
function splitDecls(body) {
  const decls = []; let buf = '', paren = 0, quote = null;
  for (let i = 0; i < body.length; i++) {
    const c = body[i];
    if (quote) { buf += c; if (c === '\\') { buf += body[++i] || ''; continue; } if (c === quote) quote = null; continue; }
    if (c === '"' || c === "'") { quote = c; buf += c; continue; }
    if (c === '(') { paren++; buf += c; continue; }
    if (c === ')') { paren--; buf += c; continue; }
    if (c === ';' && paren === 0) { if (buf.trim()) decls.push(buf.trim()); buf = ''; continue; }
    buf += c;
  }
  if (buf.trim()) decls.push(buf.trim());
  return decls.filter(d => d.includes(':'));
}

// 归一化只做空白处理，保留伪类/伪元素：.foo 与 .foo:hover 必须视为不同规则
const normSel = (sel) => sel.split(',').map(s => s.trim()
  .replace(/\s*>\s*/g, '>').replace(/\s+/g, ' '))
  .filter(Boolean).sort().join(', ');

const merged = new Map();
for (const b of topRules) {
  const key = normSel(b.sel);
  if (!merged.has(key)) merged.set(key, { sel: b.sel, lastIndex: b.index, props: new Map() });
  const e = merged.get(key);
  e.lastIndex = b.index; e.sel = b.sel;
  for (const d of splitDecls(b.body)) {
    const ci = d.indexOf(':');
    const prop = d.slice(0, ci).trim().toLowerCase();
    let value = d.slice(ci + 1).trim();
    const important = /!important\s*$/i.test(value);
    if (important) value = value.replace(/!important\s*$/i, '').trim();
    const prev = e.props.get(prop);
    if (prev && prev.important && !important) continue;
    e.props.set(prop, { value, important });
  }
}
const ordered = [...merged.values()].sort((a, b) => a.lastIndex - b.lastIndex);
const emitBlock = (e) => `${e.sel} {\n${[...e.props].map(([p, v]) => `    ${p}: ${v.value}${v.important ? ' !important' : ''};`).join('\n')}\n}`;

/* ---------- 5. 组装 ---------- */
const HEAD = `/*
 * Antigravity Kite — 侧栏样式
 *
 * 结构：
 *   PART 1  BASE  — 视觉底座，原样搬入 E:/project/BuddyRelay/resources/webview/main.css，
 *                   仅做 tab 容器 ID 重映射（#tab-account -> #tabAccounts，其余类推）
 *   PART 2  ADAPT — Kite 独有组件（多实例 / 增强面板 / 配额 2x2 / 弹窗 / Toast / 分页）
 *                   旧文件里的 5 层补丁已按属性级合并压平为单层
 *   PART 3  FIX   — 底座与 Kite 布局的少量对齐修正
 *
 * 已知事项：底座源文件存在若干「丢失选择器头的孤立声明段」，浏览器按规范直接丢弃、
 * 从不生效。此处保持原样以维持与 BuddyRelay 的视觉一致，待视觉验收通过后单独清理。
 */

/* ═══════════════════════════════════════════════════════════════
   PART 1 · BASE — BuddyRelay 样式底座
   ═══════════════════════════════════════════════════════════════ */


`;

const ADAPT_HEAD = `

/* ═══════════════════════════════════════════════════════════════
   PART 2 · ADAPT — Kite 专有组件
   ═══════════════════════════════════════════════════════════════ */

`;

const adaptBody = ordered.map(emitBlock).join('\n\n') +
  (mediaRules.length ? '\n\n' + mediaRules.map(b => kiteLines.slice(b.s, b.e + 1).join('\n')).join('\n\n') : '');

const FIX = `

/* ═══════════════════════════════════════════════════════════════
   PART 3 · FIX — 布局对齐修正
   ═══════════════════════════════════════════════════════════════ */

/* 侧栏底色：底座 body 上有一层顶部蓝色渐变，BuddyRelay 用同一条规则压成纯色 */
body {
    background: var(--vscode-sideBar-background, var(--vscode-editor-background)) !important;
}

/* tab 栏：底座按 4 列网格设计，Kite 只有 3 个页签，改成 3 列铺满 */
.app-tabs {
    grid-template-columns: repeat(3, minmax(0, 1fr));
}

/* 窄侧栏：底座未覆盖的部分，沿用 Kite 原有断点 */
@media (max-width: 420px) {
    .app {
        padding-left: 8px;
        padding-right: 8px;
    }
}

@media (max-width: 340px) {
    .toolbar-bar {
        flex-wrap: wrap;
        row-gap: 5px;
    }
}

@media (max-width: 320px) {
    .tab-count {
        display: none;
    }
}

/* 账号区标题：人形图标转灰、去掉与面板分隔线重复的那条线 */
.accounts-section-header .list-icon {
    /* 底座把 .list-icon 设成绿色并带 !important，此处必须同等强度才压得住 */
    color: var(--muted) !important;
    opacity: 1;
}
.accounts-section-header {
    border-bottom: 1px solid var(--card-border);
    margin-bottom: 0;
}
#tabAccounts .panel-divider {
    display: none;
}

/* 账号计数：与 BuddyRelay 完全一致 —— 去外发光、12px/800、等宽数字 */
.accounts-section-header .grid-count {
    box-shadow: none;
    font-size: 12px;
    font-weight: 800;
    font-family: var(--font-sans);
    font-variant-numeric: tabular-nums;
    line-height: 1.2;
    min-height: 24px;
    display: inline-flex;
    align-items: center;
    justify-content: center;
}

/* 配额条：对齐 BuddyRelay 的 7px 胶囊 */
.q2-col .quota-bar,
.grid-card-quotas .quota-bar {
    height: 7px;
    border-radius: 4px;
}

/* 搜索框：按主题分色，深色下极淡、浅色下纯白（对齐 BuddyRelay） */
#tabAccounts .search-bar {
    box-shadow: none !important;
}
body.vscode-dark #tabAccounts .search-bar,
body.vscode-high-contrast #tabAccounts .search-bar {
    background: rgba(255, 255, 255, 0.05) !important;
    border: 1px solid rgba(255, 255, 255, 0.12) !important;
}
body.vscode-light #tabAccounts .search-bar,
body.vscode-high-contrast-light #tabAccounts .search-bar {
    background: #ffffff !important;
    border: 1px solid rgba(0, 0, 0, 0.12) !important;
    box-shadow: 0 1px 2px rgba(0, 0, 0, 0.04) !important;
}
body.vscode-dark #tabAccounts .search-bar:focus-within,
body.vscode-high-contrast #tabAccounts .search-bar:focus-within {
    border-color: var(--ac-emerald) !important;
    box-shadow: 0 0 0 2px color-mix(in srgb, var(--ac-emerald) 20%, transparent) !important;
}
body.vscode-light #tabAccounts .search-bar:focus-within,
body.vscode-high-contrast-light #tabAccounts .search-bar:focus-within {
    border-color: var(--ac-emerald) !important;
    box-shadow: 0 0 0 2px rgba(16, 185, 129, 0.15) !important;
}

/* 卡片底栏：左侧操作与右侧图标统一为 BuddyRelay 的一套规格 */
.grid-card-actions {
    display: flex;
    align-items: center;
    gap: 6px;
    margin-top: 8px;
    padding-top: 8px;
    border-top: 1px solid var(--card-border);
}

/* 切换按钮：BuddyRelay 同款绿→青→蓝渐变胶囊 + 品牌色投影 */
.grid-card-actions .grid-switch-btn {
    flex: 0 0 auto;
    height: 24px;
    padding: 0 12px;
    font-size: 11px;
    font-weight: 500;
    line-height: 1;
    border-radius: 999px;
    border: 1px solid color-mix(in srgb, var(--ac-emerald) 55%, transparent);
    background: linear-gradient(135deg, #10b981, #14b8a6 55%, #3b82f6);
    color: #fff;
    box-shadow: var(--ui-shadow-active);
}
.grid-card-actions .grid-switch-btn:hover {
    filter: brightness(1.06);
}

/* 「使用中」状态：与切换按钮同高，不再单独成行 */
.grid-card-actions .grid-current-label {
    flex: 0 0 auto;
    height: 24px;
    font-size: 11px;
    font-weight: 600;
    gap: 5px;
    color: var(--ac-emerald);
}

/* 右侧图标组：透明幽灵，hover 才提亮 */
.grid-card-actions .grid-actions-right {
    display: flex;
    align-items: center;
    gap: 4px;
    margin-left: auto;
    flex: 0 0 auto;
}
.grid-card-actions .icon-btn {
    width: 24px;
    height: 24px;
    padding: 0;
    border: none;
    border-radius: 6px;
    background: transparent;
    box-shadow: none;
    color: var(--muted);
    opacity: 0.8;
}
.grid-card-actions .icon-btn:hover {
    opacity: 1;
    color: var(--vscode-foreground);
    background: var(--hover-bg);
}
.grid-card-actions .icon-btn.danger:hover {
    color: var(--gh-red);
    background: color-mix(in srgb, var(--gh-red) 12%, transparent);
}

/* 切换中加载态：按钮内转圈 + 等待光标 */
.grid-card-actions .btn-spinner {
    width: 10px;
    height: 10px;
    border: 2px solid rgba(255, 255, 255, 0.45);
    border-top-color: #fff;
    border-radius: 50%;
    display: inline-block;
    margin-right: 5px;
    vertical-align: -1px;
    animation: spin 0.7s linear infinite;
}
.grid-card-actions .grid-switch-btn.is-loading {
    cursor: wait;
    opacity: 0.85;
}

/* 账号启停开关：沿用 BuddyRelay .status-switch 设计语言 */
.grid-card-actions .status-switch {
    width: 26px;
    height: 15px;
    min-width: 26px;
    min-height: 15px;
    padding: 0;
    border: none;
    border-radius: 8px;
    cursor: pointer;
    flex-shrink: 0;
    display: inline-block;
    position: relative;
    box-sizing: border-box;
    vertical-align: middle;
    transition: background 0.2s;
}
.grid-card-actions .status-switch .status-switch-thumb {
    position: absolute;
    width: 11px;
    height: 11px;
    top: 2px;
    left: 2px;
    background: #ffffff;
    border-radius: 50%;
    box-shadow: 0 1px 3px rgba(0, 0, 0, 0.3);
    transition: transform 0.25s cubic-bezier(0.34, 1.56, 0.64, 1);
}
.grid-card-actions .status-switch.is-on {
    background: color-mix(in srgb, var(--gh-green, #3fb950) 45%, #8b9a90);
}
.grid-card-actions .status-switch.is-on:hover {
    background: color-mix(in srgb, var(--gh-green, #3fb950) 58%, #8b9a90);
}
.grid-card-actions .status-switch.is-on .status-switch-thumb {
    transform: translateX(11px);
}
.grid-card-actions .status-switch.is-off {
    background: color-mix(in srgb, var(--vscode-foreground) 20%, transparent);
}
.grid-card-actions .status-switch.is-off:hover {
    background: color-mix(in srgb, var(--gh-green, #3fb950) 35%, transparent);
}

/* 侧栏内边距：对齐 BuddyRelay，顶部留 6px 让 tab 栏不贴边 */
.app {
    padding: 6px 10px 20px;
}

/* ═══════════════════════════════════════════════════════════════
   设置面板（全屏沉浸式模态，对齐 BuddyRelay 设计系统）
   ═══════════════════════════════════════════════════════════════ */
#settingsOverlay.modal-overlay:not([hidden]) {
    position: fixed !important;
    inset: 0 !important;
    width: 100% !important;
    height: 100% !important;
    background: var(--vscode-sideBar-background, var(--vscode-editor-background, #ffffff)) !important;
    backdrop-filter: none !important;
    -webkit-backdrop-filter: none !important;
    z-index: 1000 !important;
    display: flex !important;
    flex-direction: column !important;
    padding: 0 !important;
    margin: 0 !important;
    border: none !important;
    animation: none !important;
}

#settingsOverlay .modal-box {
    width: 100% !important;
    max-width: 100% !important;
    height: 100% !important;
    max-height: 100% !important;
    border: none !important;
    border-radius: 0 !important;
    background: transparent !important;
    box-shadow: none !important;
    display: flex !important;
    flex-direction: column !important;
    animation: none !important;
    overflow: hidden !important;
}

#settingsOverlay .modal-header {
    padding: 12px 14px !important;
    border-bottom: 1px solid var(--ui-border, var(--card-border)) !important;
    background: transparent !important;
    display: flex !important;
    align-items: center !important;
    justify-content: space-between !important;
    flex-shrink: 0 !important;
}

#settingsOverlay .modal-header h3 {
    margin: 0 !important;
    font-size: 13px !important;
    font-weight: 700 !important;
    color: var(--vscode-foreground) !important;
}

#settingsOverlay .modal-body {
    flex: 1 1 auto !important;
    overflow-y: auto !important;
    padding: 12px 14px !important;
    display: flex !important;
    flex-direction: column !important;
    gap: 10px !important;
    min-height: 0 !important;
}

#settingsOverlay .modal-footer {
    padding: 10px 14px !important;
    border-top: 1px solid var(--ui-border, var(--card-border)) !important;
    background: transparent !important;
    display: flex !important;
    align-items: center !important;
    justify-content: space-between !important;
    flex-shrink: 0 !important;
}

/* 卡片容器：BuddyRelay 同款边框与微底色 */
.settings-group {
    border: 1px solid var(--card-border) !important;
    border-radius: var(--radius-md, 8px) !important;
    background: var(--card-bg) !important;
    padding: 10px 12px !important;
    display: flex !important;
    flex-direction: column !important;
    gap: 8px !important;
}

.settings-group-head {
    display: flex !important;
    align-items: center !important;
    gap: 6px !important;
    font-size: 12px !important;
    font-weight: 600 !important;
    color: var(--vscode-foreground) !important;
    padding-bottom: 2px;
}

.settings-group-head svg {
    color: var(--muted) !important;
    flex-shrink: 0 !important;
}

.settings-row {
    display: flex !important;
    align-items: center !important;
    justify-content: space-between !important;
    gap: 10px !important;
    min-height: 26px !important;
}

.settings-row-label {
    font-size: 11.5px !important;
    color: var(--vscode-foreground) !important;
    min-width: 0 !important;
}

.settings-input {
    height: 26px !important;
    padding: 0 8px !important;
    font-size: 12px !important;
    font-family: var(--font-sans) !important;
    color: var(--vscode-foreground) !important;
    background: var(--vscode-input-background, var(--elevated-bg)) !important;
    border: 1px solid var(--card-border) !important;
    border-radius: 6px !important;
    outline: none !important;
    min-width: 0 !important;
    box-sizing: border-box !important;
}

.settings-input:focus {
    border-color: var(--ac-emerald) !important;
}

.settings-row .settings-input {
    width: 80px !important;
    text-align: center !important;
}

.settings-select {
    height: 26px !important;
    padding: 0 6px !important;
    font-size: 11.5px !important;
    color: var(--vscode-foreground) !important;
    background: var(--vscode-dropdown-background, var(--elevated-bg)) !important;
    border: 1px solid var(--card-border) !important;
    border-radius: 6px !important;
    outline: none !important;
    box-sizing: border-box !important;
}

.settings-hint {
    font-size: 10.5px !important;
    color: var(--muted) !important;
    line-height: 1.4 !important;
    padding-top: 2px !important;
    border-top: 1px dashed var(--card-border) !important;
}

/* 标签编辑弹窗：chip 的配色由 JS 内联控制，这里只补输入框与悬停反馈 */
#tagEditInput {
    height: 28px;
    padding: 0 10px;
    font-size: 12px;
    color: var(--vscode-foreground);
    background: var(--vscode-input-background, var(--elevated-bg));
    border: 1px solid var(--card-border);
    border-radius: 6px;
    outline: none;
}
#tagEditInput:focus {
    border-color: var(--ac-emerald);
}
.tag-edit-color-dot {
    transition: transform 0.12s;
}
.tag-edit-color-dot:hover {
    transform: scale(1.2);
}
.tag-edit-chip:hover,
.tag-edit-opt:hover {
    filter: brightness(1.08);
}
.tag-edit-remove {
    transition: color 0.12s, opacity 0.12s;
}
.tag-edit-remove:hover {
    opacity: 1;
    color: var(--gh-red);
}
`;

const out = HEAD + relay + ADAPT_HEAD + adaptBody + FIX + '\n';
fs.writeFileSync(`${DIR}/final.css`, out, 'utf8');

console.log('底座行数:', relay.split('\n').length);
console.log('适配层: 规则块', ordered.length, '| @media', mediaRules.length, '| 行数', adaptBody.split('\n').length);
console.log('最终行数:', out.split('\n').length, '| 字节:', Buffer.byteLength(out));
console.log('!important:', (out.match(/!important/g) || []).length);
console.log('#tab-account 残留:', out.split('#tab-account').length - 1);
console.log('.kite-tab 残留:', out.split('.kite-tab').length - 1);
