#!/usr/bin/env node
/**
 * 弹窗守护诊断工具（IDE 升级后自检用，不参与打包）
 *
 *   node scripts/diag_decl_guard.mjs            只读：列出表面 + 守护注入状态
 *   node scripts/diag_decl_guard.mjs --selftest 注入假弹窗卡片，验证点击链路
 *
 * 前提：IDE 以 --remote-debugging-port 启动（默认 9333）。未开端口会明确报告。
 * 设计依据（2026-11-16 事故）：IDE 1.107.0 起弹窗表面含 vscode-webview://，
 * 旧 scheme 白名单整类漏掉；本工具用与产品一致的黑名单排除法枚举。
 */
import http from 'http';

const PORT = Number(process.env.KITE_CDP_PORT || 9333);
const SELFTEST = process.argv.includes('--selftest');

const EXCLUDE = [/^devtools:\/\//i, /^chrome-extension:\/\//i, /^chrome:\/\//i, /^about:/i, /^data:/i, /^blob:/i];
function excluded(url) {
  if (!url) return 'empty-url';
  for (const re of EXCLUDE) if (re.test(url)) return 'scheme';
  if (url.includes('extensionId=soulvon.antigravity-kite')) return 'self-webview';
  return null;
}

function get(pathname) {
  return new Promise((resolve) => {
    const req = http.get(`http://127.0.0.1:${PORT}${pathname}`, { timeout: 2500 }, (res) => {
      let d = '';
      res.on('data', (c) => (d += c));
      res.on('end', () => { try { resolve(JSON.parse(d)); } catch { resolve(null); } });
    });
    req.on('error', () => resolve(null));
    req.on('timeout', () => { req.destroy(); resolve(null); });
  });
}

function wsEval(wsUrl, expression, timeoutMs = 6000) {
  return new Promise((resolve) => {
    let ws;
    try { ws = new WebSocket(wsUrl); } catch (e) { resolve({ ok: false, error: String(e) }); return; }
    const timer = setTimeout(() => { try { ws.close(); } catch {} resolve({ ok: false, error: 'timeout' }); }, timeoutMs);
    ws.onopen = () => ws.send(JSON.stringify({ id: 1, method: 'Runtime.evaluate', params: { expression, returnByValue: true } }));
    ws.onmessage = (ev) => {
      try {
        const m = JSON.parse(String(ev.data));
        if (m.id === 1) { clearTimeout(timer); try { ws.close(); } catch {} resolve({ ok: true, value: m.result && m.result.result ? m.result.result.value : m.result }); }
      } catch {}
    };
    ws.onerror = () => { clearTimeout(timer); try { ws.close(); } catch {} resolve({ ok: false, error: 'ws_error' }); };
  });
}

const READ = `(() => JSON.stringify({
  guardV: window.__kiteDeclGuardV || null,
  clicks: window.__kiteDeclGuardStat ? window.__kiteDeclGuardStat.clicks : null,
  hits: window.__kiteDeclGuardStat ? window.__kiteDeclGuardStat.hits : null,
  href: location.href.slice(0, 80)
}))()`;

const FAKE = `(() => {
  window.__kiteTestClicked = 0;
  const old = document.getElementById('__kite_fake_card');
  if (old) old.remove();
  const card = document.createElement('div');
  card.id = '__kite_fake_card';
  card.style.cssText = 'all:initial;position:fixed;left:20px;top:20px;z-index:2147483647;background:#fff;color:#111;padding:12px;border:1px solid #333;font:13px sans-serif;';
  card.textContent = 'One last thing before getting started — kite guard self-test';
  const btn = document.createElement('button');
  btn.textContent = 'Continue';
  btn.style.cssText = 'all:initial;display:inline-block;margin-left:8px;padding:4px 10px;background:#0a7;color:#fff;cursor:pointer;';
  btn.onclick = (e) => { e.stopPropagation(); window.__kiteTestClicked = (window.__kiteTestClicked || 0) + 1; try { card.remove(); } catch (err) {} };
  card.appendChild(btn);
  document.body.appendChild(card);
  return 'injected';
})()`;

const READ_FAKE = `(() => JSON.stringify({
  clicked: window.__kiteTestClicked || 0,
  cardGone: !document.getElementById('__kite_fake_card')
}))()`;

const CLEAN = `(() => {
  try { const c = document.getElementById('__kite_fake_card'); if (c) c.remove(); } catch (e) {}
  return 'ok';
})()`;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  const list = await get('/json/list');
  if (!list) {
    console.error(`CDP 127.0.0.1:${PORT} 不可达：IDE 未以 --remote-debugging-port 启动，或端口不同。`);
    console.error('此时弹窗守护整体不可用（kite.log 应有 declGuard.noPort）。');
    process.exitCode = 2;
    return;
  }
  console.log(`CDP 就绪，target ${list.length} 个\n`);
  let fail = 0;
  for (const t of list) {
    if (t.type !== 'page' && t.type !== 'iframe' && t.type !== 'webview') continue;
    const why = excluded(t.url);
    const tag = why ? `SKIP(${why})` : 'GUARD';
    console.log(`[${tag}] ${t.type} ${String(t.url).slice(0, 78)}`);
    if (why) continue;

    const rd = await wsEval(t.webSocketDebuggerUrl, READ);
    let v = rd.value;
    if (typeof v === 'string') { try { v = JSON.parse(v); } catch {} }
    console.log(`         ${rd.ok ? JSON.stringify(v) : 'read FAIL ' + rd.error}`);
    if (!rd.ok) { fail++; continue; }

    if (SELFTEST) {
      const inj = await wsEval(t.webSocketDebuggerUrl, FAKE);
      await sleep(2500);
      const r2 = await wsEval(t.webSocketDebuggerUrl, READ_FAKE);
      let v2 = r2.value;
      if (typeof v2 === 'string') { try { v2 = JSON.parse(v2); } catch {} }
      const ok = v2 && v2.cardGone === true && v2.clicked >= 1;
      console.log(`         selftest: ${ok ? 'PASS' : 'FAIL'} ${JSON.stringify(v2)}`);
      if (!ok) fail++;
      await wsEval(t.webSocketDebuggerUrl, CLEAN);
    }
  }
  if (fail > 0) { console.log(`\n失败 ${fail} 项`); process.exitCode = 1; }
  else console.log('\n全部表面检查通过');
})();
