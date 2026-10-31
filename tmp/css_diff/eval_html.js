// 求值 _getHtmlForWebview 的模板字符串，抽出 webview JS 做语法检查
const fs = require('fs');
const vm = require('vm');
const path = require('path');

const src = fs.readFileSync('e:/project/Antigravity Kite/out/extension.js', 'utf8');

// 1. 定位 _getHtmlForWebview 方法体内的模板：找 `<!DOCTYPE html>` 起点
const startIdx = src.indexOf('<!DOCTYPE html>');
if (startIdx < 0) { console.log('未找到 HTML 模板起点'); process.exit(1); }

// 向前找模板起始反引号
let tplStart = src.lastIndexOf('`', startIdx);
// 向后找配对反引号（模板里不会有未转义的反引号，TS 编译保证）
let i = tplStart + 1, depth = 0;
// 简单扫描：跳过 ${} 内的内容（其中可能有字符串），找结尾 `
let inExpr = false, quote = null;
for (let j = tplStart + 1; j < src.length; j++) {
  const c = src[j], p = src[j - 1];
  if (inExpr) {
    if (quote) { if (c === quote && p !== '\\') quote = null; continue; }
    if (c === '"' || c === "'" || c === '`') { quote = c; continue; }
    if (c === '{') depth++;
    if (c === '}') { depth--; if (depth === 0) inExpr = false; }
    continue;
  }
  if (c === '$' && src[j + 1] === '{') { inExpr = true; depth = 0; j++; continue; }
  if (c === '\\' ) { j++; continue; }
  if (c === '`') { i = j; break; }
}
const tplEnd = i;
const tpl = src.slice(tplStart + 1, tplEnd);

// 2. 沙盒求值：mock 插值依赖
const sandbox = {
  cssUri: 'https://mock.invalid/main.css',
  Date: { now: () => 1700000000000 },
  JSON,
  getLang: () => 'zh',
  localeBundle: (p) => { window.__bundlePrefix = p; return window.__bundle; },
  // TS 编译后 import 变成 i18n_1.xxx
  i18n_1: {
    getLang: () => 'zh',
    localeBundle: (p) => ({}),
  },
};
sandbox.window = sandbox;
sandbox.__bundle = {};
// localeBundle 在编译产物里的调用形式可能是 t/L 相关，宽松兜底
const ctx = vm.createContext(sandbox);
let html;
try {
  html = vm.runInContext('(`' + tpl + '`)', ctx, { timeout: 5000 });
} catch (e) {
  console.log('模板求值失败:', e.message);
  // 打印出错附近的插值表达式辅助定位
  process.exit(1);
}
console.log('HTML 求值成功，长度:', html.length);

// 3. 提取 <script> ... </script>
const m = html.match(/<script>([\s\S]*)<\/script>/);
if (!m) { console.log('未找到 script'); process.exit(1); }
const js = m[1];
fs.writeFileSync('e:/project/Antigravity Kite/tmp/css_diff/webview_script.js', js, 'utf8');
console.log('webview JS 行数:', js.split('\n').length);

// 4. 语法检查
try {
  new vm.Script(js, { filename: 'webview-inline.js' });
  console.log('✔ JS 语法检查通过');
} catch (e) {
  console.log('✘ JS 语法错误:', e.message);
  // 提取错误行上下文
  const lineMatch = /webview-inline\.js:(\d+)/.exec(e.stack);
  if (lineMatch) {
    const ln = parseInt(lineMatch[1]);
    const lines = js.split('\n');
    for (let k = Math.max(0, ln - 4); k < Math.min(lines.length, ln + 3); k++) {
      console.log((k + 1 === ln ? '>> ' : '   ') + (k + 1) + ': ' + lines[k]);
    }
  }
}
