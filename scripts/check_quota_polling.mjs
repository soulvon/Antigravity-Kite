#!/usr/bin/env node
/**
 * 配额刷新与本机 LS 读取门控（devloop 红线 4：先写能在旧代码上失败的检查）
 *
 * 校验项：
 *   Q1 精简状态检测路径，移除独立推理请求探测入口
 *   Q2 精简后台刷新模式（quotaRefreshScope 仅保留 active / manual，历史 all 自动归一化为 active）
 *   Q3 隔离沙箱实测本机官方 LS RPC 配额读取与账号一致性校验（127.0.0.1 直连，邮箱不匹配返回 null）
 *   Q4 隔离沙箱实测 QuotaOrchestrator：
 *      - active 默认模式后台仅通过本机官方 LS 读取当前活跃账号；本机 LS 暂不可用时跳过本轮
 *      - manual 模式停用后台定时与自动首刷
 *      - 手动刷新全部时，当前号优先走本机 LS、其余可用号串行错峰刷新
 *      - 窗口失焦满 30 分钟自动挂机休眠，重新聚焦自动补刷过期目标
 *   Q5 本地 resetTime 到期回血折算（resolveEffectiveUsage + getUsage 同源输出，不污染底层快照）
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

console.log('=== 配额刷新与本机 LS 读取门控 ===\n');

const pkg = JSON.parse(read('package.json'));
const usageSvcSrc = read('src/usageService.ts');
const orchestratorSrc = read('src/quotaOrchestrator.ts');
const sidebarHtml = read('resources/webview/sidebar.html');
const sidebarJs = read('resources/webview/sidebar.js');
const sidebarProvSrc = read('src/sidebarProvider.ts');
const statusBarSrc = read('src/statusBar.ts');
const extSrc = read('src/extension.ts');

// ── Q1 精简状态检测与命令入口 ──
const srcFiles = fs.readdirSync(path.join(root, 'src')).filter((f) => f.endsWith('.ts'));
const removedSymbols = ['probeGenerateContent', 'kite-health-', 'v1internal:generateContent', 'checkAccountHealth', 'probeAllHealth', 'probeOneHealth'];
const residualHits = [];
for (const f of srcFiles) {
  const txt = read(path.join('src', f));
  for (const tok of removedSymbols) {
    if (txt.includes(tok)) residualHits.push(`${f}:${tok}`);
  }
}
gate(
  'Q1.1 src/ 全目录已清理废弃的独立状态探测逻辑',
  residualHits.length === 0,
  residualHits.join(', '),
);

const cmds = (pkg.contributes?.commands || []).map((c) => c.command);
const noHealthRecheckEntry = !cmds.includes('antigravityKite.healthRecheck')
  && !extSrc.includes('antigravityKite.healthRecheck')
  && !statusBarSrc.includes('recheckHealth')
  && !sidebarProvSrc.includes("case 'checkHealth'")
  && !sidebarJs.includes("type: 'checkHealth'");
gate(
  'Q1.2 命令、底栏 QuickPick 与侧栏 Webview 均已移除废弃状态复检入口',
  noHealthRecheckEntry,
);

const noLegacyVersionSplit = !usageSvcSrc.includes("'1.20.5'") && !usageSvcSrc.includes('"1.20.5"');
gate('Q1.3 usageService 移除过时 1.20.5 版本号硬编码', noLegacyVersionSplit);

// ── Q2 彻底移除后台全池轮询（仅保留 active / manual） ──
const scopeProp = pkg.contributes?.configuration?.properties?.['antigravityKite.quotaRefreshScope'];
gate(
  'Q2.1 package.json quotaRefreshScope 仅声明 active / manual（默认 active，移除 all）',
  Boolean(scopeProp)
    && scopeProp.default === 'active'
    && JSON.stringify(scopeProp.enum) === JSON.stringify(['active', 'manual']),
  JSON.stringify(scopeProp || null),
);

const noBgAllPolling = !orchestratorSrc.includes('refreshAllBackground')
  && !sidebarHtml.includes('value="all"')
  && sidebarHtml.includes('id="setQuotaScope"')
  && sidebarJs.includes('setQuotaScope')
  && /setQuotaRefresh[\s\S]{0,200}disabled/.test(sidebarJs)
  && sidebarProvSrc.includes('quotaRefreshScope')
  && extSrc.includes('antigravityKite.quotaRefreshScope');
gate('Q2.2 移除 refreshAllBackground 与 UI all 选项，侧栏/宿主设置闭环完整', noBgAllPolling);

const noImportAutoStorm = !/importFrom(?:CockpitTools|AntigravityManager|JsonFile)[\s\S]{0,450}_refreshAllUsage/.test(sidebarProvSrc);
gate('Q2.3 批量导入账号后不再自动触发全池云端刷新风暴', noImportAutoStorm);

// ── Q3, Q4 & Q5 隔离沙箱运行态验证 ──
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
assert.equal(typeof usageService.fetchUsageFromLocalLs, 'function', '缺少 fetchUsageFromLocalLs 导出');

// 校验 normalizeRefreshScope：历史 all 与非法值均收口回 active
assert.equal(qoMod.normalizeRefreshScope('active'), 'active');
assert.equal(qoMod.normalizeRefreshScope('manual'), 'manual');
assert.equal(qoMod.normalizeRefreshScope('all'), 'active', '历史 all 必须归一化为 active');
assert.equal(qoMod.normalizeRefreshScope('invalid'), 'active');
assert.equal(qoMod.normalizeRefreshScope(undefined), 'active');

// 校验 resolveEffectiveUsage：已过 resetTime 窗口本地回血至 100%，不篡改原对象
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
assert.equal(effPart.models[0].remainingPercent, 100);
assert.equal(effPart.models[1].remainingPercent, 65);
assert.equal(effPart.minRemainingPercent, 65);
assert.equal(rawSnap.models[0].remainingPercent, 0);

(async () => {
  // Q3: fetchUsageFromLocalLs 实测（邮箱匹配返回真数据，邮箱不匹配 Fail-Closed 返回 null）
  const mockHub = { fileName: 'hub_32794.json', pid: process.pid, httpPort: 32794, csrfToken: 'tok', lsVersion: '2.35.2', mtimeMs: Date.now() };
  const rpcLog = [];
  const fakeDeps = {
    discoverHubs: () => [mockHub],
    rpcPost: async (_hub, method) => {
      rpcLog.push(method);
      if (method === 'GetUserStatus') {
        return {
          userStatus: {
            email: 'cur@example.com',
            userTier: {
              id: 'g1-ultra-tier',
              name: 'Google AI Ultra',
              availableCredits: [{ creditType: 'GOOGLE_ONE_AI', creditAmount: '120' }],
            },
          },
        };
      }
      if (method === 'RetrieveUserQuotaSummary') {
        return {
          response: {
            groups: [
              {
                displayName: 'Gemini Models',
                buckets: [
                  { bucketId: 'gemini-5h', remainingFraction: 0.92, resetTime: '2026-11-27T18:00:00Z' },
                  { bucketId: 'gemini-weekly', remainingFraction: 0.85, resetTime: '2026-12-03T14:00:00Z' },
                ],
              },
              {
                displayName: 'Claude and GPT models',
                buckets: [
                  { bucketId: '3p-5h', remainingFraction: 1 },
                ],
              },
            ],
          },
        };
      }
      throw new Error('Unexpected RPC: ' + method);
    },
  };

  const localHit = await usageService.fetchUsageFromLocalLs('cur@example.com', fakeDeps);
  assert.ok(localHit, '本地 LS 匹配当前账号时应返回有效配额快照');
  assert.equal(localHit.tierId, 'Google AI Ultra');
  assert.equal(localHit.availableAICredits, 120);
  assert.equal(localHit.minRemainingPercent, 85);
  assert.equal(localHit.models.length, 3);
  assert.deepEqual(rpcLog, ['GetUserStatus', 'RetrieveUserQuotaSummary']);

  const localMiss = await usageService.fetchUsageFromLocalLs('standby1@example.com', fakeDeps);
  assert.equal(localMiss, null, '本地 LS 登录邮箱与目标不一致时必须 Fail-Closed 返回 null 防串号');

  // Q4: QuotaOrchestrator 全链路验证
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
    { email: 'cur@example.com', accessToken: 'ya29.cur', refreshToken: '1//cur', projectId: 'p-cur' },
    { email: 'standby1@example.com', accessToken: 'ya29.s1', refreshToken: '1//s1', projectId: 'p-s1' },
    { email: 'banned@example.com', accessToken: 'ya29.ban', refreshToken: '1//ban', health: { status: 'banned', checkedAt: new Date().toISOString() } },
  ], { overwriteTokens: true });

  const cloudCalls = [];
  const localLsCalls = [];
  let localLsAvailable = true;

  usageService.fetchUsage = async (acc) => {
    cloudCalls.push(acc.email);
    return {
      minRemainingPercent: 80,
      updatedAt: Date.now(),
      tierId: 'PRO',
      models: [{ label: 'Claude 5h', modelId: 'claude:5h', remainingPercent: 80 }],
    };
  };
  usageService.fetchUsageFromLocalLs = async (email) => {
    localLsCalls.push(email);
    if (!localLsAvailable || email !== storeMap.get('currentEmail')) return null;
    return {
      minRemainingPercent: 95,
      updatedAt: Date.now(),
      tierId: 'Google AI Ultra',
      models: [{ label: 'Gemini 5h', modelId: 'gemini:5h', remainingPercent: 95 }],
    };
  };

  const mockTracker = { recordRefresh() {}, recordUsage() {} };
  const recordedDelays = [];
  const orchestrator = new qoMod.QuotaOrchestrator(mockCtx, mockTracker, {}, {
    sleepFn: async (ms) => { recordedDelays.push(ms); },
  });

  // 1) active 模式后台周期：只走本地 LS 读当前号，云端 OAuth 0 请求
  currentScope = 'active';
  await orchestrator.refreshBackgroundCycle();
  assert.deepEqual(localLsCalls, ['cur@example.com'], 'active 后台周期必须走本地 LS 读当前号');
  assert.equal(cloudCalls.length, 0, 'active 后台周期命中本地 LS 时外网云端必须零请求');

  // 2) 本地 LS 暂不可用时，active 后台周期必须安全跳过，严禁偷偷回退外网直连
  localLsCalls.length = 0;
  cloudCalls.length = 0;
  localLsAvailable = false;
  await orchestrator.refreshBackgroundCycle();
  assert.deepEqual(localLsCalls, ['cur@example.com']);
  assert.equal(cloudCalls.length, 0, '本地 LS 不可用时后台自动周期不得回退外网直连 cloudcode-pa');

  // 3) manual 模式：后台零请求；手动全池刷新时当前号走本地 LS、备用号串行错峰、自动跳过 banned 号
  localLsCalls.length = 0;
  cloudCalls.length = 0;
  recordedDelays.length = 0;
  localLsAvailable = true;
  currentScope = 'manual';
  orchestrator.applyRefreshInterval();
  await orchestrator.refreshBackgroundCycle();
  assert.equal(localLsCalls.length, 0);
  assert.equal(cloudCalls.length, 0);

  const okCount = await orchestrator.refreshAllInteractive();
  assert.equal(okCount, 2, '手动全池刷新应跳过 banned 号，仅刷新 2 个有效号');
  assert.deepEqual(localLsCalls, ['cur@example.com'], '当前号优先走本地 LS');
  assert.deepEqual(cloudCalls, ['standby1@example.com'], '仅非活跃非封禁备用号走云端，且跳过 banned@example.com');
  assert.ok(recordedDelays.length >= 1 && recordedDelays.every((d) => d >= 1000), '批量刷新备用号必须串行且带 >=1000ms 错峰延迟: ' + JSON.stringify(recordedDelays));

  // 4) 窗口失焦 >30 分钟休眠，聚焦自动补刷（走本地 LS）
  localLsCalls.length = 0;
  cloudCalls.length = 0;
  currentScope = 'active';
  windowFocused = false;
  for (const fn of windowListeners) fn({ focused: false });
  orchestrator._setUnfocusedSinceForTest(Date.now() - 31 * 60 * 1000);
  storeMap.set('currentEmail', 'standby1@example.com');
  orchestrator._usageCache.set('standby1@example.com', {
    minRemainingPercent: 0,
    updatedAt: Date.now() - 20 * 60 * 1000,
    models: [{ label: 'Claude 5h', modelId: 'claude:5h', remainingPercent: 0, resetTime: new Date(Date.now() - 60_000).toISOString() }],
  });

  const effectiveBeforeFetch = orchestrator.getUsage('standby1@example.com');
  assert.equal(effectiveBeforeFetch.minRemainingPercent, 100);
  const sorted = statusBarMod.sortPoolForQuickPick(
    accountStore.getAll(),
    (em) => orchestrator.getUsage(em),
    'cur@example.com',
  );
  assert.equal(sorted[1].email, 'standby1@example.com');

  await orchestrator.refreshBackgroundCycle();
  assert.equal(localLsCalls.length, 0, '失焦超过 30 分钟时后台轮询必须休眠跳过');

  windowFocused = true;
  for (const fn of windowListeners) fn({ focused: true });
  await new Promise((r) => setTimeout(r, 30));
  assert.deepEqual(localLsCalls, ['standby1@example.com'], '重新聚焦后应通过本地 LS 补刷过期当前号');
  assert.equal(cloudCalls.length, 0, '聚焦补刷同样零外网直连');

  // 5) 切号后延迟同步仅走本地 LS（首次未就绪自动重试一次，全程零外网）
  localLsCalls.length = 0;
  cloudCalls.length = 0;
  localLsAvailable = false;
  orchestrator.schedulePostSwitchRefresh('standby1@example.com', 10, 15);
  await new Promise((r) => setTimeout(r, 20));
  localLsAvailable = true;
  await new Promise((r) => setTimeout(r, 30));
  assert.deepEqual(localLsCalls, ['standby1@example.com', 'standby1@example.com'], '切号延迟同步应重试本地 LS');
  assert.equal(cloudCalls.length, 0, '切号延迟同步全程不发外网直连');

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
  gate('Q3-Q5 隔离沙箱实测本地 LS 零外网读配额、防串号、跳过 banned 与失焦休眠唤醒', out.includes('POLLING_SANDBOX_OK'), out.trim());
} catch (err) {
  const detail = err?.stderr ? String(err.stderr).trim() : (err instanceof Error ? err.message : String(err));
  gate('Q3-Q5 隔离沙箱实测本地 LS 零外网读配额、防串号、跳过 banned 与失焦休眠唤醒', false, detail.split(/\r?\n/)[0]);
} finally {
  fs.rmSync(sandboxDir, { recursive: true, force: true });
}

console.log(`\n配额刷新与本机 LS 读取门控结果: ${passed} 通过, ${failed} 失败`);
process.exit(failed > 0 ? 1 : 0);
