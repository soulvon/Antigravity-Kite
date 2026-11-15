#!/usr/bin/env node
/**
 * 切号性能优化与三平台原生链路回归门控（Win / macOS / Linux）
 *
 * 覆盖：
 *   P1 macOS BSD ps 含空格 .app 路径解析（防 Antigravity IDE.app 漏杀 agy）
 *   P2 Linux /proc 零派生解析器（含带空格/括号进程名安全解析）
 *   P3 跨平台进程树祖先定位 resolveAgyPidsFromTree（单 IDE 多 utility/多 agy 精确隔离，不误伤旁路实例）
 *   P4 Windows 原生编译缓存 .exe Helper（KiteWinHelper_<hash>.exe 零 PowerShell CredReadW + Toolhelp32 快路径）
 *   P5 Token Scope 校验绑定复用（只复用 Kite 自身刷新且 SHA256 指纹匹配的 AT，防外部导入 403）
 *   P6 extension.ts 三阶段并发切号流水线（OAuth 与本地预定位并行、Phase B 并发落盘）
 */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const require2 = createRequire(import.meta.url);

// 注入 vscode stub 以便直接加载 out/*.js 单测
const stubDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kite-perf-stub-'));
fs.mkdirSync(path.join(stubDir, 'vscode'), { recursive: true });
fs.writeFileSync(path.join(stubDir, 'vscode', 'package.json'), JSON.stringify({ name: 'vscode', main: 'index.js' }));
fs.writeFileSync(
  path.join(stubDir, 'vscode', 'index.js'),
  `const c = new Proxy(function () {}, {
    get: (_t, p) => (p === 'then' ? undefined : (p === Symbol.toPrimitive || p === 'toString' || p === 'valueOf') ? () => '' : c),
    apply: () => c,
    construct: () => c,
  });
  module.exports = c;`
);
process.env.NODE_PATH = [stubDir, process.env.NODE_PATH].filter(Boolean).join(path.delimiter);
require2('module')._initPaths();

let pass = 0;
let fail = 0;
function gate(name, ok, detail = '') {
  if (ok) {
    pass++;
    console.log(`  PASS  ${name}${detail ? ' | ' + detail : ''}`);
  } else {
    fail++;
    console.log(`  FAIL  ${name}${detail ? ' <- ' + detail : ''}`);
  }
}

console.log('=== 切号性能与跨平台优化门控 ===\n');

let rtMod = null;
try { rtMod = require2(path.join(root, 'out', 'ideRuntime.js')); } catch {}

// P1: macOS ps 含空格路径解析（Antigravity IDE.app）
const psCommMac = [
  '  45896 /Applications/Antigravity IDE.app/Contents/Resources/app/extensions/antigravity/bin/agy',
  '  54088 agy',
  '  99901 /Applications/Antigravity IDE.app/Contents/MacOS/Antigravity Helper',
].join('\n');
const macPids = rtMod && typeof rtMod.parseUnixAgyPidsFromPs === 'function'
  ? rtMod.parseUnixAgyPidsFromPs(psCommMac)
  : null;
gate('P1a macOS ps -eo pid=,comm= 正确识别含空格 .app 路径下的 agy PID',
  Array.isArray(macPids) && macPids.length === 2 && macPids[0] === 45896 && macPids[1] === 54088,
  JSON.stringify(macPids));

const psCmdMac = [
  '  66304 1 /Applications/Antigravity IDE.app/Contents/MacOS/Antigravity --remote-debugging-port=9333',
  '  28472 66304 /Applications/Antigravity IDE.app/Contents/Frameworks/Helper.app/Contents/MacOS/Helper --type=utility',
  '  45896 28472 /Applications/Antigravity IDE.app/Contents/Resources/app/bin/agy --stdio',
].join('\n');
const macProcs = rtMod && typeof rtMod.parseUnixProcessesFromPs === 'function'
  ? rtMod.parseUnixProcessesFromPs(psCmdMac)
  : null;
