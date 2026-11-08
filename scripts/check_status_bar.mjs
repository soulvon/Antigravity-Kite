#!/usr/bin/env node
/**
 * 底栏重构检查（devloop 红线 4：修改旧行为前，先写一条能在旧代码上失败的检查）
 *
 * 断言 out/statusBar.js 的纯函数导出（不实例化 StatusBarManager、不触 real globalState）：
 *   1. validateStyle —— 新增 smart 聚合样式且为默认；旧 6 档全保留（自定义丰富）；非法值回退 smart
 *   2. sortPoolForQuickPick —— 可用号按最紧额度降序（最优号在顶）→ 未知 → 封禁/登录失效 → 禁用垫底
 *   3. pickHealthMark —— 封禁=error 红底 / 登录失效=warning / ok 与未检测不亮牌（异常才亮牌）
 *   4. formatWindowShort —— 平铺样式窗口短标（复用 usageService 权威 label，不重复实现）
 *
 * 旧产物（<1.1.16）没有这些导出 → 直接 FAIL，这正是本次重构的行为差异。
 */
import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');
const require2 = createRequire(import.meta.url);

// NODE_PATH 注入 vscode 桩：本脚本自造链式桩（浅桩返回 {}，i18n.getLang 要调 getConfiguration().get() 会断）
// 共享桩 .preview/vscode-stub 仍留给 probe 脚本，互不影响
const stubNM = path.join(root, '.preview', 'vscode-stub', 'node_modules');
const stubDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kite-vscode-stub-'));
fs.mkdirSync(path.join(stubDir, 'vscode'), { recursive: true });
fs.writeFileSync(
  path.join(stubDir, 'vscode', 'package.json'),
  JSON.stringify({ name: 'vscode', main: 'index.js' })
);
const STUB_SRC = `
const chain = new Proxy(function () {}, {
  get: (t, prop) => {
    if (prop === 'then' || prop === Symbol.toPrimitive) return undefined;
    return chain;
  },
  apply: () => chain,
  construct: () => chain,
});
module.exports = chain;
`;
fs.writeFileSync(path.join(stubDir, 'vscode', 'index.js'), STUB_SRC);
process.env.NODE_PATH = [stubDir, stubNM, process.env.NODE_PATH].filter(Boolean).join(path.delimiter);
const Module = require2('module');
Module._initPaths();

let failures = 0;
const ok = (name) => console.log(`  PASS  ${name}`);
const fail = (name, msg) => { failures++; console.error(`  FAIL  ${name}\n        ${msg}`); };
const assert = (name, cond, msg = '') => (cond ? ok(name) : fail(name, msg));

console.log('[check_status_bar] 加载 out/statusBar.js …');
let mod;
try {
  mod = require2(path.join(root, 'out', 'statusBar.js'));
} catch (e) {
  console.error(`  FAIL  out/statusBar.js 加载失败: ${e.message}`);
  process.exit(1);
}

// ── 1. validateStyle ──────────────────────────────────────────────
if (typeof mod.validateStyle !== 'function') {
  fail('validateStyle 存在', '旧产物无此导出——底栏尚未引入 smart 聚合样式（本次重构核心行为）');
} else {
  assert('validateStyle(smart) = smart（默认聚合段）', mod.validateStyle('smart') === 'smart');
  assert('validateStyle(full) 保留旧样式', mod.validateStyle('full') === 'full');
  assert('validateStyle(dot/percent/compact/dual/labeled) 全保留',
    ['dot', 'percent', 'compact', 'dual', 'labeled'].every(s => mod.validateStyle(s) === s));
  assert('validateStyle(非法值) 回退 smart', mod.validateStyle('bogus') === 'smart');
}

// ── 2. sortPoolForQuickPick ───────────────────────────────────────
if (typeof mod.sortPoolForQuickPick !== 'function') {
  fail('sortPoolForQuickPick 存在', '旧产物无此导出——QuickPick 未按最紧额度排序（对标 BoyGR 模式）');
} else {
  const mk = (email, extra = {}) => ({ email, ...extra });
  const usage = (min) => ({ minRemainingPercent: min, models: [] });
  const pool = [
    mk('banned@x.com', { health: { status: 'banned', checkedAt: '' } }),      // 封禁但额度满格
    mk('low@x.com'),                                                          // 可用 20%
    mk('disabled@x.com', { disabled: true }),                                 // 禁用
    mk('high@x.com'),                                                         // 可用 80%
    mk('unknown@x.com', { health: { status: 'unknown', checkedAt: '' } }),    // 检测异常
    mk('current@x.com'),                                                      // 当前号 50%
  ];
  const getUsage = (email) => ({
    'banned@x.com': usage(100), 'low@x.com': usage(20), 'disabled@x.com': usage(90),
    'high@x.com': usage(80), 'unknown@x.com': usage(100), 'current@x.com': usage(50),
  }[email]);
  const got = mod.sortPoolForQuickPick(pool, getUsage, 'current@x.com').map(a => a.email);
  const want = ['current@x.com', 'high@x.com', 'low@x.com', 'unknown@x.com', 'banned@x.com', 'disabled@x.com'];
  assert('QuickPick 排序：当前号 → 可用按最紧额度降序 → 未知 → 封禁 → 禁用垫底',
    JSON.stringify(got) === JSON.stringify(want), `实际: ${got.join(' , ')}`);
}

