#!/usr/bin/env node
/**
 * OAuth 复制授权链接与跨设备手动回调回归门控
 *
 * 覆盖：
 *   1. parseOAuthCallbackInput：完整回调 URL / 无协议 loopback / 空白裁剪 / error 透传 / 错粘授权页拦截 / 空输入拦截
 *   2. createOAuthSession({ openBrowser: false })：不弹本机浏览器、生成合法授权链接、错 state 不中断监听、手动提交回调完成换票并释放端口
 *   3. openInBrowser() 触发 openExternal；cancel() 立即关停端口并以 OAuthCancelledError 结束
 *   4. startManagedOAuthSession 单实例替换：新会话自动清理旧会话端口
 *   5. 侧栏 UI / 宿主消息 / dispose 清理契约全闭合
 */
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const require2 = createRequire(import.meta.url);

// 注入轻量 vscode stub，记录 openExternal 调用
const openExternalCalls = [];
const stubDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kite-oauth-link-stub-'));
fs.mkdirSync(path.join(stubDir, 'vscode'), { recursive: true });
fs.writeFileSync(path.join(stubDir, 'vscode', 'package.json'), JSON.stringify({ name: 'vscode', main: 'index.js' }));
fs.writeFileSync(
  path.join(stubDir, 'vscode', 'index.js'),
  `const calls = [];
  module.exports = {
    __openExternalCalls: calls,
    env: {
      language: 'zh-CN',
      clipboard: { writeText: async () => {} },
      openExternal: async (uri) => { calls.push(String(uri && uri.value ? uri.value : uri)); return true; },
    },
    Uri: {
      parse: (v) => ({ value: String(v), toString: () => String(v) }),
    },
    workspace: {
      getConfiguration: () => ({ get: (_k, d) => d }),
    },
  };`
);
process.env.NODE_PATH = [stubDir, process.env.NODE_PATH].filter(Boolean).join(path.delimiter);
require2('module')._initPaths();

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

function isPortListening(port) {
  return new Promise((resolve) => {
    const socket = net.createConnection({ host: '127.0.0.1', port });
    socket.once('connect', () => {
      socket.destroy();
      resolve(true);
    });
    socket.once('error', () => {
      socket.destroy();
      resolve(false);
    });
  });
}

console.log('=== OAuth 复制链接与手动回调门控 ===\n');

const vscodeStub = require2('vscode');
const httpClient = require2(path.join(root, 'out', 'httpClient.js'));
const oauthMod = require2(path.join(root, 'out', 'oauthService.js'));

gate(
  'L1 oauthService 导出 createOAuthSession / parseOAuthCallbackInput / 管理式会话接口',
  typeof oauthMod.createOAuthSession === 'function'
    && typeof oauthMod.parseOAuthCallbackInput === 'function'
    && typeof oauthMod.startManagedOAuthSession === 'function'
    && typeof oauthMod.submitActiveOAuthCallback === 'function'
    && typeof oauthMod.cancelActiveOAuthSession === 'function'
    && typeof oauthMod.isOAuthCancelledError === 'function'
);

if (typeof oauthMod.parseOAuthCallbackInput === 'function') {
  const p1 = oauthMod.parseOAuthCallbackInput('  http://127.0.0.1:11451/callback?state=st123&code=4%2F0AbcDef&scope=openid  ');
  const p2 = oauthMod.parseOAuthCallbackInput('127.0.0.1:11452/callback?state=st456&code=4/xyz');
  const p3 = oauthMod.parseOAuthCallbackInput('http://localhost:11451/callback?error=access_denied&state=st789');
  const p4 = oauthMod.parseOAuthCallbackInput('https://accounts.google.com/o/oauth2/auth?client_id=abc&redirect_uri=http://127.0.0.1:11451/callback');
  const p5 = oauthMod.parseOAuthCallbackInput('   ');
  const p6 = oauthMod.parseOAuthCallbackInput('?state=st999&code=4/queryOnly');
  gate(
    'L2 parseOAuthCallbackInput 正确解析完整 URL / 无协议 loopback / query / 错误拦截',
    p1.ok === true && p1.code === '4/0AbcDef' && p1.state === 'st123'
      && p2.ok === true && p2.code === '4/xyz' && p2.state === 'st456'
      && p3.ok === false && p3.oauthError === 'access_denied'
      && p4.ok === false && p4.reason === 'auth_url_not_callback'
      && p5.ok === false && p5.reason === 'empty'
      && p6.ok === true && p6.code === '4/queryOnly' && p6.state === 'st999',
    JSON.stringify({ p1, p2, p3, p4, p5, p6 })
  );
} else {
  gate('L2 parseOAuthCallbackInput 正确解析各类回调输入', false, '函数未导出');
}

