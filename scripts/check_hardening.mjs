#!/usr/bin/env node
/**
 * 工程健壮性与尾项修复回归门控（devloop 红线 4：先写失败检查，再改代码，最终编译与运行时双过）
 *
 * 覆盖：
 *   1. extension.ts / main.css / i18n 尾项清理（无死 openTagColorPicker、无 stale 'smart' 默认、无 ?v=Date.now()）
 *   2. usageService.ts remainingFraction 缺省语义（带 resetTime 缺 fraction 视为 0% 耗尽而非 100%，全空对象跳过）
 *   3. declarationSuppressor.ts CDP 宿主验真、Buffer 拼包、自适应心跳调度
 *   4. ideRuntime.ts detectExePath Windows PowerShell CIM 优先 + wmic 回退
 *   5. cdpGate.ts 去重 --remote-debugging-port、清 ELECTRON_RUN_AS_NODE、POSIX 退出分支、失败留痕
 *   6. ideStateDb.ts protobuf 越界校验、遇未知 wireType / 非标准结构不覆盖套餐权益
 *   7. oauthService.ts crypto.randomBytes 状态、failHtml 转义防 XSS、误访问/错 state 不中断有效会话
 *   8. localReader.ts & updater.ts 统一 Buffer.concat 读响应 + 重定向清 timer
 *   9. Webview inline <script> 语法校验
 */
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import assert from 'node:assert/strict';
import os from 'node:os';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const require2 = createRequire(import.meta.url);

// Inject chained vscode stub for loading out/*.js
const stubDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kite-hardening-stub-'));
fs.mkdirSync(path.join(stubDir, 'vscode'), { recursive: true });
fs.writeFileSync(path.join(stubDir, 'vscode', 'package.json'), JSON.stringify({ name: 'vscode', main: 'index.js' }));
fs.writeFileSync(
  path.join(stubDir, 'vscode', 'index.js'),
  `const c = new Proxy(function () {}, {
    get: (t, p) => {
      if (p === 'then') return undefined;
      if (p === Symbol.toPrimitive) return () => '';
      if (p === 'toString' || p === 'valueOf') return () => '';
      return c;
    },
    apply: () => c,
    construct: () => c,
  });
  module.exports = c;`
);
process.env.NODE_PATH = [stubDir, process.env.NODE_PATH].filter(Boolean).join(path.delimiter);
require2('module')._initPaths();

let failures = 0;
function gate(name, ok, detail = '') {
  console.log((ok ? '  PASS  ' : '  FAIL  ') + name + (ok || !detail ? '' : '  <- ' + detail));
  if (!ok) failures++;
}

const readSrc = (rel) => fs.readFileSync(path.join(root, rel), 'utf8');

const extSrc = readSrc('src/extension.ts');
const sidebarSrc = readSrc('src/sidebarProvider.ts');
const sidebarHtmlSrc = readSrc('resources/webview/sidebar.html');
const sidebarJsSrc = readSrc('resources/webview/sidebar.js');
const cssSrc = readSrc('resources/webview/main.css');
const i18nSrc = readSrc('src/i18n.ts');
const declSrc = readSrc('src/declarationSuppressor.ts');
const rtSrc = readSrc('src/ideRuntime.ts');
const cdpSrc = readSrc('src/cdpGate.ts');
const oauthSrc = readSrc('src/oauthService.ts');
const lrSrc = readSrc('src/localReader.ts');
const updSrc = readSrc('src/updater.ts');
const httpSrc = readSrc('src/httpClient.ts');

console.log('[check_hardening] 检查工程健壮性与尾项修复 …');

// ── 1. extension.ts / sidebarProvider.ts / webview / main.css 尾项清理 ───────────────────────────────
gate('E1 无死代码 openTagColorPicker 及孤立 .tag-color-picker CSS',
  !/function openTagColorPicker/.test(extSrc)
    && !/function openTagColorPicker/.test(sidebarSrc)
    && !/function openTagColorPicker/.test(sidebarJsSrc)
    && !cssSrc.includes('.tag-color-picker'),
  '仍残留死函数 openTagColorPicker 或 .tag-color-picker 样式');
gate('E2 设置面板 statusBarStyle 默认回退为 full（非 smart）',
  /set\('setStatusStyle',\s*s\.statusBarStyle\s*\|\|\s*'full'\)/.test(sidebarJsSrc),
  "仍存在 s.statusBarStyle || 'smart'");
