#!/usr/bin/env node
/**
 * 切号链路健康门控（2026-11-16 事故：IDE 升级后弹窗没人点 + 切号慢）
 *
 * 真机事实：
 * - IDE 1.107.0 起弹窗表面含 vscode-webview://，旧 scheme 白名单直接漏掉，accepted 归零
 * - 当前实例不带 --remote-debugging-port 时守护整体失效，且 heartbeat 零日志（纯静默）
 * - 切号双刷 token（外层 + seamlessSwitch 内层各一次），hot.session 中位 3.7s 有一半是重复网络
 * - Swap 凭据每次重新 Add-Type 编译 C#，hot.cred 中位 4.5s
 *
 * 本门控把「黑名单覆盖 + 无端口可见 + 不可重复刷新 + DLL 预编译」固化成硬断言。
 */
import { readFileSync } from 'fs';
import { execSync } from 'child_process';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => readFileSync(join(root, p), 'utf8');
const pkg = JSON.parse(read('package.json'));

let pass = 0, fail = 0;
function check(name, cond, extra) {
  if (cond) { pass++; console.log(`  PASS  ${name}${extra ? ' | ' + extra : ''}`); }
  else { fail++; console.log(`  FAIL  ${name}${extra ? ' | ' + extra : ''}`); }
}

console.log('=== 切号链路健康门控 ===\n');

const decl = read('src/declarationSuppressor.ts');
const ext = read('src/extension.ts');
const ss = read('src/seamlessSwitcher.ts');
const cred = read('src/winCredential.ts');

// H1 守护目标必须黑名单排除法，不得回到 scheme 白名单
check('H1a 使用黑名单排除（devtools/chrome/about/data/blob）', /devtools\|chrome-extension\|chrome\|about\|data\|blob/.test(decl));
check('H1b 不再使用 scheme 白名单变量', !/isIdeSurface/.test(decl) && !/isWorkbench\s*=\s*url\.startsWith/.test(decl));
check('H1c 自家扩展 webview 仍被排除', decl.includes('extensionId=soulvon.antigravity-kite'));

// H2 渲染表面 type 覆盖
check('H2 type 过滤含 webview', /type !== 'webview'/.test(decl));

// H3 无端口不得静默：必须留痕
check('H3a 无端口落 declGuard.noPort', decl.includes('declGuard.noPort'));
check('H3b 无端口日志有去重标记', /noPortLogged/.test(decl));

// H4 target 连接失败必须留痕
check('H4 连接失败落 declGuard.attachFail', decl.includes('declGuard.attachFail'));

// H5 表面清单可查（弹窗挂在哪类 target）
check('H5 周期落 declGuard.surfaces', decl.includes('declGuard.surfaces'));

// H6 切号后主动补扫，不等心跳自然轮询
check('H6a 导出 pokeGuard', /export function pokeGuard/.test(decl));
check('H6b 切号链路调用 pokeGuard', /switch\.hot\.identity[\s\S]{0,400}pokeGuard\(\)/.test(ext));

// H7 禁止双刷 token：seamlessSwitch 必须接受外部 token，且调用方传参
check('H7a seamlessSwitch 接受 preparedExternal', /seamlessSwitch\(account: StoredAccount, preparedExternal\?: PreparedSwitchToken\)/.test(ss));
check('H7b 外部 token 优先于内部刷新', /preparedExternal\s*\?[\s\S]{0,80}token: preparedExternal/.test(ss));
check('H7c 切号链路传入 prepared.token', /seamlessSwitch\(account, prepared\.token\)/.test(ext));

// H8 凭据 P/Invoke 预编译 DLL（首次编译、后续加载）
check('H8a 脚本引用 KiteWinCred DLL', cred.includes('KiteWinCred_v1.dll'));
check('H8b 含 csc 预编译路径', cred.includes('csc.exe') && cred.includes('/target:library'));
check('H8c DLL 加载失败可回退即时编译', /Add-Type -Path \$Dll[\s\S]{0,120}Add-Type -TypeDefinition/.test(cred));
check('H8d 统一渲染注入 DLLDIR，无漏占位', cred.includes('renderPs(') && cred.includes("replace('<DLLDIR>'"));

// H9 门控自身挂进 compile 链
check('H9a compile 链含 check_switch_health', (pkg.scripts.compile || '').includes('check_switch_health'));
check('H9b package 链经 compile 覆盖门控', (pkg.scripts.package || '').includes('npm run compile'));

// L1 反向验证：固定取 v1.3.1（旧 scheme 白名单实现）验证断言确实能抓住旧缺陷。
// 不能用 HEAD：提交后 HEAD 就是新代码，反向验证会自己失效（踩过）。
let legacy = '';
try { legacy = execSync('git show v1.3.1:src/declarationSuppressor.ts', { cwd: root, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] }); } catch { /* tag 不存在（浅检出） */ }
if (legacy) {
  const legacyHasBlacklist = /devtools\|chrome-extension\|chrome\|about\|data\|blob/.test(legacy);
  const legacyHasWebview = /type !== 'webview'/.test(legacy);
  check('L1 旧代码确实不满足新断言（反向验证）', !legacyHasBlacklist && !legacyHasWebview);
} else {
  console.log('  SKIP  L1 旧代码反向验证（无 git 历史）');
}

console.log(`\n切号健康门控结果: ${pass} 通过, ${fail} 失败`);
process.exit(fail > 0 ? 1 : 0);
