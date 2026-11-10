#!/usr/bin/env node
/**
 * 多开启动链路门控（devloop 红线 4：改旧行为前先写一条能在旧代码上失败的检查）
 *
 * 真机事故（v1.2.13）：点「启动」后进程被拉起，pid 有值，但几百毫秒内秒退，多开目录里只剩
 * .kite-bind、没有任何 Electron 初始化产物，界面一直停在「已停止」——表现就是「点了没反应」。
 * 两个独立缺陷叠加：
 *   1. spawn 继承了扩展宿主的 ELECTRON_RUN_AS_NODE=1，IDE 以纯 Node 模式启动，
 *      Node 不认识 --user-data-dir → "bad option" 退出（exit 9）。
 *      本机隔离实验：干净环境存活；仅注入 VSCODE_IPC_HOOK 仍存活；注入 ELECTRON_RUN_AS_NODE=1 必秒退。
 *      再叠加 stdio:'ignore' + try/catch（spawn 失败是异步 error 事件，catch 抓不到）导致完全静默。
 *   2. 进程枚举的 --user-data-dir 正则要求路径后紧跟 -- 或行尾，而实际命令行后面
 *      还跟着工作区路径，导致多开进程被误判成主窗口，状态永远「已停止」。
 */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');
const require2 = createRequire(import.meta.url);

// ideRuntime 顶层只 require('vscode')，空桩即可（不访问任何 vscode 属性）
const stubDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kite-vscode-stub-'));
fs.mkdirSync(path.join(stubDir, 'vscode'), { recursive: true });
fs.writeFileSync(path.join(stubDir, 'vscode', 'package.json'), JSON.stringify({ name: 'vscode', main: 'index.js' }));
fs.writeFileSync(path.join(stubDir, 'vscode', 'index.js'), 'module.exports = {};');
process.env.NODE_PATH = [stubDir, process.env.NODE_PATH].filter(Boolean).join(path.delimiter);
const Module = require2('module');
Module._initPaths();

let failures = 0;
const gate = (name, ok, detail = '') => {
  console.log((ok ? '  PASS  ' : '  FAIL  ') + name + (ok || !detail ? '' : '  <- ' + detail));
  if (!ok) failures++;
};

console.log('[check_mw_launch] 多开启动与状态识别 …');

let runtime;
try {
  runtime = require2(path.join(root, 'out', 'ideRuntime.js'));
} catch (e) {
  console.error(`  FAIL  out/ideRuntime.js 加载失败: ${e.message}`);
  process.exit(1);
}

// ── P：命令行解析（行为断言，不是文本匹配） ──
gate('P1 导出 parseUserDataDir（旧代码无此导出 → 直接 FAIL）', typeof runtime.parseUserDataDir === 'function');

if (typeof runtime.parseUserDataDir === 'function') {
  const parse = runtime.parseUserDataDir;
  const defaultDir = runtime.getDefaultUserDataDir();

  const realCase = '"C:\\Users\\admin\\AppData\\Local\\Programs\\Antigravity IDE\\Antigravity IDE.exe" --user-data-dir C:\\Users\\admin\\AppData\\Roaming\\.antigravity-kite\\windows\\mw_6782c3d0ee14 "e:\\project\\Antigravity Kite"';
  gate('P2 后面跟工作区路径时仍能取出多开目录（真实事故命令行）',
    parse(realCase).toLowerCase() === 'c:\\users\\admin\\appdata\\roaming\\.antigravity-kite\\windows\\mw_6782c3d0ee14',
    parse(realCase));

  gate('P3 等号形式 --user-data-dir=路径',
    parse('"X.exe" --user-data-dir=C:\\tmp\\mw_a --new-window') === 'C:\\tmp\\mw_a',
    parse('"X.exe" --user-data-dir=C:\\tmp\\mw_a --new-window'));

  gate('P4 带引号且含空格的多开目录',
    parse('"X.exe" --user-data-dir "C:\\a b\\mw_x" "e:\\work space"') === 'C:\\a b\\mw_x',
    parse('"X.exe" --user-data-dir "C:\\a b\\mw_x" "e:\\work space"'));

  gate('P5 单引号形式',
    parse("X.exe --user-data-dir 'C:\\tmp\\mw_q'") === 'C:\\tmp\\mw_q',
    parse("X.exe --user-data-dir 'C:\\tmp\\mw_q'"));

  gate('P6 不带该参数 → 归主窗口默认目录',
    parse('"X.exe" --remote-debugging-port=9333') === defaultDir,
    parse('"X.exe" --remote-debugging-port=9333'));

  // 旧正则回归对照：证明修复针对真实缺陷，不是空改
  const oldRe = /--user-data-dir[= ]+["']?([^"']+?)["']?(?:\s+--|\s*$)/i;
  const oldHit = realCase.match(oldRe);
  gate('P7 旧正则在真实命令行上确实失败（缺陷可复现）', !oldHit || !/mw_6782c3d0ee14/.test(oldHit[1]));
}

// ── S：spawn 启动健壮性（静态断言） ──
const mwSrc = fs.readFileSync(path.join(root, 'src', 'multiWindowManager.ts'), 'utf8');
gate('S1 清理继承的 VS Code IPC / Electron 环境变量',
  /INHERITED_ENV_BLOCKLIST/.test(mwSrc) && /VSCODE_IPC_HOOK/.test(mwSrc) && /ELECTRON_RUN_AS_NODE/.test(mwSrc));
gate('S2 不再用 stdio:\'ignore\' 吞掉启动错误',
  !/stdio:\s*'ignore'/.test(mwSrc), '仍然丢弃子进程输出');
gate('S3 启动输出落盘可查（logs/mw-<id>.log）',
  /mw-\$\{win\.id\}\.log/.test(mwSrc));
gate('S4 显式等待存活窗口并监听异步 error/exit',
  /START_PROBE_MS/.test(mwSrc) && /child\.once\('error'/.test(mwSrc) && /child\.once\('exit'/.test(mwSrc),
  'spawn 的失败是异步 error 事件，try/catch 抓不到');
gate('S5 秒退必须抛错（不允许静默成功）',
  /if \(!outcome\.alive\)/.test(mwSrc) && /mwStartExited/.test(mwSrc));

// ── Q：启动前预写身份（把 35 秒运行时切号压到秒级）──
const extSrc = fs.readFileSync(path.join(root, 'src', 'extension.ts'), 'utf8');
gate('Q1 启动前预写目标窗口身份',
  /_primeWindowIdentity/.test(extSrc) && /switchIdeStateIdentity\(\s*acc\.email/.test(extSrc),
  '不预写就得等运行时自愈切号，实测约 35 秒才变成目标号');
gate('Q2 预写写到该窗口自己的 state.vscdb（不波及主窗口）',
  /resolveIdeStateDbPathFromUserData\(win\.userDataDir\)/.test(extSrc));
gate('Q3 token 临期不写（避免写入将失效的凭据）',
  /preIdentity\.tokenExpiring/.test(extSrc));
gate('Q4 新建启动与卡片启动都走预写',
  (extSrc.match(/_primeWindowIdentity\(/g) || []).length >= 3);

console.log(failures === 0
  ? '[check_mw_launch] 全部通过 ✔'
  : `[check_mw_launch] ${failures} 项失败 ✘`);
process.exit(failures === 0 ? 0 : 1);
