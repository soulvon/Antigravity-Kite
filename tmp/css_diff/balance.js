// 严谨的 CSS 括号平衡检查：跳过注释与字符串
const fs = require('fs');

function check(css, name) {
  let i = 0, depth = 0, line = 1;
  const errs = [];
  while (i < css.length) {
    const c = css[i];
    if (c === '\n') { line++; i++; continue; }
    if (c === '/' && css[i + 1] === '*') {
      const end = css.indexOf('*/', i + 2);
      if (end < 0) { errs.push(`L${line}: 未闭合注释`); break; }
      line += (css.slice(i, end).match(/\n/g) || []).length;
      i = end + 2; continue;
    }
    if (c === '"' || c === "'") {
      const q = c; let j = i + 1;
      while (j < css.length && css[j] !== q) { if (css[j] === '\\') j++; j++; }
      line += (css.slice(i, j).match(/\n/g) || []).length;
      i = j + 1; continue;
    }
    if (c === '{') { depth++; i++; continue; }
    if (c === '}') { depth--; if (depth < 0) errs.push(`L${line}: 多余的 }`); i++; continue; }
    i++;
  }
  console.log(`${name}: 末态深度=${depth}${depth === 0 && !errs.length ? ' ✔ 平衡' : ' ✘'}`);
  errs.slice(0, 10).forEach(e => console.log('   ' + e));
  return depth;
}

const DIR = 'e:/project/Antigravity Kite/tmp/css_diff';
check(fs.readFileSync('E:/project/BuddyRelay/resources/webview/main.css', 'utf8'), 'Relay 原始');
check(fs.readFileSync(`${DIR}/part1_base.css`, 'utf8'), '底座(重映射后)');
check(fs.readFileSync(`${DIR}/part2_adapt_raw.css`, 'utf8'), '适配层');
check(fs.readFileSync('e:/project/Antigravity Kite/resources/webview/main.css', 'utf8'), 'Kite 原始');
