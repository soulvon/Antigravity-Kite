// 按已保存的精确函数文本批量删除死导出
const fs = require('fs');
const path = require('path');
const SRC = 'e:/project/Antigravity Kite/src';
const TMP = 'e:/project/Antigravity Kite/tmp/css_diff';

const targets = [
  'accountStore.ts', 'winCredential.ts', 'geminiFiles.ts',
  'usageService.ts', 'declarationSuppressor.ts', 'importService.ts',
];

for (const file of targets) {
  const p = path.join(SRC, file);
  const delFile = path.join(TMP, `del_${file}.txt`);
  if (!fs.existsSync(delFile)) { console.log(`跳过 ${file}（无删除文本）`); continue; }
  const delText = fs.readFileSync(delFile, 'utf8');
  let src = fs.readFileSync(p, 'utf8');
  if (!src.includes(delText)) { console.log(`⚠ ${file}: 精确文本未命中，跳过`); continue; }
  // 删除函数体 + 其后紧跟的空行（最多吞 1 行，保持段间一个空行）
  let removed = delText + '\n';
  src = src.replace(removed, '');
  // 若出现连续两个空行，收敛为一个
  src = src.replace(/\n\n\n+/g, '\n\n');
  fs.writeFileSync(p, src, 'utf8');
  console.log(`✔ ${file}: 已删 ${delText.split('\n').length} 行`);
}
