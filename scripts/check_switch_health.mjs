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
import { readFileSync, existsSync, statSync } from 'fs';
import { execSync } from 'child_process';
import { createRequire } from 'module';
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

// H8 凭据 P/Invoke 预编译 DLL（首次编译、后续加载；文件名绑定源码 hash）
check('H8a DLL 文件名绑定 C# 源码 hash（杜绝旧 DLL）', cred.includes('createHash') && /KiteWinCred_\$\{/.test(cred));
check('H8b 含 csc 预编译路径', cred.includes('csc.exe') && cred.includes('/target:library'));
check('H8c DLL 加载失败可回退即时编译', /Add-Type -Path \$Dll[\s\S]{0,120}Add-Type -TypeDefinition/.test(cred));
check('H8d 统一渲染注入 DLLDIR/DLLNAME，无漏占位', cred.includes('renderPs(') && cred.includes("replace('<DLLDIR>'") && cred.includes("replace('<DLLNAME>'"));
check('H8e C# 源码严禁再包一层单引号（1.3.3 事故根因）', !/CS_SOURCE_LINES\.map\([^)]*['"]'['"]/.test(cred) && cred.includes('...CS_SOURCE_LINES,'));

// H10 切号 toast 错误文案必须带 {0} 占位符，防止错误明细被 t() 静默吞掉
const i18nSrc = read('src/i18n.ts');
for (const k of ['switchCredFail', 'switchAgyPtrFail', 'switchGeminiFail', 'switchCancelled', 'switchDone']) {
  check(`H10 ${k} 含 {0} 占位符`, new RegExp(`${k}:[\\s\\S]{0,160}\\{0\\}`).test(i18nSrc));
}

// H8f 运行期冒烟（Windows）：真跑一次编译后的 readIdeCredential，验证 PS 语法 + Add-Type + csc 生成 hash DLL
if (process.platform === 'win32') {
  const require = createRequire(import.meta.url);
  const mod = require(join(root, 'out', 'winCredential.js'));
  const probe = await mod.readIdeCredential('kite:gate:nonexistent-smoke');
  // 目标靶标不存在时必须走到 Win32 ERROR_NOT_FOUND(1168)，若 PS/C# 语法或编译炸了不会是 err=1168
  const pInvokeRan = probe && probe.ok === false && typeof probe.error === 'string' && probe.error.includes('err=1168');
  check('H8f Windows 凭据 PS/C# 编译与 P/Invoke 实跑通畅', pInvokeRan, pInvokeRan ? mod.WIN_CRED_DLL_NAME : (probe && probe.error));
  const dllPath = join(process.env.APPDATA || '', '.antigravity-kite', 'dll', mod.WIN_CRED_DLL_NAME || 'missing');
  const dllOk = existsSync(dllPath) && statSync(dllPath).size > 0;
  check('H8g csc 预编译 hash DLL 已生成', dllOk, dllOk ? `${mod.WIN_CRED_DLL_NAME} (${statSync(dllPath).size}B)` : dllPath);
} else {
  console.log('  SKIP  H8f/H8g Windows 凭据运行期冒烟（非 win32）');
}

// H9 门控自身挂进 compile 链
check('H9a compile 链含 check_switch_health', (pkg.scripts.compile || '').includes('check_switch_health'));
check('H9b package 链经 compile 覆盖门控', (pkg.scripts.package || '').includes('npm run compile'));

// H11 单 agy 快路径：listAllProcesses 全系统快照只能在 probe.pids.length >= 2 时触发
const rtSrc = read('src/ideRuntime.ts');
check('H11 单 agy 免跑 6.6s 全量进程快照', /probe\.pids\.length === 1[\s\S]{0,400}probe\.pids\.length >= 2[\s\S]{0,200}listAllProcesses\(\)/.test(rtSrc));

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
