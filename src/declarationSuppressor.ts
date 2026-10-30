/**
 * 安全声明弹窗自动关闭器（CDP 注入）
 *
 * 背景（真机实证）：
 * - 声明弹窗由 agy.exe 的 hub 页面渲染（IDE 内的跨源 iframe），前端资源编译进 agy.exe，
 *   磁盘无对应文件，无法像扩展那样注入；唯一通道是 `--remote-debugging-port` + CDP
 *   （与 AnyBridge 处理这两个界面的方式一致）。
 * - 弹窗判定 = 面板存储里的 lastLoginUsername ≠ 当前账号 → 切号必弹一次。
 * - 该记录握在 IDE 主进程内存里，外部写 state.vscdb 无效；接受动作由页面自己写回。
 *
 * 因此：注入一个常驻 MutationObserver，弹窗出现即勾选并点「接受并继续」，
 * 用户感知为"一闪而过"。页面重建（agy 重启/换端口）后靠轮询补注入。
 */
import * as http from 'http';
import { logInfo, logWarn } from './logger';

const CDP_PORT = 9333;
const POLL_MS = 2000;

/** 注入脚本：幂等安装，弹窗出现即自动接受 */
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
    } catch (e) { /* 页面结构变化不影响主流程 */ }
  };
  try {
    new MutationObserver(tryAccept).observe(document.documentElement, { childList: true, subtree: true });
  } catch (e) { /* 忽略 */ }
  setInterval(tryAccept, 1200);
  return 'installed';
})()`;

interface CdpTarget {
  url: string;
  ws: string;
}

let timer: NodeJS.Timeout | null = null;
let running = false;

function getJson(url: string, timeoutMs = 2500): Promise<unknown | null> {
  return new Promise((resolve) => {
    const req = http.get(url, { timeout: timeoutMs }, (res) => {
      let d = '';
      res.on('data', (c) => (d += c));
      res.on('end', () => {
        try {
          resolve(JSON.parse(d));
        } catch {
          resolve(null);
        }
      });
    });
    req.on('error', () => resolve(null));
    req.on('timeout', () => {
      req.destroy();
      resolve(null);
    });
  });
}

function isAppTarget(url: string): boolean {
  return url.startsWith('http://127.0.0.1:')
    && (url.includes('/settings-standalone') || url.includes('extensionView=true'));
}

async function listTargets(): Promise<CdpTarget[]> {
  const list = (await getJson(`http://127.0.0.1:${CDP_PORT}/json/list`)) as Array<Record<string, unknown>> | null;
  if (!Array.isArray(list)) return [];
  const out: CdpTarget[] = [];
  for (const item of list) {
    const url = String(item.url || '');
    const ws = String(item.webSocketDebuggerUrl || '');
    if (!url || !ws) continue;
    if (!isAppTarget(url)) continue;
    out.push({ url, ws });
  }
  return out;
}

/** 在单个 target 上执行注入（幂等；失败静默） */
function inject(target: CdpTarget): Promise<boolean> {
  return new Promise((resolve) => {
    let ws: WebSocket;
    let settled = false;
    const done = (ok: boolean) => {
      if (settled) return;
      settled = true;
      try { ws.close(); } catch { /* 已关闭 */ }
      resolve(ok);
    };
    try {
      ws = new WebSocket(target.ws);
    } catch {
      resolve(false);
      return;
    }
    const watchdog = setTimeout(() => done(false), 6000);
    ws.onopen = () => {
      try {
        ws.send(JSON.stringify({ id: 1, method: 'Runtime.evaluate', params: { expression: GUARD_SCRIPT, returnByValue: true } }));
      } catch {
        clearTimeout(watchdog);
        done(false);
      }
    };
    ws.onmessage = (ev) => {
      try {
        const msg = JSON.parse(String((ev as MessageEvent).data));
        if (msg.id === 1) {
          clearTimeout(watchdog);
          done(!!(msg.result && msg.result.result));
        }
      } catch {
        clearTimeout(watchdog);
        done(false);
      }
    };
    ws.onerror = () => {
      clearTimeout(watchdog);
      done(false);
    };
    ws.onclose = () => {
      clearTimeout(watchdog);
      done(false);
    };
  });
}

async function tick(): Promise<void> {
  if (running) return;
  running = true;
  try {
    const targets = await listTargets();
    if (targets.length === 0) return;
    let ok = 0;
    for (const t of targets) {
      if (await inject(t)) ok += 1;
    }
    if (ok > 0) logInfo('declGuard.injected', { targets: targets.length, ok });
  } catch (e) {
    logWarn('declGuard.tick', e);
  } finally {
    running = false;
  }
}

/**
 * 启动守护：静默轮询 CDP，给设置页/Agent 面板注入自动接受脚本。
 * 未开启调试端口时自动空转（每 8 秒一次探测，几乎零开销）。
 */
export function startDeclarationSuppressor(): void {
  if (timer) return;
  timer = setInterval(() => { void tick(); }, POLL_MS);
  // 首次延迟 5 秒（等 IDE 面板就绪）
  setTimeout(() => { void tick(); }, 5000);
  logInfo('declGuard.start', { port: CDP_PORT, intervalMs: POLL_MS });
}

export function stopDeclarationSuppressor(): void {
  if (timer) {
    clearInterval(timer);
    timer = null;
    logInfo('declGuard.stop', {});
  }
}
