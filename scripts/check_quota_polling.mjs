#!/usr/bin/env node
/**
 * 配额轮询降敏与回血推算门控（devloop 红线 4：先写能在旧代码上失败的检查）
 *
 * 校验项：
 *   Q1 停用后台定时全池 1-token 推理探针（仅保留手动 probeOneHealth / probeAllHealth）
 *   Q2 三档后台刷新范围（active 默认 / all / manual）在 package.json、宿主与侧栏 UI 全闭合
 *   Q3 隔离沙箱实测 QuotaOrchestrator：
 *      - active 默认模式后台仅刷当前账号，备用号零请求
 *      - manual 模式停用后台定时与自动首刷，手动全池刷新仍可用
 *      - 批量刷新带账号间随机错峰抖动（拒绝多号同毫秒齐射）
 *      - 窗口失焦满 30 分钟自动挂机休眠，重新聚焦自动补刷过期目标
 *   Q4 本地 resetTime 到期回血折算（resolveEffectiveUsage + getUsage 同源输出，不污染底层快照）
 */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (rel) => fs.readFileSync(path.join(root, rel), 'utf8');

let passed = 0;
let failed = 0;
function gate(name, ok, detail = '') {
  if (ok) {
    passed++;
    console.log(`  PASS  ${name}${detail ? ' | ' + detail : ''}`);
  } else {
    failed++;
    console.error(`  FAIL  ${name}${detail ? ' <- ' + detail : ''}`);
  }
}

console.log('=== 配额轮询降敏与回血推算门控 ===\n');

const pkg = JSON.parse(read('package.json'));
const orchestratorSrc = read('src/quotaOrchestrator.ts');
const sidebarHtml = read('resources/webview/sidebar.html');
const sidebarJs = read('resources/webview/sidebar.js');
const sidebarProvSrc = read('src/sidebarProvider.ts');
const extSrc = read('src/extension.ts');