gate('E3 Webview cssUri 不拼接 ?v=${Date.now()}',
  !/\$\{cssUri\}\?v=\$\{Date\.now\(\)\}/.test(extSrc)
    && !/\$\{cssUri\}\?v=\$\{Date\.now\(\)\}/.test(sidebarSrc)
    && !/\{\{CSS_URI\}\}\?v=/.test(sidebarHtmlSrc),
  '仍存在 ?v=${Date.now()}');
gate('E4 Webview 内联与外联脚本运行时渲染语法可编译（new Function）', (() => {
  try {
    const extMod = require2(path.join(root, 'out', 'extension.js'));
    if (typeof extMod.SidebarProvider !== 'function') return false;
    const provider = new extMod.SidebarProvider({ fsPath: root }, {});
    const html = provider._getHtmlForWebview({
      cspSource: 'https://test.invalid',
      asWebviewUri: () => 'https://test.invalid/main.css',
    });
    const m = html.match(/<script\b[^>]*>([\s\S]*?)<\/script>/);
    if (!m) return false;
    new Function(m[1]);
    new Function(sidebarJsSrc);
    return true;
  } catch (e) {
    console.error('        E4 detail:', e && e.message);
    return false;
  }
})());

// ── 2. usageService.ts remainingFraction 语义 ────────────────────────
let usageMod = null;
try { usageMod = require2(path.join(root, 'out', 'usageService.js')); } catch {}
gate('U1 out/usageService.js 导出 extractQuotaFromSummary 与 extractQuotaFromModels',
  !!usageMod && typeof usageMod.extractQuotaFromSummary === 'function' && typeof usageMod.extractQuotaFromModels === 'function',
  'extractQuotaFromModels 未导出');
if (usageMod && typeof usageMod.extractQuotaFromSummary === 'function' && typeof usageMod.extractQuotaFromModels === 'function') {
  const futureReset = new Date(Date.now() + 2 * 3600e3).toISOString();
  const s = usageMod.extractQuotaFromSummary({
    groups: [{
      buckets: [
        { bucketId: '3p-5h', resetTime: futureReset }, // protobuf 省略 0 值：带 resetTime 无 fraction => 0%
        { bucketId: 'gemini-5h' },                    // 既无 fraction 又无 resetTime => 跳过，不瞎填 100%
        { bucketId: 'gemini-weekly', remainingFraction: 0.4, resetTime: futureReset },
      ],
    }],
  });
  gate('U2 extractQuotaFromSummary: 带 resetTime 缺 remainingFraction 判为 0%，全空 bucket 跳过', (() => {
    const p3 = s.find(x => x.modelId === 'claude:5h');
    const g5 = s.find(x => x.modelId === 'gemini:5h');
    const gw = s.find(x => x.modelId === 'gemini:weekly');
    return p3?.remainingPercent === 0 && !g5 && gw?.remainingPercent === 40;
  })(), JSON.stringify(s));

  const m = usageMod.extractQuotaFromModels({
    'claude-sonnet': { displayName: 'Claude', quotaInfo: { resetTime: futureReset } },
    'gemini-3-pro': { displayName: 'Gemini Pro', quotaInfo: {} },
    'gemini-3-flash': { displayName: 'Gemini Flash' },
  });
  gate('U3 extractQuotaFromModels: 带 resetTime 缺 remainingFraction 判为 0%，无配额模型跳过', (() => {
    const c5 = m.models.find(x => x.modelId === 'claude:5h');
    const g5 = m.models.find(x => x.modelId === 'gemini:5h');
    return m.models.length === 1 && c5?.remainingPercent === 0 && m.minRemainingPercent === 0 && !g5;
  })(), JSON.stringify(m));
}

// ── 3. declarationSuppressor.ts 加固 ─────────────────────────────────
let declMod = null;
try { declMod = require2(path.join(root, 'out', 'declarationSuppressor.js')); } catch {}
gate('D1 declarationSuppressor 使用 Buffer.concat 收包且无 += 字符串拼接',
  declSrc.includes('Buffer.concat') && !/d\s*\+=\s*c/.test(declSrc),
  '存在原始字符串分片拼接 d += c');
