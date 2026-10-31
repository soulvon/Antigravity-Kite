// 检查 Relay 底座中会与 Kite 布局冲突的基础规则（body / html / .app / .tab-page / .card）
const fs = require('fs');
const css = fs.readFileSync('E:/project/BuddyRelay/resources/webview/main.css', 'utf8');
const lines = css.split('\n');

const TARGETS = ['body', 'html', '.app', '.tab-page', '.card', '.list-card', '.list-body', '.list-details'];
const blocks = [];
let depth = 0, blockStart = -1, selLines = [];
for (let i = 0; i < lines.length; i++) {
  const opens = (lines[i].match(/\{/g) || []).length;
  const closes = (lines[i].match(/\}/g) || []).length;
  if (depth === 0 && opens > 0) { blockStart = i; selLines = []; }
  if (depth === 0) selLines.push(lines[i]);
  depth += opens - closes;
  if (depth === 0 && blockStart >= 0 && closes > 0) {
    const sel = selLines.join(' ').replace(/\s+/g, ' ').trim().replace(/\{$/, '');
    blocks.push({ s: blockStart + 1, e: i + 1, sel });
    blockStart = -1; selLines = [];
  }
}

function hit(sel) {
  // 选择器以 body / html / .app / .tab-page / .card 开头或单独出现
  return /(^|,)\s*(body|html)\b/.test(sel) || /(^|,)\s*\.(app|tab-page|card|list-card|list-body)\b/.test(sel);
}

console.log('=== Relay 底座中 body/html/.app/.tab-page/.card 相关顶层块 ===');
for (const b of blocks) {
  if (hit(b.sel)) {
    console.log(`\n----- L${b.s}-${b.e} -----`);
    console.log(lines.slice(b.s - 1, b.e).join('\n'));
  }
}
