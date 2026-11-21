#!/usr/bin/env node
/**
 * 统计中心与 TokenLedger 门控测试（隔离沙箱 + DOM ID 全闭合 + 运行时冒烟）
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const require2 = createRequire(import.meta.url);

// 注入最小 vscode stub，确保脱离 IDE 宿主独立实测
const stubDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kite-stats-stub-'));
fs.mkdirSync(path.join(stubDir, 'vscode'), { recursive: true });
fs.writeFileSync(path.join(stubDir, 'vscode', 'package.json'), JSON.stringify({ name: 'vscode', main: 'index.js' }));
fs.writeFileSync(
  path.join(stubDir, 'vscode', 'index.js'),
  `module.exports = { env: { language: 'zh-CN' }, workspace: { getConfiguration: () => ({ get: (_k, d) => d }) } };`,
);
process.env.NODE_PATH = [stubDir, process.env.NODE_PATH].filter(Boolean).join(path.delimiter);
const Module = require2('module');
Module._initPaths();

let passed = 0;
let failed = 0;
async function check(name, fn) {
  try {
    await fn();
    passed++;
    console.log(`  PASS  ${name}`);
  } catch (err) {
    failed++;
    console.error(`  FAIL  ${name} <- ${err instanceof Error ? err.message : String(err)}`);
  }
}

console.log('=== 统计中心与 TokenLedger 门控 ===\n');

const { TokenLedger, formatLocalDateKey } = require2(path.join(root, 'out', 'tokenLedger.js'));

const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'kite-ledger-test-'));
try {
  const desktopBrain = path.join(sandbox, 'desktop-brain');
  const cliBrain = path.join(sandbox, 'cli-brain');
  const cacheFile = path.join(sandbox, 'token-ledger-v1.json');

  const conv1Dir = path.join(desktopBrain, 'conv-1', '.system_generated', 'logs');
  fs.mkdirSync(conv1Dir, { recursive: true });
  const now = new Date();
  const todayKey = formatLocalDateKey(now);
  const yest = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1, 14, 0, 0);
  const yestKey = formatLocalDateKey(yest);

  const lines1 = [
    JSON.stringify({ step_index: 1, type: 'USER_INPUT', created_at: now.toISOString(), content: 'hi' }),
    // 同 step_index=2 两次写入，后者应覆盖前者不重复累加
    JSON.stringify({ step_index: 2, created_at: now.toISOString(), model: 'gemini-4-argon-high', input_tokens: 1000, cache_read_tokens: 4000, output_tokens: 200 }),
    JSON.stringify({ step_index: 2, created_at: now.toISOString(), model: 'gemini-4-argon-high', input_tokens: 1200, cache_read_tokens: 4800, output_tokens: 300 }),
    JSON.stringify({ step_index: 5, created_at: yest.toISOString(), model: 'claude-sonnet-4-6', input_tokens: 2000, cache_read_tokens: 8000, output_tokens: 500 }),
    '{corrupt-json-line-with-input_tokens}',
  ];
  fs.writeFileSync(path.join(conv1Dir, 'transcript.jsonl'), lines1.join('\n'), 'utf8');

  const cliConvDir = path.join(cliBrain, 'cli-1');
  fs.mkdirSync(cliConvDir, { recursive: true });
  fs.writeFileSync(
    path.join(cliConvDir, 'transcript.jsonl'),
    JSON.stringify({ step_index: 1, created_at: now.toISOString(), model: 'gemini-4-argon-high', input_tokens: 500, cache_read_tokens: 500, output_tokens: 100 }) + '\n',
    'utf8',
  );

  await check('S1 TokenLedger 隔离沙箱解析、step_index 去重、双源合并与 52 周热力图结构正确', async () => {
    const ledger = new TokenLedger({ desktopBrainDir: desktopBrain, cliBrainDir: cliBrain, cacheFilePath: cacheFile });
    ledger.recordSpeedSample({
      cascadeId: 'c1',
      title: 'T',
      modelName: 'gemini-4-argon-high',
      isRunning: false,
      workspaceMatched: true,
      usedTokens: 6300,
      budgetTokens: 512000,
      percent: 1.2,
      isEstimated: false,
      estimatedTokens: null,
      inputTokens: 1200,
      cacheReadTokens: 4800,
      outputTokens: 300,
      thinkingTokens: 0,
      responseTokens: 300,
      ttftSec: 2.5,
      streamingSec: 3.0,
      durationSec: 5.5,
      streamingTps: 100.0,
      tps: 54.5,
      isPreviousSpeed: false,
      breakdownGroups: [],
      updatedAt: Date.now(),
    });
    // 重复样本应被去重
    ledger.recordSpeedSample({
      cascadeId: 'c1',
      title: 'T',
      modelName: 'gemini-4-argon-high',
      isRunning: false,
      workspaceMatched: true,
      usedTokens: 6300,
      budgetTokens: 512000,
      percent: 1.2,
      isEstimated: false,
      estimatedTokens: null,
      inputTokens: 1200,
      cacheReadTokens: 4800,
      outputTokens: 300,
      thinkingTokens: 0,
      responseTokens: 300,
      ttftSec: 2.5,
      streamingSec: 3.0,
      durationSec: 5.5,
      streamingTps: 100.0,
      tps: 54.5,
      isPreviousSpeed: false,
      breakdownGroups: [],
      updatedAt: Date.now(),
    });

    const summary = await ledger.getSummary(true);
    assert.equal(summary.scannedFiles, 2);
    assert.equal(summary.todayKey, todayKey);
    // 今日：desktop(1200+4800+300=6300) + cli(500+500+100=1100) = 7400
    assert.equal(summary.totals.today.total, 7400);
    assert.equal(summary.totals.today.desktopTotal, 6300);
    assert.equal(summary.totals.today.cliTotal, 1100);
    assert.equal(summary.totals.today.steps, 2);
    // 累计：今日 7400 + 昨日 10500 = 17900
    assert.equal(summary.totals.allTime.total, 17900);
    assert.equal(summary.heatmapDays.length, 364);
    assert.equal(summary.daily30.length, 30);

    const yestRec = summary.heatmapDays.find((d) => d.date === yestKey);
    assert.ok(yestRec && yestRec.total === 10500);

    const argonModel = summary.models.find((m) => m.model === 'gemini-4-argon-high');
    assert.ok(argonModel);
    assert.equal(argonModel.total, 7400);
    assert.equal(argonModel.avgStreamingTps, 100);
    assert.equal(argonModel.avgTtftSec, 2.5);
    assert.equal(argonModel.speedSamples, 1);

    ledger.dispose();
    assert.equal(fs.existsSync(cacheFile), true, 'dispose 后应落盘增量缓存');
  });

  await check('S2 损坏缓存文件触发只读保护，不抹除磁盘坏文件且正常聚合返回', async () => {
    const corruptPath = path.join(sandbox, 'corrupt-ledger.json');
    fs.writeFileSync(corruptPath, '{bad-json', 'utf8');
    const ledger = new TokenLedger({ desktopBrainDir: desktopBrain, cliBrainDir: cliBrain, cacheFilePath: corruptPath });
    const summary = await ledger.getSummary(false);
    assert.equal(summary.totals.allTime.total, 17900);
    ledger.dispose();
    assert.equal(fs.readFileSync(corruptPath, 'utf8'), '{bad-json', '不得覆盖未知损坏文件');
  });

  await check('S3 统计面板 DOM ID 与 log-panel.js 引用 100% 闭合且 JS 语法无误', () => {
    const lpTs = fs.readFileSync(path.join(root, 'src', 'logPanelProvider.ts'), 'utf8');
    const lpJs = fs.readFileSync(path.join(root, 'resources', 'webview', 'log-panel.js'), 'utf8');

    // JS 语法编译校验
    new vm.Script(lpJs, { filename: 'log-panel.js' });

    const htmlIds = new Set([...lpTs.matchAll(/\bid="([^"]+)"/g)].map((m) => m[1]));
    const refIds = [...new Set([...lpJs.matchAll(/document\.getElementById\(\s*['"]([^'"]+)['"]\s*\)/g)].map((m) => m[1]))];
    const missing = refIds.filter((id) => !htmlIds.has(id));
    assert.deepEqual(missing, [], `log-panel.js 引用了未在 HTML 中定义的 DOM ID: ${missing.join(', ')}`);

    const lpCss = fs.readFileSync(path.join(root, 'resources', 'webview', 'log-panel.css'), 'utf8');
    assert.ok(!lpCss.includes('min-width: 1018px'), '热力图不得写死 min-width: 1018px 导致分屏产生横向滚动条');
    assert.ok(lpCss.includes('repeat(52, minmax(0, 1fr))'), '热力图应使用 52 列自适应 Grid 等比缩放');
    assert.ok(lpJs.includes('/ 52) * 100}%'), '热力图月份标签应使用百分比横坐标对齐自适应列');
  });

  await check('S4 底栏直达统计面板与侧栏入口全链路接线闭合', () => {
    const sbTs = fs.readFileSync(path.join(root, 'src', 'statusBar.ts'), 'utf8');
    const sideHtml = fs.readFileSync(path.join(root, 'resources', 'webview', 'sidebar.html'), 'utf8');
    const sideJs = fs.readFileSync(path.join(root, 'resources', 'webview', 'sidebar.js'), 'utf8');
    const sideProv = fs.readFileSync(path.join(root, 'src', 'sidebarProvider.ts'), 'utf8');
    const extTs = fs.readFileSync(path.join(root, 'src', 'extension.ts'), 'utf8');

    assert.ok(sbTs.includes('this._deps.openLogPanel?.()'), 'statusBar 点击实时上下文应直达统计面板');
    assert.ok(!sbTs.includes('showDetailsQuickPick'), 'statusBar 不再经过 QuickPick 中转');
    assert.ok(sideHtml.includes('id="openStatsBtn"'), '侧栏工具栏应包含统计面板入口按钮');
    assert.ok(sideJs.includes('openStatsBtn') && sideJs.includes("type: 'openStatsPanel'"), 'sidebar.js 应绑定统计面板入口事件');
    assert.ok(sideProv.includes("case 'openStatsPanel':"), 'sidebarProvider 应响应打开统计面板消息');
    assert.ok(extTs.includes('logPanel.setLogPanelDeps(') && extTs.includes('new TokenLedger()'), 'extension.ts 应接入 TokenLedger 与 LogPanelDeps');
  });

  await check('S5 TokenLedger 应从 conversations/*.db 的 gen_metadata 解出未标注步骤、历史速率与美元费用', async () => {
    const sqlite = require2('node:sqlite');
    const protoBrain = path.join(sandbox, 'proto-brain');
    const protoCli = path.join(sandbox, 'proto-cli');
    const protoConvs = path.join(sandbox, 'proto-convs');
    const protoCache = path.join(sandbox, 'proto-cache.json');
    const convLogDir = path.join(protoBrain, 'conv-proto', '.system_generated', 'logs');
    fs.mkdirSync(convLogDir, { recursive: true });
    fs.mkdirSync(protoCli, { recursive: true });
    fs.mkdirSync(protoConvs, { recursive: true });

    // transcript.jsonl 中的步骤刻意不带 model 与速度字段
    fs.writeFileSync(
      path.join(convLogDir, 'transcript.jsonl'),
      JSON.stringify({
        step_index: 3,
        created_at: now.toISOString(),
        input_tokens: 1000,
        cache_read_tokens: 9000,
        output_tokens: 500,
      }) + '\n',
      'utf8',
    );

    // 构造 Protobuf gen_metadata 二进制（field 2 = stepIndex 3; field 1 = { 11: ttft(1.2s), 12: streaming(2.5s), 19: rawModel, 21: label }）
    const encVarint = (n) => {
      const out = [];
      let v = BigInt(n);
      while (v >= 0x80n) {
        out.push(Number((v & 0x7fn) | 0x80n));
        v >>= 7n;
      }
      out.push(Number(v));
      return Buffer.from(out);
    };
    const encLen = (fieldNum, buf) => Buffer.concat([encVarint((fieldNum << 3) | 2), encVarint(buf.length), buf]);
    const encVarField = (fieldNum, val) => Buffer.concat([encVarint((fieldNum << 3) | 0), encVarint(val)]);
    const encDuration = (sec, nanos) => Buffer.concat([encVarField(1, sec), encVarField(2, nanos)]);
    const innerMsg = Buffer.concat([
      encLen(11, encDuration(1, 200_000_000)),
      encLen(12, encDuration(2, 500_000_000)),
      encLen(19, Buffer.from('claude-sonnet-4-6', 'utf8')),
      encLen(21, Buffer.from('Claude Sonnet 4.6', 'utf8')),
    ]);
    const topMsg = Buffer.concat([encLen(1, innerMsg), encVarField(2, 3)]);

    const db = new sqlite.DatabaseSync(path.join(protoConvs, 'conv-proto.db'));
    db.exec('CREATE TABLE gen_metadata (id TEXT, data BLOB)');
    db.prepare('INSERT INTO gen_metadata (id, data) VALUES (?, ?)').run('m1', topMsg);
    db.close();

    const ledger = new TokenLedger({
      desktopBrainDir: protoBrain,
      cliBrainDir: protoCli,
      cacheFilePath: protoCache,
      conversationsDir: protoConvs,
    });
    const summary = await ledger.getSummary(true);
    ledger.dispose();

    const untagged = summary.models.find((m) => m.model === 'untagged');
    assert.equal(untagged, undefined, '应通过 gen_metadata 自动补全模型归属，无 untagged');
    const claudeModel = summary.models.find((m) => m.displayName === 'Claude Sonnet 4.6');
    assert.ok(claudeModel, '应识别出 Claude Sonnet 4.6 模型条目');
    assert.equal(claudeModel.total, 10500);
    assert.equal(claudeModel.speedSamples, 1, '应从 gen_metadata 计算出历史速度样本');
    assert.equal(claudeModel.avgStreamingTps, 200);
    assert.equal(claudeModel.avgTtftSec, 1.2);
    assert.ok(summary.totals.allTime.costUsd > 0, '应计算 API 等效美元费用');
    assert.ok(summary.totals.allTime.savedByCacheUsd > 0, '应计算缓存命中节省费用');
  });

  await check('S6 UsageTracker 记录三池配额明细与变化即记快照', async () => {
    const prevSharedDir = process.env.KITE_SHARED_DIR;
    process.env.KITE_SHARED_DIR = path.join(sandbox, 'shared-kite');
    try {
      const { UsageTracker } = require2(path.join(root, 'out', 'usageTracker.js'));
      const store = new Map();
      const mockCtx = {
        globalState: {
          get: (k, d) => (store.has(k) ? store.get(k) : d),
          update: async (k, v) => { store.set(k, v); },
        },
      };
      const tracker = new UsageTracker(mockCtx);
      tracker.recordUsage('a@test.com', 60, 'pro', { claude: 80, gemini: 60, argon: 90 });
      // 即使 minRemainingPercent 同为 60，只要子池 claude 发生变动也应入史
      tracker.recordUsage('a@test.com', 60, 'pro', { claude: 75, gemini: 60, argon: 90 });
      // 三池与总览完全未变时不重复灌水
      tracker.recordUsage('a@test.com', 60, 'pro', { claude: 75, gemini: 60, argon: 90 });

      const hist = tracker.getQuotaHistory(undefined, 24);
      assert.equal(hist.length, 2, '子池配额变化应产生新历史记录，完全相同则去重');
      assert.deepEqual(hist[1].pools, { claude: 75, gemini: 60, argon: 90 });
      tracker.dispose();
    } finally {
      if (prevSharedDir === undefined) delete process.env.KITE_SHARED_DIR;
      else process.env.KITE_SHARED_DIR = prevSharedDir;
    }
  });

  await check('S7 侧栏可折叠统计抽屉与分池切换 DOM / IPC 闭合', () => {
    const sideHtml = fs.readFileSync(path.join(root, 'resources', 'webview', 'sidebar.html'), 'utf8');
    const sideJs = fs.readFileSync(path.join(root, 'resources', 'webview', 'sidebar.js'), 'utf8');
    const lpTs = fs.readFileSync(path.join(root, 'src', 'logPanelProvider.ts'), 'utf8');
    const lpJs = fs.readFileSync(path.join(root, 'resources', 'webview', 'log-panel.js'), 'utf8');

    assert.ok(sideHtml.includes('id="statsCollapseBtn"'), 'sidebar.html 应包含左标题折叠按钮 #statsCollapseBtn');
    assert.ok(sideHtml.includes('id="sidebarStatsDrawer"'), 'sidebar.html 应包含可折叠统计抽屉 #sidebarStatsDrawer');
    assert.ok(!sideHtml.includes('id="sbPoolHealthCard"') && !sideHtml.includes('id="sbPoolQuotaCard"'), '已去掉上排可用账号与池均余量迷你卡');
    assert.ok(sideHtml.includes('id="sbTodayStripBtn"'), '抽屉应包含今日统计直达条');

    const collapseMatch = sideHtml.match(/<button[^>]*id="statsCollapseBtn"[\s\S]*?<\/button>/);
    assert.ok(collapseMatch && !collapseMatch[0].includes('addAccountBtn'), '添加账号按钮不得包进折叠触发器内');
    assert.ok(sideJs.includes('statsCollapseBtn') && sideJs.includes('sbTodayStripBtn'), 'sidebar.js 应绑定折叠与跳转事件');
    assert.ok(lpTs.includes('id="lpQuotaPoolSeg"'), 'logPanelProvider 应包含配额分池切换栏 #lpQuotaPoolSeg');
    assert.ok(lpJs.includes('fmtUsd') && lpJs.includes('lpQuotaPoolSeg'), 'log-panel.js 应包含美元格式与三池切换逻辑');
  });

  await check('S8 AccountTimeline 时间片归因与切号事件标记正确', () => {
    const prevSharedDir = process.env.KITE_SHARED_DIR;
    const tlSharedDir = path.join(sandbox, 'shared-timeline');
    process.env.KITE_SHARED_DIR = tlSharedDir;
    try {
      const { AccountTimeline } = require2(path.join(root, 'out', 'accountTimeline.js'));
      const tl = new AccountTimeline();
      tl.recordActiveAccount('Alice@Test.com', 1000);
      // 同一账号重复上报不新增切片
      tl.recordActiveAccount('alice@test.com', 1200);
      tl.recordActiveAccount('bob@test.com', 2000);

      assert.equal(tl.resolveEmailAt(900), '', '早于首条记录的时间戳不得硬猜归为当前号');
      assert.equal(tl.resolveEmailAt(1500), 'alice@test.com', '区间内二分匹配首个账号');
      assert.equal(tl.resolveEmailAt(2500), 'bob@test.com', '切号后匹配第二个账号');

      const events = tl.getSwitchEvents();
      assert.equal(events.length, 1);
      assert.equal(events[0].email, 'bob@test.com');
      assert.equal(events[0].fromEmail, 'alice@test.com');
      assert.equal(events[0].ts, 2000 * 1000);
    } finally {
      if (prevSharedDir === undefined) delete process.env.KITE_SHARED_DIR;
      else process.env.KITE_SHARED_DIR = prevSharedDir;
    }
  });

  await check('S9 双 SQLite 解析、加权等效口径、6 场景归因、父子会话树、同名模型去重与单号汇总', async () => {
    const sqlite = require2('node:sqlite');
    const prevSharedDir = process.env.KITE_SHARED_DIR;
    const dualSharedDir = path.join(sandbox, 'shared-dual');
    process.env.KITE_SHARED_DIR = dualSharedDir;
    try {
      const { AccountTimeline } = require2(path.join(root, 'out', 'accountTimeline.js'));
      const { computeWeightedTokens } = require2(path.join(root, 'out', 'modelCatalog.js'));

      assert.equal(computeWeightedTokens(1000, 10000, 500), 1000 + 1000 + 3000, '加权等效公式應为 in + 0.1*cache + 6*out');

      const timeline = new AccountTimeline();
      const todayNoonSec = Math.floor(new Date(now.getFullYear(), now.getMonth(), now.getDate(), 12, 0, 0).getTime() / 1000);
      const baseSec = Math.floor(todayNoonSec / 300) * 300;
      timeline.recordActiveAccount('a1@test.com', baseSec - 600);
      // 刻意将 a2 切号设在 5 分钟桶内 +15s，step 2 仅晚 30s（仍在同一 300s 桶内），回归锁死切号后立即归因新号
      timeline.recordActiveAccount('a2@test.com', baseSec + 1815);

      const dualBrain = path.join(sandbox, 'dual-brain');
      const dualCli = path.join(sandbox, 'dual-cli');
      const dualConvs = path.join(sandbox, 'dual-convs');
      const sumDbPath = path.join(sandbox, 'conversation_summaries.db');
      const cachePath = path.join(sandbox, 'dual-ledger.json');
      fs.mkdirSync(dualBrain, { recursive: true });
      fs.mkdirSync(dualCli, { recursive: true });
      fs.mkdirSync(dualConvs, { recursive: true });

      const encVarint = (n) => {
        const out = [];
        let v = BigInt(n);
        while (v >= 0x80n) { out.push(Number((v & 0x7fn) | 0x80n)); v >>= 7n; }
        out.push(Number(v));
        return Buffer.from(out);
      };
      const encLen = (f, b) => Buffer.concat([encVarint((f << 3) | 2), encVarint(b.length), b]);
      const encVar = (f, v) => Buffer.concat([encVarint((f << 3) | 0), encVarint(v)]);
      const encDur = (s, ns) => Buffer.concat([encVar(1, s), encVar(2, ns)]);
      const encKv = (k, v) => Buffer.concat([encLen(1, Buffer.from(k)), encLen(2, Buffer.from(v))]);

      const buildGen = ({ stepIdx, inTok, outTok, cacheTok, thinkTok, respTok, slug, label, modelEnum }) => {
        const usageMsg = Buffer.concat([
          encVar(2, inTok),
          encVar(3, outTok),
          encVar(5, cacheTok),
          encVar(9, thinkTok),
          encVar(10, respTok),
        ]);
        const inner = Buffer.concat([
          encLen(4, usageMsg),
          encLen(11, encDur(1, 0)),
          encLen(12, encDur(2, 0)),
          encLen(19, Buffer.from(slug)),
          encLen(20, encKv('model_enum', modelEnum)),
          encLen(21, Buffer.from(label)),
        ]);
        return Buffer.concat([encLen(1, inner), encVar(2, stepIdx)]);
      };
      const buildStepMeta = (tsSec) => encLen(1, encVar(1, tsSec));

      // conversation_summaries.db: 父会话 root-1（desktop, proj A）、子会话 sub-1（desktop, browser）、CLI 会话 cli-2
      const sdb = new sqlite.DatabaseSync(sumDbPath);
      sdb.exec('CREATE TABLE conversation_summaries (conversation_id TEXT PRIMARY KEY, title TEXT, last_modified_time TEXT, workspace_uris TEXT, source TEXT, project_id TEXT, agent_name TEXT, parent_conversation_id TEXT, nesting_depth INTEGER)');
      sdb.exec('CREATE TABLE conversation_parents (conversation_id TEXT PRIMARY KEY, parent_id TEXT NOT NULL)');
      const ins = sdb.prepare('INSERT INTO conversation_summaries VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)');
      ins.run('root-1', 'Fix Auth Flow', now.toISOString(), '["file:///e%3A/project/AlphaApp"]', '', 'p1', '', '', 0);
      ins.run('sub-1', '', now.toISOString(), '["file:///e%3A/project/AlphaApp"]', '', 'p1', 'browser', 'root-1', 1);
      sdb.prepare('INSERT INTO conversation_parents VALUES (?, ?)').run('sub-1', 'root-1');
      sdb.close();

      // 父会话 db：step 1 (tools, slug A -> Claude Opus 4.6) @ baseSec -> a1@test.com; step 2 (chat, slug B -> Claude Opus 4.6 同名!) @ baseSec+1845 -> a2@test.com
      const dbRoot = new sqlite.DatabaseSync(path.join(dualConvs, 'root-1.db'));
      dbRoot.exec('CREATE TABLE steps (idx INTEGER PRIMARY KEY, step_type INTEGER, metadata BLOB)');
      dbRoot.exec('CREATE TABLE gen_metadata (idx INTEGER PRIMARY KEY, data BLOB)');
      dbRoot.prepare('INSERT INTO steps VALUES (?, ?, ?)').run(1, 132, buildStepMeta(baseSec));
      dbRoot.prepare('INSERT INTO steps VALUES (?, ?, ?)').run(2, 15, buildStepMeta(baseSec + 1845));
      dbRoot.prepare('INSERT INTO gen_metadata VALUES (?, ?)').run(0, buildGen({
        stepIdx: 1, inTok: 1000, outTok: 200, cacheTok: 5000, thinkTok: 50, respTok: 150,
        slug: 'claude-opus-4-6-a', label: 'Claude Opus 4.6 (Thinking)', modelEnum: 'MODEL_A',
      }));
      dbRoot.prepare('INSERT INTO gen_metadata VALUES (?, ?)').run(1, buildGen({
        stepIdx: 2, inTok: 3000, outTok: 500, cacheTok: 1000, thinkTok: 100, respTok: 400,
        slug: 'claude-opus-4-6-b', label: 'Claude Opus 4.6 (Thinking)', modelEnum: 'MODEL_B',
      }));
      dbRoot.close();

      // 子会话 db：sub-1 (browser, a1@test.com)
      const dbSub = new sqlite.DatabaseSync(path.join(dualConvs, 'sub-1.db'));
      dbSub.exec('CREATE TABLE steps (idx INTEGER PRIMARY KEY, step_type INTEGER, metadata BLOB)');
      dbSub.exec('CREATE TABLE gen_metadata (idx INTEGER PRIMARY KEY, data BLOB)');
      dbSub.prepare('INSERT INTO steps VALUES (?, ?, ?)').run(0, 15, buildStepMeta(baseSec + 100));
      dbSub.prepare('INSERT INTO gen_metadata VALUES (?, ?)').run(0, buildGen({
        stepIdx: 0, inTok: 400, outTok: 100, cacheTok: 100, thinkTok: 20, respTok: 80,
        slug: 'gemini-3-flash', label: 'Gemini 3 Flash', modelEnum: 'MODEL_F',
      }));
      dbSub.close();

      const ledger = new TokenLedger({
        desktopBrainDir: dualBrain,
        cliBrainDir: dualCli,
        conversationsDir: dualConvs,
        summariesDbPath: sumDbPath,
        cacheFilePath: cachePath,
        timeline,
      });
      const sum = await ledger.getSummary(true);
      ledger.dispose();

      // 同名模型 "Claude Opus 4.6 (Thinking)" 应合并为一条（routes.length === 2），无重复行
      const opusRows = sum.models.filter((m) => m.displayName === 'Claude Opus 4.6 (Thinking)');
      assert.equal(opusRows.length, 1, '相同展示名模型的不同内部路由应合并去重');
      assert.equal(opusRows[0].input, 4000);
      assert.equal(opusRows[0].output, 700);
      assert.equal(opusRows[0].routes.length, 2);

      // 6 场景应包含 tools、chat、subagent
      const toolsSc = sum.scenarios.find((s) => s.key === 'tools');
      const chatSc = sum.scenarios.find((s) => s.key === 'chat');
      const subSc = sum.scenarios.find((s) => s.key === 'subagent');
      assert.ok(toolsSc && toolsSc.steps === 1 && chatSc && chatSc.steps === 1 && subSc && subSc.steps === 1,
        `场景统计异常: ${JSON.stringify(sum.scenarios)}`);

      // 父子会话聚合：root-1 应挂载 sub-1，含 AlphaApp 项目名及 activeDates
      const rootSess = sum.sessions.find((s) => s.conversationId === 'root-1');
      assert.ok(rootSess && rootSess.projectName === 'AlphaApp', '应关联项目名 AlphaApp');
      assert.ok(rootSess.subagents && rootSess.subagents.length === 1 && rootSess.subagents[0].agentName === 'browser',
        '子会话应挂到父会话 subagents[] 下');
      assert.ok(Array.isArray(rootSess.activeDates) && rootSess.activeDates.includes(todayKey),
        '父子会话应汇总活跃日期 activeDates 供热力图联动筛选');

      // 端×项目×账号场景/模型过滤切片
      assert.ok(Array.isArray(sum.scenarioSlices) && sum.scenarioSlices.length >= 3, '应生成 scenarioSlices 供多维联动筛选');
      assert.ok(Array.isArray(sum.modelSlices) && sum.modelSlices.length >= 2, '应生成 modelSlices 供多维联动筛选');

      // 按账号归因：a1@test.com 和 a2@test.com 都有独立汇总
      assert.ok(sum.perAccount['a1@test.com'] && sum.perAccount['a1@test.com'].totalTokens > 0);
      assert.ok(sum.perAccount['a2@test.com'] && sum.perAccount['a2@test.com'].totalTokens > 0);
    } finally {
      if (prevSharedDir === undefined) delete process.env.KITE_SHARED_DIR;
      else process.env.KITE_SHARED_DIR = prevSharedDir;
    }
  });

  await check('S10 侧栏双视图/条件积分/卡片Token/悬浮小票 与 完整统计页金字塔 DOM 全闭合', () => {
    const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
    const sideHtml = fs.readFileSync(path.join(root, 'resources', 'webview', 'sidebar.html'), 'utf8');
    const sideJs = fs.readFileSync(path.join(root, 'resources', 'webview', 'sidebar.js'), 'utf8');
    const lpTs = fs.readFileSync(path.join(root, 'src', 'logPanelProvider.ts'), 'utf8');
    const lpJs = fs.readFileSync(path.join(root, 'resources', 'webview', 'log-panel.js'), 'utf8');

    assert.ok('antigravityKite.sidebar.cardView' in pkg.contributes.configuration.properties);
    assert.ok('antigravityKite.sidebar.showCardTokens' in pkg.contributes.configuration.properties);
    assert.equal(pkg.contributes.configuration.properties['antigravityKite.statusBar.style'].default, 'pulse');

    assert.ok(sideHtml.includes('id="setCardView"') && sideHtml.includes('id="setCardTokens"'));
    assert.ok(sideHtml.includes('id="sbTodayPopover"'));
    assert.ok(sideJs.includes('availableAICredits > 0'), 'AI 积分必须仅在 > 0 时渲染，0/无积分账号严格隐藏');
    assert.ok(sideJs.includes('compact') && sideJs.includes('grid-card-tokens'));
    assert.ok(sideJs.includes('open-account-tokens'), '卡片 Token 消耗条应支持直达该账号统计页');

    // 统计页金字塔控制与下钻 ID + 无 setTimeout switchTab 竞态
    assert.ok(lpTs.includes('data-mode="weighted"') && lpTs.includes('data-mode="usd"'));
    assert.ok(lpTs.includes('id="lpProjectFilter"') && lpTs.includes('id="lpAccountFilter"'));
    assert.ok(lpTs.includes('id="lpActiveFilterChips"') && lpTs.includes('id="lpSessionSort"'));
    assert.ok(lpTs.includes('id="lpScenarioWrap"') && lpTs.includes('id="lpSessionExplorer"'));
    assert.ok(!/setTimeout\([\s\S]{0,120}switchTab/.test(lpTs), 'logPanelProvider 不应使用脆弱的 setTimeout 延迟切页');
    assert.ok(lpTs.includes('id="lpLowCacheBtn"') && lpJs.includes('renderScenarioSection'));
  });
} finally {
  fs.rmSync(sandbox, { recursive: true, force: true });
  fs.rmSync(stubDir, { recursive: true, force: true });
}

console.log(`\n统计中心与 TokenLedger 门控结果: ${passed} 通过, ${failed} 失败`);
process.exit(failed > 0 ? 1 : 0);