gate('D2 declarationSuppressor 导出并实现 CDP 宿主验真 isAntigravityCdpHost',
  !!declMod && typeof declMod.isAntigravityCdpHost === 'function'
  && declMod.isAntigravityCdpHost({ Browser: 'Chrome/132.0.0.0 Electron/34.0.0' }, []) === true
  && declMod.isAntigravityCdpHost({ Browser: 'Chrome/132.0.0.0' }, [{ url: 'https://example.com' }]) === false
  && declMod.isAntigravityCdpHost({ Browser: 'Chrome/132.0.0.0' }, [{ url: 'vscode-file://vscode-app/index.html' }]) === true,
  '外部 Chrome 9222 未被识别过滤或误杀真实 Electron/vscode-file');
gate('D3 declarationSuppressor 使用 burst -> 退避自适应心跳间隔（非永久 500ms 死扫）',
  !!declMod && typeof declMod.getNextIntervalMs === 'function'
  && declMod.getNextIntervalMs(1000, 500, true, 10000) <= 500
  && declMod.getNextIntervalMs(100000, 500, false, 10000) >= 3000,
  '缺少自适应心跳间隔控制 getNextIntervalMs');

if (declMod && typeof declMod.verifyCdpHost === 'function') {
  const serveMockCdp = (versionObj, listArr) => new Promise((resolve) => {
    const srv = http.createServer((req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      if ((req.url || '').startsWith('/json/version')) {
        res.end(JSON.stringify(versionObj));
      } else {
        res.end(JSON.stringify(listArr));
      }
    });
    srv.listen(0, '127.0.0.1', () => resolve({ srv, port: srv.address().port }));
  });

  const chromeSrv = await serveMockCdp(
    { Browser: 'Chrome/132.0.0.0', 'User-Agent': 'Mozilla/5.0 Chrome/132.0.0.0' },
    [{ id: '1', type: 'page', url: 'https://google.com', webSocketDebuggerUrl: 'ws://127.0.0.1/devtools/page/1' }]
  );
  const electronSrv = await serveMockCdp(
    { Browser: 'Chrome/132.0.6834.111 Electron/34.1.0' },
    [{ id: '2', type: 'page', url: 'https://example.com', webSocketDebuggerUrl: 'ws://127.0.0.1/devtools/page/2' }]
  );
  const workbenchSrv = await serveMockCdp(
    { Browser: 'Chrome/132.0.0.0' },
    [{ id: '3', type: 'page', url: 'vscode-file://vscode-app/index.html', webSocketDebuggerUrl: 'ws://127.0.0.1/devtools/page/3' }]
  );
  try {
    const rChrome = await declMod.verifyCdpHost(chromeSrv.port, 1200);
    const rElectron = await declMod.verifyCdpHost(electronSrv.port, 1200);
    const rWorkbench = await declMod.verifyCdpHost(workbenchSrv.port, 1200);
    gate('D4 verifyCdpHost 本地 HTTP 实测：拒绝普通 Chrome 端口，放行 Electron / vscode-file 工作台',
      rChrome === false && rElectron === true && rWorkbench === true,
      `chrome=${rChrome}, electron=${rElectron}, workbench=${rWorkbench}`);
  } finally {
    chromeSrv.srv.close();
    electronSrv.srv.close();
    workbenchSrv.srv.close();
  }
}

// ── 4. ideRuntime.ts detectExePath Win11 PowerShell CIM 优先 ──────────
const detectIdx = rtSrc.indexOf('async function detectExeWindows');
const detectBlock = detectIdx >= 0 ? rtSrc.slice(detectIdx, detectIdx + 2400) : '';
gate('R1 ideRuntime.detectExeWindows Step 3 优先 PowerShell Get-CimInstance（Win11 无 wmic 不失效）',
  detectBlock.includes('Get-CimInstance') && detectBlock.includes('runPowerShellAsync'),
  'detectExeWindows 仍仅依赖 wmic');

// ── 5. cdpGate.ts 跨平台重启 + 参数去重 + 清 ELECTRON_RUN_AS_NODE ──────
let cdpMod = null;
try { cdpMod = require2(path.join(root, 'out', 'cdpGate.js')); } catch {}
gate('C1 cdpGate.relaunchWithPort 清洗旧 --remote-debugging-port 参数',
  !!cdpMod && typeof cdpMod.sanitizeCdpLaunchArgs === 'function'
  && JSON.stringify(cdpMod.sanitizeCdpLaunchArgs(['--foo', '--remote-debugging-port=9222', '--bar', '--remote-debugging-port', '9444', '--baz'], 9333))
     === JSON.stringify(['--foo', '--bar', '--baz', '--remote-debugging-port=9333']),
  '未清洗历史 --remote-debugging-port');
