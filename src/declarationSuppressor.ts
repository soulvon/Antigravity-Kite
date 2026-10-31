/**
 * 安全声明自动确认器（CDP 注入，社区同款架构）
 *
 * 背景（真机实证）：
 * - 声明弹窗由 agy.exe 的 hub 页面渲染（IDE 内跨源 iframe，资源编译进二进制），
 *   扩展 API 无法触及，CDP 是唯一通道（同类 1 万+ 安装插件同结论）。
 * - 弹窗判定 = 页面存储记录的账号 ≠ 当前账号；接受 = 页面自身代码写入存储。
 * - 页面重建（agy 重启换端口）即重新判定，因此需要常驻守护。
 *
 * 架构（对齐 AntiGravity-AutoAccept）：
 * - 每 10s 心跳：枚举 targets → 对未注入的注入一次性 MutationObserver（幂等标记）
 * - observer 死亡（页面重建/上下文清除）→ 标记消失 → 心跳自动重注入
 * - 端口：主端口（设置）→ 兜底 9222（IDE 自带浏览器功能）
 */
import * as http from 'http';
import * as vscode from 'vscode';
import { logInfo, logWarn } from './logger';

/** 心跳间隔：读设置（默认 500ms， clamp 200~5000），每轮动态读取（改设置即时生效） */
function getHeartbeatMs(): number {
  const raw = vscode.workspace.getConfiguration('antigravityKite').get<number>('cdpHeartbeatMs', 500);
  const n = Number(raw);
  if (!Number.isFinite(n)) return 500;
  return Math.min(5000, Math.max(200, n));
}
const INJECTED = new Set<string>(); // CDP target id（/json/list 的 id）

let timer: NodeJS.Timeout | null = null;
let running = false;

function getPort(): number {
  return vscode.workspace.getConfiguration('antigravityKite').get<number>('cdpPort', 9333);
}

function cdpAlive(port: number, timeoutMs = 1500): Promise<boolean> {
  return new Promise((resolve) => {
    const req = http.get(`http://127.0.0.1:${port}/json/version`, { timeout: timeoutMs }, (res) => {
      res.resume();
      resolve(res.statusCode === 200);
    });
    req.on('error', () => resolve(false));
    req.on('timeout', () => { req.destroy(); resolve(false); });
  });
}

/** 探测可用端口：主端口 → 9222 兜底 */
export async function probeCdpPort(): Promise<number | null> {
  const primary = getPort();
  if (await cdpAlive(primary)) return primary;
  if (primary !== 9222 && (await cdpAlive(9222))) return 9222;
  return null;
}

interface TargetInfo { id: string; ws: string }

async function listAppTargets(port: number): Promise<TargetInfo[]> {
  return new Promise((resolve) => {
    const req = http.get(`http://127.0.0.1:${port}/json/list`, { timeout: 2500 }, (res) => {
      let d = '';
      res.on('data', (c) => (d += c));
      res.on('end', () => {
        try {
          const list = JSON.parse(d) as Array<Record<string, unknown>>;
          const out: TargetInfo[] = [];
          for (const t of list) {
            const url = String(t.url || '');
            const id = String(t.id || '');
            const ws = String(t.webSocketDebuggerUrl || '');
            if (!id || !ws) continue;
            if (!url.startsWith('http://127.0.0.1:')) continue;
            if (!(url.includes('/settings-standalone') || url.includes('extensionView=true'))) continue;
            out.push({ id, ws });
          }
          resolve(out);
        } catch {
          resolve([]);
        }
      });
    });
    req.on('error', () => resolve([]));
    req.on('timeout', () => { req.destroy(); resolve([]); });
  });
}

/** 注入脚本：幂等；弹窗出现即勾选并点接受（页面自身代码路径写存储） */
const GUARD_SCRIPT = `(() => {
  if (window.__kiteDeclGuard) return 'already';
  window.__kiteDeclGuard = true;
  const RE = /接受并继续|Accept and continue/i;
  const tryAccept = () => {
    try {
      const btn = Array.from(document.querySelectorAll('button, div[role="button"]'))
        .find((e) => RE.test(e.textContent || ''));
      if (!btn) return;
      const cb = document.querySelector('input[type="checkbox"], [role="checkbox"]');
      if (cb) {
        const ck = cb.checked === true || cb.getAttribute('aria-checked') === 'true';
        if (!ck) cb.click();
      }
      btn.click();
    } catch (e) { /* DOM 结构变化不影响主流程 */ }
  };
  try {
    new MutationObserver(tryAccept).observe(document.documentElement, { childList: true, subtree: true });
  } catch (e) { /* 忽略 */ }
  setInterval(tryAccept, 1500);
  return 'installed';
})()`;

function inject(target: TargetInfo): Promise<boolean> {
  return new Promise((resolve) => {
    let ws: WebSocket;
    let settled = false;
    const done = (ok: boolean) => {
      if (settled) return;
      settled = true;
      try { ws.close(); } catch { /* 已关闭 */ }
      resolve(ok);
    };
    try { ws = new WebSocket(target.ws); } catch { resolve(false); return; }
    const watchdog = setTimeout(() => done(false), 6000);
    ws.onopen = () => {
      try {
        ws.send(JSON.stringify({ id: 1, method: 'Runtime.enable', params: {} }));
        ws.send(JSON.stringify({ id: 2, method: 'Runtime.evaluate', params: { expression: GUARD_SCRIPT, returnByValue: true } }));
      } catch {
        clearTimeout(watchdog);
        done(false);
      }
    };
    ws.onmessage = (ev) => {
      try {
        const m = JSON.parse(String((ev as MessageEvent).data));
        if (m.id === 2) {
          clearTimeout(watchdog);
          done(!!(m.result && m.result.result));
        }
      } catch {
        clearTimeout(watchdog);
        done(false);
      }
    };
    ws.onerror = () => { clearTimeout(watchdog); done(false); };
    ws.onclose = () => { clearTimeout(watchdog); done(false); };
  });
}

async function heartbeat(): Promise<void> {
  const port = await probeCdpPort();
  if (!port) {
    // 端口不在：清空已注入记录，下次端口回来会重新注入
    if (INJECTED.size) INJECTED.clear();
    return;
  }
  const targets = await listAppTargets(port);
  const alive = new Set<string>();
  let injected = 0;
  for (const t of targets) {
    alive.add(t.id);
    if (INJECTED.has(t.id)) continue;
    if (await inject(t)) { INJECTED.add(t.id); injected += 1; }
  }
  // 清理已消失的 target
  for (const id of [...INJECTED]) if (!alive.has(id)) INJECTED.delete(id);
  if (injected > 0) logInfo('declGuard.injected', { port, targets: targets.length, injected });
}

async function tick(): Promise<void> {
  if (running) return;
  running = true;
  try {
    await heartbeat();
  } catch (e) {
    logWarn('declGuard.tick', e);
  } finally {
    running = false;
  }
}

/** 自调度循环：每轮重新读设置（改间隔即时生效） */
function loop(): void {
  timer = setTimeout(() => {
    void (async () => {
      await tick();
      loop();
    })();
  }, getHeartbeatMs());
}

/** 启动守护（静默轮询；端口不可用时自动空转） */
export function startDeclarationSuppressor(): void {
  if (timer) return;
  loop();
  setTimeout(() => { void tick(); }, 1000);
  logInfo('declGuard.start', { heartbeatMs: getHeartbeatMs() });
}

export function stopDeclarationSuppressor(): void {
  if (timer) {
    clearInterval(timer);
    timer = null;
    logInfo('declGuard.stop', {});
  }
}