const agyProc = Array.isArray(macProcs) ? macProcs.find((p) => p.pid === 45896) : null;
gate('P1b macOS ps -eo pid=,ppid=,command= 正确提取含空格路径的 agy 进程名',
  !!agyProc && agyProc.name === 'agy' && agyProc.ppid === 28472,
  JSON.stringify(agyProc));

// P2: Linux /proc/<pid>/stat 解析器（含空格与嵌套括号进程名）
const statNormal = rtMod && typeof rtMod.parseLinuxProcStat === 'function'
  ? rtMod.parseLinuxProcStat(54088, '54088 (agy) S 28472 28472 0 0 -1 4194304 0 0 0 0')
  : null;
const statParen = rtMod && typeof rtMod.parseLinuxProcStat === 'function'
  ? rtMod.parseLinuxProcStat(1001, '1001 (Web Content (1)) S 500 500 0 0 -1 4194304')
  : null;
gate('P2a Linux /proc/<pid>/stat 正确解析 name 与 ppid（含空格与括号）',
  statNormal?.pid === 54088 && statNormal?.ppid === 28472 && statNormal?.name === 'agy'
  && statParen?.pid === 1001 && statParen?.ppid === 500 && statParen?.name === 'Web Content (1)',
  JSON.stringify({ statNormal, statParen }));
gate('P2b ideRuntime 导出并实现零派生 /proc 快路径 readLinuxProcTree',
  !!rtMod && typeof rtMod.readLinuxProcTree === 'function',
  '缺少 readLinuxProcTree');

// P3: 统一树定位算法 resolveAgyPidsFromTree（单窗口多 utility 多 agy 精确隔离）
const mockTree = [
  { pid: 14328, ppid: 1, name: 'explorer.exe', cmd: '' },
  { pid: 66304, ppid: 14328, name: 'Antigravity IDE.exe', cmd: '"Antigravity IDE.exe" --remote-debugging-port=9333' },
  { pid: 24520, ppid: 66304, name: 'Antigravity IDE.exe', cmd: '--type=utility' },
  { pid: 28472, ppid: 66304, name: 'Antigravity IDE.exe', cmd: '--type=utility' },
  { pid: 45896, ppid: 24520, name: 'agy.exe', cmd: '' },
  { pid: 54088, ppid: 28472, name: 'agy.exe', cmd: '' },
  { pid: 77000, ppid: 14328, name: 'Antigravity.exe', cmd: 'white-hub' },
  { pid: 88001, ppid: 77000, name: 'agy.exe', cmd: '' },
];
const treeHit = rtMod && typeof rtMod.resolveAgyPidsFromTree === 'function'
  ? rtMod.resolveAgyPidsFromTree(mockTree, 28472, true)
  : null;
gate('P3 resolveAgyPidsFromTree 通过 selfPid 上溯主进程并精准命中双 utility 下的双 agy（不误杀 88001）',
  !!treeHit && treeHit.rootPid === 66304
  && JSON.stringify(treeHit.treeAgy.slice().sort()) === JSON.stringify([45896, 54088])
  && JSON.stringify(treeHit.allAgy.slice().sort()) === JSON.stringify([45896, 54088, 88001]),
  JSON.stringify(treeHit));

// P4: Windows 原生缓存 Helper .exe（零 PowerShell CredReadW + Toolhelp32）
let winHelperMod = null;
try { winHelperMod = require2(path.join(root, 'out', 'winNativeHelper.js')); } catch {}
const helperSrcExists = fs.existsSync(path.join(root, 'src', 'winNativeHelper.ts'));
gate('P4a winNativeHelper 模块存在并绑定 C# 源码 hash 生成独立 .exe',
  helperSrcExists && !!winHelperMod
  && typeof winHelperMod.WIN_HELPER_EXE_NAME === 'string'
  && /^KiteWinHelper_[0-9a-f]{8}\.exe$/.test(winHelperMod.WIN_HELPER_EXE_NAME),
  winHelperMod?.WIN_HELPER_EXE_NAME || 'missing winNativeHelper');

