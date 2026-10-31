#!/usr/bin/env node
/**
 * 跨平台兼容门控
 * 防回潮：任何把 Windows 专属机制（APPDATA 直引/taskkill/powershell/CredWrite）
 * 当唯一路径、或让助手与扩展的共享目录语义漂移的改动，在此直接失败。
 */
import { readFileSync, readdirSync, statSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const src = join(root, 'src');

let pass = 0;
let fail = 0;
function check(name, cond, extra) {
  if (cond) { pass++; console.log(`  PASS  ${name}${extra ? ' | ' + extra : ''}`); }
  else { fail++; console.log(`  FAIL  ${name}${extra ? ' | ' + extra : ''}`); }
}
function readSrc(name) {
  return readFileSync(join(src, name), 'utf8');
}

console.log('=== Antigravity Kite 跨平台门控 ===\n');

// G1 路径单一真源：platformPaths.ts 存在、零 vscode 依赖、三平台分支齐备
const pp = readSrc('platformPaths.ts');
check('G1a platformPaths.ts 不依赖 vscode', !pp.includes(`from 'vscode'`) && !pp.includes('require(\'vscode\')'));
check('G1b platformPaths 覆盖 win32/darwin/linux', pp.includes("'win32'") && pp.includes("'darwin'") && pp.includes("XDG_CONFIG_HOME"));

// G2 共享目录两端一致：助手不得再出现裸 APPDATA 回退（否则日志/交接文件与扩展端分裂）
const helper = readSrc('switchRestartHelper.ts');
check('G2a switchRestartHelper 引用 platformPaths.getAppDataDir', helper.includes("from './platformPaths'"));
check('G2b 助手无裸 APPDATA||homedir 回退', !/process\.env\.APPDATA\s*\|\|\s*os\.homedir\(\)/.test(helper));

// G3 关 IDE 进程必须双平台：Windows taskkill + POSIX SIGTERM/SIGKILL
check('G3a closeIde 含 Windows taskkill 分支', helper.includes('taskkill'));
check('G3b closeIde 含 POSIX SIGTERM/SIGKILL 分支', helper.includes('SIGTERM') && helper.includes('SIGKILL'));
check('G3c closeIde 按平台分支', helper.includes("process.platform === 'win32'"));

// G4 凭据服务显式平台门控：非 Windows 必须结构化失败，不得让 powershell ENOENT 裸暴露
const cred = readSrc('winCredential.ts');
check('G4a winCredential 含平台门控', cred.includes("process.platform !== 'win32'"));
check('G4b 门控走 i18n 文案（credWindowsOnly）', cred.includes('credWindowsOnly'));

// G5 状态库候选必须覆盖三平台（darwin Library/AS + linux .config）
const ideDb = readSrc('ideStateDb.ts');
check('G5 ideStateDb 候选含 darwin/linux 目录', ideDb.includes("'darwin'") && ideDb.includes('getAppDataDir'));

// G6 IDE 进程枚举双平台：listAllProcesses/listIdeProcesses 必须有 POSIX ps 分支
const rt = readSrc('ideRuntime.ts');
check('G6a ideRuntime 引用 platformPaths', rt.includes("from './platformPaths'"));
check('G6b listAllProcesses 含 POSIX ps 分支', /ps -eo pid=,ppid=,command=/.test(rt));
check('G6c listIdeProcesses 含 POSIX ps 分支', rt.split('ps aux').length >= 2);
check('G6d agy 引擎名称按平台匹配', rt.includes('agyNameRe'));
check('G6e 杀进程按平台（SIGKILL 分支）', rt.includes('SIGKILL'));

// G7 全源码扫描：禁止裸 APPDATA/LOCALAPPDATA 无平台分支回退（目录语义漂移模式）
const files = [];
(function walk(dir) {
  for (const f of readdirSync(dir)) {
    const fp = join(dir, f);
    if (statSync(fp).isDirectory()) walk(fp);
    else if (f.endsWith('.ts')) files.push(fp);
  }
})(src);
const offenders = [];
for (const f of files) {
  const text = readFileSync(f, 'utf8');
  // 裸模式：APPDATA 直接回退 homedir（Windows 专属目录被套到其他平台）
  if (/process\.env\.APPDATA\s*\|\|\s*os\.homedir\(\)/.test(text)) offenders.push(f.replace(src, 'src'));
}
check('G7 无裸 APPDATA||homedir 回退模式', offenders.length === 0, offenders.join(', '));

// G8 门控脚本自身必须挂进 compile/package 链，防止被绕过
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
check('G8a compile 链含 check_platform_gates', (pkg.scripts.compile || '').includes('check_platform_gates'));
check('G8b package 链经 compile 覆盖门控', (pkg.scripts.package || '').includes('npm run compile'));

console.log(`\n跨平台门控结果: ${pass} 通过, ${fail} 失败`);
process.exit(fail > 0 ? 1 : 0);
