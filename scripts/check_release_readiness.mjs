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

// ── R0 敏感资产与防泄漏强制门控 (Git Leakage Barrier) ──
// 铁律：内部指南 docs/、账号信息、本地临时文件与真实凭证严禁进入 GitHub 仓库
try {
  const tracked = execSync('git ls-files', { cwd: ROOT, encoding: 'utf8' }).split('\n').filter(Boolean);
  let staged = [];
  try {
    staged = execSync('git diff --cached --name-only', { cwd: ROOT, encoding: 'utf8' }).split('\n').filter(Boolean);
  } catch (_) {}
  const allAuditedFiles = Array.from(new Set([...tracked, ...staged]));

  const forbiddenPatterns = [
    /^docs\//i,                          // 内部指南/复盘/草稿等纯本地私有文档
    /^tmp\//i,                           // 本地临时产物
    /^(AGENTS|CLAUDE)\.md$/i,            // 本地私有指令与心智模型规范
    /\.env(\..+)?$/i,                    // 环境变量文件
    /(\.pem|\.key|\.pfx|\.p12)$/i,       // 证书与私钥文件
    /(token|secret|credential|password)[^/]*\.(json|md|txt|ya?ml)$/i // 敏感凭据配置文件
  ];
  const leakedPaths = allAuditedFiles.filter(f => forbiddenPatterns.some(p => p.test(f)));
  gate('R0.1 敏感路径防线: 内部指南 docs/ 与私密文件严禁进入 Git 跟踪' + (leakedPaths.length ? ` — 违规文件: ${leakedPaths.join(', ')}` : ''), leakedPaths.length === 0);

  // 内容特征扫描: 严禁在已跟踪代码或文档中硬编码真实高熵 Token / 私钥
  const secretPatterns = [
    { name: 'Open VSX 访问令牌 (ovsx_...)', regex: /ovsx_[A-Za-z0-9_-]{20,}/ },
    { name: 'GitHub 经典令牌 (ghp_...)', regex: /ghp_[A-Za-z0-9]{36}/ },
    { name: 'GitHub 精细令牌 (github_pat_...)', regex: /github_pat_[A-Za-z0-9_]{50,}/ },
    { name: 'RSA/EC 私钥明文', regex: /-----BEGIN [A-Z ]*PRIVATE KEY-----/ }
  ];
  const textFiles = tracked.filter(f => !/\.(png|webp|svg|ico|vsix|wasm)$/i.test(f));
  const leakedSecrets = [];
  for (const f of textFiles) {
    const fullPath = path.join(ROOT, f);
    if (!fs.existsSync(fullPath)) continue;
    try {
      const content = fs.readFileSync(fullPath, 'utf8');
      for (const sp of secretPatterns) {
        if (sp.regex.test(content)) {
          leakedSecrets.push(`${f} (命中: ${sp.name})`);
        }
      }
    } catch (_) {}
  }
  gate('R0.2 凭证特征防线: 源码与文档严禁硬编码真实 Token/私钥' + (leakedSecrets.length ? ` — 违规命中: ${leakedSecrets.join(', ')}` : ''), leakedSecrets.length === 0);
} catch (e) {
  gate('R0 敏感资产检查异常中断', false);
}

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
  gate('R3.6 包体瘦身: vsix 严格排除 node_modules (由 node:sqlite 原生承载, 零打包依赖)', !names.some(n => /(^|\/)node_modules\//.test(n)));
  gate('R3.7 包体瘦身: vsix 严格排除非运行时预览大图 resources/preview-*', !names.some(n => /resources\/preview-/.test(n)));
  gate('R3.8 包体瘦身: vsix 严格排除 .github/ 与 AGENTS.md', !names.some(n => /(^|\/)(\.github|AGENTS\.md)/.test(n)));
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
  // 坑: execSync 经 cmd.exe 时 gh 内置 jq 不认单引号字符串(join(',')), 必须改为 Node 端解析
  const rel = JSON.parse(execSync(`gh release view v${V} -R soulvon/Antigravity-Kite --json assets`, { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] }).trim());
  const assets = rel.assets.map(a => a.name).join(',');
  gate('R6.1 GitHub Release v' + V + ' 存在且挂 vsix (自动更新链)', assets.includes(`antigravity-kite-${V}.vsix`));
} catch { gate('R6.1 GitHub Release v' + V + ' 存在且挂 vsix', false, true); }
try {
  const store = JSON.parse(execSync('curl -s --max-time 15 "https://open-vsx.org/api/soulvon/antigravity-kite"', { encoding: 'utf8' }));
  gate('R6.2 Open VSX latest == ' + V, store.version === V);
} catch { gate('R6.2 Open VSX latest 校验', false, true); }

console.log(`\n═══ 结果: ${passed} 通过 / ${failed} 失败 / ${skipped} 跳过 ═══`);
process.exit(failed > 0 ? 1 : 0);
