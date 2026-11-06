/**
 * 安全声明与首次引导自动确认器（CDP 注入，社区同款架构）
 *
 * 背景（真机实证）：
 * - 声明弹窗由 agy.exe 的 hub 页面渲染（IDE 内跨源 iframe，资源编译进二进制），
 *   扩展 API 无法触及，CDP 是唯一通道（同类 1 万+ 安装插件同结论）。
 * - 弹窗判定 = 页面存储记录的账号 ≠ 当前账号；接受 = 页面自身代码写入存储。
 * - 新版或切号后新增 "One last thing before getting started..." 设置/条款卡片，按钮为“继续 / Continue”。
 * - 该卡片的按钮不一定是 <button>（实测 workbench 里按文本找得到文案、找不到 button 元素），
 *   所以选择器必须按"文本 + 可点击性（tag/role/onclick/cursor:pointer）"放宽，并穿透 Shadow DOM。
 * - 页面重建（agy 重启换端口）即重新判定，因此需要常驻守护。
 *
 * 架构：
 * - 动态探测多端口：配置端口（默认 9333）→ DevToolsActivePort（动态分配）→ 9222 兜底
 * - 每个 target 维持一条常驻 WebSocket（断线自动重连），页面导航时用
 *   Page.addScriptToEvaluateOnNewDocument 预置脚本，卡片一出现就能点到，不等心跳恢复
 * - 心跳只做存活探针（window 标记），脚本丢失（页面重建/上下文清除）立即重装
 * - 脚本内部用 MutationObserver + 定时扫描；深扫有 2.5s 节流，避免文档里出现同款文案时空转
 */
import * as http from 'http';
import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { logInfo, logWarn } from './logger';
import { getAppDataDir } from './platformPaths';

/** 心跳间隔：读设置（默认 500ms， clamp 200~5000），每轮动态读取（改设置即时生效） */
function getHeartbeatMs(): number {
  const raw = vscode.workspace.getConfiguration('antigravityKite').get<number>('cdpHeartbeatMs', 500);
  const n = Number(raw);
  if (!Number.isFinite(n)) return 500;
  return Math.min(5000, Math.max(200, n));
}

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

/** 从 DevToolsActivePort 文件读取 Chromium/Electron 动态分配的调试端口 */
export function readDevToolsActivePort(appDataName: string): number | null {
  try {
    const base = getAppDataDir();
    const p = path.join(base, appDataName, 'DevToolsActivePort');
    if (fs.existsSync(p)) {
      const line = fs.readFileSync(p, 'utf8').split('\n')[0]?.trim();
      const port = Number(line);
      if (Number.isFinite(port) && port > 0 && port < 65536) return port;
    }
  } catch { }
  return null;
}

/** 探测所有当前存活的 CDP 调试端口（配置端口、DevToolsActivePort、9222 兜底） */
export async function getAliveCdpPorts(): Promise<number[]> {
  const candidates = new Set<number>();
  const primary = getPort();
  if (primary) candidates.add(primary);
  candidates.add(9222);

  const appDataDirs = ['Antigravity IDE', 'Antigravity', 'Antigravity IDE - Next'];
  for (const d of appDataDirs) {
    const p = readDevToolsActivePort(d);
    if (p) candidates.add(p);
  }

  const alive: number[] = [];
  for (const p of candidates) {
    if (await cdpAlive(p)) alive.push(p);
  }
  return alive;
}

/** 探测可用端口：优先配置端口，依次尝试存活端口 */
export async function probeCdpPort(): Promise<number | null> {
  const ports = await getAliveCdpPorts();
  return ports.length > 0 ? ports[0] : null;
}

interface TargetInfo { id: string; ws: string; type: string }

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
            const type = String(t.type || '');
            if (!id || !ws) continue;
            // 忽略非网页节点（如 worker/service_worker/node 等）
            if (type !== 'page' && type !== 'iframe') continue;
            // 排除自身扩展的 webview
            if (url.includes('extensionId=soulvon.antigravity-kite')) continue;

            // 匹配本地 127.0.0.1 / localhost 上的 http / https 页面，以及 vscode 内部页面
            const isLocalWeb =
              url.startsWith('http://127.0.0.1:') ||
              url.startsWith('https://127.0.0.1:') ||
              url.startsWith('http://localhost:') ||
              url.startsWith('https://localhost:');
            const isVscodePage = url.startsWith('vscode-file://') || url.startsWith('vscode-webview://');
            if (isLocalWeb || isVscodePage) {
              out.push({ id, ws, type });
            }
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

