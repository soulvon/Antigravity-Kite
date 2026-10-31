// 适配层压平：同选择器的多层补丁做属性级合并，输出位置取最后一次出现
const fs = require('fs');
const DIR = 'e:/project/Antigravity Kite/tmp/css_diff';
const adapt = fs.readFileSync(`${DIR}/part2_adapt_raw.css`, 'utf8');

/* ---------- 解析顶层块 ---------- */
function parseBlocks(css) {
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
      const raw = lines.slice(start, i + 1).join('\n');
      // 块内声明体：去掉选择器部分与最外层花括号
      const openIdx = raw.indexOf('{');
      const body = raw.slice(openIdx + 1, raw.lastIndexOf('}'));
      out.push({ sel, body, index: out.length });
      start = -1; selLines = [];
    }
  }
  return out;
}

/* ---------- 声明切分（考虑括号与引号） ---------- */
function splitDecls(body) {
  const decls = [];
  let buf = '', paren = 0, quote = null;
  for (let i = 0; i < body.length; i++) {
    const c = body[i];
    if (quote) {
      buf += c;
      if (c === '\\') { buf += body[++i] || ''; continue; }
      if (c === quote) quote = null;
      continue;
    }
    if (c === '"' || c === "'") { quote = c; buf += c; continue; }
    if (c === '(') { paren++; buf += c; continue; }
    if (c === ')') { paren--; buf += c; continue; }
    if (c === ';' && paren === 0) { if (buf.trim()) decls.push(buf.trim()); buf = ''; continue; }
    buf += c;
  }
  if (buf.trim()) decls.push(buf.trim());
  return decls.filter(d => d.includes(':'));
}

/* ---------- 归一化选择器 ---------- */
function normSel(sel) {
  return sel.split(',').map(s => s.trim()
    .replace(/::?[\w-]+(\([^)]*\))?/g, '')
    .replace(/\s*>\s*/g, '>')
    .replace(/\s+/g, ' ')).filter(Boolean).sort().join(', ');
}

/* ---------- 合并 ---------- */
const blocks = parseBlocks(adapt);
const topBlocks = blocks.filter(b => !b.sel.startsWith('@'));
const mediaBlocks = blocks.filter(b => b.sel.startsWith('@'));

const merged = new Map(); // normSel -> { sel, lastIndex, props: Map<prop, {value, important}> }
for (const b of topBlocks) {
  const key = normSel(b.sel);
  if (!merged.has(key)) merged.set(key, { sel: b.sel, lastIndex: b.index, props: new Map() });
  const entry = merged.get(key);
  entry.lastIndex = b.index;          // 位置取最后一次出现
  entry.sel = b.sel;                  // 用最后出现的写法
  for (const d of splitDecls(b.body)) {
    const ci = d.indexOf(':');
    const prop = d.slice(0, ci).trim().toLowerCase();
    let value = d.slice(ci + 1).trim();
    const important = /!important\s*$/i.test(value);
    if (important) value = value.replace(/!important\s*$/i, '').trim();
    const prev = entry.props.get(prop);
    // !important 优先：旧的是 important 而新的不是，则保留旧的
    if (prev && prev.important && !important) continue;
    entry.props.set(prop, { value, important });
  }
}

// 按最后出现顺序输出
const ordered = [...merged.values()].sort((a, b) => a.lastIndex - b.lastIndex);

function emit(entry) {
  const decls = [...entry.props.entries()]
    .map(([p, v]) => `    ${p}: ${v.value}${v.important ? ' !important' : ''};`)
    .join('\n');
  return `${entry.sel} {\n${decls}\n}`;
}

const outParts = [];
outParts.push('/* Kite 专有组件：旧 CSS 的 5 层补丁已按属性级合并压平为单层 */');
for (const e of ordered) outParts.push(emit(e));

// @media 原样保留（内部散乱但数量少，且条件互不重叠）
if (mediaBlocks.length) {
  outParts.push('');
  outParts.push('/* 响应式补充 */');
  for (const m of mediaBlocks) outParts.push(m.sel + m.body.replace(/^\s*/, ' ') .replace(/\{\s*/, ' {\n    ').replace(/\}\s*$/, '\n}'));
}

const result = outParts.join('\n\n') + '\n';
fs.writeFileSync(`${DIR}/part2_adapt.css`, result, 'utf8');

const impBefore = (adapt.match(/!important/g) || []).length;
const impAfter = (result.match(/!important/g) || []).length;
console.log('合并前:', adapt.split('\n').length, '行 /', adapt.length, '字节 /', impBefore, '!important');
console.log('合并后:', result.split('\n').length, '行 /', result.length, '字节 /', impAfter, '!important');
console.log('选择器数:', ordered.length, '| @media 块:', mediaBlocks.length);
