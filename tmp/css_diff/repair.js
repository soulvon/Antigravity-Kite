// 通用修复：移除 CSS 中「丢失选择器头的破损段」——块外孤立声明及其悬空 }
const fs = require('fs');

function repair(css, verbose) {
  const lines = css.split('\n');
  const out = [];
  let depth = 0, i = 0;
  const removed = [];

  while (i < lines.length) {
    const trimmed = lines[i].trim();

    // 破损判定：深度 0、以分号结尾的声明（选择器行不会以分号结尾）、不含 {
    const isDeclLike = /^[-a-zA-Z]+\s*:/.test(trimmed) && /;\s*$/.test(trimmed) && !trimmed.includes('{');
    const isNoise = trimmed === '' || trimmed.startsWith('/*') || trimmed.startsWith('*') ||
      trimmed.startsWith('//') || trimmed.startsWith('@');

    if (depth === 0 && isDeclLike && !isNoise) {
      const start = i;
      // 一直删到遇到第一个 }（那个 } 是原本闭合丢失规则块的）
      let sawBrace = false;
      while (i < lines.length) {
        const l = lines[i];
        i++;
        if (l.includes('}')) { sawBrace = true; break; }
      }
      removed.push({ s: start + 1, e: i, sawBrace, text: lines.slice(start, i).join(' | ').trim().slice(0, 140) });
      continue;
    }

    out.push(lines[i]);
    depth += (lines[i].match(/\{/g) || []).length - (lines[i].match(/\}/g) || []).length;
    i++;
  }

  if (verbose) {
    console.log('移除破损段:', removed.length, '处');
    removed.forEach(r => console.log(`  L${r.s}-${r.e} 闭合=${r.sawBrace} :: ${r.text}`));
  }
  return out.join('\n');
}

function check(s, name) {
  let d = 0, i = 0, ln = 1; const errs = [];
  while (i < s.length) {
    const c = s[i];
    if (c === '\n') { ln++; i++; continue; }
    if (c === '/' && s[i + 1] === '*') { const e = s.indexOf('*/', i + 2); if (e < 0) break; ln += (s.slice(i, e).match(/\n/g) || []).length; i = e + 2; continue; }
    if (c === '"' || c === "'") { const q = c; let j = i + 1; while (j < s.length && s[j] !== q) { if (s[j] === '\\') j++; j++; } ln += (s.slice(i, j).match(/\n/g) || []).length; i = j + 1; continue; }
    if (c === '{') d++;
    else if (c === '}') { d--; if (d < 0) errs.push('L' + ln); }
    i++;
  }
  console.log(`${name}: 末态深度=${d}${d === 0 && !errs.length ? ' ✔ 平衡' : ' ✘ 残留 ' + JSON.stringify(errs.slice(0, 6))}`);
  return d;
}

module.exports = { repair, check };

if (require.main === module) {
  const css = fs.readFileSync('E:/project/BuddyRelay/resources/webview/main.css', 'utf8');
  const fixed = repair(css, true);
  check(css, 'Relay 原始');
  check(fixed, '修复后');
  console.log('行数:', css.split('\n').length, '->', fixed.split('\n').length);
  fs.writeFileSync('e:/project/Antigravity Kite/tmp/css_diff/relay_repaired.css', fixed, 'utf8');
}
