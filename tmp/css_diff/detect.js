// 精确检测：在「收集选择器」阶段遇到以分号结尾的行 = 选择器头丢失
const fs = require('fs');

function detect(css, name) {
  const lines = css.split('\n');
  const issues = [];
  let i = 0;
  const stack = []; // 'rule' | 'media'

  while (i < lines.length) {
    // ---- 收集选择器 ----
    let selLines = [];
    let found = false;
    while (i < lines.length) {
      const t = lines[i].trim();
      if (t === '' || t.startsWith('/*') || t.startsWith('*') || t.startsWith('//')) { i++; continue; }
      // 在收集选择器时遇到声明（以 ; 结尾、无 {）= 破损
      if (/;\s*$/.test(t) && !t.includes('{')) {
        issues.push({ line: i + 1, inBlock: stack.length > 0, text: lines.slice(Math.max(0, i - 3), i + 4).map((x, k) => `${Math.max(0, i - 3) + k + 1}: ${x}`) });
        // 吞到下一个 }
        while (i < lines.length) { const l = lines[i]; i++; if (l.includes('}')) break; }
        selLines = [];
        break;
      }
      selLines.push(lines[i]);
      if (lines[i].includes('{')) { found = true; i++; break; }
      i++;
    }
    if (!found) continue;

    const sel = selLines.join(' ').replace(/\s+/g, ' ').trim();
    if (/^@(media|supports)/.test(sel)) {
      stack.push('media');
    } else {
      // ---- 收集声明直到配平的 } ----
      let d = selLines.join('').split('{').length - 1 - (selLines.join('').split('}').length - 1);
      while (i < lines.length && d > 0) {
        d += (lines[i].match(/\{/g) || []).length;
        d -= (lines[i].match(/\}/g) || []).length;
        i++;
      }
      if (stack.length && d < 0) stack.pop();
    }
  }

  console.log(`\n=== ${name} ===`);
  console.log('破损点:', issues.length);
  issues.forEach(x => {
    console.log(`\n--- L${x.line} (在块内: ${x.inBlock}) ---`);
    x.text.forEach(t => console.log('   ' + t));
  });
}

detect(fs.readFileSync('E:/project/BuddyRelay/resources/webview/main.css', 'utf8'), 'Relay');