/**
 * 注入脚本：安装一次 observer（幂等），每次调用都扫一遍并回报统计。
 * 关键点：
 * - 穿透 Shadow DOM（Web Component 化的 UI 里 querySelectorAll 找不到按钮）
 * - 完整指针事件序列（React/WebComponents 需要 pointerdown/mousedown/pointerup/mouseup/click）
 * - 按钮识别按"文本 + 可点击性"放宽：按钮不一定是 <button>
 * - 点击后 900ms 复检卡片是否消失（afterClickGone），点击无效时能被日志抓到
 */
const GUARD_SCRIPT = `(() => {
  const stat = window.__kiteDeclGuardStat || {
    scans: 0, deepScans: 0, hits: 0, clicks: 0, lastHit: '', afterClickGone: null, lastDeepAt: 0
  };
  window.__kiteDeclGuardStat = stat;

  const clickEl = (el) => {
    if (!el) return;
    try {
      if (typeof el.focus === 'function') el.focus();
      const rect = el.getBoundingClientRect();
      const opts = {
        bubbles: true, cancelable: true, composed: true, view: window,
        clientX: rect.left + rect.width / 2, clientY: rect.top + rect.height / 2, button: 0
      };
      try { el.dispatchEvent(new PointerEvent('pointerdown', opts)); } catch (e) {}
      el.dispatchEvent(new MouseEvent('mousedown', opts));
      try { el.dispatchEvent(new PointerEvent('pointerup', opts)); } catch (e) {}
      el.dispatchEvent(new MouseEvent('mouseup', opts));
      el.dispatchEvent(new MouseEvent('click', opts));
      if (typeof el.click === 'function') el.click();
    } catch (e) {}
  };

  const walkAll = (root, visit, depth) => {
    if (!root || depth > 14 || !root.querySelectorAll) return;
    let nodes;
    try { nodes = root.querySelectorAll('*'); } catch (e) { return; }
    for (const el of nodes) {
      visit(el);
      if (el.shadowRoot) walkAll(el.shadowRoot, visit, depth + 1);
    }
  };

  const textOf = (el) => ((el && el.textContent) || '').trim();
  const isChecked = (el) => el.checked === true || (el.getAttribute && el.getAttribute('aria-checked') === 'true');

  const isClickable = (el) => {
    const tag = el.tagName;
    const role = el.getAttribute ? (el.getAttribute('role') || '') : '';
    if (tag === 'BUTTON' || tag === 'A' || role === 'button') return true;
    try { if (el.onclick) return true; } catch (e) {}
    try { return window.getComputedStyle(el).cursor === 'pointer'; } catch (e) { return false; }
  };

  const findClickable = (root, re) => {
    let hit = null;
    walkAll(root, (el) => {
      if (hit) return;
      const t = textOf(el);
      if (!t || t.length > 16) return;
      if (!re.test(t)) return;
      if (!isClickable(el)) return;
      hit = el;
    }, 0);
    return hit;
  };

  /** 含关键字的"最小"元素 = 卡片本体（文本量最少才算最内层） */
  const findCard = (keyword) => {
    let best = null;
    let bestLen = Infinity;
    walkAll(document, (el) => {
      const t = textOf(el);
      if (!t || t.length > 4000 || t.length >= bestLen) return;
      if (t.indexOf(keyword) < 0) return;
      best = el;
      bestLen = t.length;
    }, 0);
    return best;
  };

  /**
   * 锚点常常只是标题（实测命中 H2.text-lg），按钮在最外层卡片容器里，
   * 所以必须从锚点向上逐层找"含主按钮"的祖先，否则永远点不到。
   */
  const ANCHOR_KEYWORDS = [
    'One last thing before getting started',
    'A few things to know',
    'Help us improve Antigravity',
    '开始之前', '最后一步', '帮助我们改进'
  ];
  const CONTINUE_RE = /^(继续|下一步|知道了|我明白了|开始使用|开始|确定|好的|完成|Continue|Next|Start|Got it|Done|OK)$/i;

  const findOnboardingCard = () => {
    let anchor = null;
    for (const kw of ANCHOR_KEYWORDS) {
      anchor = findCard(kw);
      if (anchor) break;
    }
    if (!anchor) return null;
    let node = anchor;
    for (let i = 0; i < 14 && node && node !== document.body; i++) {
      if (findClickable(node, CONTINUE_RE) || findClickable(node, /继续|Continue|下一步|Next/i)) return node;
      node = node.parentElement;
    }
    return anchor;
  };

  /** 兜底：卡片里最靠右下的可点击元素就是主按钮（不依赖文案，汉化版也能点） */
  const pickPrimaryButton = (card) => {
    let best = null;
    let bestScore = -Infinity;
    let cardRect;
    try { cardRect = card.getBoundingClientRect(); } catch (e) { return null; }
    if (!cardRect || cardRect.width < 100) return null;
    walkAll(card, (el) => {
      if (!isClickable(el)) return;
      let r;
      try { r = el.getBoundingClientRect(); } catch (e) { return; }
      if (!r || r.width < 48 || r.height < 22) return;
      if (r.width > cardRect.width * 0.9) return;
      const score = ((r.right - cardRect.left) / cardRect.width) * 2 + (r.bottom - cardRect.top) / cardRect.height;
      if (score > bestScore) { bestScore = score; best = el; }
    }, 0);
    return best;
  };

  // 点击前先把浮层藏起来，避免"卡片出现→消失"的闪烁；点不掉时 1.2s 后恢复可见
  let hiddenEl = null;
  const hideOverlay = (el) => {
    try {
      let node = el;
      let target = el;
      for (let i = 0; i < 8 && node; i++) {
        const cs = window.getComputedStyle(node);
        if (cs && (cs.position === 'fixed' || cs.position === 'absolute')) target = node;
        node = node.parentElement;
      }
      target.style.visibility = 'hidden';
      hiddenEl = target;
    } catch (e) {}
  };
  const restoreHidden = () => {
    if (!hiddenEl) return;
    try { hiddenEl.style.visibility = ''; } catch (e) {}
    hiddenEl = null;
  };

  const tryAccept = () => {
    try {
      stat.scans += 1;
      let quick = '';
      try { quick = (document.body ? document.body.textContent : '') || ''; } catch (e) {}

      const quickHit =
        quick.indexOf('One last thing before getting started') >= 0 ||
        quick.indexOf('A few things to know') >= 0 ||
        quick.indexOf('Help us improve Antigravity') >= 0 ||
        quick.indexOf('接受并继续') >= 0 || quick.indexOf('Accept and continue') >= 0;

      const needDeep = quickHit || (stat.scans % 8 === 0);
      if (!needDeep) return;
      // 深扫节流：workspace 里的文档也可能出现同款英文文案，全量遍历必须压到 1.5s 一次
      const gap = quickHit ? 1500 : 4000;
      if (Date.now() - (stat.lastDeepAt || 0) < gap) return;
      stat.lastDeepAt = Date.now();
      stat.deepScans += 1;

      // 场景 1: 经典 "接受并继续"
      const classicRe = /接受并继续|Accept and continue|我同意|I agree/i;
      const classicBtn = findClickable(document, classicRe);
      if (classicBtn) {
        stat.hits += 1; stat.lastHit = 'classic';
        walkAll(document, (el) => {
          const isCb = (el.tagName === 'INPUT' && el.type === 'checkbox')
            || (el.getAttribute && el.getAttribute('role') === 'checkbox');
          if (isCb && !isChecked(el)) clickEl(el);
        }, 0);
        clickEl(classicBtn);
        stat.clicks += 1;
        return;
      }

      // 场景 2: "One last thing before getting started..." 引导卡片
      const card = findOnboardingCard();
      if (!card) return;
      stat.hits += 1; stat.lastHit = 'onboarding';

      // 只勾必选条款项，不碰 "Stay up to date" 这类可选营销项
      walkAll(card, (el) => {
        const isCb = (el.tagName === 'INPUT' && el.type === 'checkbox')
          || (el.getAttribute && el.getAttribute('role') === 'checkbox');
        if (!isCb || isChecked(el)) return;
        const p = el.closest('label, div') || el.parentElement;
        const t = p ? (p.innerText || p.textContent || '') : '';
        if (t.indexOf('Help us improve') >= 0 || t.indexOf('服务条款') >= 0 ||
            t.indexOf('Privacy Policy') >= 0 || t.indexOf('Terms') >= 0) {
          clickEl(el);
        }
      }, 0);

      const btn = findClickable(card, CONTINUE_RE)
        || findClickable(card, /继续|Continue|下一步|Next/i)
        // 兜底：引导卡片在场时，页面上唯一的"继续"就是它（实测按钮在 agy 的 webview 里）
        || findClickable(document, CONTINUE_RE)
        || pickPrimaryButton(card);
      if (btn) {
        hideOverlay(btn);
        clickEl(btn);
        stat.clicks += 1;
        setTimeout(() => {
          const still = findOnboardingCard();
          stat.afterClickGone = !still;
          if (still) restoreHidden();
        }, 1200);
      }
    } catch (e) {}
  };

  // 版本号：脚本升级后必须能顶掉旧闭包，否则页面里永远跑的是旧逻辑（踩过）
  const GUARD_VERSION = 3;
  const install = () => {
    if (window.__kiteDeclGuardV === GUARD_VERSION) { tryAccept(); return; }
    try { if (window.__kiteDeclGuardTimer) clearInterval(window.__kiteDeclGuardTimer); } catch (e) {}
    try { if (window.__kiteDeclGuardObserver) window.__kiteDeclGuardObserver.disconnect(); } catch (e) {}
    window.__kiteDeclGuardV = GUARD_VERSION;
    window.__kiteDeclGuardInstalled = true;
    try {
      const mo = new MutationObserver(() => setTimeout(tryAccept, 60));
      mo.observe(document.documentElement, { childList: true, subtree: true, characterData: true });
      window.__kiteDeclGuardObserver = mo;
    } catch (e) {}
    window.__kiteDeclGuardTimer = setInterval(tryAccept, 800);
    tryAccept();
  };

  // Page.addScriptToEvaluateOnNewDocument 会在文档解析前执行，此时 documentElement 还不存在
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', install, { once: true });
  } else {
    install();
  }
  return JSON.stringify(stat);
})()`;

