#!/usr/bin/env node
/**
 * 状态栏样式卡片 demo 冒烟检查（防 TDZ/运行时异常回归）。
 * 背景：v1.1.25 曾把 const famRst 插进 switch 两个 case 之间，执行 labeled 分支跳过
 * 声明行触发 TDZ（Cannot access before initialization），真机红条报错、侧栏黑屏。
 * 做法：从 .preview/kite-sidebar.html 抽取 sbDemoHTML/sbOpts/SB_USER_SVG 源码，
 * mock document/vscode 后真跑 7 档，断言无异常且输出合理。
 * 运行：先 node .preview/build-previews.js，再 node scripts/check_sb_demo.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');
const htmlPath = path.join(root, '.preview', 'kite-sidebar.html');
if (!fs.existsSync(htmlPath)) {
  console.error('  FAIL  找不到 .preview/kite-sidebar.html —— 先跑 node .preview/build-previews.js');
  process.exit(1);
}
const html = fs.readFileSync(htmlPath, 'utf8');

function extract(name) {
  // 从 HTML 的内联脚本里截取函数/常量声明（ brace-counting 抽完整块）
  const idx = html.indexOf(name);
  if (idx < 0) throw new Error(`找不到 ${name}`);
  const braceStart = html.indexOf('{', idx);
  let depth = 0, end = braceStart;
  for (let i = braceStart; i < html.length; i++) {
    if (html[i] === '{') depth++;
    else if (html[i] === '}') { depth--; if (depth === 0) { end = i; break; } }
  }
  return html.slice(idx, end + 1);
}

let failures = 0;
const check = (n, c, d = '') => { console.log((c ? '  PASS  ' : '  FAIL  ') + n + (c ? '' : ' <- ' + d)); if (!c) fails++; };

let SB_USER_SVG = '';
let fails = 0;
try {
  SB_USER_SVG = html.match(/const SB_USER_SVG = '([^']+)'/)[1];
} catch { /* 可能内联在别处 */ }
const sbDemoSrc = extract('function sbDemoHTML');
const sbOptsSrc = extract('function sbOpts');

// mock：document 读 tag 全为开（is-on），vscode.acquireVsCodeApi 不被触达
const sandbox = `
  const document = { getElementById: (id) => ({ classList: { contains: () => true }, getAttribute: () => 'smart' }) };
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

console.log(fails === 0 ? '[check_sb_demo] 全部通过 ✔' : `[check_sb_demo] ${fails} 项失败 ✘`);
process.exit(fails === 0 ? 0 : 1);
