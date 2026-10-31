// 追踪账号 tab 区域所有 background 来源
const fs = require('fs');
const css = fs.readFileSync('e:/project/Antigravity Kite/resources/webview/main.css', 'utf8');
const lines = css.split('\n');

const blocks = [];
let depth = 0, start = -1, selLines = [];
for (let i = 0; i < lines.length; i++) {
  const opens = (lines[i].match(/\{/g) || []).length;
  const closes = (lines[i].match(/\}/g) || []).length;
  if (depth === 0 && opens > 0) { start = i; selLines = []; }
  if (depth === 0) selLines.push(lines[i]);
  depth += opens - closes;
  if (depth === 0 && start >= 0 && closes > 0) {
    const sel = (lines.slice(start, start + 4).join(' ').split('{')[0] || '').replace(/\s+/g, ' ').trim();
    blocks.push({ s: start + 1, e: i + 1, sel, body: lines.slice(start, i + 1).join('\n') });
    start = -1; selLines = [];
  }
}

const TARGETS = ['#tabAccounts', '.tab-page', '.list-body', '.accounts-section-header', '.app', 'body'];
console.log('=== 影响账号区背景的规则（按行号） ===\n');
for (const b of blocks) {
  if (b.sel.startsWith('@')) continue;
  const hit = TARGETS.some(t => b.sel.split(',').some(x => x.trim().startsWith(t)));
  if (!hit) continue;
  if (!/background/.test(b.body)) continue;
  const bgLines = b.body.split('\n').filter(l => /background/.test(l)).map(l => l.trim());
  console.log(`L${b.s}-${b.e}  ${b.sel.replace(/\s+/g, ' ').slice(0, 90)}`);
  bgLines.forEach(l => console.log('      ' + l));
  console.log('');
}
