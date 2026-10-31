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
const pkgJson = JSON.parse(pkgRaw);
const currentVersion = pkgJson.version;
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

// ── 4. 文档双语同步与版本对齐门控 ──
const readmeZhPath = path.join(root, 'README.md');
const readmeEnPath = path.join(root, 'README_en.md');
const i18nGuidePath = path.join(root, 'docs', 'I18N_GUIDE.md');

if (!fs.existsSync(i18nGuidePath)) {
  problems.push('缺少国际化开发指南: docs/I18N_GUIDE.md');
}

if (fs.existsSync(readmeZhPath) && fs.existsSync(readmeEnPath)) {
  const readmeZh = fs.readFileSync(readmeZhPath, 'utf8');
  const readmeEn = fs.readFileSync(readmeEnPath, 'utf8');

  // 校验两份文档顶部的版本徽标是否与 package.json 一致
  const versionBadgePattern = new RegExp(`badge/version-${currentVersion.replace(/\./g, '\\.')}-`, 'i');
  if (!versionBadgePattern.test(readmeZh)) {
    problems.push(`README.md 版本徽标未更新为当前版本 v${currentVersion}`);
  }
  if (!versionBadgePattern.test(readmeEn)) {
    problems.push(`README_en.md 版本徽标未更新为当前版本 v${currentVersion}`);
  }
} else {
  problems.push('缺少双语 README 文档（需同时具备 README.md 与 README_en.md）');
}

// ── 5. 源码关键 UI 渲染区硬编码中文防御 ──
// 重点扫描卡片配额渲染与状态栏渲染区，杜绝直接写死汉字
const extSrc = fs.readFileSync(path.join(root, 'src', 'extension.ts'), 'utf8');
const quotasBlockMatch = extSrc.match(/\/\/ 模型配额：单列竖排[\s\S]*?quotasHtml = phHtml \+ loadErrorHtml;/);
if (quotasBlockMatch) {
  const quotasCode = quotasBlockMatch[0];
  // 排除注释后，不应出现中文字符串字面量
  const codeWithoutComments = quotasCode.replace(/\/\/.*/g, '');
  const chineseInCode = codeWithoutComments.match(/['"][^'"]*[\u4e00-\u9fa5]+[^'"]*['"]/g);
  if (chineseInCode) {
    problems.push(`src/extension.ts 配额渲染区包含裸露的硬编码中文字符串: ${chineseInCode.join(', ')}（必须使用 tl()）`);
  }
}

// ── 结果 ──
console.log(`[check-i18n] 字典 ${Object.keys(dict).length} 条 | 宿主 ${hostKeys.size} + 侧栏 ${uiKeys.size} + 统计面板 ${lpKeys.size} 个使用点 | nls ${usedNls.length} 个占位符 | 文档 v${currentVersion} 对齐校验通过`);
if (problems.length) {
  console.error('[check-i18n] FAIL — 以下问题必须修复（改动文案请同步补齐中英双语）:');
  for (const p of problems) console.error('  - ' + p);
  process.exit(1);
}
console.log('[check-i18n] OK');
