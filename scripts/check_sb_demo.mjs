#!/usr/bin/env node
/**
 * 状态栏样式卡片 demo 冒烟检查（防 TDZ/运行时异常回归）。
 * 背景：v1.1.25 曾把 const famRst 插进 switch 两个 case 之间，执行 labeled 分支跳过
 * 声明行触发 TDZ（Cannot access before initialization），真机红条报错、侧栏黑屏。
 * 做法：直接从 resources/webview/sidebar.js 抽取 SB_USER_SVG / sbOpts / sbDemoHTML 源码，
 * mock document 后真跑全部 7 档样式，断言无异常且输出合理。
 * 运行：node scripts/check_sb_demo.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');
const sidebarJsPath = path.join(root, 'resources', 'webview', 'sidebar.js');
if (!fs.existsSync(sidebarJsPath)) {
  console.error('  FAIL  找不到 resources/webview/sidebar.js');
  process.exit(1);
}
const src = fs.readFileSync(sidebarJsPath, 'utf8');

function extractFn(name) {
  // 从 sidebar.js 源码里截取完整函数声明（大括号配对，跳过字符串字面量）
  const idx = src.indexOf(name);
  if (idx < 0) throw new Error(`找不到 ${name}`);
  const braceStart = src.indexOf('{', idx);
  let depth = 0;
  let end = braceStart;
  let quote = null;
  for (let i = braceStart; i < src.length; i++) {
    const ch = src[i];
    if (quote) {
      if (ch === '\\') { i++; continue; }
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === "'" || ch === '"' || ch === '`') { quote = ch; continue; }
    if (ch === '{') depth++;
    else if (ch === '}') {
      depth--;
      if (depth === 0) { end = i; break; }
    }
  }
  return src.slice(idx, end + 1);
}

let failures = 0;
const check = (n, c, d = '') => {
  console.log((c ? '  PASS  ' : '  FAIL  ') + n + (c ? '' : ' <- ' + d));
  if (!c) failures++;
};

let SB_USER_SVG = '';
try {
  SB_USER_SVG = src.match(/const SB_USER_SVG = '([^']+)'/)[1];
} catch {
  check('提取 SB_USER_SVG', false, 'sidebar.js 缺少 const SB_USER_SVG');
}
const sbOptsSrc = extractFn('function sbOpts');
const sbDemoSrc = extractFn('function sbDemoHTML');

// mock：document 读 tag 全为开（is-on），vscode.acquireVsCodeApi 不被触达
const sandbox = `
  const document = { getElementById: () => ({ classList: { contains: () => true }, getAttribute: () => 'smart' }) };
  const SB_USER_SVG = ${JSON.stringify(SB_USER_SVG)};
  ${sbOptsSrc}
  ${sbDemoSrc}
`;
const styles = ['smart', 'dot', 'percent', 'compact', 'dual', 'labeled', 'full'];
let run;
try {
  run = new Function('styles', sandbox + `
    return styles.map(st => { try { return { st, out: sbDemoHTML(st), err: null }; } catch (e) { return { st, out: '', err: e.constructor.name + ': ' + e.message }; } });`)(styles);
} catch (e) {
  console.error(`  FAIL  sbDemoHTML 编译失败: ${e.message}`);
  process.exit(1);
}

for (const r of run) {
  check(`demo[${r.st}] 无运行时异常`, r.err === null, r.err || '');
  check(`demo[${r.st}] 输出非空 HTML`, typeof r.out === 'string' && r.out.length > 0 && !/undefined|NaN/.test(r.out), r.out.slice(0, 80));
}
const labeled = run.find(r => r.st === 'labeled');
check('demo[labeled] 含族分格与倒计时（TDZ 案发分支）', /Claude 96%\/100%/.test(labeled.out) && /🕐/.test(labeled.out), labeled.out.slice(0, 120));

console.log(failures === 0 ? '[check_sb_demo] 全部通过 ✔' : `[check_sb_demo] ${failures} 项失败 ✘`);
process.exit(failures === 0 ? 0 : 1);