/** 存活探针：页面重建或脚本版本落后时都会返回 missing，触发重装（版本号与 GUARD_SCRIPT 内 GUARD_VERSION 保持一致） */
const ALIVE_PROBE = `(() => (window.__kiteDeclGuardV === 3 ? 'ok' : 'missing'))()`;

/**
 * 常驻 CDP 会话：一条 WebSocket 反复 evaluate，断线由心跳重建。
 * 顺带用 Page.addScriptToEvaluateOnNewDocument 把守卫预置到后续导航，
 * 这样页面重建到脚本就位的窗口期趋近于零。
 */
class CdpSession {
  private ws: WebSocket | null = null;
  private nextId = 1;
  private opened = false;
  private readonly pending = new Map<number, (value: unknown) => void>();

  /**
   * persistScript=true 时把守卫预置到该 target 的后续导航。
   * 只对 page（workbench / hub 主页）开启：iframe 多为其他扩展的 webview，
   * 往别人页面里常驻注入脚本没有必要且会干扰它们。
   */
  constructor(
    private readonly url: string,
    private readonly persistScript: boolean,
    private readonly onDead: () => void,
  ) {}

  isOpen(): boolean {
    return this.opened && this.ws !== null;
  }

  connect(): Promise<boolean> {
    return new Promise((resolve) => {
      let ws: WebSocket;
      try { ws = new WebSocket(this.url); } catch { resolve(false); return; }
      this.ws = ws;
      let settled = false;
      const watchdog = setTimeout(() => {
        if (!settled) { settled = true; this.close(); resolve(false); }
      }, 6000);

      ws.onopen = () => {
        if (settled) return;
        settled = true;
        clearTimeout(watchdog);
        this.opened = true;
        // 仅 page 预置到后续导航；失败不影响当前页面注入
        if (this.persistScript) {
          void this.send('Page.addScriptToEvaluateOnNewDocument', { source: GUARD_SCRIPT });
        }
        resolve(true);
      };
      ws.onmessage = (ev) => {
        try {
          const m = JSON.parse(String((ev as MessageEvent).data)) as { id?: number; result?: unknown };
          if (typeof m.id === 'number') {
            const fn = this.pending.get(m.id);
            if (fn) { this.pending.delete(m.id); fn(m.result); }
          }
        } catch { /* 非 JSON 事件忽略 */ }
      };
      ws.onerror = () => {
        if (!settled) { settled = true; clearTimeout(watchdog); this.close(); resolve(false); }
      };
      ws.onclose = () => {
        this.opened = false;
        this.ws = null;
        for (const fn of this.pending.values()) fn(undefined);
        this.pending.clear();
        this.onDead();
        if (!settled) { settled = true; clearTimeout(watchdog); resolve(false); }
      };
    });
  }