gate('C2 cdpGate 支持 POSIX SIGTERM/SIGKILL、清除 ELECTRON_RUN_AS_NODE 且记录失败日志',
  cdpSrc.includes('SIGTERM') && cdpSrc.includes('SIGKILL')
  && cdpSrc.includes('ELECTRON_RUN_AS_NODE')
  && (cdpSrc.includes('logWarn') || cdpSrc.includes('logInfo')),
  '缺少 POSIX 信号、ELECTRON_RUN_AS_NODE 清理或失败日志');

// ── 6. ideStateDb.ts protobuf 安全 ───────────────────────────────────
let dbMod = null;
try { dbMod = require2(path.join(root, 'out', 'ideStateDb.js')); } catch {}
gate('S1 out/ideStateDb.js 导出 updateUserStatusEmail',
  !!dbMod && typeof dbMod.updateUserStatusEmail === 'function',
  'updateUserStatusEmail 未导出');
if (dbMod && typeof dbMod.updateUserStatusEmail === 'function') {
  const encStr = (f, s) => {
    const b = Buffer.from(s, 'utf8');
    return Buffer.concat([Buffer.from([(f << 3) | 2, b.length]), b]);
  };
  // 含 field 1 + field 2 email + field 5 plan
  const orig = Buffer.concat([encStr(1, 'plan-pro'), encStr(2, 'old@x.com'), encStr(5, 'quota-tier')]);
  const updated = dbMod.updateUserStatusEmail(orig, 'new@x.com');
  gate('S2 updateUserStatusEmail 正常更新 field 2 并保留其余字段',
    updated.includes(Buffer.from('plan-pro')) && updated.includes(Buffer.from('quota-tier'))
    && updated.includes(Buffer.from('new@x.com')) && !updated.includes(Buffer.from('old@x.com')));

  // 无 field 2 的合法 protobuf：应保留原字段并追加 field 2，不得退化覆盖掉 plan-pro
  const noEmail = encStr(1, 'plan-ultra');
  const appended = dbMod.updateUserStatusEmail(noEmail, 'u@x.com');
  gate('S3 合法 protobuf 缺失 field 2 时保留原有权益字段并追加 email（不抹套餐）',
    appended.includes(Buffer.from('plan-ultra')) && appended.includes(Buffer.from('u@x.com')),
    appended.toString('hex'));

  // 含未知 wireType=6：必须显式抛错拒绝，不得静默退化成 minimal 抹掉权益
  const corrupt = Buffer.concat([encStr(1, 'plan-ultra'), Buffer.from([(3 << 3) | 6]), encStr(2, 'old@x.com')]);
  let threwOnUnknown = false;
  try {
    dbMod.updateUserStatusEmail(corrupt, 'new@x.com');
  } catch {
    threwOnUnknown = true;
  }
  gate('S4 遇未知 wireType 时显式抛错拒绝覆盖（绝不静默清空套餐权益）', threwOnUnknown, '未抛错且可能静默覆写');

  // 截断 fixed32 (wireType=5)：必须抛错越界保护
  let threwOnTrunc = false;
  try {
    dbMod.updateUserStatusEmail(Buffer.from([(1 << 3) | 5, 0x01, 0x02]), 'new@x.com');
  } catch {
    threwOnTrunc = true;
  }
  gate('S5 截断定长字段 wireType=5/1 触发边界保护抛错', threwOnTrunc, '固定长度读取无边界检查');

  // S6 真实长度 userStatus（base64 > 8192，Row length varint 第二字节=0x41 'A'）必须完整解包 Row.field 1 后保权益更新
  if (typeof dbMod.switchIdeStateIdentity === 'function') {
    const { DatabaseSync } = require2('node:sqlite');
    const tmpDbDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kite-db-s6-'));
    const tmpDbPath = path.join(tmpDbDir, 'state.vscdb');
    const encodeVarint = (n) => {
      const out = [];
      let v = BigInt(n);
      do {
        let b = Number(v & 0x7fn);
        v >>= 7n;
        if (v > 0n) b |= 0x80;
        out.push(b);
      } while (v > 0n);
      return Buffer.from(out);
    };
    const encLD = (f, buf) => Buffer.concat([encodeVarint((f << 3) | 2), encodeVarint(buf.length), buf]);
    const wrapTopic = (key, payload) => {
      const row = encLD(1, Buffer.from(payload.toString('base64'), 'utf8'));
      const de = Buffer.concat([encLD(1, Buffer.from(key, 'utf8')), encLD(2, row)]);
      return encLD(1, de).toString('base64');
    };
    // 构造约 6275 字节的真实尺寸 UserStatus（base64 ~8368 字符 -> varint 为 0xb0 0x41，第二字节为 'A'）
    const bigQuota = Buffer.from('quota-pro-marker-' + 'x'.repeat(6220), 'utf8');
    const bigUserStatus = Buffer.concat([encLD(2, Buffer.from('old@x.com', 'utf8')), encLD(3, bigQuota)]);
    const oauthPayload = encLD(1, Buffer.from('ya29.old', 'utf8'));
    const db = new DatabaseSync(tmpDbPath);
    db.exec('CREATE TABLE ItemTable (key TEXT PRIMARY KEY, value TEXT)');
    db.prepare('INSERT INTO ItemTable (key, value) VALUES (?, ?)').run(
      'antigravityUnifiedStateSync.oauthToken',
      wrapTopic('oauthTokenInfoSentinelKey', oauthPayload)
    );
    db.prepare('INSERT INTO ItemTable (key, value) VALUES (?, ?)').run(
      'antigravityUnifiedStateSync.userStatus',
      wrapTopic('userStatusSentinelKey', bigUserStatus)
    );
    db.close();

    const s6Res = dbMod.switchIdeStateIdentity(
      'new@x.com',
      { accessToken: 'ya29.new', refreshToken: '1//rt', expiryDateSeconds: Math.floor(Date.now() / 1000) + 3600 },
      { dbPath: tmpDbPath }
    );
    const dbVerify = new DatabaseSync(tmpDbPath, { readOnly: true });
    const afterStatusRow = dbVerify.prepare('SELECT value FROM ItemTable WHERE key = ?').get('antigravityUnifiedStateSync.userStatus');
    const afterOnboarding = dbVerify.prepare('SELECT value FROM ItemTable WHERE key = ?').get('agy.onboarding.lastLoginUsername');
    dbVerify.close();
    try { fs.rmSync(tmpDbDir, { recursive: true, force: true }); } catch {}

    let s6Ok = false;
    if (s6Res && s6Res.dbWritten === true && afterStatusRow && afterOnboarding?.value === 'new@x.com') {
      const readV = (buf, o) => {
        let val = 0, shift = 0, p = o;
        while (p < buf.length) { const b = buf[p++]; val += (b & 0x7f) * (2 ** shift); if (!(b & 0x80)) return [val, p]; shift += 7; }
        throw new Error('eof');
      };
      // 按 DataEntry.f2(Row).f1(base64) 严格解包，不依赖正则（避免 varint 字节 0x41='A' 干扰）
      const outer = Buffer.from(String(afterStatusRow.value), 'base64');
      const [, o1] = readV(outer, 0); const [deLen, o2] = readV(outer, o1);
      const de = outer.subarray(o2, o2 + deLen);
      let p = 0, b64Str = '';
      while (p < de.length) {
        const [tag, p1] = readV(de, p); const [len, p2] = readV(de, p1);
        const bytes = de.subarray(p2, p2 + len); p = p2 + len;
        if ((tag >> 3) === 2) {
          const [, rp1] = readV(bytes, 0); const [rLen, rp2] = readV(bytes, rp1);
          b64Str = bytes.subarray(rp2, rp2 + rLen).toString('utf8');
        }
      }
      const inner = Buffer.from(b64Str, 'base64');
      s6Ok = inner.includes(Buffer.from('quota-pro-marker')) && inner.includes(Buffer.from('new@x.com')) && !inner.includes(Buffer.from('old@x.com'));
    }
    gate('S6 长尺寸 UserStatus(>8KB base64, Row varint 含 0x41) 解包保权益且原子写入 onboarding 标记', s6Ok, JSON.stringify(s6Res));
  }
}

