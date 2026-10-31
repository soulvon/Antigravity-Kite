// ── AK 发版就绪门控 (check:release) ──
// 今日事故固化: 版本漂移/README快照过期/文档被gitignore屏蔽/打包垃圾混入/CSP缺失/渠道断链
// 发版流程: npm run compile -> vsce package -> **npm run check:release** -> git tag -> GitHub Release -> ovsx publish
import fs from 'fs';
import path from 'path';
import { execSync } from 'child_process';
import { fileURLToPath } from 'url';
import AdmZip from 'adm-zip';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
let passed = 0, failed = 0, skipped = 0;
function gate(name, ok, skip = false) {
  console.log((skip ? '  SKIP  ' : ok ? '  PASS  ' : '  FAIL  ') + name);
  if (skip) skipped++; else ok ? passed++ : failed++;
}
const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
const V = pkg.version;
const zh = fs.readFileSync(path.join(ROOT, 'README.md'), 'utf8');
const en = fs.readFileSync(path.join(ROOT, 'README_en.md'), 'utf8');

console.log(`\n═══ 发版就绪门控 — antigravity-kite v${V} ═══\n`);

// ── R1 版本一致性 ──
gate('R1.1 package.json == README.md 徽章', zh.includes(`version-${V}-blue`));
gate('R1.2 package.json == README_en.md 徽章', en.includes(`version-${V}-blue`));
gate('R1.3 安装命令 vsix 文件名 == 版本 (zh/en)', zh.includes(`antigravity-kite-${V}.vsix`) && en.includes(`antigravity-kite-${V}.vsix`));
let tag = '';
try { tag = execSync('git describe --tags --abbrev=0', { cwd: ROOT, encoding: 'utf8' }).trim(); } catch { /* 无 tag */ }
gate('R1.4 最新 git tag == package.json 版本', tag === `v${V}`, tag === '');

// ── R2 README 完整性 ──
const enTracked = execSync('git ls-files README_en.md', { cwd: ROOT, encoding: 'utf8' }).trim() !== '';
gate('R2.1 README_en.md 存在且被 git 跟踪 (曾被 *.md 忽略屏蔽)', fs.existsSync(path.join(ROOT, 'README_en.md')) && enTracked);
gate('R2.2 .gitignore 白名单含 !README_en.md', fs.readFileSync(path.join(ROOT, '.gitignore'), 'utf8').includes('!README_en.md'));
gate('R2.3 中文版含语言互跳入口', zh.includes('README_en.md'));
gate('R2.4 英文版含语言互跳入口', en.includes('README.md'));

// ── R3 打包卫生 (对当前版本 vsix) ──
const vsixPath = path.join(ROOT, `antigravity-kite-${V}.vsix`);
if (fs.existsSync(vsixPath)) {
  const zip = new AdmZip(vsixPath);
  const names = zip.getEntries().map(e => e.entryName);
  const extNames = names.filter(n => n.startsWith('extension/'));
  gate('R3.1 vsix 无 tmp/ 混入', !names.some(n => /(^|\/)tmp\//.test(n)));
  gate('R3.2 vsix 无 docs/ 草稿混入', !names.some(n => /\/docs\//.test(n)));
  const readmeName = extNames.find(n => /readme\.md$/i.test(n) && !/readme_en\.md$/i.test(n));
  const readmeInVsix = readmeName ? zip.readAsText(readmeName) : '';
  gate('R3.3 vsix 内 README 徽章 == package.json 版本 (快照过期治理)', readmeInVsix.includes(`version-${V}-blue`));
  gate('R3.4 vsix 内 README 无旧版本徽章残留', !/version-0\.\d+\.\d+-blue/.test(readmeInVsix));
  gate('R3.5 out/extension.js 含 CSP 声明', fs.readFileSync(path.join(ROOT, 'out', 'extension.js'), 'utf8').includes('Content-Security-Policy'));
} else {
  gate(`R3.* vsix antigravity-kite-${V}.vsix 不存在 (先 vsce package)`, false);
}

// ── R4 webview 加固 ──
const ext = fs.readFileSync(path.join(ROOT, 'src', 'extension.ts'), 'utf8');
const lp = fs.readFileSync(path.join(ROOT, 'src', 'logPanelProvider.ts'), 'utf8');
gate('R4.1 侧栏 HTML 自声明 CSP (cspSource)', /Content-Security-Policy[^`]*script-src \$\{webview\.cspSource\}/.test(ext));
gate('R4.2 统计面板 HTML 自声明 CSP (cspSource)', /Content-Security-Policy[^`]*script-src \$\{cspSource\}/.test(lp));
gate('R4.3 modal-body flex-basis auto (纵向塌陷防御)', /flex:\s*1\s+1\s+auto/.test(fs.readFileSync(path.join(ROOT, 'resources', 'webview', 'main.css'), 'utf8')));

// ── R5 i18n 纪律 ──
const i18n = fs.readFileSync(path.join(ROOT, 'src', 'i18n.ts'), 'utf8');
let bad = 0;
for (const m of i18n.matchAll(/'([^']{2,60})':\s*'([^']*)'/g)) {
  if (/^[（(][^（）()]{1,8}[）)]$/.test(m[2].trim())) bad++;
}
gate('R5.1 字典无全角括号短文案劣化', bad === 0);
const nlsZh = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.nls.zh-cn.json'), 'utf8'));
const nlsEn = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.nls.json'), 'utf8'));
gate('R5.2 nls zh/en key 集一致', JSON.stringify(Object.keys(nlsZh).sort()) === JSON.stringify(Object.keys(nlsEn).sort()));

// ── R6 发布渠道 (依赖 gh/网络, 失败 SKIP 不阻断本地) ──
try {
  const assets = execSync(`gh release view v${V} -R soulvon/Antigravity-Kite --json assets --jq "[.assets[].name] | join(',')"`, { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] }).trim();
  gate('R6.1 GitHub Release v' + V + ' 存在且挂 vsix (自动更新链)', assets.includes(`antigravity-kite-${V}.vsix`));
} catch { gate('R6.1 GitHub Release v' + V + ' 存在且挂 vsix', false, true); }
try {
  const store = JSON.parse(execSync('curl -s --max-time 15 "https://open-vsx.org/api/soulvon/antigravity-kite"', { encoding: 'utf8' }));
  gate('R6.2 Open VSX latest == ' + V, store.version === V);
} catch { gate('R6.2 Open VSX latest 校验', false, true); }

console.log(`\n═══ 结果: ${passed} 通过 / ${failed} 失败 / ${skipped} 跳过 ═══`);
process.exit(failed > 0 ? 1 : 0);
