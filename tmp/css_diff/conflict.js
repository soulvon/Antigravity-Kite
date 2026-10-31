// 审查：底座与适配层的选择器重叠 + !important 用量 + 括号平衡
const fs = require('fs');
const DIR = 'e:/project/Antigravity Kite/tmp/css_diff';
const base = fs.readFileSync(`${DIR}/part1_base.css`, 'utf8');
const adapt = fs.readFileSync(`${DIR}/part2_adapt_raw.css`, 'utf8');
const merged = fs.readFileSync(`${DIR}/merged.css`, 'utf8');

function blocksOf(css) {
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
      const sel = selLines.join(' ').replace(/\s+/g, ' ').trim().replace(/\{$/, '');
      out.push({ s: start + 1, e: i + 1, sel, text: lines.slice(start, i + 1).join('\n') });
      start = -1; selLines = [];
    }
  }
  return out;
}

const bb = blocksOf(base), ab = blocksOf(adapt);

// 选择器归一化：拆逗号、去伪类、去空格
function keysOf(sel) {
  if (sel.startsWith('@')) return [];
  return sel.split(',').map(s => s.trim()
    .replace(/::?[\w-]+(\([^)]*\))?/g, '')   // 去伪类
    .replace(/\s*>\s*/g, '>')
    .replace(/\s+/g, ' ')
    .trim()).filter(Boolean);
}

const baseMap = new Map();
for (const b of bb) for (const k of keysOf(b.sel)) baseMap.set(k, (baseMap.get(k) || 0) + 1);
const adaptMap = new Map();
for (const b of ab) for (const k of keysOf(b.sel)) adaptMap.set(k, (adaptMap.get(k) || 0) + 1);

const overlap = [...adaptMap.keys()].filter(k => baseMap.has(k)).sort();

console.log('底座顶层块:', bb.length, '| 适配层顶层块:', ab.length);
console.log('\n=== 完全同名选择器重叠（适配层会压过底座）:', overlap.length, '个 ===');
overlap.forEach(k => console.log('  ' + k));

// !important 统计
const imp = (s) => (s.match(/!important/g) || []).length;
console.log('\n=== !important 用量 ===');
console.log('底座:', imp(base), '| 适配层:', imp(adapt), '| 合并:', imp(merged));

// 括号平衡
function balance(css, name) {
  let d = 0, bad = false;
  for (const ch of css) { if (ch === '{') d++; else if (ch === '}') { d--; if (d < 0) bad = true; } }
  console.log(`${name}: 最终深度=${d}${d === 0 && !bad ? ' ✔' : ' ✘ 不平衡'}`);
}
console.log('\n=== 花括号平衡 ===');
balance(base, '底座');
balance(adapt, '适配层');
balance(merged, '合并稿');

// 适配层里出现频率最高的 !important 块（可能是暴力覆盖）
const heavy = ab.filter(b => imp(b.text) >= 4).sort((a, b) => imp(b.text) - imp(a.text));
console.log('\n=== 适配层中 !important 最密集的 12 个块 ===');
heavy.slice(0, 12).forEach(b => console.log(`  ${imp(b.text)}x  L${b.s}-${b.e} :: ${b.sel.slice(0, 90)}`));
