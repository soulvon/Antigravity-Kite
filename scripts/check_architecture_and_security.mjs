#!/usr/bin/env node
/**
 * 全局架构与安全门控（Antigravity Kite 重构验收基线）
 *
 * 校验项：
 *   1. 规模阈值：src/*.ts < 900 行、src/extension.ts < 250 行、resources/webview/main.css < 2500 行
 *   2. 零僵尸资产：无 multiWindowManager/switchRestart* 源码或编译产物、无 mw* 词条、根目录 icon.svg 不入包且 resources/icon.svg 在包内
 *   3. Webview 安全：sidebar.html & logPanelProvider.ts 启用强 Nonce script-src（无 'unsafe-inline'）、零内联 onclick=、DOM ID 全闭合
 *   4. 隔离沙箱实测 accountStore：明文平滑 AES-256-GCM 加密迁移（磁盘零明文）、upsertBatch 智能续期保标签、损坏防抹空熔断与备份
 *   5. 隔离沙箱实测 usageTracker：globalState.quotaHistory 自动迁至共享目录独立 quota-history.json 并清除旧键
 *   6. G22 三端隐私同步闭环：sidebarProvider <-> extension <-> logPanelProvider <-> log-panel.js + statusBar
 *   7. 样式合规：main.css 零 uppercase、零 <12px 字体、sidebar.html / sidebar.js 静态类全存在
 */
import assert from 'node:assert/strict';
import { execFileSync, execSync } from 'node:child_process';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const require2 = createRequire(import.meta.url);

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

console.log('=== 全局架构与安全门控 ===\n');

// ── 1. 文件行数规模阈值 ──
const srcDir = path.join(root, 'src');
const tsFiles = fs.readdirSync(srcDir).filter((f) => f.endsWith('.ts'));
const over900 = [];
for (const f of tsFiles) {
  const lineCount = fs.readFileSync(path.join(srcDir, f), 'utf8').split(/\r?\n/).length;
  if (lineCount >= 900) over900.push(`${f}(${lineCount})`);
}
gate('A1.1 src/*.ts 全部低于 900 行', over900.length === 0, over900.join(', '));

const extLines = fs.readFileSync(path.join(srcDir, 'extension.ts'), 'utf8').split(/\r?\n/).length;
gate('A1.2 src/extension.ts 低于 250 行', extLines < 250, `${extLines} 行`);

const cssText = fs.readFileSync(path.join(root, 'resources', 'webview', 'main.css'), 'utf8');
const cssLines = cssText.split(/\r?\n/).length;
gate('A1.3 resources/webview/main.css 低于 2500 行', cssLines < 2500, `${cssLines} 行`);

// ── 2. 零僵尸模块 / 词条 / 根 icon.svg 入包 ──
const zombieNames = ['multiWindowManager', 'switchRestart', 'switchRestartHelper'];
const zombieSrcHits = zombieNames.filter((n) => fs.existsSync(path.join(srcDir, `${n}.ts`)));
const zombieOutHits = zombieNames.filter((n) => fs.existsSync(path.join(root, 'out', `${n}.js`)));
gate(
  'A2.1 无多开/重启僵尸源码与 out/ 残留产物',
  zombieSrcHits.length === 0 && zombieOutHits.length === 0,
  `src=${zombieSrcHits.join(',')}, out=${zombieOutHits.join(',')}`,
);

const i18nMod = require2(path.join(root, 'out', 'i18n.js'));
const dict = i18nMod.__dictForCheck();
const zombieKeys = Object.keys(dict).filter((k) => /^mw[A-Z]|^ui\.mw|^ui\.multiWindow$/.test(k));
gate('A2.2 i18n 字典零 mw* 多开僵尸词条', zombieKeys.length === 0, zombieKeys.join(', '));

