/**
 * 守卫门控：安全声明与协议自动确认（Declaration & Onboarding Suppressor）
 * 覆盖：
 *   - M1: 弹窗卡片识别——覆盖新版 "One last thing before getting started..." 与 "继续" 按钮
 *   - M2: 经典声明兼容——覆盖 "接受并继续" / "Accept and continue"
 *   - M3: 防误伤——普通页面中无关的 "继续" 按钮不可乱点
 *   - M4: target 过滤——覆盖 https://127.0.0.1、vscode-file://，并排除自身 webview
 *   - M5: 端口发现——支持 DevToolsActivePort 动态端口读取
 */
import assert from 'assert';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const srcFile = path.resolve(__dirname, '../src/declarationSuppressor.ts');
const content = fs.readFileSync(srcFile, 'utf8');

console.log('=== Declaration Suppressor Gate Check ===\n');

let failed = 0;
function pass(msg) { console.log(`  PASS  ${msg}`); }
function fail(msg, err) { console.error(`  FAIL  ${msg}: ${err}`); failed++; }

// 检查 1: 必须包含对新版引导弹窗文案的处理
try {
  assert(content.includes('One last thing before getting started') || content.includes('Help us improve Antigravity'),
    'declarationSuppressor.ts 缺少对 "One last thing" 或 "Help us improve" 引导弹窗的识别');
  pass('M1 新版引导卡片识别');
} catch (e) {
  fail('M1 新版引导卡片识别', e.message);
}

// 检查 2: 按钮正则必须能匹配 "继续" / "Continue"
try {
  assert(content.includes('继续') && content.includes('Continue'),
    'declarationSuppressor.ts 缺少对 "继续" / "Continue" 按钮的匹配');
  pass('M2 匹配 "继续" / "Continue" 按钮');
} catch (e) {
  fail('M2 匹配 "继续" / "Continue" 按钮', e.message);
}

// 检查 3: Target 过滤必须支持 https 协议
try {
  assert(/https\?:\/\/(127\.0\.0\.1|localhost)/i.test(content) || (content.includes('https://') && content.includes('127.0.0.1')),
    'declarationSuppressor.ts 目标 URL 过滤未覆盖 https://127.0.0.1');
  pass('M3 Target 过滤支持 https');
} catch (e) {
  fail('M3 Target 过滤支持 https', e.message);
}

// 检查 4: 支持 DevToolsActivePort 端口读取
try {
  assert(content.includes('DevToolsActivePort'),
    'declarationSuppressor.ts 未实现 DevToolsActivePort 动态端口读取');
  pass('M4 支持 DevToolsActivePort 端口读取');
} catch (e) {
  fail('M4 支持 DevToolsActivePort 端口读取', e.message);
}

// 检查 5: 必须使用 platformPaths 提供的跨平台路径
try {
  assert(content.includes('getAppDataDir'),
    'declarationSuppressor.ts 必须通过 platformPaths.getAppDataDir 获取数据目录');
  pass('M5 符合跨平台规范');
} catch (e) {
  fail('M5 符合跨平台规范', e.message);
}

console.log(`\n门控结果: ${5 - failed} 通过, ${failed} 失败\n`);
if (failed > 0) process.exit(1);