  send(method: string, params: Record<string, unknown>): Promise<unknown> {
    return new Promise((resolve) => {
      const ws = this.ws;
      if (!ws || !this.opened) { resolve(undefined); return; }
      const id = this.nextId++;
      const timer = setTimeout(() => { this.pending.delete(id); resolve(undefined); }, 4000);
      this.pending.set(id, (value) => { clearTimeout(timer); resolve(value); });
      try {
        ws.send(JSON.stringify({ id, method, params }));
      } catch {
        clearTimeout(timer);
        this.pending.delete(id);
        resolve(undefined);
      }
    });
  }

  async evaluate(expression: string): Promise<unknown> {
    const res = await this.send('Runtime.evaluate', { expression, returnByValue: true }) as
      { result?: { value?: unknown } } | undefined;
    return res?.result?.value;
  }

  close(): void {
    const ws = this.ws;
    this.ws = null;
    this.opened = false;
    try { ws?.close(); } catch { /* 已关闭 */ }
  }
}

interface GuardStat {
  scans?: number;
  deepScans?: number;
  hits?: number;
  clicks?: number;
  lastHit?: string;
  afterClickGone?: boolean | null;
}

const SESSIONS = new Map<string, CdpSession>();
/** 已上报过的点击次数，避免每轮心跳重复写日志 */
let reportedClicks = 0;
/** 是否已记录过"看到卡片但没点到"的证据 */
let seenLogged = false;
let tickCount = 0;