if (typeof oauthMod.createOAuthSession === 'function') {
  const origHttpRequest = httpClient.httpRequest;
  httpClient.httpRequest = async (url) => {
    if (String(url).includes('oauth2.googleapis.com/token')) {
      return {
        status: 200,
        headers: {},
        body: JSON.stringify({
          access_token: 'ya29.manual-callback-access',
          refresh_token: '1//manual-callback-refresh',
          id_token: 'eyJ.manual.idtoken',
          expires_in: 3600,
        }),
      };
    }
    if (String(url).includes('googleapis.com/oauth2/v2/userinfo')) {
      return {
        status: 200,
        headers: {},
        body: JSON.stringify({
          email: 'alice@example.com',
          name: 'Alice',
        }),
      };
    }
    return origHttpRequest(url);
  };

  try {
    vscodeStub.__openExternalCalls.length = 0;
    const session = await oauthMod.createOAuthSession({ openBrowser: false, timeoutMs: 30_000 });
    const parsedAuthUrl = new URL(session.authUrl);
    const listeningBefore = await isPortListening(session.port);

    gate(
      'L3 createOAuthSession({ openBrowser: false }) 启动监听、生成合法 v2 授权链接且不自动弹窗',
      vscodeStub.__openExternalCalls.length === 0
        && listeningBefore === true
        && parsedAuthUrl.origin === 'https://accounts.google.com'
        && parsedAuthUrl.pathname === '/o/oauth2/v2/auth'
        && parsedAuthUrl.searchParams.get('redirect_uri') === session.redirectUri
        && parsedAuthUrl.searchParams.get('state') === session.state
        && parsedAuthUrl.searchParams.get('access_type') === 'offline'
        && parsedAuthUrl.searchParams.get('prompt') === 'consent',
      `openCalls=${vscodeStub.__openExternalCalls.length}, listening=${listeningBefore}, port=${session.port}`
    );

    // 提交错误 state 必须拒收但不中止监听
    let badStateErr = null;
    try {
      await session.submitCallbackUrl(`http://127.0.0.1:${session.port}/callback?state=wrong-state&code=4/fake`);
    } catch (e) {
      badStateErr = e;
    }
    const stillListening = await isPortListening(session.port);
    gate(
      'L4 手动提交错误 state 回调链接时报错且保持会话存活可重试',
      badStateErr !== null && stillListening === true,
      `err=${badStateErr ? badStateErr.message : 'none'}, listening=${stillListening}`
    );

    // 提交正确回调 URL 完成换票，promise 与返回值一致并关闭端口
    const manualAcc = await session.submitCallbackUrl(
      `http://127.0.0.1:${session.port}/callback?state=${session.state}&code=4%2FvalidCode123&scope=openid`
    );
    const promiseAcc = await session.promise;
    await new Promise((r) => setTimeout(r, 40));
    const listeningAfter = await isPortListening(session.port);
    gate(
      'L5 手动提交正确回调 URL 完成 Token 交换、同步 resolve 会话并关闭本地端口',
      manualAcc.email === 'alice@example.com'
        && manualAcc.refreshToken === '1//manual-callback-refresh'
        && manualAcc.accessToken === 'ya29.manual-callback-access'
        && promiseAcc.email === 'alice@example.com'
        && listeningAfter === false,
      `email=${manualAcc.email}, listeningAfter=${listeningAfter}`
    );

    // openInBrowser + cancel 验证
    const session2 = await oauthMod.createOAuthSession({ openBrowser: false, timeoutMs: 30_000 });
    await session2.openInBrowser();
    const opened = vscodeStub.__openExternalCalls.length === 1 && vscodeStub.__openExternalCalls[0] === session2.authUrl;
    const cancelWait = session2.promise.then(() => null).catch((err) => err);
    session2.cancel();
    const cancelErr = await cancelWait;
    await new Promise((r) => setTimeout(r, 40));
    const listeningAfterCancel = await isPortListening(session2.port);
    gate(
      'L6 openInBrowser 调起外部浏览器，cancel 立即关闭端口并以 OAuthCancelledError 结束',
      opened && oauthMod.isOAuthCancelledError(cancelErr) && listeningAfterCancel === false,
      `opened=${opened}, isCancel=${oauthMod.isOAuthCancelledError(cancelErr)}, listening=${listeningAfterCancel}`
    );

    // 管理式单实例：新会话自动清理旧会话端口（若复用同端口则验证旧 state 已被拒绝，绝无幽灵旧会话）
    const m1 = await oauthMod.startManagedOAuthSession({ openBrowser: false, timeoutMs: 30_000 });
    const m1ErrPromise = m1.promise.then(() => null).catch((e) => e);
    const m2 = await oauthMod.startManagedOAuthSession({ openBrowser: false, timeoutMs: 30_000 });
    const m1Err = await m1ErrPromise;
    await new Promise((r) => setTimeout(r, 40));
    const m2ListeningBeforeCancel = await isPortListening(m2.port);
    const oldPortOk = m1.port === m2.port
      ? (await fetch(`http://127.0.0.1:${m2.port}/callback?state=${m1.state}&code=4/stale`)).status === 400
      : !(await isPortListening(m1.port));
    const m2ErrPromise = m2.promise.then(() => null).catch((e) => e);
    oauthMod.cancelActiveOAuthSession();
    await m2ErrPromise;
    await new Promise((r) => setTimeout(r, 40));
    const m2ListeningAfterCancel = await isPortListening(m2.port);
    gate(
      'L7 管理式 OAuth 会话新开时自动取消旧会话并释放端口（无幽灵监听）',
      oauthMod.isOAuthCancelledError(m1Err)
        && m2ListeningBeforeCancel === true
        && oldPortOk === true
        && m2ListeningAfterCancel === false,
      `m1Port=${m1.port}, m2Port=${m2.port}, oldPortOk=${oldPortOk}, afterCancel=${m2ListeningAfterCancel}`
    );
  } finally {
    httpClient.httpRequest = origHttpRequest;
  }
}

