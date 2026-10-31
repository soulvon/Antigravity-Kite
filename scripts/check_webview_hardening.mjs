// ── AK Webview 加固门控: 防御 CodeBuddy/Antigravity 类宿主的兜底 CSP 拦截 ──
// 背景: 宿主壳页模板自带严格 CSP (script-src 'sha256-固定hash' 'self'),
//       未自声明 CSP 的扩展 webview inline 脚本全灭 (BuddyRelay v1.0.0 事故).
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
let passed = 0, failed = 0;
function gate(name, ok) {
  console.log((ok ? '  PASS  ' : '  FAIL  ') + name);
  ok ? passed++ : failed++;
}

const ext = fs.readFileSync(path.join(ROOT, 'src', 'extension.ts'), 'utf8');
const lp = fs.readFileSync(path.join(ROOT, 'src', 'logPanelProvider.ts'), 'utf8');
const css = fs.readFileSync(path.join(ROOT, 'resources', 'webview', 'main.css'), 'utf8');

gate('H1 侧栏 CSP: _getHtmlForWebview 自声明 Content-Security-Policy', /Content-Security-Policy[^`]*script-src \$\{webview\.cspSource\}/.test(ext));
gate('H1 侧栏 CSP: cspSource 注入资源白名单', ext.includes('${webview.cspSource}'));
gate('H1 统计面板 CSP: buildHtml 自声明 CSP + cspSource 参数', /Content-Security-Policy[^`]*script-src \$\{cspSource\}/.test(lp) && lp.includes('cspSource: string'));
gate('H2 flex 塌陷: modal-body 使用 flex-basis auto (纵向容器禁 0)', /\.modal-body\s*\{[^}]*flex:\s*1\s+1\s+auto/.test(css));
gate('H2 flex 塌陷: 无纵向容器 flex-basis 0 残留 (排除横向等宽按钮组)', !/\.modal-body\s*\{[^}]*flex:\s*1\s+1\s+0/.test(css));
gate('H3 打包卫生: .vscodeignore 排除 tmp/', fs.readFileSync(path.join(ROOT, '.vscodeignore'), 'utf8').includes('tmp/**'));

console.log(`\n加固门控结果: ${passed} 通过, ${failed} 失败`);
process.exit(failed > 0 ? 1 : 0);
