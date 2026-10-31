/**
 * i18n 强校验门控（compile 后强制执行，失败退出非 0，阻断打包）
 *
 * 校验项：
 *   1. 字典双语同构：每个 key 的 [zh, en] 齐全、非空，且英文不得等于 key 本身（= 未翻译）
 *   2. 使用覆盖：源码用到的 key 必须全部在字典中
 *      - t(<宿主key>)        → 字典直查
 *      - tl(<ui-key>) / data-i18n*（extension.ts）→ 必须存在 ui.* 条目
 *      - l(<lp-key>) / data-i18n*（log-panel.js / logPanelProvider.ts）→ 必须存在 lp.* 条目
 *   3. package.json nls 对齐：%key% 占位符与两份 package.nls*.json 双向一致、值非空
 *
 * 约定：修改任何用户可见文案时，必须同步补齐中英双语，否则编译不过。
 */
'use strict';
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const problems = [];

// ── 加载编译产物中的字典 ──
let dict;
try {
  const mod = require(path.join(root, 'out', 'i18n.js'));
  dict = mod.__dictForCheck();
  if (!dict || typeof dict !== 'object') throw new Error('__dictForCheck() 返回非法');
} catch (e) {
  console.error('[check-i18n] 无法加载 out/i18n.js（请确认 tsc 已编译）: ' + e.message);
  process.exit(1);
}

// ── 1. 双语同构 ──
for (const [key, pair] of Object.entries(dict)) {
  if (!Array.isArray(pair) || pair.length !== 2) {
    problems.push(`字典 ${key}: 条目必须是 [zh, en] 双元素数组`);
    continue;
  }
  const [zh, en] = pair;
  if (typeof zh !== 'string' || !zh.trim()) problems.push(`字典 ${key}: 中文文案为空`);
  if (typeof en !== 'string' || !en.trim()) problems.push(`字典 ${key}: 英文文案为空`);
  if (en === key) problems.push(`字典 ${key}: 英文未翻译（等于 key 本身）`);
}

// ── 2. 使用覆盖 ──
function listFiles(dir, out) {
  for (const name of fs.readdirSync(dir)) {
    const p = path.join(dir, name);
    const st = fs.statSync(p);
    if (st.isDirectory()) {
      // scripts/ = 构建工具脚本（含本文件），不含业务文案，排除防自匹配
      if (name === 'node_modules' || name === 'out' || name === 'tmp' || name === 'scripts') continue;
      listFiles(p, out);
    } else if (/\.(ts|js)$/.test(name)) {
      out.push(p);
    }
  }
  return out;
}

const files = listFiles(root, []);
const hostKeys = new Set(); // t() 直查字典的 key
const uiKeys = new Set();   // tl() / data-i18n（extension.ts）
const lpKeys = new Set();   // l() / data-i18n（log-panel.js、logPanelProvider.ts）

for (const file of files) {
  const rel = path.relative(root, file).replace(/\\/g, '/');
  const text = fs.readFileSync(file, 'utf8');

  for (const m of text.matchAll(/\bt\(\s*['"]([a-zA-Z0-9_.]+)['"]/g)) hostKeys.add(m[1]);

  // ui.* 条目：extension.ts 的 tl() 与 data-i18n 属性
  if (rel === 'src/extension.ts') {
    for (const m of text.matchAll(/\btl\(\s*['"]([a-zA-Z0-9_]+)['"]/g)) uiKeys.add(m[1]);
    for (const m of text.matchAll(/data-i18n(?:-ph|-title)?="([a-zA-Z0-9_]+)"/g)) uiKeys.add(m[1]);
  }
  // lp.* 条目：log-panel.js 的 l() 与 data-i18n；logPanelProvider.ts 的 t('lp.*') 与 data-i18n
  if (rel === 'resources/webview/log-panel.js') {
    for (const m of text.matchAll(/\bl\(\s*['"]([a-zA-Z0-9_]+)['"]/g)) lpKeys.add(m[1]);
  }
  if (rel === 'src/logPanelProvider.ts') {
    for (const m of text.matchAll(/data-i18n(?:-ph|-title)?="([a-zA-Z0-9_]+)"/g)) lpKeys.add(m[1]);
    for (const m of text.matchAll(/\bt\(\s*['"](lp\.[a-zA-Z0-9_]+)['"]/g)) hostKeys.add(m[1]);
  }
}

for (const k of hostKeys) {
  if (!(k in dict)) problems.push(`宿主文案缺 key: ${k}`);
}
for (const k of uiKeys) {
  if (!('ui.' + k in dict)) problems.push(`侧栏面板缺 key: ui.${k}`);
}
for (const k of lpKeys) {
  if (!('lp.' + k in dict)) problems.push(`统计面板缺 key: lp.${k}`);
}

// ── 3. package.json nls 对齐 ──
const pkgRaw = fs.readFileSync(path.join(root, 'package.json'), 'utf8');
const usedNls = [...pkgRaw.matchAll(/%([a-zA-Z0-9_.]+)%/g)].map(m => m[1]);
const nlsEn = JSON.parse(fs.readFileSync(path.join(root, 'package.nls.json'), 'utf8'));
const nlsZh = JSON.parse(fs.readFileSync(path.join(root, 'package.nls.zh-cn.json'), 'utf8'));

for (const k of usedNls) {
  if (!(k in nlsEn) || !String(nlsEn[k]).trim()) problems.push(`package.nls.json 缺 key 或为空: ${k}`);
  if (!(k in nlsZh) || !String(nlsZh[k]).trim()) problems.push(`package.nls.zh-cn.json 缺 key 或为空: ${k}`);
}
for (const k of Object.keys(nlsEn)) {
  if (!usedNls.includes(k)) problems.push(`package.nls.json 多余 key（package.json 未引用）: ${k}`);
}
for (const k of Object.keys(nlsZh)) {
  if (!usedNls.includes(k)) problems.push(`package.nls.zh-cn.json 多余 key（package.json 未引用）: ${k}`);
}

// ── 结果 ──
console.log(`[check-i18n] 字典 ${Object.keys(dict).length} 条 | 宿主 ${hostKeys.size} + 侧栏 ${uiKeys.size} + 统计面板 ${lpKeys.size} 个使用点 | nls ${usedNls.length} 个占位符`);
if (problems.length) {
  console.error('[check-i18n] FAIL — 以下问题必须修复（改动文案请同步补齐中英双语）:');
  for (const p of problems) console.error('  - ' + p);
  process.exit(1);
}
console.log('[check-i18n] OK');