// ── 3. pickHealthMark ─────────────────────────────────────────────
if (typeof mod.pickHealthMark !== 'function') {
  fail('pickHealthMark 存在', '旧产物无此导出——健康态未接入底栏（封禁号照样 ✓ 100% 的化装问题）');
} else {
  assert('封禁 → 🚫 + error 红底', (() => {
    const m = mod.pickHealthMark({ status: 'banned', checkedAt: '' });
    return m.icon === '🚫' && m.bg === 'error';
  })(), JSON.stringify(mod.pickHealthMark({ status: 'banned', checkedAt: '' })));
  assert('登录失效 → 🔑 + warning 橙底', (() => {
    const m = mod.pickHealthMark({ status: 'auth_invalid', checkedAt: '' });
    return m.bg === 'warning' && m.icon === '🔑';
  })(), JSON.stringify(mod.pickHealthMark({ status: 'auth_invalid', checkedAt: '' })));
  assert('检测异常 → ❓ 不亮底', (() => {
    const m = mod.pickHealthMark({ status: 'unknown', checkedAt: '' });
    return m.bg === undefined && m.icon === '❓';
  })(), JSON.stringify(mod.pickHealthMark({ status: 'unknown', checkedAt: '' })));
  assert('ok / 未检测 → 不亮牌（异常才亮牌原则）', (() => {
    const a = mod.pickHealthMark({ status: 'ok', checkedAt: '' });
    const b = mod.pickHealthMark(undefined);
    return !a.icon && !a.bg && !b.icon && !b.bg;
  })(), JSON.stringify([mod.pickHealthMark({ status: 'ok', checkedAt: '' }), mod.pickHealthMark(undefined)]));
}

// ── 4. formatWindowShort（平铺样式短标，标签唯一权威源在 usageService.label）────
if (typeof mod.formatWindowShort !== 'function') {
  fail('formatWindowShort 存在', '旧产物无此导出——平铺样式仍在 statusBar 内重复实现模型标签');
} else {
  assert('label 优先（usageService 权威标签直通）',
    mod.formatWindowShort({ label: 'Gemini 周额度', modelId: 'gemini:weekly', remainingPercent: 100 }) === 'Gemini 周额度',
    mod.formatWindowShort({ label: 'Gemini 周额度', modelId: 'gemini:weekly', remainingPercent: 100 }));
  assert('无 label 时按 modelId 推导兜底',
    /Gemini/.test(mod.formatWindowShort({ modelId: 'gemini:weekly', remainingPercent: 50 })),
    mod.formatWindowShort({ modelId: 'gemini:weekly', remainingPercent: 50 }));
}

// ── 5. colorDot（四档 emoji 色点）──────────────────────────────
if (typeof mod.colorDot !== 'function') {
  fail('colorDot 存在', '旧产物无此导出——状态点尚未 emoji 四档化');
} else {
  assert('色点四档：96🟢 44🟡 28🟠 8🔴',
    mod.colorDot(96) === '🟢' && mod.colorDot(44) === '🟡' && mod.colorDot(28) === '🟠' && mod.colorDot(8) === '🔴',
    [mod.colorDot(96), mod.colorDot(44), mod.colorDot(28), mod.colorDot(8)].join(''));
}

// ── 6. formatFamilySegments（多池多窗口族分格）─────────────────
if (typeof mod.formatFamilySegments !== 'function') {
  fail('formatFamilySegments 存在', '旧产物无此导出——多池多窗口未按族分格（Wanow 斜杠范式）');
} else {
  const mq = (id, p) => ({ modelId: id, label: id, remainingPercent: p });
  const segs = mod.formatFamilySegments([
    mq('claude:5h', 96), mq('claude:weekly', 100),
    mq('gemini:5h', 44),            // Gemini 只有 5h（无周）
    mq('argon:weekly', 8),          // Gemini 4 只有周（无 5h）
  ]);
  assert('族分格：三池三格，5h/周斜杠并排，缺窗跳过，色点取族内最紧',
    segs === '🟢 Claude 96%/100% · 🟡 Gemini 44% · 🔴 Gemini 4 8%', segs);
  const onlyClaude = mod.formatFamilySegments([mq('claude:weekly', 100)]);
  assert('单池单窗：无斜杠直接显示', onlyClaude === '🟢 Claude 100%', onlyClaude);
  const empty = mod.formatFamilySegments([]);
  assert('无数据：空串不渲染', empty === '', empty);
}

// ── 7. formatCredits（AI 点数：有就显示带 💎，没有不显示）─────
if (typeof mod.formatCredits !== 'function') {
  fail('formatCredits 存在', '旧产物无此导出——AI 点数尚未接入聚合段');
} else {
  assert('有点数 → 🪙 金币（整数直显）', mod.formatCredits(120) === '🪙 120', mod.formatCredits(120));
  assert('小数保留两位内', mod.formatCredits(87.5) === '🪙 87.5', mod.formatCredits(87.5));
  assert('无点数 → 空串不显示', mod.formatCredits(undefined) === '' && mod.formatCredits(null) === '');
}

// ── 8. maskEmailStr（隐私脱敏：G22 底栏/tooltip/QuickPick 同源）──
if (typeof mod.maskEmailStr !== 'function') {
  fail('maskEmailStr 存在', '旧产物无此导出——隐私态尚未接入底栏（G22 违规）');
} else {
  assert('邮箱脱敏形态 so***1@***', mod.maskEmailStr('soulvon2501@gmail.com') === 'so***1@***', mod.maskEmailStr('soulvon2501@gmail.com'));
  assert('短名/无 @ 兜底不炸', mod.maskEmailStr('ab@x.com') === 'a***@***' && mod.maskEmailStr('plain') === 'pl***' && mod.maskEmailStr('') === '');
}

console.log(failures === 0
  ? '[check_status_bar] 全部通过 ✔'
  : `[check_status_bar] ${failures} 项失败 ✘`);
process.exit(failures === 0 ? 0 : 1);
