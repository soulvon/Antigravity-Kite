const fs = require('fs');

function check(css, name) {
  let i = 0, depth = 0, line = 1;
  const errs = [];
  while (i < css.length) {
    const c = css[i];
    if (c === '\n') { line++; i++; continue; }
    if (c === '/' && css[i + 1] === '*') {
      const end = css.indexOf('*/', i + 2);
      if (end < 0) { errs.push('L' + line + ': 未闭合注释'); break; }
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
    if (c === '}') { depth--; if (depth < 0) errs.push('L' + line + ': 多余的 }'); i++; continue; }
    i++;
  }
  console.log(name + ': 末态深度=' + depth + (depth === 0 && !errs.length ? ' ✔ 平衡' : ' ✘'));
  errs.slice(0, 8).forEach(e => console.log('   ' + e));
}

const f = 'e:/project/Antigravity Kite/tmp/css_diff/final.css';
const css = fs.readFileSync(f, 'utf8');
check(css, 'final.css');
console.log('行数:', css.split('\n').length, '| 字节:', Buffer.byteLength(css));
console.log('!important:', (css.match(/!important/g) || []).length);
console.log('规则块粗估（{ 计数）:', (css.match(/\{/g) || []).length);

// 残留检查：不该再出现旧 tab 类
for (const bad of ['.kite-tab', 'kite-brand-mark-inline']) {
  const n = (css.split(bad).length - 1);
  console.log(`残留 ${bad}:`, n);
}
// ID 映射确认
for (const id of ['#tabAccounts', '#tabInstances', '#tabEnhance', '#tab-account', '#tab-instance', '#tab-enhance']) {
  console.log(`${id}:`, css.split(id).length - 1, '次');
}