async function heartbeat(): Promise<void> {
  tickCount += 1;
  const ports = await getAliveCdpPorts();
  if (ports.length === 0) {
    for (const s of SESSIONS.values()) s.close();
    SESSIONS.clear();
    return;
  }

  const alive = new Set<string>();
  let attached = 0;

  for (const port of ports) {
    const targets = await listAppTargets(port);
    for (const t of targets) {
      const key = `${port}:${t.id}`;
      alive.add(key);

      let session = SESSIONS.get(key);
      if (!session || !session.isOpen()) {
        if (session) { session.close(); SESSIONS.delete(key); }
        session = new CdpSession(t.ws, t.type === 'page', () => SESSIONS.delete(key));
        if (!(await session.connect())) {
          session.close();
          continue;
        }
        SESSIONS.set(key, session);
        attached += 1;
      }

      // 存活探针：页面重建（导航）后标记消失，立刻重装守卫
      const probe = await session.evaluate(ALIVE_PROBE);
      const needInject = probe !== 'ok';
      // 每 3 次心跳额外跑一次完整脚本，把页面内的统计取回来（否则点了也不知道）
      if (needInject || tickCount % 3 === 0) {
        const statRaw = await session.evaluate(GUARD_SCRIPT);
        if (typeof statRaw === 'string') {
          try {
            const st = JSON.parse(statRaw) as GuardStat;
            if (st.clicks && st.clicks > reportedClicks) {
              reportedClicks = st.clicks;
              logInfo('declGuard.accepted', {
                port,
                clicks: st.clicks,
                hit: st.lastHit,
                cardGone: st.afterClickGone,
              });
            } else if (st.hits && !seenLogged) {
              // 看得到卡片却没点到：留一条证据，方便定位按钮结构
              seenLogged = true;
              logInfo('declGuard.seen', { port, hit: st.lastHit, clicks: st.clicks || 0 });
            }
          } catch { /* 统计解析失败不影响守护 */ }
        }
      }
    }
  }

  // 清理已消失的 target
  for (const key of [...SESSIONS.keys()]) {
    if (!alive.has(key)) { SESSIONS.get(key)?.close(); SESSIONS.delete(key); }
  }
  if (attached > 0) logInfo('declGuard.attached', { ports, attached, targets: alive.size });
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
    clearTimeout(timer);
    timer = null;
    for (const s of SESSIONS.values()) s.close();
    SESSIONS.clear();
    logInfo('declGuard.stop', {});
  }
}