if (process.platform === 'win32' && winHelperMod && typeof winHelperMod.runWinCredRead === 'function' && typeof winHelperMod.locateWinAgyNative === 'function') {
  const t0 = Date.now();
  const exePath = await winHelperMod.ensureWinNativeHelper();
  const credProbe = await winHelperMod.runWinCredRead('kite:gate:nonexistent-smoke');
  const agyProbe = await winHelperMod.locateWinAgyNative(process.pid);
  const elapsedMs = Date.now() - t0;
  const credOk = credProbe && credProbe.ok === false && typeof credProbe.error === 'string' && credProbe.error.includes('err=1168');
  const agyOk = agyProbe && agyProbe.ok === true && Array.isArray(agyProbe.allAgy) && Array.isArray(agyProbe.treeAgy);
  gate('P4b Windows 原生 .exe CredReadW(err=1168) 与 Toolhelp32 locate 冒烟通过',
    !!exePath && fs.existsSync(exePath) && credOk && agyOk,
    `exe=${path.basename(exePath || '')}, cred=${credProbe?.error}, agyOk=${agyOk}, total=${elapsedMs}ms`);
} else if (process.platform === 'win32') {
  gate('P4b Windows 原生 .exe 冒烟函数已就绪', false, 'winNativeHelper 未导出所需函数');
}

// P5: Token Scope 校验绑定复用（只信任 Kite 刷新且 SHA256 匹配的 AT）
let ssMod = null;
try { ssMod = require2(path.join(root, 'out', 'seamlessSwitcher.js')); } catch {}
const canReuseFn = ssMod && typeof ssMod.canReuseVerifiedSwitchToken === 'function' ? ssMod.canReuseVerifiedSwitchToken : null;
const now = Date.now();
const futureIso = new Date(now + 40 * 60 * 1000).toISOString();
const nearIso = new Date(now + 5 * 60 * 1000).toISOString();
const goodAt = 'ya29.kite-verified-sample-token';
const goodHash = createHash('sha256').update(goodAt).digest('hex').slice(0, 16);
const p5Ok = !!canReuseFn
  && canReuseFn({ email: 'a@b.com', accessToken: goodAt, refreshToken: '1//rt', expiresAt: futureIso }, now) === false
  && canReuseFn({ email: 'a@b.com', accessToken: 'ya29.tampered', refreshToken: '1//rt', expiresAt: futureIso, verifiedAtHash: goodHash, verifiedAt: now }, now) === false
  && canReuseFn({ email: 'a@b.com', accessToken: goodAt, refreshToken: '1//rt', expiresAt: futureIso, verifiedAtHash: goodHash, verifiedAt: now }, now) === true
  && canReuseFn({ email: 'a@b.com', accessToken: goodAt, refreshToken: '1//rt', expiresAt: nearIso, verifiedAtHash: goodHash, verifiedAt: now }, now) === false
  && canReuseFn({ email: 'a@b.com', accessToken: goodAt, refreshToken: '1//rt', expiresAt: futureIso, verifiedAtHash: goodHash, verifiedAt: now, health: { status: 'auth_invalid', checkedAt: futureIso } }, now) === false;
gate('P5 canReuseVerifiedSwitchToken 仅复用 Kite 已验 scope 且未篡改/未临期/非失效 AT',
  p5Ok,
  canReuseFn ? '判定分支不符合预期' : '未导出 canReuseVerifiedSwitchToken');

// P6: extension.ts 并发切号流水线
const extSrc = fs.readFileSync(path.join(root, 'src', 'extension.ts'), 'utf8');
gate('P6 extension.ts 将 agy 目标探查/helper 预热与 prepareSwitchToken 并发执行',
  /Promise\.all\(\[\s*prepareSwitchToken\(account\),\s*ideRuntime\.prepareAgyReload/.test(extSrc),
  '尚未并发重排 Phase A 流水线');

try { fs.rmSync(stubDir, { recursive: true, force: true }); } catch {}
console.log(`\n切号性能与跨平台门控结果: ${pass} 通过, ${fail} 失败`);
process.exit(fail > 0 ? 1 : 0);

