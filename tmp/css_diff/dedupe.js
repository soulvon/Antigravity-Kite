// 统计适配层内部的选择器重复覆盖情况
const fs = require('fs');
const DIR = 'e:/project/Antigravity Kite/tmp/css_diff';
const adapt = fs.readFileSync(`${DIR}/part2_adapt_raw.css`, 'utf8');

const lines = adapt.split('\n');
const blocks = [];
let depth = 0, start = -1, selLines = [];
for (let i = 0; i < lines.length; i++) {
  const opens = (lines[i].match(/\{/g) || []).length;
  const closes = (lines[i].match(/\}/g) || []).length;
  if (depth === 0 && opens > 0) { start = i; selLines = []; }
  if (depth === 0) selLines.push(lines[i]);
  depth += opens - closes;
  if (depth === 0 && start >= 0 && closes > 0) {
    const sel = selLines.join(' ').replace(/\s+/g, ' ').trim().replace(/\{$/, '');
    blocks.push({ s: start + 1, e: i + 1, sel, text: lines.slice(start, i + 1).join('\n') });
    start = -1; selLines = [];
  }
}

function norm(sel) {
  return sel.split(',').map(s => s.trim()
    .replace(/::?[\w-]+(\([^)]*\))?/g, '')
    .replace(/\s*>\s*/g, '>').replace(/\s+/g, ' ')).filter(Boolean).sort().join(' , ');
}

const groups = new Map();
for (const b of blocks) {
  if (b.sel.startsWith('@')) continue;
  const k = norm(b.sel);
  if (!groups.has(k)) groups.set(k, []);
  groups.get(k).push(b);
}

const dup = [...groups.entries()].filter(([, v]) => v.length > 1).sort((a, b) => b[1].length - a[1].length);

console.log('适配层规则块:', blocks.length, '| 归一化后唯一选择器:', groups.size);
console.log('重复覆盖的选择器:', dup.length, '组');

let dupLines = 0, keepLines = 0;
for (const [, v] of dup) for (let i = 0; i < v.length - 1; i++) dupLines += (v[i].e - v[i].s + 1);
for (const [, v] of groups) keepLines += (v[v.length - 1].e - v[v.length - 1].s + 1);
console.log('只保留最后一次出现可省行数:', dupLines, '| 保留后行数约:', keepLines);

console.log('\n=== 重复最多的 15 组 ===');
dup.slice(0, 15).forEach(([k, v]) => {
  console.log(`  ${v.length} 次 :: ${k.slice(0, 100)}`);
  console.log(`      行号 ${v.map(x => x.s).join(', ')}`);
});