// 静态前后端契约检查
const sidebarHtml = fs.readFileSync(path.join(root, 'resources', 'webview', 'sidebar.html'), 'utf8');
const sidebarJs = fs.readFileSync(path.join(root, 'resources', 'webview', 'sidebar.js'), 'utf8');
const sidebarProvider = fs.readFileSync(path.join(root, 'src', 'sidebarProvider.ts'), 'utf8');

const uiContractOk = sidebarHtml.includes('id="btnOAuth"')
  && !sidebarHtml.includes('id="btnOAuthLink"')
  && sidebarHtml.includes('id="oauthModal"')
  && sidebarHtml.includes('id="oauthAuthUrl"')
  && sidebarHtml.includes('id="oauthCopyBtn"')
  && sidebarHtml.includes('id="oauthOpenBrowserBtn"')
  && sidebarHtml.includes('id="oauthCallbackInput"')
  && sidebarHtml.includes('id="oauthSubmitBtn"')
  && sidebarHtml.includes('id="oauthRegenerateBtn"')
  && sidebarHtml.includes('id="oauthCancelBtn"')
  && sidebarJs.includes("{ type: 'oauthLogin', openBrowser: false, copyUrl: false }")
  && sidebarJs.includes("type: 'oauthCopyUrl'")
  && sidebarJs.includes("type: 'oauthOpenBrowser'")
  && sidebarJs.includes("type: 'oauthSubmitCallback'")
  && sidebarJs.includes("type: 'oauthCancel'")
  && sidebarJs.includes("msg.type === 'oauthSession'")
  && sidebarProvider.includes("case 'oauthCopyUrl':")
  && sidebarProvider.includes("case 'oauthOpenBrowser':")
  && sidebarProvider.includes("case 'oauthSubmitCallback':")
  && sidebarProvider.includes("case 'oauthCancel':")
  && /dispose\(\):\s*void\s*\{[\s\S]*cancelActiveOAuthSession\(\)/.test(sidebarProvider);

gate('L8 侧栏单一 OAuth 入口 / 紧贴复制按钮弹窗 / 消息与 dispose 清理契约全闭合', uiContractOk);

try { fs.rmSync(stubDir, { recursive: true, force: true }); } catch {}
console.log(`\nOAuth 复制链接门控结果: ${passed} 通过, ${failed} 失败`);
process.exit(failed > 0 ? 1 : 0);