// ── 7. oauthService.ts 安全与抗干扰 ──────────────────────────────────
let oauthMod = null;
try { oauthMod = require2(path.join(root, 'out', 'oauthService.js')); } catch {}
gate('O1 oauthService 使用 crypto.randomBytes 生成 state（弃用 Math.random）',
  oauthSrc.includes('randomBytes') && !oauthSrc.includes('Math.random()'),
  '仍在使用 Math.random()');
gate('O2 oauthService failHtml 转义 HTML 特殊字符防反射型 XSS',
  !!oauthMod && typeof oauthMod.failHtml === 'function'
  && !oauthMod.failHtml('<img src=x onerror=alert(1)>').includes('<img src=x'),
  'failHtml 未转义或未导出');
gate('O3 oauthService 遇到错误 state 的杂波请求不终止等待中的 OAuth 流程',
  !/if\s*\(gotState !== state\)[\s\S]{0,180}reject\(/.test(oauthSrc),
  '错误 state 仍调用 cleanup()/reject() 导致正常登录被预请求提前中止');

// ── 8. localReader.ts & updater.ts & httpClient.ts HTTP 安全 ──────────────────────────
gate('H1 localReader.ts 无 += chunk 并下沉至 httpClient.ts 使用 Buffer.concat',
  !/(?:body|data)\s*\+=\s*chunk/.test(lrSrc)
    && httpSrc.includes('Buffer.concat')
    && lrSrc.includes("t('errSqliteUnavailable')"),
  'localReader 仍存在 += chunk、httpClient 缺 Buffer.concat 或未复用 i18n errSqliteUnavailable');
gate('H2 updater.ts 复用 httpClient.ts，使用 Buffer.concat 收包、重定向前清 timer、非 200 resume 排水',
  !/(?:body|data)\s*\+=\s*chunk/.test(updSrc)
    && updSrc.includes("from './httpClient'")
    && httpSrc.includes('Buffer.concat')
    && /REDIRECT_STATUSES[\s\S]{0,180}clearTimer\(\)[\s\S]{0,80}res\.resume\(\)/.test(httpSrc),
  'updater 未委托 httpClient 或 httpClient 缺重定向清理');

// ── 9. 轻量收口清理（K1-K3） ──────────────────────────────────────────
const ssSrc = readSrc('src/seamlessSwitcher.ts');
const pkgManifest = JSON.parse(readSrc('package.json'));
const k1DeadLeft = ['shouldRefreshForSwitch', 'TOKEN_REFRESH_BUFFER_MS', 'clearHostAuth', 'ensureFreshToken']
  .filter((sym) => ssSrc.includes(sym));
gate('K1 seamlessSwitcher.ts 已清理未调用的死函数与废弃常量',
  k1DeadLeft.length === 0,
  '仍残留: ' + k1DeadLeft.join(', '));

const localPathRe = /[A-Za-z]:[\\/](?:Users|Ailoop|project|情报|内容生产|SCRAG)(?:[\\/]|$)/;
const localPathAllow = [
  /[A-Za-z]:[\\/]Users[\\/]test(?![\w-])/i,
  /[A-Za-z]:[\\/]Users[\\/]Test User(?![\w-])/i,
  /[A-Za-z]:[\\/]Users[\\/]<user>(?![\w-])/i,
  /[A-Za-z]:[\\/]project[\\/]demo(?![\w-])/i,
];
const rtLeakLines = rtSrc.split('\n').filter((line) => localPathRe.test(line) && !localPathAllow.some((re) => re.test(line)));
gate('K2 ideRuntime.ts 注释不含触发防泄漏检查的本地路径示例',
  rtLeakLines.length === 0,
  rtLeakLines.join(' | '));

const engineVscode = String(pkgManifest.engines?.vscode || '');
const engineMatch = engineVscode.match(/(\d+)\.(\d+)\./);
const engineOk = !!engineMatch && (Number(engineMatch[1]) > 1 || (Number(engineMatch[1]) === 1 && Number(engineMatch[2]) >= 101));
gate('K3 package.json engines.vscode 已对齐 node:sqlite 所需基线 (>=1.101.0)',
  engineOk,
  `当前 engines.vscode=${engineVscode}`);

try { fs.rmSync(stubDir, { recursive: true, force: true }); } catch {}
console.log(failures === 0 ? '[check_hardening] 全部通过 ✔' : `[check_hardening] ${failures} 项失败 ✘`);
process.exit(failures === 0 ? 0 : 1);