// ── Q1 停用后台定时全池推理探针 ──
const noAutoHealthTimer = !orchestratorSrc.includes('_healthProbeTimer')
  && !orchestratorSrc.includes('_startupHealthTimer')
  && !/setInterval\([\s\S]{0,120}probeAllHealth/.test(orchestratorSrc)
  && !/setTimeout\([\s\S]{0,120}probeAllHealth/.test(orchestratorSrc);
const manualHealthKept = orchestratorSrc.includes('async probeOneHealth(')
  && orchestratorSrc.includes('async probeAllHealth(');
gate('Q1.1 后台已彻底移除自动定时/启动全池推理健康探针', noAutoHealthTimer);
gate('Q1.2 手动单号与全池健康复检入口完整保留', manualHealthKept);

// ── Q2 三档刷新范围配置与 UI 闭合 ──
const scopeProp = pkg.contributes?.configuration?.properties?.['antigravityKite.quotaRefreshScope'];
gate(
  'Q2.1 package.json 声明 quotaRefreshScope（active/all/manual，默认 active）',
  Boolean(scopeProp)
    && scopeProp.default === 'active'
    && JSON.stringify(scopeProp.enum) === JSON.stringify(['active', 'all', 'manual']),
  JSON.stringify(scopeProp || null),
);

const uiScopeWired = sidebarHtml.includes('id="setQuotaScope"')
  && sidebarJs.includes('setQuotaScope')
  && sidebarJs.includes("quotaRefreshScope")
  && /setQuotaRefresh[\s\S]{0,200}disabled/.test(sidebarJs)
  && sidebarProvSrc.includes("quotaRefreshScope")
  && extSrc.includes("antigravityKite.quotaRefreshScope");
gate('Q2.2 侧栏设置 #setQuotaScope、manual 置灰联动与宿主配置监听闭合', uiScopeWired);

// ── Q3 & Q4 隔离沙箱运行态验证 ──
const sandboxDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kite-quota-poll-'));
const runnerPath = path.join(sandboxDir, 'runner.cjs');
const runnerCode = `
'use strict';
const assert = require('node:assert/strict');
const path = require('node:path');
const Module = require('node:module');

const root = ${JSON.stringify(root)};
let currentScope = 'active';
let currentMinutes = 15;
let windowFocused = true;
const windowListeners = [];

const vscodeStub = {
  env: { language: 'zh-CN', appRoot: '' },
  ConfigurationTarget: { Global: 1 },
  workspace: {
    getConfiguration: () => ({
      get: (k, d) => {
        if (k === 'quotaRefreshScope') return currentScope;
        if (k === 'quotaRefreshMinutes') return currentMinutes;
        return d;
      },
    }),
  },
  window: {
    get state() { return { focused: windowFocused }; },
    onDidChangeWindowState: (fn) => {
      windowListeners.push(fn);
      return { dispose() { const i = windowListeners.indexOf(fn); if (i >= 0) windowListeners.splice(i, 1); } };
    },
  },
  commands: { registerCommand: () => ({ dispose() {} }) },
};

const origLoad = Module._load;
Module._load = function (req) {
  if (req === 'vscode') return vscodeStub;
  return origLoad.apply(this, arguments);
};

const accountStore = require(path.join(root, 'out', 'accountStore.js'));
const usageService = require(path.join(root, 'out', 'usageService.js'));
const statusBarMod = require(path.join(root, 'out', 'statusBar.js'));
const qoMod = require(path.join(root, 'out', 'quotaOrchestrator.js'));

assert.equal(typeof qoMod.normalizeRefreshScope, 'function', '缺少 normalizeRefreshScope 导出');
assert.equal(typeof qoMod.resolveEffectiveUsage, 'function', '缺少 resolveEffectiveUsage 导出');

// 校验 normalizeRefreshScope
assert.equal(qoMod.normalizeRefreshScope('active'), 'active');
assert.equal(qoMod.normalizeRefreshScope('all'), 'all');
assert.equal(qoMod.normalizeRefreshScope('manual'), 'manual');
assert.equal(qoMod.normalizeRefreshScope('invalid'), 'active');
assert.equal(qoMod.normalizeRefreshScope(undefined), 'active');

// 校验 resolveEffectiveUsage：已过 resetTime 窗口本地回血至 100%，保留未到期窗口，不篡改原对象
const now = Date.parse('2026-11-26T12:00:00Z');
const rawSnap = {
  minRemainingPercent: 0,
  updatedAt: now - 6 * 3600_000,
  tierId: 'PRO',
  models: [
    { label: 'Claude 5h', modelId: 'claude:5h', remainingPercent: 0, resetTime: '2026-11-26T10:00:00Z' },
    { label: 'Claude 周额度', modelId: 'claude:weekly', remainingPercent: 65, resetTime: '2026-11-29T10:00:00Z' },
  ],
};
const effPart = qoMod.resolveEffectiveUsage(rawSnap, now);
assert.equal(effPart.models[0].remainingPercent, 100, '已过 resetTime 的 5h 窗口应折算为 100%');
assert.equal(effPart.models[0].resetTime, '2026-11-26T10:00:00Z', '保留原 resetTime 供卡片显示已重置');
assert.equal(effPart.models[1].remainingPercent, 65, '未到期周窗口应保持 65%');
assert.equal(effPart.minRemainingPercent, 65, '整体最低余量应重算为 65%');
assert.equal(rawSnap.models[0].remainingPercent, 0, '严禁原地篡改原始持久化快照');

const rawFullReset = {
  minRemainingPercent: 0,
  updatedAt: now - 6 * 3600_000,
  models: [
    { label: 'Claude 5h', modelId: 'claude:5h', remainingPercent: 0, resetTime: '2026-11-26T11:59:00Z' },
    { label: 'Gemini 5h', modelId: 'gemini:5h', remainingPercent: 12, resetTime: '2026-11-26T09:00:00Z' },
  ],
};
const effFull = qoMod.resolveEffectiveUsage(rawFullReset, now);
assert.equal(effFull.minRemainingPercent, 100, '全部窗口均过重置时间后整体应折算为 100%');

(async () => {
  const sharedDir = process.env.KITE_SHARED_DIR;
  const storeMap = new Map([['currentEmail', 'cur@example.com']]);
  const mockCtx = {
    globalStorageUri: { fsPath: path.join(sharedDir, 'gs') },
    globalState: {
      get: (k, d) => (storeMap.has(k) ? storeMap.get(k) : d),
      update: async (k, v) => { if (v === undefined) storeMap.delete(k); else storeMap.set(k, v); },
    },
  };

  accountStore.init(mockCtx);
  accountStore.upsertBatch([
    { email: 'cur@example.com', accessToken: 'ya29.cur', refreshToken: '1//cur' },
    { email: 'standby1@example.com', accessToken: 'ya29.s1', refreshToken: '1//s1' },
    { email: 'standby2@example.com', accessToken: 'ya29.s2', refreshToken: '1//s2' },
  ], { overwriteTokens: true });

  const fetchCalls = [];
  usageService.fetchUsage = async (acc) => {
    fetchCalls.push(acc.email);
    return {
      minRemainingPercent: 80,
      updatedAt: Date.now(),
      tierId: 'PRO',
      models: [{ label: 'Claude 5h', modelId: 'claude:5h', remainingPercent: 80 }],
    };
  };

  const mockTracker = {
    recordRefresh() {},
    recordUsage() {},
  };

  const recordedDelays = [];
  const orchestrator = new qoMod.QuotaOrchestrator(mockCtx, mockTracker, {}, {
    sleepFn: async (ms) => { recordedDelays.push(ms); },
  });

  // 1) active 模式后台周期：仅刷当前号，备用号 0 请求
  currentScope = 'active';
  await orchestrator.refreshBackgroundCycle();
  assert.deepEqual(fetchCalls, ['cur@example.com'], 'active 模式下后台刷新只能请求当前活跃号');

  // 2) manual 模式：后台周期 0 请求，无定时器；手动全池刷新照常拉取全部 3 个号且带错峰延迟
  fetchCalls.length = 0;
  recordedDelays.length = 0;
  currentScope = 'manual';
  orchestrator.applyRefreshInterval();
  await orchestrator.refreshBackgroundCycle();
  assert.equal(fetchCalls.length, 0, 'manual 模式下后台周期不得发起任何请求');

  const okCount = await orchestrator.refreshAllInteractive();
  assert.equal(okCount, 3, 'manual 模式下手动全池刷新仍应刷齐 3 个号');
  assert.equal(fetchCalls.length, 3);
  assert.ok(recordedDelays.length >= 2 && recordedDelays.every((d) => d >= 500), '批量全池刷新必须包含 >=500ms 的账号间错峰延迟: ' + JSON.stringify(recordedDelays));

  // 3) 挂机失焦休眠（>30 分钟跳过后台刷新，重新聚焦且缓存过期时自动补刷）
  fetchCalls.length = 0;
  currentScope = 'active';
  windowFocused = false;
  for (const fn of windowListeners) fn({ focused: false });
  // 模拟已失焦 31 分钟且当前号缓存已过期
  orchestrator._setUnfocusedSinceForTest(Date.now() - 31 * 60 * 1000);
  storeMap.set('currentEmail', 'standby1@example.com');
  // 把 standby1 缓存时间拨回 20 分钟前（已超 15 分钟阈值）
  orchestrator._usageCache.set('standby1@example.com', {
    minRemainingPercent: 0,
    updatedAt: Date.now() - 20 * 60 * 1000,
    models: [{ label: 'Claude 5h', modelId: 'claude:5h', remainingPercent: 0, resetTime: new Date(Date.now() - 60_000).toISOString() }],
  });

  // 在未刷新前，通过 getUsage 读取已过 resetTime 的 standby1，应直接获得 100% 本地回血推算，且 QuickPick 排序提优
  const effectiveBeforeFetch = orchestrator.getUsage('standby1@example.com');
  assert.equal(effectiveBeforeFetch.minRemainingPercent, 100, 'getUsage 应返回本地 resetTime 回血折算后的 100%');
  const sorted = statusBarMod.sortPoolForQuickPick(
    accountStore.getAll(),
    (em) => orchestrator.getUsage(em),
    'cur@example.com',
  );
  assert.equal(sorted[1].email, 'standby1@example.com', '已过 resetTime 的满血备用号应在 QuickPick 中排在 80% 号之前');

  await orchestrator.refreshBackgroundCycle();
  assert.equal(fetchCalls.length, 0, '窗口失焦超过 30 分钟时后台轮询必须休眠跳过');

  // 模拟用户回到窗口聚焦（注入 0ms 唤醒延迟测试即时触发）
  windowFocused = true;
  for (const fn of windowListeners) fn({ focused: true });
  await new Promise((r) => setTimeout(r, 30));
  assert.deepEqual(fetchCalls, ['standby1@example.com'], '窗口重新聚焦后应自动补刷已过期的当前账号');

  orchestrator.dispose();
  accountStore.dispose();
  console.log('POLLING_SANDBOX_OK');
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
`;
fs.writeFileSync(runnerPath, runnerCode, 'utf8');

try {
  const out = execFileSync(process.execPath, [runnerPath], {
    env: { ...process.env, KITE_SHARED_DIR: path.join(sandboxDir, 'shared'), KITE_MASTER_KEY_FILE: '' },
    encoding: 'utf8',
  });
  gate('Q3 & Q4 隔离沙箱实测 active/manual 范围、错峰抖动、失焦休眠唤醒与本地回血排序', out.includes('POLLING_SANDBOX_OK'), out.trim());
} catch (err) {
  const detail = err?.stderr ? String(err.stderr).trim() : (err instanceof Error ? err.message : String(err));
  gate('Q3 & Q4 隔离沙箱实测 active/manual 范围、错峰抖动、失焦休眠唤醒与本地回血排序', false, detail.split(/\r?\n/)[0]);
} finally {
  fs.rmSync(sandboxDir, { recursive: true, force: true });
}

console.log(`\n配额轮询降敏门控结果: ${passed} 通过, ${failed} 失败`);
process.exit(failed > 0 ? 1 : 0);
