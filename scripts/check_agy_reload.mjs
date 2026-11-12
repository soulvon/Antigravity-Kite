#!/usr/bin/env node
/**
 * agy 引擎热重载门控（事故：切号后模型列表不刷新）
 *
 * 真机证据：
 * - kite.log.1 11-09~11-11 共 15 次切号 killed:1/2/4、agyWasRunning:true（模型列表随引擎重建刷新）
 * - kite.log   11-12 起共 8 次切号 killed:0、agyWasRunning:false，但系统里 agy.exe 实际在跑
 * 根因：进程枚举只走 powershell -EncodedCommand，失败被吞成 null；JSON.parse catch 空吞；
 *       wmic 回退静默；最终空数组被 killAgyEngine 当成「agy 本就没运行」静默返回成功。
 *
 * 本门控把「读失败 = 未知，绝不当成空列表」和「无进程不得静默当成功」固化成硬断言。
 */
import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const src = join(root, 'src');
const read = (name) => readFileSync(join(src, name), 'utf8');
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));

let pass = 0;
let fail = 0;
function check(name, cond, extra) {
  if (cond) { pass++; console.log(`  PASS  ${name}${extra ? ' | ' + extra : ''}`); }
  else { fail++; console.log(`  FAIL  ${name}${extra ? ' | ' + extra : ''}`); }
}

console.log('=== agy 引擎热重载门控 ===\n');

const rt = read('ideRuntime.ts');
const ext = read('extension.ts');
const i18n = read('i18n.ts');

// A1 独立进程校验：不得把 powershell -EncodedCommand 当唯一来源
check('A1a 存在独立 agy PID 校验函数', /async function listAgyPids\s*\(/.test(rt));
check('A1b 独立校验走 tasklist（不派生 powershell）', rt.includes('tasklist') && /IMAGENAME eq agy\.exe/.test(rt));
check('A1c 独立校验覆盖 POSIX 分支', /ps -eo pid=,comm=/.test(rt) && rt.includes("process.platform === 'win32'"));

// A2 读失败必须暴露，禁止静默降级
const psFn = rt.match(/export function runPowerShellAsync[\s\S]*?\n}/)?.[0] || '';
check('A2a runPowerShellAsync 函数体内有 logWarn 留痕', psFn.includes('logWarn'));
const enumFn = rt.slice(rt.indexOf('async function listAllProcesses'), rt.indexOf('interface AgyPidProbe'));
check('A2b listAllProcesses 的 catch 不再空吞', !/catch\s*\{\s*\/\*/.test(enumFn));
check('A2c listAllProcesses 解析失败有 logWarn', rt.includes('agy.enum.parse'));
check('A2d wmic 回退失败有 logWarn', rt.includes('agy.enum.wmic'));

// A3 枚举结果与独立校验必须比对，差异要暴露
check('A3a killAgyEngine 调用独立 agy PID 校验', /killAgyEngine[\s\S]{0,1200}listAgyPids\(/.test(rt));
check('A3b 枚举差异显式告警', rt.includes('agy.enum.mismatch'));
check('A3c 独立校验命令失败不得当成「无进程」', /AgyProbe[\s\S]{0,200}ok:\s*false/.test(rt) || /probe\.ok\s*===\s*false/.test(rt));

// A4 「agy 未运行」不得静默当成功：必须有可见错误
const noEngineBranch = rt.match(/if \(agyPids\.length === 0\)[\s\S]{0,500}/);
check('A4a 无 agy 分支返回 error', !!noEngineBranch && /error:/.test(noEngineBranch[0]));
check('A4b 无 agy 分支有 i18n 文案', !!noEngineBranch && /t\('agyReload/.test(noEngineBranch[0]));
check('A4c 无 agy 分支保留结构化的 agyWasRunning', !!noEngineBranch && /agyWasRunning:\s*false/.test(noEngineBranch[0]));

// A5 切号收口必须把引擎重载失败透出到 toast
check('A5a 切号 toast 收集 agyReload.error', /notes\.push\(agyReload\.error\)/.test(ext));
check('A5b 切号日志记录 agyWasRunning', /switch\.hot\.agyReload[\s\S]{0,300}agyWasRunning/.test(ext));

// A6 新增文案必须中英双全
for (const key of ['agyReloadNoEngine', 'agyReloadEnumFail']) {
  check(`A6 ${key} 中英双全`, new RegExp(`${key}:\\s*\\[\\s*'[^']+'\\s*,\\s*'[^']+'\\s*,?\\s*\\]`).test(i18n));
}

// A7 门控自身挂进 compile 链，防止被绕过
check('A7a compile 链含 check_agy_reload', (pkg.scripts.compile || '').includes('check_agy_reload'));
check('A7b package 链经 compile 覆盖门控', (pkg.scripts.package || '').includes('npm run compile'));

console.log(`\nagy 热重载门控结果: ${pass} 通过, ${fail} 失败`);
process.exit(fail > 0 ? 1 : 0);
