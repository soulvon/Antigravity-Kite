// 验证疑似死导出在当前代码库的真实引用数（排除定义处本身）
const fs = require('fs');
const path = require('path');
const SRC = 'e:/project/Antigravity Kite/src';

const files = [];
(function walk(dir) {
  for (const f of fs.readdirSync(dir)) {
    const p = path.join(dir, f);
    const st = fs.statSync(p);
    if (st.isDirectory()) walk(p);
    else if (f.endsWith('.ts')) files.push(p);
  }
})(SRC);

const contents = new Map(files.map(f => [f, fs.readFileSync(f, 'utf8')]));

// [导出名, 定义所在文件关键词]
const suspects = [
  ['countActive', 'accountStore'],
  ['deleteIdeCredentialByTarget', 'winCredential'],
  ['readActiveAccount', 'geminiFiles'],
  ['fetchUsageBatch', 'usageService'],
  ['stopDeclarationSuppressor', 'declarationSuppressor'],
  ['setStyle', 'statusBar'],
  ['hide', 'statusBar'],
  ['StatusBarStyle', 'statusBar'],
  ['getAppDataDir', 'storage'],
  ['getAvailableImportSources', 'importService'],
];

console.log('=== 疑似死导出引用核查 ===');
for (const [name, fileKey] of suspects) {
  let refs = [];
  for (const [f, src] of contents) {
    const base = path.basename(f);
    const isDefFile = base.includes(fileKey);
    // 统计出现次数（含定义处）
    const count = (src.match(new RegExp('\\b' + name + '\\b', 'g')) || []).length;
    if (count > 0) {
      refs.push(`${base}: ${count} 次${isDefFile ? '（定义文件）' : ''}`);
    }
  }
  // 定义文件外的引用 = 活引用（导入/调用）
  const external = refs.filter(r => !r.includes('（定义文件）'));
  console.log(`\n.${fileKey} 的 ${name}:`);
  console.log(refs.length ? '  ' + refs.join('\n  ') : '  （全库无出现）');
  if (!external.length) console.log('  >>> 除定义文件外无引用 → 可删');
}
