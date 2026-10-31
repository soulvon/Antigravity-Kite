// 展示待删函数的完整范围（含前导注释）
const fs = require('fs');
const path = require('path');
const SRC = 'e:/project/Antigravity Kite/src';

const targets = [
  ['accountStore.ts', 'countActive'],
  ['winCredential.ts', 'deleteIdeCredentialByTarget'],
  ['geminiFiles.ts', 'readActiveAccount'],
  ['usageService.ts', 'fetchUsageBatch'],
  ['declarationSuppressor.ts', 'stopDeclarationSuppressor'],
  ['importService.ts', 'getAvailableImportSources'],
];

for (const [file, name] of targets) {
  const p = path.join(SRC, file);
  const lines = fs.readFileSync(p, 'utf8').split('\n');
  // 找 export function/const 定义行
  let defIdx = -1;
  for (let i = 0; i < lines.length; i++) {
    if (new RegExp('export\\s+(async\\s+)?function\\s+' + name + '\\b').test(lines[i]) ||
        new RegExp('export\\s+const\\s+' + name + '\\b').test(lines[i])) {
      defIdx = i; break;
    }
  }
  if (defIdx < 0) { console.log(`\n### ${file}: ${name} 未找到 export 定义`); continue; }
  // 向上收集连续注释行
  let start = defIdx;
  while (start > 0 && (lines[start - 1].trim().startsWith('*') || lines[start - 1].trim().startsWith('/**') || lines[start - 1].trim().startsWith('//'))) start--;
  // 向下找配对花括号
  let depth = 0, end = defIdx, seen = false;
  for (let i = defIdx; i < lines.length; i++) {
    for (const ch of lines[i]) {
      if (ch === '{') { depth++; seen = true; }
      else if (ch === '}') depth--;
    }
    if (seen && depth <= 0) { end = i; break; }
  }
  // 含尾随空行
  let tail = end;
  while (tail + 1 < lines.length && lines[tail + 1].trim() === '') tail++;
  console.log(`\n### ${file} :: ${name}  (L${start + 1}-${tail + 1}, ${tail - start + 1} 行)`);
  console.log(lines.slice(start, Math.min(tail + 1, start + 4)).join('\n'));
  console.log('   ...');
  console.log(lines.slice(Math.max(start, tail - 2), tail + 1).join('\n'));
  fs.writeFileSync(`e:/project/Antigravity Kite/tmp/css_diff/del_${file}.txt`, lines.slice(start, tail + 1).join('\n'), 'utf8');
  fs.writeFileSync(`e:/project/Antigravity Kite/tmp/css_diff/range_${file}.txt`, `${start + 1},${tail + 1}`, 'utf8');
}