let vsceFiles = [];
let vsceErr = '';
try {
  const out = execSync('npx vsce ls', { cwd: root, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] });
  vsceFiles = out.split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
} catch (err) {
  vsceErr = err instanceof Error ? err.message : String(err);
}
gate(
  'A2.3 vsce ls 排除根目录 icon.svg 且保留 resources/icon.svg，零僵尸文件入包',
  vsceFiles.length > 0
    && !vsceFiles.includes('icon.svg')
    && vsceFiles.includes('resources/icon.svg')
    && !vsceFiles.some((f) => /multiWindowManager|switchRestart/.test(f))
    && !vsceFiles.some((f) => /^(tmp|docs|scripts|\.preview)\//.test(f)),
  vsceErr || `count=${vsceFiles.length}, hasRootIcon=${vsceFiles.includes('icon.svg')}, hasResIcon=${vsceFiles.includes('resources/icon.svg')}`,
);

// ── 3. Webview 强 Nonce CSP / 零内联事件 / DOM ID 闭合 ──
const sidebarHtml = fs.readFileSync(path.join(root, 'resources', 'webview', 'sidebar.html'), 'utf8');
const sidebarJs = fs.readFileSync(path.join(root, 'resources', 'webview', 'sidebar.js'), 'utf8');
const sidebarProviderSrc = fs.readFileSync(path.join(srcDir, 'sidebarProvider.ts'), 'utf8');
const logPanelSrc = fs.readFileSync(path.join(srcDir, 'logPanelProvider.ts'), 'utf8');
const logPanelJs = fs.readFileSync(path.join(root, 'resources', 'webview', 'log-panel.js'), 'utf8');

const sidebarCsp = sidebarHtml.match(/<meta http-equiv="Content-Security-Policy" content="([^"]+)">/)?.[1] || '';
const sidebarScriptSrc = sidebarCsp.match(/script-src\s+([^;]+)/)?.[1] || '';
const logCsp = logPanelSrc.match(/http-equiv="Content-Security-Policy" content="([^"]+)"/)?.[1] || '';
const logScriptSrc = logCsp.match(/script-src\s+([^;]+)/)?.[1] || '';

gate(
  'A3.1 sidebar.html 与 logPanelProvider.ts 均启用强 Nonce script-src 且无 unsafe-inline',
  sidebarScriptSrc.includes("'nonce-{{NONCE}}'")
    && !sidebarScriptSrc.includes('unsafe-inline')
    && logScriptSrc.includes("'nonce-${nonce}'")
    && !logScriptSrc.includes('unsafe-inline'),
  `sidebar=${sidebarScriptSrc}; log=${logScriptSrc}`,
);

const inlineOnclickFiles = [
  ['sidebar.html', sidebarHtml],
  ['sidebar.js', sidebarJs],
  ['sidebarProvider.ts', sidebarProviderSrc],
  ['logPanelProvider.ts', logPanelSrc],
  ['log-panel.js', logPanelJs],
].filter(([, txt]) => /\bonclick\s*=/.test(txt)).map(([name]) => name);
gate('A3.2 Webview 前后端零内联 onclick=', inlineOnclickFiles.length === 0, inlineOnclickFiles.join(', '));

