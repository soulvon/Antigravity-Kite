#!/usr/bin/env node
/**
 * 底栏实时上下文与 Token 速度门控测试（隔离沙箱 + 真机读数校验）
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');
const require2 = createRequire(import.meta.url);

// 注入轻量 vscode stub，确保可脱离 IDE 宿主独立运行纯逻辑与格式测试
const stubDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kite-ctx-stub-'));
fs.mkdirSync(path.join(stubDir, 'vscode'), { recursive: true });
fs.writeFileSync(
  path.join(stubDir, 'vscode', 'package.json'),
  JSON.stringify({ name: 'vscode', main: 'index.js' }),
);
fs.writeFileSync(
  path.join(stubDir, 'vscode', 'index.js'),
  `
const noop = () => {};
const disp = { dispose: noop };
const chain = new Proxy(function () {}, {
  get: (_t, prop) => {
    if (prop === 'then' || prop === Symbol.toPrimitive) return undefined;
    if (prop === 'StatusBarAlignment') return { Left: 1, Right: 2 };
    if (prop === 'QuickPickItemKind') return { Separator: -1, Default: 0 };
    if (prop === 'EventEmitter') return class { event = () => disp; fire = noop; dispose = noop; };
    if (prop === 'MarkdownString') return class { constructor() { this.text = ''; } appendMarkdown(s) { this.text += s; } };
    if (prop === 'window') return {
      state: { focused: true },
      onDidChangeWindowState: () => disp,
      createStatusBarItem: () => ({ show: noop, hide: noop, dispose: noop }),
    };
    if (prop === 'workspace') return {
      workspaceFolders: [],
      onDidChangeWorkspaceFolders: () => disp,
      getConfiguration: () => ({ get: (_k, d) => d }),
    };
    return chain;
  },
  apply: () => chain,
  construct: () => chain,
});
module.exports = chain;
`,
);

process.env.NODE_PATH = [stubDir, process.env.NODE_PATH].filter(Boolean).join(path.delimiter);
const Module = require2('module');
Module._initPaths();

let passed = 0;
let failed = 0;
function check(name, fn) {
  try {
    fn();
    passed++;
    console.log(`  PASS  ${name}`);
  } catch (err) {
    failed++;
    console.error(`  FAIL  ${name} <- ${err instanceof Error ? err.message : String(err)}`);
  }
}

console.log('=== 底栏实时上下文与 Token 速度门控 ===\n');

const meterMod = require2(path.join(root, 'out', 'liveContextMeter.js'));
const barMod = require2(path.join(root, 'out', 'liveContextStatusBar.js'));

// ── 1. discoverAliveHubDaemons ──
const tmpDaemon = fs.mkdtempSync(path.join(os.tmpdir(), 'kite-daemon-test-'));
try {
  fs.writeFileSync(path.join(tmpDaemon, 'hub_1001.json'), JSON.stringify({ pid: 11111, httpPort: 1001, csrfToken: 'tok-dead' }));
  fs.writeFileSync(path.join(tmpDaemon, 'hub_1002.json'), '{broken-json');
  fs.writeFileSync(path.join(tmpDaemon, 'hub_1003.json'), JSON.stringify({ pid: 22222, httpPort: 99999, csrfToken: 'bad-port' }));
  fs.writeFileSync(path.join(tmpDaemon, 'hub_1004.json'), JSON.stringify({ pid: 33333, httpPort: 1004, csrfToken: '' }));
  fs.writeFileSync(path.join(tmpDaemon, 'hub_1005.json'), JSON.stringify({ pid: 44444, httpPort: 1005, csrfToken: 'tok-alive-1', lsVersion: '2.33.0' }));
  fs.writeFileSync(path.join(tmpDaemon, 'other.json'), JSON.stringify({ pid: 44444, httpPort: 1006, csrfToken: 'ignored' }));

  check('L1.1 discoverAliveHubDaemons 严格过滤死 PID / 损坏 JSON / 非法端口 / 空 token', () => {
    const alive = meterMod.discoverAliveHubDaemons(tmpDaemon, (pid) => pid === 44444);
    assert.equal(alive.length, 1);
    assert.equal(alive[0].httpPort, 1005);
    assert.equal(alive[0].csrfToken, 'tok-alive-1');
  });

  check('L1.2 discoverAliveHubDaemons 目录不存在返回空数组不抛错', () => {
    const missing = meterMod.discoverAliveHubDaemons(path.join(tmpDaemon, 'nonexistent'), () => true);
    assert.deepEqual(missing, []);
  });
} finally {
  fs.rmSync(tmpDaemon, { recursive: true, force: true });
}

// ── 2. pickBestTrajectory ──
check('L2 pickBestTrajectory 工作区精确匹配（含空格编码与盘符大小写）> 运行状态 > 最新修改', () => {
  const hubA = { fileName: 'hub_1.json', pid: 1, httpPort: 1, csrfToken: 'a', mtimeMs: 100 };
  const hubB = { fileName: 'hub_2.json', pid: 2, httpPort: 2, csrfToken: 'b', mtimeMs: 200 };
  const entries = [
    {
      hub: hubB,
      summaries: {
        otherRunning: {
          summary: 'Other project running',
          status: 'CASCADE_RUN_STATUS_RUNNING',
          lastModifiedTime: '2026-11-19T02:50:00Z',
          workspaces: [{ workspaceFolderAbsoluteUri: 'file:///D:/work/other' }],
        },
      },
    },
    {
      hub: hubA,
      summaries: {
        kiteIdleOld: {
          summary: 'Kite old',
          status: 'CASCADE_RUN_STATUS_IDLE',
          lastModifiedTime: '2026-11-19T02:00:00Z',
          workspaces: [{ workspaceFolderAbsoluteUri: 'file:///e:/project/demo%20app' }],
        },
        kiteIdleNew: {
          summary: 'Kite latest',
          status: 'CASCADE_RUN_STATUS_IDLE',
          lastModifiedTime: '2026-11-19T02:40:00Z',
          workspaces: [{ workspaceFolderAbsoluteUri: 'file:///e:/project/demo%20app' }],
        },
      },
    },
  ];
  const best = meterMod.pickBestTrajectory(entries, ['file:///E%3A/project/demo%20app']);
  assert.ok(best);
  assert.equal(best.cascadeId, 'kiteIdleNew');
  assert.equal(best.workspaceMatched, true);
});

// ── 3. extractLiveContextSnapshot ──
check('L3.1 extractLiveContextSnapshot 正确解析真实用量、TTFT、流式速度与分组构成', () => {
  const metaList = [
    {
      chatModel: {
        modelDisplayName: 'Gemini 4 Hydrogen (XHigh)',
        timeToFirstToken: '5.528167700s',
        streamingDuration: '4.813957700s',
        usage: {
          inputTokens: '5998',
          cacheReadTokens: '354891',
          outputTokens: '1297',
          thinkingOutputTokens: '552',
          responseOutputTokens: '745',
        },
        chatStartMetadata: {
          contextWindowMetadata: {
            estimatedTokensUsed: 346897,
            maxContextTokens: 512000,
            tokenBreakdown: {
              groups: [{ groupLabel: 'History', tokenCount: 250000 }, { groupLabel: 'Tools', tokenCount: 15000 }],
            },
          },
        },
      },
    },
  ];
  const snap = meterMod.extractLiveContextSnapshot(metaList, {
    cascadeId: '848c23f5',
    summary: { summary: 'Test conv' },
    workspaceMatched: true,
    isRunning: false,
  });
  assert.ok(snap);
  assert.equal(snap.usedTokens, 5998 + 354891 + 1297);
  assert.equal(snap.budgetTokens, 512000);
  assert.equal(snap.isEstimated, false);
  assert.equal(snap.ttftSec, 5.53);
  assert.equal(snap.streamingSec, 4.81);
  assert.equal(snap.streamingTps, 269.4);
  assert.equal(snap.tps, 125.4);
  assert.equal(snap.isPreviousSpeed, false);
  assert.equal(snap.breakdownGroups.length, 2);
});

check('L3.2 extractLiveContextSnapshot 生成中未落账时使用预估上下文并保留上轮速度标注 isPreviousSpeed', () => {
  const prev = {
    cascadeId: '848c23f5',
    title: 'Test conv',
    modelName: 'Gemini 4 Hydrogen (XHigh)',
    isRunning: false,
    workspaceMatched: true,
    usedTokens: 362186,
    budgetTokens: 512000,
    percent: 70.7,
    isEstimated: false,
    estimatedTokens: 346897,
    inputTokens: 5998,
    cacheReadTokens: 354891,
    outputTokens: 1297,
    thinkingTokens: 552,
    responseTokens: 745,
    ttftSec: 5.53,
    streamingSec: 4.81,
    durationSec: 10.34,
    streamingTps: 269.4,
    tps: 125.4,
    isPreviousSpeed: false,
    breakdownGroups: [],
    updatedAt: 1,
  };
  const runningMeta = [
    {
      chatModel: {
        modelDisplayName: 'Gemini 4 Hydrogen (XHigh)',
        chatStartMetadata: {
          contextWindowMetadata: {
            estimatedTokensUsed: 380000,
            maxContextTokens: 512000,
          },
        },
      },
    },
  ];
  const snap = meterMod.extractLiveContextSnapshot(runningMeta, {
    cascadeId: '848c23f5',
    summary: { summary: 'Test conv' },
    workspaceMatched: true,
    isRunning: true,
  }, prev);
  assert.ok(snap);
  assert.equal(snap.isRunning, true);
  assert.equal(snap.usedTokens, 380000);
  assert.equal(snap.isEstimated, true);
  assert.equal(snap.streamingTps, 269.4);
  assert.equal(snap.isPreviousSpeed, true);
});

// ── 4. 底栏格式化与开关门控 ──
check('L4 formatCompactTokens 与 formatLiveContextBarText 分开关及高占比提醒正确', () => {
  assert.equal(barMod.formatCompactTokens(362186), '362K');
  assert.equal(barMod.formatCompactTokens(1048576), '1.05M');
  assert.equal(barMod.formatCompactTokens(1250), '1.3K');

  const sample = {
    cascadeId: 'c1',
    title: 'Demo',
    modelName: 'Gemini 4',
    isRunning: false,
    workspaceMatched: true,
    usedTokens: 362186,
    budgetTokens: 512000,
    percent: 70.7,
    isEstimated: false,
    estimatedTokens: null,
    inputTokens: 5998,
    cacheReadTokens: 354891,
    outputTokens: 1297,
    thinkingTokens: 552,
    responseTokens: 745,
    ttftSec: 5.53,
    streamingSec: 4.81,
    durationSec: 10.34,
    streamingTps: 269.4,
    tps: 125.4,
    isPreviousSpeed: false,
    breakdownGroups: [],
    updatedAt: Date.now(),
  };

  assert.equal(
    barMod.formatLiveContextBarText(sample, { showContext: true, showSpeed: true }),
    '$(pulse) 362K/512K (71%) · ⚡ 269.4 tok/s',
  );
  assert.equal(
    barMod.formatLiveContextBarText({ ...sample, isRunning: true, isEstimated: true }, { showContext: true, showSpeed: true }),
    '$(sync~spin) ~362K/512K (71%) · ⚡ 269.4 tok/s',
  );
  assert.equal(
    barMod.formatLiveContextBarText({ ...sample, percent: 92 }, { showContext: true, showSpeed: false }),
    '🟠 362K/512K (92%)',
  );
  assert.equal(
    barMod.formatLiveContextBarText(sample, { showContext: false, showSpeed: true }),
    '⚡ 269.4 tok/s',
  );
  assert.equal(
    barMod.formatLiveContextBarText(sample, { showContext: false, showSpeed: false }),
    null,
  );
  assert.equal(
    barMod.formatLiveContextBarText(null, { showContext: true, showSpeed: true }),
    null,
  );
});

check('L3.3 extractLiveContextSnapshot 计算距自动压缩余量、连续轮次思考/输出累计与活跃子 Agent 数', () => {
  const metaList = [
    {
      chatModel: {
        modelDisplayName: 'Claude Opus 4.6 (Thinking)',
        timeToFirstToken: '1.2s',
        streamingDuration: '2.8s',
        usage: {
          inputTokens: '4000',
          cacheReadTokens: '200000',
          outputTokens: '900',
          thinkingOutputTokens: '400',
          responseOutputTokens: '500',
        },
        chatStartMetadata: { contextWindowMetadata: { maxContextTokens: 200000 } },
      },
    },
    {
      chatModel: {
        modelDisplayName: 'Claude Opus 4.6 (Thinking)',
        timeToFirstToken: '0.9s',
        streamingDuration: '1.6s',
        usage: {
          inputTokens: '4500',
          cacheReadTokens: '140000',
          outputTokens: '600',
          thinkingOutputTokens: '250',
          responseOutputTokens: '350',
        },
        chatStartMetadata: { contextWindowMetadata: { maxContextTokens: 200000 } },
      },
    },
  ];
  const snap = meterMod.extractLiveContextSnapshot(
    metaList,
    {
      cascadeId: 'parent-1',
      summary: { summary: 'Parent Conv' },
      workspaceMatched: true,
      isRunning: true,
      activeSubagents: 2,
      totalSubagents: 3,
    },
  );
  assert.ok(snap);
  // used = 4500 + 140000 + 600 = 145100; 85% compact watermark = 170000; remaining = 24900
  assert.equal(snap.remainingToCompactTokens, 24900);
  assert.equal(snap.activeSubagents, 2);
  assert.equal(snap.totalSubagents, 3);
  assert.equal(snap.turnStepCount, 2);
  assert.equal(snap.turnThinkingTokens, 650);
  assert.equal(snap.turnResponseTokens, 850);
});

check('L4.2 formatLiveContextBarText 在 pulseMode 下的自适应灵动呈现', () => {
  const base = {
    cascadeId: 'c1',
    title: 'Demo',
    modelName: 'Gemini 4',
    isRunning: false,
    workspaceMatched: true,
    usedTokens: 120000,
    budgetTokens: 512000,
    percent: 23.4,
    isEstimated: false,
    estimatedTokens: null,
    inputTokens: 3000,
    cacheReadTokens: 116500,
    outputTokens: 500,
    thinkingTokens: 200,
    responseTokens: 300,
    ttftSec: 1.5,
    streamingSec: 2.0,
    durationSec: 3.5,
    streamingTps: 250.0,
    tps: 142.9,
    isPreviousSpeed: false,
    breakdownGroups: [],
    remainingToCompactTokens: 315200,
    turnStepCount: 1,
    turnThinkingTokens: 200,
    turnResponseTokens: 300,
    turnDurationSec: 3.5,
    activeSubagents: 0,
    totalSubagents: 0,
    updatedAt: Date.now(),
  };

  assert.equal(
    barMod.formatLiveContextBarText(base, { showContext: true, showSpeed: true, pulseMode: true }),
    '$(pulse) 23%',
  );
  assert.equal(
    barMod.formatLiveContextBarText({ ...base, percent: 84, usedTokens: 430080 }, { showContext: true, showSpeed: true, pulseMode: true }),
    '🟡 430K/512K (84%)',
  );
  assert.equal(
    barMod.formatLiveContextBarText({ ...base, isRunning: true, percent: 71, activeSubagents: 2 }, { showContext: true, showSpeed: true, pulseMode: true }),
    '$(sync~spin) 71% · ⚡ 250 tok/s · +2 sub',
  );
});

// ── 5. 全链路接线检查 ──
check('L5 package / sidebar / extension / statusBar 接线全部闭合', () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
  const props = pkg.contributes.configuration.properties;
  assert.ok('antigravityKite.statusBar.showLiveContext' in props);
  assert.ok('antigravityKite.statusBar.showLiveSpeed' in props);

  const sidebarHtml = fs.readFileSync(path.join(root, 'resources', 'webview', 'sidebar.html'), 'utf8');
  assert.ok(sidebarHtml.includes('id="setStatusLiveContext"'));
  assert.ok(sidebarHtml.includes('id="setStatusLiveSpeed"'));

  const sidebarJs = fs.readFileSync(path.join(root, 'resources', 'webview', 'sidebar.js'), 'utf8');
  assert.ok(sidebarJs.includes('statusBarLiveContext'));
  assert.ok(sidebarJs.includes('statusBarLiveSpeed'));

  const extSrc = fs.readFileSync(path.join(root, 'src', 'extension.ts'), 'utf8');
  assert.ok(extSrc.includes('new LiveContextMeter('));
  assert.ok(extSrc.includes('liveContextMeter.onDidChange'));

  const sbSrc = fs.readFileSync(path.join(root, 'src', 'statusBar.ts'), 'utf8');
  assert.ok(sbSrc.includes('LIVE_CONTEXT_CMD'));
  assert.ok(sbSrc.includes('updateLiveContext'));
});

fs.rmSync(stubDir, { recursive: true, force: true });
console.log(`\n底栏实时上下文门控结果: ${passed} 通过, ${failed} 失败`);
process.exit(failed > 0 ? 1 : 0);