const htmlIds = new Set([...sidebarHtml.matchAll(/\bid="([^"]+)"/g)].map((m) => m[1]));
for (const m of sidebarJs.matchAll(/\.id\s*=\s*['"]([a-zA-Z0-9_-]+)['"]/g)) htmlIds.add(m[1]);
for (const m of sidebarJs.matchAll(/\bid=["']([a-zA-Z0-9_-]+)["']/g)) htmlIds.add(m[1]);
const referencedIds = [...new Set([...sidebarJs.matchAll(/document\.getElementById\(\s*['"]([^'"]+)['"]\s*\)/g)].map((m) => m[1]))];
const missingDomIds = referencedIds.filter((id) => !htmlIds.has(id));
gate('A3.3 sidebar.js 引用的所有 DOM ID 100% 闭合存在', missingDomIds.length === 0, missingDomIds.join(', '));

// ── 4 & 5. 隔离沙箱子进程实测 accountStore & usageTracker ──
const sandboxDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kite-arch-sec-'));
const sandboxRunnerPath = path.join(sandboxDir, 'runner.cjs');
const sandboxRunnerCode = `
'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const Module = require('node:module');

const vscodeStub = {
  env: { language: 'zh-CN', appRoot: '' },
  workspace: { getConfiguration: () => ({ get: (_k, d) => d }) },
  window: { showOpenDialog: async () => undefined },
  commands: { registerCommand: () => ({ dispose() {} }) },
};
const origLoad = Module._load;
Module._load = function (req) {
  if (req === 'vscode') return vscodeStub;
  return origLoad.apply(this, arguments);
};

const root = ${JSON.stringify(root)};
const sharedDir = process.env.KITE_SHARED_DIR;
const mode = process.argv[2];

function makeMockCtx(initialMap) {
  const store = new Map(Object.entries(initialMap || {}));
  return {
    _store: store,
    globalStorageUri: { fsPath: path.join(sharedDir, 'global-storage') },
    globalState: {
      get: (k, d) => (store.has(k) ? store.get(k) : d),
      update: async (k, v) => {
        if (v === undefined) store.delete(k);
        else store.set(k, v);
      },
    },
  };
}

(async () => {
if (mode === 'migrate-and-upsert') {
  const accountsFile = path.join(sharedDir, 'accounts.json');
  fs.mkdirSync(sharedDir, { recursive: true });
  fs.writeFileSync(accountsFile, JSON.stringify([
    {
      email: 'Alice@Example.com',
      name: 'Alice',
      accessToken: 'ya29.plain-access-secret',
      refreshToken: '1//plain-refresh-secret',
      idToken: 'eyJ.plain.idtoken',
      tags: ['主力'],
      projectId: 'proj-01',
      disabled: false,
      tag: 'cockpit-tools',
    },
  ], null, 2), 'utf8');

  const accountStore = require(path.join(root, 'out', 'accountStore.js'));
  accountStore.init(makeMockCtx());
  assert.equal(accountStore.isLoadHealthy(), true, '明文迁移后应健康');
  assert.equal(accountStore.count(), 1);
  const loadedAlice = accountStore.getByEmail('alice@example.com');
  assert.equal(loadedAlice.accessToken, 'ya29.plain-access-secret');
  assert.equal(loadedAlice.refreshToken, '1//plain-refresh-secret');
  assert.deepEqual(loadedAlice.tags, ['主力']);

  assert.equal(fs.existsSync(path.join(sharedDir, 'master.key')), true, '应生成 master.key');
  assert.equal(fs.existsSync(path.join(sharedDir, 'accounts.pre-encrypt.bak')), true, '应备份 accounts.pre-encrypt.bak');

  const diskText = fs.readFileSync(accountsFile, 'utf8');
  assert.equal(diskText.includes('ya29.plain-access-secret'), false, '磁盘不得残留明文 accessToken');
  assert.equal(diskText.includes('1//plain-refresh-secret'), false, '磁盘不得残留明文 refreshToken');
  assert.equal(diskText.includes('eyJ.plain.idtoken'), false, '磁盘不得残留明文 idToken');
  const diskArr = JSON.parse(diskText);
  assert.ok(String(diskArr[0].accessToken).startsWith('enc:v1:'));
  assert.ok(String(diskArr[0].refreshToken).startsWith('enc:v1:'));
  assert.ok(String(diskArr[0].idToken).startsWith('enc:v1:'));
  assert.equal(diskArr[0].tag, undefined, '迁移时同步剥离旧单数脏 tag');

  // upsertBatch 智能续期（大小写不敏感匹配 + 保留 tags/disabled/projectId）
  const r1 = accountStore.upsertBatch([
    {
      email: 'ALICE@EXAMPLE.COM',
      accessToken: 'ya29.renewed-access',
      refreshToken: '1//renewed-refresh',
      expiresAt: new Date(Date.now() + 3600_000).toISOString(),
    },
    {
      email: 'bob@example.com',
      accessToken: 'ya29.bob-access',
      refreshToken: '1//bob-refresh',
    },
  ], { overwriteTokens: true });
  assert.deepEqual(r1, { added: 1, updated: 1, skipped: 0 });
  const updatedAlice = accountStore.getByEmail('alice@example.com');
  assert.equal(updatedAlice.accessToken, 'ya29.renewed-access');
  assert.equal(updatedAlice.refreshToken, '1//renewed-refresh');
  assert.deepEqual(updatedAlice.tags, ['主力']);
  assert.equal(updatedAlice.projectId, 'proj-01');
  assert.equal(updatedAlice.disabled, false);

  const r2 = accountStore.upsertBatch([
    {
      email: 'alice@example.com',
      accessToken: 'ya29.renewed-access',
      refreshToken: '1//renewed-refresh',
    },
  ], { overwriteTokens: true });
  assert.deepEqual(r2, { added: 0, updated: 0, skipped: 1 });

  // atomicFile 同进程嵌套重入不死锁
  const atomicFile = require(path.join(root, 'out', 'atomicFile.js'));
  const reentrantPath = path.join(sharedDir, 'reentrant-check.json');
  const reentrantVal = atomicFile.withFileLockSync(reentrantPath, () => {
    return atomicFile.withFileLockSync(reentrantPath, () => 'reentrant-ok', 150);
  }, 300);
  assert.equal(reentrantVal, 'reentrant-ok', 'withFileLockSync 同进程重入应无死锁通过');

  // accountStore 本进程变更触发 onChange + OAuth 重登覆盖清除旧 auth_invalid 并保留 tags
  let onChangeFired = 0;
  const unsub = accountStore.onChange(() => { onChangeFired++; });
  accountStore.update('alice@example.com', { health: { status: 'auth_invalid', checkedAt: new Date().toISOString(), detail: '401' } });
  assert.equal(onChangeFired, 1, '本进程 update 应立即通知 onChange');
  accountStore.add({
    email: 'alice@example.com',
    accessToken: 'ya29.relogin-access',
    refreshToken: '1//relogin-refresh',
    expiresAt: new Date(Date.now() + 3600_000).toISOString(),
  });
  assert.equal(onChangeFired, 2, '本进程 add 应立即通知 onChange');
  const reloginAlice = accountStore.getByEmail('alice@example.com');
  assert.equal(reloginAlice.health, undefined, '重新登录覆盖后应清除旧 auth_invalid 状态');
  assert.deepEqual(reloginAlice.tags, ['主力'], '重新登录覆盖未传 tags 时应保留原有用户标签');
  unsub.dispose();

  // updater.compareVersions 预发布段数值比较
  const updaterMod = require(path.join(root, 'out', 'updater.js'));
  assert.ok(updaterMod.compareVersions('1.4.0-beta.10', '1.4.0-beta.2') > 0, 'SemVer 预发布数值段 10 应大于 2');
  assert.ok(updaterMod.compareVersions('1.4.0', '1.4.0-rc.1') > 0, '正式版应大于同版本预发布版');

  // usageService.ensureFreshToken 空 accessToken 时即使 expiresAt 在未来也绝不跳过刷新直接返回空串
  const googleOAuthMod = require(path.join(root, 'out', 'googleOAuth.js'));
  const origRefresh = googleOAuthMod.refreshGoogleAccessToken;
  googleOAuthMod.refreshGoogleAccessToken = async () => ({ accessToken: 'ya29.refreshed-from-empty', expiresIn: 3600 });
  const usageSvcMod = require(path.join(root, 'out', 'usageService.js'));
  const ensuredTok = await usageSvcMod.ensureFreshToken({
    email: 'bob@example.com',
    accessToken: '',
    refreshToken: '1//bob-refresh',
    expiresAt: new Date(Date.now() + 3600_000).toISOString(),
  });
  googleOAuthMod.refreshGoogleAccessToken = origRefresh;
  assert.equal(ensuredTok, 'ya29.refreshed-from-empty', '空 accessToken 不得被未来 expiresAt 欺骗跳过刷新');

  // usageTracker 独立文件迁移与持久化
  const { UsageTracker } = require(path.join(root, 'out', 'usageTracker.js'));
  const oldHistory = [
    { ts: Date.now() - 120000, email: 'alice@example.com', remaining: 80, delta: 0, tierId: 'pro' },
    { ts: Date.now() - 60000, email: 'alice@example.com', remaining: 75, delta: -5, tierId: 'pro' },
  ];
  const ctxTracker = makeMockCtx({ 'usageTracker.quotaHistory': oldHistory });
  const tracker1 = new UsageTracker(ctxTracker);
  assert.equal(ctxTracker._store.has('usageTracker.quotaHistory'), false, '迁移后应从 globalState 清除旧键');
  const histPath = path.join(sharedDir, 'quota-history.json');
  assert.equal(fs.existsSync(histPath), true, '应生成独立 quota-history.json');
  tracker1.recordUsage('alice@example.com', 60, 'pro');
  tracker1.dispose();

  const tracker2 = new UsageTracker(makeMockCtx({}));
  const loadedHist = tracker2.getQuotaHistory('alice@example.com', 50);
  assert.equal(loadedHist.length, 3, '重启后应从 quota-history.json 读取全部 3 条记录');
  assert.equal(loadedHist[2].remaining, 60);
  tracker2.dispose();

  // 磁盘损坏防抹空保护（已加载状态遇到盘坏拒写）
  const rawHealthy = fs.readFileSync(accountsFile, 'utf8');
  fs.writeFileSync(accountsFile, '{corrupt-json-payload', 'utf8');
  const addBlocked = accountStore.add({ email: 'charlie@example.com', accessToken: 'ya29.c' });
  assert.equal(addBlocked, false, '磁盘损坏时 add 必须拒写返回 false');
  assert.equal(accountStore.isLoadHealthy(), false, '磁盘损坏后健康状态必为 false');
  assert.equal(accountStore.count(), 2, '内存原有 2 个账号绝不可被抹空');
  assert.equal(fs.readFileSync(accountsFile, 'utf8'), '{corrupt-json-payload', '原损坏文件不可被覆盖');
  const corruptBaks = fs.readdirSync(sharedDir).filter((f) => f.startsWith('accounts.corrupt.') && f.endsWith('.bak'));
  assert.ok(corruptBaks.length >= 1, '拒写前应备份 accounts.corrupt.*.bak');

  accountStore.dispose();
  console.log('SANDBOX_OK_1');
} else if (mode === 'cold-corrupt-boot') {
  const accountsFile = path.join(sharedDir, 'accounts.json');
  fs.mkdirSync(sharedDir, { recursive: true });
  fs.writeFileSync(accountsFile, '[broken-at-boot', 'utf8');
  const accountStore = require(path.join(root, 'out', 'accountStore.js'));
  accountStore.init(makeMockCtx());
  assert.equal(accountStore.isLoadHealthy(), false, '冷启动读损坏文件应标记 loadHealthy=false');
  assert.equal(accountStore.add({ email: 'new@example.com', accessToken: 'ya29.n' }), false, '损坏态不可覆盖写入');
  assert.equal(fs.readFileSync(accountsFile, 'utf8'), '[broken-at-boot');
  accountStore.dispose();
  console.log('SANDBOX_OK_2');
}
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
`;
fs.writeFileSync(sandboxRunnerPath, sandboxRunnerCode, 'utf8');

try {
  const dir1 = path.join(sandboxDir, 'case1');
  const out1 = execFileSync(process.execPath, [sandboxRunnerPath, 'migrate-and-upsert'], {
    env: { ...process.env, KITE_SHARED_DIR: dir1, KITE_MASTER_KEY_FILE: '' },
    encoding: 'utf8',
  });
  const dir2 = path.join(sandboxDir, 'case2');
  const out2 = execFileSync(process.execPath, [sandboxRunnerPath, 'cold-corrupt-boot'], {
    env: { ...process.env, KITE_SHARED_DIR: dir2, KITE_MASTER_KEY_FILE: '' },
    encoding: 'utf8',
  });
  gate(
    'A4 & A5 隔离沙箱实测 accountStore 加密迁移/续期保标签/防抹空熔断 + usageTracker 独立 JSON 迁移',
    out1.includes('SANDBOX_OK_1') && out2.includes('SANDBOX_OK_2'),
    `${out1.trim()} | ${out2.trim()}`,
  );
} catch (err) {
  const detail = err?.stderr ? String(err.stderr) : (err instanceof Error ? err.message : String(err));
  gate('A4 & A5 隔离沙箱实测 accountStore 与 usageTracker', false, detail);
} finally {
  fs.rmSync(sandboxDir, { recursive: true, force: true });
}

// ── 6. G22 logPanel <-> sidebar <-> statusBar 双向隐私同步与零泄露 ──
const extSrc = fs.readFileSync(path.join(srcDir, 'extension.ts'), 'utf8');
const seamlessSrc = fs.readFileSync(path.join(srcDir, 'seamlessSwitcher.ts'), 'utf8');
const statusBarSrc = fs.readFileSync(path.join(srcDir, 'statusBar.ts'), 'utf8');
const logPanelCss = fs.readFileSync(path.join(root, 'resources', 'webview', 'log-panel.css'), 'utf8');

const lpMaskFnSrc = logPanelJs.match(/function maskEmail\(em\)\s*\{[\s\S]*?\n  \}/)?.[0] || '';
let lpMaskedSample = '';
if (lpMaskFnSrc) {
  const maskSandbox = { privacyMode: true };
  vm.runInNewContext(lpMaskFnSrc, maskSandbox);
  lpMaskedSample = maskSandbox.maskEmail('alice@secret-corp.internal');
}

const g22Ok = logPanelSrc.includes('export function broadcastPrivacyToLogPanel')
  && logPanelSrc.includes("type === 'privacyChanged'")
  && logPanelSrc.includes("type === 'webviewReady'")
  && logPanelSrc.includes('privacyMode:')
  && logPanelJs.includes("type: 'privacyChanged'")
  && logPanelJs.includes("type: 'webviewReady'")
  && logPanelJs.includes("msg.type === 'privacyMode'")
  && sidebarProviderSrc.includes('public broadcastPrivacy(')
  && sidebarProviderSrc.includes("case 'privacyChanged'")
  && extSrc.includes('broadcastPrivacyToLogPanel')
  && extSrc.includes('broadcastPrivacy(')
  && lpMaskedSample === 'al***e@***'
  && sidebarJs.includes("tl('confirmRemove', displayEmail(email))")
  && !seamlessSrc.includes('accessToken.substring(');
gate('A6 logPanel 与侧栏/状态栏 G22 双向隐私模式同步及域名脱敏闭环', g22Ok, `lpMasked=${lpMaskedSample}`);

// ── 7. 样式规范与静态类检查（main.css + log-panel.css） ──
const hasUppercase = /text-transform\s*:\s*uppercase/i.test(cssText) || /text-transform\s*:\s*uppercase/i.test(logPanelCss);
const smallFonts = [
  ...[...cssText.matchAll(/font-size\s*:\s*(\d+(?:\.\d+)?)px/gi)].filter((m) => parseFloat(m[1]) < 12).map((m) => `main:${m[0]}`),
  ...[...logPanelCss.matchAll(/font-size\s*:\s*(\d+(?:\.\d+)?)px/gi)].filter((m) => parseFloat(m[1]) < 12).map((m) => `lp:${m[0]}`),
];
const hasHiddenGuard = /\[hidden\][\s\S]{0,120}display:\s*none\s*!important/.test(cssText);

const cssClasses = new Set([...cssText.matchAll(/\.([a-zA-Z_][a-zA-Z0-9_-]*)/g)].map((m) => m[1]));
const htmlClasses = new Set();
for (const m of sidebarHtml.matchAll(/\bclass="([^"]+)"/g)) {
  for (const c of m[1].trim().split(/\s+/)) if (c) htmlClasses.add(c);
}
const jsStaticClasses = new Set();
for (const m of sidebarJs.matchAll(/class="([^"\n]+)"/g)) {
  const staticPart = m[1]
    .replace(/\S*\$\{[^}]*\}\S*/g, ' ')
    .replace(/\S*'\s*\+[\s\S]*?(?:\+\s*'\S*|$)/g, ' ');
  for (const tok of staticPart.split(/\s+/)) {
    const clean = tok.trim();
    if (clean && !clean.endsWith('-') && /^[a-zA-Z_-][a-zA-Z0-9_-]*$/.test(clean)) {
      jsStaticClasses.add(clean);
    }
  }
}
const missingHtmlClasses = [...htmlClasses].filter((c) => !cssClasses.has(c));
const missingJsClasses = [...jsStaticClasses].filter((c) => !cssClasses.has(c));

gate(
  'A7 main.css 与 log-panel.css 零 uppercase、零 <12px 字号、含 [hidden] 防护且前端静态类无缺失',
  !hasUppercase
    && smallFonts.length === 0
    && hasHiddenGuard
    && missingHtmlClasses.length === 0
    && missingJsClasses.length === 0,
  `uppercase=${hasUppercase}, smallFonts=${smallFonts.join(',')}, missingHtml=${missingHtmlClasses.join(',')}, missingJs=${missingJsClasses.join(',')}`,
);

// ── 8. 宿主交互状态一致性（删当前号清 currentEmail、外部改配置同步、状态栏重建保 name、401 自动补刷） ──
const usageSvcSrc = fs.readFileSync(path.join(srcDir, 'usageService.ts'), 'utf8');
const a8Checks = {
  extCfgMethod: sidebarProviderSrc.includes('onExternalConfigurationChanged('),
  extCfgWired: extSrc.includes('sidebar.onExternalConfigurationChanged(e)'),
  lpReloadWired: extSrc.includes('logPanel.reloadLogPanelForLocale('),
  lpDisposeWired: extSrc.includes('logPanel.disposeLogPanel()'),
  rmClearsCur: /case 'removeAccount':[\s\S]{0,360}update\('currentEmail',\s*''\)/.test(sidebarProviderSrc),
  batchRmClearsCur: /case 'batchDelete':[\s\S]{0,520}update\('currentEmail',\s*''\)/.test(sidebarProviderSrc),
  sbKeepNames: /private _ensureAlignment[\s\S]{0,650}_main\.name\s*=\s*'Kite Quota'[\s\S]{0,200}_pool\.name\s*=\s*'Kite Pool'/.test(statusBarSrc),
  emptyAtGuard: /!forceRefresh\s*&&\s*account\.accessToken\s*&&\s*account\.expiresAt/.test(usageSvcSrc),
};
const hostConsistencyOk = Object.values(a8Checks).every(Boolean);
gate(
  'A8 宿主删当前号清理、外部设置同步、状态栏对齐保名与空 AT 防漏刷全闭合',
  hostConsistencyOk,
  JSON.stringify(a8Checks),
);

console.log(`\n架构与安全门控结果: ${passed} 通过, ${failed} 失败`);
process.exit(failed > 0 ? 1 : 0);
