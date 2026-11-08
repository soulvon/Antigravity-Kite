/**
 * 底部状态栏管理器（v1.1.16 重构：对标 12 家同类 + BuddyRelay 范式）
 *
 * 设计：
 *   [右·主]  $(account) 账号前缀 🟢 98% 🪙 87.5 —— smart 聚合段（默认）：账号+最紧额度+点数，异常才升级
 *   [右·副]  池 3/5（无图标）       —— 号池统计，点击开侧栏
 *
 * 模式收敛（对标结论）：
 * - 默认单段聚合，详情下沉 tooltip / QuickPick（Copilot 官方、Gravity Orchestrator、BuddyRelay 同款）
 * - 变色取"最吃紧"一档：min(各窗口) 决定，<30 警告底 / <10 错误底（社区阈值收敛区）
 * - 健康态上栏：封禁=🚫 红底、登录失效=🔑 橙底、检测异常=❓ 不亮底（额度色点 🟢🟡🟠🔴）
 *   （元数据端点对封禁隐身，额度满格 ≠ 健康——v1.1.14 实测定案）
 * - 点击弹混合菜单：账号按最紧额度降序（最优号在顶，BoyGR 模式）+ 快捷操作区（BuddyRelay 模式）
 * - 数据管线合一：不再自建定时抓取，走 extension.ts 的共享 usageCache + 统一刷新管线（deps 注入）
 * - 平铺样式（labeled/full）保留给重度用户（自定义丰富），标签唯一权威源是 usageService.label
 *
 * 特性：
 * - 6 档旧样式全保留，新增 smart 聚合段并设为默认（validateStyle 兜底非法值）
 * - 订阅账号变化 / 配置变化事件，自动重绘；健康翻转由 persistHealthIfChanged 触发重绘
 */
import * as vscode from 'vscode';
import * as accountStore from './accountStore';
import { UsageSnapshot, AccountHealth, StoredAccount, ModelQuota } from './types';
import { t } from './i18n';
import { notifyUi } from './uiChannel';

/** 状态栏左段信息密度：smart 聚合段（默认，账号+最紧额度）；dot/percent/compact/dual 极简；labeled/full 平铺 */
export type StatusBarStyle = 'smart' | 'dot' | 'percent' | 'compact' | 'dual' | 'labeled' | 'full';

export type StatusBarPosition = 'left' | 'right';

const VALID_STYLES: StatusBarStyle[] = ['smart', 'dot', 'percent', 'compact', 'dual', 'labeled', 'full'];
const VALID_POSITIONS: StatusBarPosition[] = ['left', 'right'];

const OPEN_SIDEBAR_CMD = 'antigravityKite.openSidebar';

/** 样式白名单校验：非法值回退 smart（读失败 = 未知，走默认保守路径） */
export function validateStyle(v: string): StatusBarStyle {
  return VALID_STYLES.includes(v as StatusBarStyle) ? (v as StatusBarStyle) : 'smart';
}

/**
 * 健康态 → 底栏标记。异常才亮牌：ok 与未检测返回空标记。
 * bg 用官方语义色（error/warning background 是官方告警条款的合理使用：额度监控类的危险档）。
 */
export function pickHealthMark(health?: AccountHealth): { icon: string; bg: 'error' | 'warning' | undefined } {
  switch (health?.status) {
    case 'banned':
      return { icon: '🚫', bg: 'error' };
    case 'auth_invalid':
      return { icon: '🔑', bg: 'warning' };
    case 'unknown':
      return { icon: '❓', bg: undefined };
    default:
      return { icon: '', bg: undefined };
  }
}

/** 额度四档 emoji 色点：绿 ≥50 / 黄 30-50 / 橙 10-30 / 红 <10（参考项目收敛阈值） */
export function colorDot(pct: number): string {
  if (pct >= 50) return '🟢';
  if (pct >= 30) return '🟡';
  if (pct >= 10) return '🟠';
  return '🔴';
}

/**
 * 重置倒计时（对标 Manager 的 🕐 窗口回血提示）：取过滤后窗口中"最近即将重置"的一个。
 * 无未来重置时间（数据缺失/全部过期）返回空串——没信息不占位。
 */
export function formatResetHint(models: ModelQuota[]): string {
  const now = Date.now();
  const times = models
    .map(m => (m.resetTime ? new Date(m.resetTime).getTime() : NaN))
    .filter(t => Number.isFinite(t) && t > now);
  if (times.length === 0) return '';
  return '🕐 ' + fmtDuration(Math.min(...times) - now);
}

/**
 * 额度族分格（多池多窗口的紧凑表达，Wanow 斜杠范式）：
 * Claude / Gemini / Gemini 4 是三个独立配额池，各一格；
 * 族内 5h 与周额度斜杠并排（96%/100%），缺失窗口只显已有的——不对称账号天然兼容；
 * 色点取族内最紧窗口（变色取"最吃紧"一档的收敛共识）。
 */
export function formatFamilySegments(models: ModelQuota[], families?: Set<string>): string {
  const FAMILIES: { key: string; label: string }[] = [
    { key: 'claude', label: 'Claude' },
    { key: 'gemini', label: 'Gemini' },
    { key: 'argon', label: 'Gemini 4' },
  ];
  const segments: string[] = [];
  for (const fam of FAMILIES) {
    if (families && !families.has(fam.key)) continue; // 用户关掉的池不显示（"某个池不用"）
    const five = models.find(m => m.modelId === fam.key + ':5h');
    const week = models.find(m => m.modelId === fam.key + ':weekly');
    if (!five && !week) continue; // 该池无数据就不渲染（没有数据就没有发言权）
    const pcts = [five?.remainingPercent, week?.remainingPercent].filter((v): v is number => typeof v === 'number');
    const dot = colorDot(Math.min(...pcts));
    const pair = pcts.map(v => v + '%').join('/');
    segments.push(dot + ' ' + fam.label + ' ' + pair);
  }
  return segments.join(' · ');
}

/** 邮箱脱敏（与 webview 端 maskEmail 同一逻辑的宿主侧实现）：soulvon2501@gmail.com → so***1@*** */
export function maskEmailStr(email: string): string {
  if (!email) return '';
  const at = email.indexOf('@');
  if (at <= 0) return email.slice(0, 2) + '***';
  const name = email.slice(0, at);
  const domain = email.slice(at + 1);
  const maskedName = name.length <= 2 ? name[0] + '***' : name.slice(0, 2) + '***' + name.slice(-1);
  return maskedName + '@***';
}

/** 隐私模式显示名：开着就脱敏，闭着用原文 */
function displayName(email: string, privacy: boolean): string {
  return privacy ? maskEmailStr(email) : email;
}

/**
 * AI 点数显示（🪙 金币图标 + 数值）。账号没有点数（undefined/null）返回空串——没点数就不显示，
 * 有点数的账号在 smart/dual/full/tooltip/QuickPick 全部带 🪙 图标露出。
 */
export function formatCredits(v: number | null | undefined): string {
  if (v === undefined || v === null || !Number.isFinite(v)) return '';
  const n = Number.isInteger(v) ? String(v) : String(Math.round(v * 100) / 100);
  return '🪙 ' + n;
}

/**
 * 会员级别文案：大驼峰，Ultra 保留官方倍数后缀（Ultra 5x / Ultra 20x）。
 * 关键词表与 Manager normalize_subscription_tier 对齐（helium/starter/standard/gcp_ 全覆盖）。
 * 与 webview 模板内 planTierLabel 同 spec 双载（maskEmailStr/maskEmail 同款套路）。
 */
export function displayTierLabel(tierId: string): string {
  const s = String(tierId);
  const t = s.toLowerCase();
  const mult = /(\d+x)/i.exec(s);
  if (t.includes('ultra') || t.includes('helium')) return 'Ultra' + (mult ? ' ' + mult[1] : '');
  if (t.includes('plus')) return 'Plus';
  if (t.includes('free') || t.includes('starter')) return 'Free';
  if (t.includes('pro') || t.includes('premium') || t.includes('advanced')) return 'Pro';
  if (t.includes('trial')) return 'Trial';
  if (t.includes('enterprise') || t.includes('standard') || t.includes('business') || t.startsWith('gcp_') || t.includes('vertex')) return 'Enterprise';
  if (t.includes('team')) return 'Team';
  return s;
}

/**
 * QuickPick 账号排序（切号场景最顺手：想切的号永远在上面）：
 * 当前号 → 可用（按最紧额度降序）→ 检测异常 → 封禁/登录失效 → 禁用垫底
 */
export function sortPoolForQuickPick(
  accounts: StoredAccount[],
  getUsage: (email: string) => UsageSnapshot | undefined,
  currentEmail: string
): StoredAccount[] {
  const rank = (a: StoredAccount): number => {
    if (a.disabled) return 4;
    if (a.email.toLowerCase() === currentEmail.toLowerCase()) return 0;
    const h = a.health?.status;
    if (h === 'banned' || h === 'auth_invalid') return 3;
    if (h === 'unknown') return 2;
    return 1;
  };
  return [...accounts].sort((a, b) => {
    const ra = rank(a);
    const rb = rank(b);
    if (ra !== rb) return ra - rb;
    if (ra === 1) {
      // 同为可用：最紧额度高的在前（undefined 额度当 -1 沉底）
      const pa = getUsage(a.email)?.minRemainingPercent ?? -1;
      const pb = getUsage(b.email)?.minRemainingPercent ?? -1;
      if (pb !== pa) return pb - pa;
    }
    return a.email.localeCompare(b.email);
  });
}

/** 平铺样式窗口短标：label 唯一权威源是 usageService（族×窗口已在抓取层定型），此处仅兜底推导 */
export function formatWindowShort(m: { label?: string; modelId?: string }): string {
  if (m.label) return m.label;
  const modelId = m.modelId || '';
  const family = modelId.startsWith('argon') ? 'Gemini 4'
    : modelId.startsWith('claude') ? 'Claude'
    : 'Gemini';
  const isWeekly = modelId.endsWith(':weekly');
  return `${family} ${isWeekly ? t('quotaWeekly') : t('quota5h')}`;
}

/** 依赖注入：状态栏不再自建数据管线，全部走 extension.ts 的共享缓存与统一刷新 */
export interface StatusBarDeps {
  /** 读共享额度缓存（唯一数据源） */
  getUsage?: (email: string) => UsageSnapshot | undefined;
  /** 刷新指定账号（统一管线：抓取→缓存→tracker→健康归类→三端分发） */
  refreshCurrent?: (email: string) => Promise<void>;
  /** 刷新全池（QuickPick 快捷操作） */
  refreshAll?: () => Promise<void>;
  /** 健康复检（QuickPick 快捷操作，独立推理探针） */
  recheckHealth?: () => Promise<void>;
  /** 打开设置弹窗（侧栏 webview 模态） */
  openSettings?: () => void;
  /** 隐私模式开关（globalState 权威源，G22：隐私不得局限在 webview 闭包） */
  getPrivacy?: () => boolean;
}

/** 配额条分档色（BuddyRelay 药丸同源：ok 翡翠/warn 橙黄/danger 红） */
function barColor(pct: number): string {
  if (pct >= 50) return '#10b981';
  if (pct >= 30) return '#f59e0b';
  if (pct >= 10) return '#f97316';
  return '#ef4444';
}

/** 毫秒 → "3h 12m" / "2d 4h"（重置倒计时用；不可解析返回空串） */
function fmtDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms <= 0) return '';
  const m = Math.round(ms / 60000);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 48) return `${h}h ${m % 60}m`;
  return `${Math.floor(h / 24)}d ${h % 24}h`;
}

export class StatusBarManager implements vscode.Disposable {
  private _main: vscode.StatusBarItem;
  private _pool: vscode.StatusBarItem;
  private _ctx: vscode.ExtensionContext;
  private _deps: StatusBarDeps;
  private _disposables: vscode.Disposable[] = [];
  private _currentAlignment: vscode.StatusBarAlignment = vscode.StatusBarAlignment.Right;

  private _refreshTimer: NodeJS.Timeout | null = null;
  private _redrawTimer: NodeJS.Timeout | null = null;

  constructor(
    ctx: vscode.ExtensionContext,
    onAccountSwitched?: (email: string) => void | Promise<void>,
    switchRequest?: (email: string) => Promise<void>,
    deps: StatusBarDeps = {}
  ) {
    this._ctx = ctx;
    this._deps = deps;

    // 主段：账号 + 额度聚合，点击弹切号菜单（QuickPick）
    this._main = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
    this._main.command = 'antigravityKite.quickSwitchAccount';
    this._main.name = 'Kite Quota';

    // 副段：号池统计，点击开侧栏
    this._pool = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 99);
    this._pool.command = OPEN_SIDEBAR_CMD;
    this._pool.name = 'Kite Pool';

    // 注册打开侧栏命令
    this._disposables.push(
      vscode.commands.registerCommand(OPEN_SIDEBAR_CMD, () => {
        vscode.commands.executeCommand('antigravityKite.sidebar.focus');
      })
    );

    // 注册状态栏点击快速切号命令
    this._disposables.push(
      vscode.commands.registerCommand('antigravityKite.quickSwitchAccount', async () => {
        await this._showQuickSwitch(onAccountSwitched, switchRequest);
      })
    );

    // 订阅状态栏设置变化，即时生效
    this._disposables.push(
      vscode.workspace.onDidChangeConfiguration(e => {
        if (e.affectsConfiguration('antigravityKite.statusBar')) {
          this._startRefreshTimer();
          this.update();
        }
      })
    );

    // 订阅账号变化（健康/禁用/增删都在 store 里，重绘即可；额度刷新由统一管线推送）
    accountStore.onChange(() => this.update());

    // 倒计时跳动：每分钟纯重绘一次（不碰网络；渲染层读的都是缓存与时间差）
    this._redrawTimer = setInterval(() => this.update(), 60 * 1000);
    this._disposables.push({ dispose: () => { if (this._redrawTimer) { clearInterval(this._redrawTimer); this._redrawTimer = null; } } });

    this.update();
    this._startRefreshTimer();
  }

  /**
   * 外部额度数据到位（统一管线推送），重绘即可——数据本体在共享 usageCache
   */
  updateUsage(_email: string, _usage: UsageSnapshot): void {
    this.update();
  }

  /** 手动触发当前号刷新（走统一管线） */
  async refreshUsage(): Promise<void> {
    const cur = this._ctx.globalState.get<string>('currentEmail') || '';
    if (cur && this._deps.refreshCurrent) {
      await this._deps.refreshCurrent(cur);
    } else {
      this.update();
    }
  }

  private _sbCfg<T>(key: string, dft: T): T {
    return vscode.workspace.getConfiguration('antigravityKite.statusBar').get<T>(key, dft);
  }

  private _getStyle(): StatusBarStyle {
    return validateStyle(this._sbCfg<string>('style', 'smart'));
  }

  private _getPosition(): StatusBarPosition {
    const v = this._sbCfg<string>('position', 'right');
    return VALID_POSITIONS.includes(v as StatusBarPosition) ? (v as StatusBarPosition) : 'right';
  }

  private _getRefreshSeconds(): number {
    const n = this._sbCfg<number>('refreshSeconds', 30);
    return Number.isFinite(n) ? Math.min(600, Math.max(10, Math.floor(n))) : 30;
  }

  /** 当前号短周期增量刷新：走统一管线（抓取→缓存→tracker→健康归类→分发），不自建 fetch */
  private _startRefreshTimer(): void {
    if (this._refreshTimer) clearInterval(this._refreshTimer);
    this._refreshTimer = setInterval(() => {
      const cur = this._ctx.globalState.get<string>('currentEmail');
      if (!cur || !this._deps.refreshCurrent) return;
      void this._deps.refreshCurrent(cur).catch(err => {
        // 管线内部已归类健康并推送卡片；这里只留痕防定时器静默失败
        console.warn('[StatusBar] 当前号刷新失败:', err instanceof Error ? err.message : String(err));
      });
    }, this._getRefreshSeconds() * 1000);
  }

  /** 按配置重建两个状态栏项的对齐方向（对齐仅创建时可指定，需重建 item） */
  private _ensureAlignment(position: StatusBarPosition): void {
    const target = position === 'left' ? vscode.StatusBarAlignment.Left : vscode.StatusBarAlignment.Right;
    if (target === this._currentAlignment) return;
    try { this._main.dispose(); } catch { /* ignore */ }
    try { this._pool.dispose(); } catch { /* ignore */ }
    this._main = vscode.window.createStatusBarItem(target, 100);
    this._pool = vscode.window.createStatusBarItem(target, 99);
    this._main.command = 'antigravityKite.quickSwitchAccount';
    this._pool.command = OPEN_SIDEBAR_CMD;
    this._currentAlignment = target;
  }

  /**
   * 刷新状态栏显示
   */
  update(): void {
    if (!this._sbCfg('enabled', true)) {
      this._main.hide();
      this._pool.hide();
      return;
    }
    this._ensureAlignment(this._getPosition());
    this._renderMain();
    this._renderPool();
  }

  /** 额度状态色点（额度维度；健康维度见 pickHealthMark）。四档 emoji 对齐 Anti Quota/Cockpit 参考系 */
  private _getStatusIcon(pct: number): string {
    return colorDot(pct);
  }

  /** 池过滤白名单（配置缺失 = 全开，读失败走保守路径） */
  private _getFamilies(): Set<string> {
    const v = this._sbCfg<string[]>('families', ['claude', 'gemini', 'argon']);
    const all = new Set(['claude', 'gemini', 'argon']);
    if (!Array.isArray(v)) return all;
    const set = new Set(v.filter((x): x is string => typeof x === 'string' && all.has(x)));
    return set.size > 0 ? set : all; // 全关视为配置异常，回退全开
  }

  /** 池过滤后的模型列表（族分格与最紧额度共用同一过滤） */
  private _filteredModels(usage: UsageSnapshot): ModelQuota[] {
    const fams = this._getFamilies();
    return usage.models.filter(m => fams.has((m.modelId || '').split(':')[0]));
  }

  private _renderMain(): void {
    const curEmail = this._ctx.globalState.get<string>('currentEmail') || '';
    const account = curEmail ? accountStore.getByEmail(curEmail) : undefined;
    const rawUsage = this._deps.getUsage ? this._deps.getUsage(curEmail) : undefined;
    const style = this._getStyle();
    const showAccount = this._sbCfg('showAccount', true);
    const showModels = this._sbCfg('showModels', true);
    const showCredits = this._sbCfg('showCredits', true);
    const showTier = this._sbCfg('showTier', true);
    const showReset = this._sbCfg('showResetCountdown', true);

    const privacy = this._deps.getPrivacy?.() ?? false;
    const short = curEmail ? displayName(curEmail, privacy) : t('sbNotLoggedIn');

    // 健康优先于额度：封禁号额度照样满格（元数据端点对封禁隐身），必须由健康定调
    const health = pickHealthMark(account?.health);

    // 内容开关 x 池过滤：models 先过"池过滤"再过"模型额度开关"；
    // min 不再信预聚合值（那是全池的），按过滤后窗口重算——关掉的池不参与"最紧额度"
    const models = rawUsage ? this._filteredModels(rawUsage) : [];
    const hasQuota = showModels && models.length > 0;
    const pcts = models.map(m => m.remainingPercent).filter(v => typeof v === 'number');
    const min = hasQuota && pcts.length > 0 ? Math.min(...pcts) : 100;
    const quotaIcon = this._getStatusIcon(min);
    const creditsStr = showCredits && rawUsage ? formatCredits(rawUsage.availableAICredits) : '';
    // 会员级别：跟账号段走（账号关则无依托）；Free 是默认态不亮牌，Pro/Ultra 才值得标
    const tier = rawUsage?.tierId ? displayTierLabel(String(rawUsage.tierId)) : '';
    const tierStr = showTier && tier && tier !== 'Free' ? ` ·${tier}` : '';
    // 重置倒计时：显示"最近回血"的那个窗口（快回血了），跟在额度块后面
    const resetStr = showReset && hasQuota ? formatResetHint(models) : '';
    // 背景色只留给健康异常（封禁/失效）；额度低用色点表达即可，整段红底太刺眼（兄弟指令）
    this._main.backgroundColor = health.bg === 'error'
      ? new vscode.ThemeColor('statusBarItem.errorBackground')
      : health.bg === 'warning'
        ? new vscode.ThemeColor('statusBarItem.warningBackground')
        : undefined;

    // 聚合段：账号 / 额度 / 积分 / 健康四块的合成器（内容开关全在这里收口）
    const smartText = (): string | null => {
      if (health.icon) return `${health.icon} ${short} ${this._healthShortLabel(account?.health)}`.trim();
      const parts: string[] = [];
      if (showAccount) parts.push(`$(account) ${short}${tierStr}`);
      if (hasQuota) parts.push(`${quotaIcon} ${min}%${resetStr ? ' ' + resetStr : ''}`);
      if (creditsStr) parts.push(creditsStr);
      return parts.length > 0 ? parts.join(' ').trim() : null;
    };

    let text: string | null = null;
    if (rawUsage && models.length > 0) {
      switch (style) {
        case 'dot':
          // 仅图标：健康异常用健康图标；额度开关关掉后无内容可显
          text = health.icon || (hasQuota ? quotaIcon : null);
          break;
        case 'percent':
          text = hasQuota ? `${min}%` : null;
          break;
        case 'compact':
          text = hasQuota ? `${health.icon || quotaIcon} ${min}%${resetStr ? ' ' + resetStr : ''}` : null;
          break;
        case 'dual':
          text = hasQuota
            ? `${health.icon || quotaIcon} ${min}%${resetStr ? ' ' + resetStr : ''}${creditsStr ? ' | ' + creditsStr : ''}`
            : (creditsStr || null);
          break;
        case 'smart':
          text = smartText();
          break;
        case 'labeled':
        case 'full':
          text = this._flatText(style, models, rawUsage, short, showAccount, showModels, showCredits, health.icon, quotaIcon, tierStr, resetStr);
          break;
      }
    }

    if (text === null) {
      // 无额度可显：回退聚合段（账号+积分），全空才隐藏
      text = smartText();
      if (text === null) {
        this._main.hide();
        return;
      }
    }

    this._main.text = text;
    this._main.tooltip = this._buildTooltip(curEmail, rawUsage);
    this._main.show();
  }

  private _healthShortLabel(health?: AccountHealth): string {
    switch (health?.status) {
      case 'banned': return t('sbHealthBanned');
      case 'auth_invalid': return t('sbHealthAuthInvalid');
      case 'unknown': return t('sbHealthUnknown');
      default: return '';
    }
  }

  /**
   * 平铺样式（labeled/full）：账号 + 各窗口额度（异常窗才带图标，正常不刷 ✓）。
   * 溢出保护：VS Code 状态栏单项不自动截断，超宽会被顶出屏幕（1.1.15 前的老毛病），
   * 文本超长自动降级为聚合段。
   */
  private _flatText(
    style: 'labeled' | 'full',
    models: ModelQuota[],
    usage: UsageSnapshot,
    short: string,
    showAccount: boolean,
    showModels: boolean,
    showCredits: boolean,
    healthIcon: string,
    quotaIcon: string,
    tierStr: string,
    resetStr: string
  ): string | null {
    const segments: string[] = [];
    if (healthIcon) {
      segments.push(`${healthIcon} ${short} ${this._healthShortLabel(accountStore.getByEmail(this._ctx.globalState.get<string>('currentEmail') || '')?.health)}`.trim());
    } else {
      if (showAccount) segments.push(`$(account) ${short}${tierStr}`);
      if (showModels) {
        const famSegs = formatFamilySegments(models);
        if (famSegs) {
          segments.push(resetStr ? `${famSegs} ${resetStr}` : famSegs);
        }
      }
      if (style === 'full' && showCredits) {
        const c = formatCredits(usage.availableAICredits);
        if (c) segments.push(c);
      }
    }
    if (segments.length === 0) return null;
    const text = segments.join(' | ');
    // 溢出降级：按渲染有效宽度估——$(codicon) 标记源码 8~10 字符，渲染只占约 1 字宽，按 1 计
    const effLen = text.replace(/\$\([a-z0-9-]+\)/gi, '@').replace(/[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/gu, '@@').length;
    const minPct = models.length > 0 ? Math.min(...models.map(m => m.remainingPercent)) : 100;
    return effLen > 110 ? `${quotaIcon} ${minPct}% | $(account) ${short}` : text;
  }

  /** tooltip 内联 CSS 配额条（Wanow 踩坑定案：█░ Unicode 在 Windows 字体度量错位，必须 CSS） */
  private _bar(pct: number): string {
    const c = barColor(pct);
    return `<span style="display:inline-block;width:120px;height:6px;border-radius:3px;background:#8884;">`
      + `<span style="display:inline-block;width:${Math.max(0, Math.min(100, pct))}%;height:6px;border-radius:3px;background:${c};vertical-align:top;"></span></span>`;
  }

  private _buildTooltip(email: string, usage?: UsageSnapshot): vscode.MarkdownString {
    const md = new vscode.MarkdownString();
    md.isTrusted = true;
    md.supportThemeIcons = true;
    md.supportHtml = true;

    if (!email) {
      md.appendMarkdown(`**Antigravity Kite**\n\n${t('sbNotSignedInTip')}\n\n_${t('sbOpenPoolTip')}_`);
      return md;
    }

    const account = accountStore.getByEmail(email);
    const privacy = this._deps.getPrivacy?.() ?? false;
    md.appendMarkdown(`**$(account) ${displayName(email, privacy)}**${account?.name ? ` · ${account.name}` : ''}${usage?.tierId ? ` · ${usage.tierId.toUpperCase()}` : ''}\n\n`);

    // 健康块：异常才亮牌（ok 与未检测不出现在 tooltip）
    const health = account?.health;
    if (health && health.status !== 'ok') {
      const mark = pickHealthMark(health);
      const label = this._healthShortLabel(health);
      md.appendMarkdown(`${mark.icon} **${label}**${health.detail ? ` —— ${health.detail.replace(/\|/g, '/')}` : ''}\n\n`);
      if (health.checkedAt) {
        md.appendMarkdown(`_${t('sbHealthCheckedAt')} ${new Date(health.checkedAt).toLocaleString()}_\n\n`);
      }
    }

    if (usage && usage.models.length > 0) {
      for (const model of usage.models) {
        md.appendMarkdown(`${this._windowLine(model)}\n\n`);
      }
      if (usage.availableAICredits !== undefined) {
        md.appendMarkdown(`---\n\n**🪙 ${t('sbAiCredits')}**：${usage.availableAICredits}\n\n`);
      }
      if (usage.updatedAt) {
        md.appendMarkdown(`_${t('sbUpdated')} ${new Date(usage.updatedAt).toLocaleTimeString()}_\n\n`);
      }
    } else {
      md.appendMarkdown(`_${t('sbNoQuotaData')}_\n\n`);
    }

    md.appendMarkdown(`---\n\n_${t('sbTooltipClick')}_`);
    return md;
  }

  /** 单窗口行：`🟢 **label** — 98% [CSS bar] · 3h 12m 后重置` */
  private _windowLine(model: ModelQuota): string {
    const label = formatWindowShort(model);
    let line = `**${colorDot(model.remainingPercent)} ${label}**：${model.remainingPercent}% ${this._bar(model.remainingPercent)}`;
    if (model.resetTime) {
      const left = fmtDuration(new Date(model.resetTime).getTime() - Date.now());
      if (left) line += ` · _${t('sbResetIn', left)}_`;
    }
    return line;
  }

  private _renderPool(): void {
    if (!this._sbCfg('showPool', true)) {
      this._pool.hide();
      return;
    }

    const accounts = accountStore.getAll();
    const curEmail = this._ctx.globalState.get<string>('currentEmail') || '';

    const total = accounts.filter(a => !a.disabled).length;
    const available = accounts.filter(a => !a.disabled && a.email !== curEmail).length;

    if (total === 0) {
      this._pool.hide();
      return;
    }

    this._pool.text = `${t('sbPool')} ${available}/${total}`;
    this._pool.tooltip = `${t('sbPoolTooltip', available, total)}\n\n_${t('sbOpenPoolTip')}_`;
    this._pool.show();
  }

  /**
   * 点击弹混合菜单：账号（按最紧额度降序 + 健康图标）+ 分隔线 + 快捷操作（BuddyRelay 模式）
   */
  private async _showQuickSwitch(
    onAccountSwitched?: (email: string) => void | Promise<void>,
    switchRequest?: (email: string) => Promise<void>
  ): Promise<void> {
    const accounts = accountStore.getAll();
    if (accounts.length === 0) {
      notifyUi('warning', t('sbPoolEmpty'));
      return;
    }

    const curEmail = this._ctx.globalState.get<string>('currentEmail') || '';
    const privacy = this._deps.getPrivacy?.() ?? false;
    const getUsage = (email: string) => this._deps.getUsage?.(email);
    const sorted = sortPoolForQuickPick(accounts, getUsage, curEmail);

    const healthIconOf = (a: StoredAccount): string => {
      if (a.disabled) return '$(circle-slash)';
      const m = pickHealthMark(a.health);
      if (m.icon) return m.icon;
      if (a.email.toLowerCase() === curEmail.toLowerCase()) return '$(check)';
      return '$(account)';
    };

    interface QPItem extends vscode.QuickPickItem {
      type: 'account' | 'action';
      email?: string;
      actionId?: string;
    }

    const items: QPItem[] = sorted.map(a => {
      const isCurrent = a.email.toLowerCase() === curEmail.toLowerCase();
      const usage = getUsage(a.email);
      const details: string[] = [];
      if (a.health?.status === 'banned') details.push(t('sbHealthBanned'));
      else if (a.health?.status === 'auth_invalid') details.push(t('sbHealthAuthInvalid'));
      else if (a.health?.status === 'unknown') details.push(t('sbHealthUnknown'));
      if (usage && usage.models.length > 0) {
        details.push(usage.models.map(m => `${formatWindowShort(m)} ${m.remainingPercent}%`).join(' · '));
        if (usage.availableAICredits !== undefined && usage.availableAICredits !== null) {
          details.push(formatCredits(usage.availableAICredits));
        }
      }
      const qpTierRaw = getUsage(a.email)?.tierId;
      const qpTier = qpTierRaw ? displayTierLabel(String(qpTierRaw)) : '';
      return {
        label: `${healthIconOf(a)} ${displayName(a.email, privacy)}`,
        description: [isCurrent ? t('sbCurrent') : (a.name || ''), qpTier && qpTier !== 'Free' ? qpTier : ''].filter(Boolean).join(' · ') || undefined,
        detail: details.length > 0 ? details.join(' | ') : (a.disabled ? t('sbDisabled') : t('sbAvailable')),
        type: 'account' as const,
        email: a.email
      };
    });

    // ── 快捷操作区（BuddyRelay 分隔线模式）──
    items.push({ label: t('qpQuickActions'), kind: vscode.QuickPickItemKind.Separator, type: 'action' });
    items.push({
      label: `$(refresh) ${t('qpRefreshAll')}`,
      detail: t('qpRefreshAllDesc'),
      actionId: 'refreshAll',
      type: 'action'
    });
    items.push({
      label: `$(shield) ${t('qpRecheckHealth')}`,
      detail: t('qpRecheckHealthDesc'),
      actionId: 'recheckHealth',
      type: 'action'
    });
    items.push({
      label: `$(layout-sidebar-left) ${t('qpOpenPanel')}`,
      detail: t('qpOpenPanelDesc'),
      actionId: 'openPanel',
      type: 'action'
    });
    items.push({
      label: `$(gear) ${t('qpOpenSettings')}`,
      detail: t('qpOpenSettingsDesc'),
      actionId: 'openSettings',
      type: 'action'
    });

    const selected = await vscode.window.showQuickPick(items, {
      title: 'Antigravity Kite',
      placeHolder: t('sbPickAccount'),
      matchOnDescription: true,
      matchOnDetail: true
    });

    if (!selected) return;

    if (selected.type === 'action') {
      switch (selected.actionId) {
        case 'refreshAll':
          await vscode.window.withProgress({
            location: vscode.ProgressLocation.Notification,
            title: t('qpRefreshAll'),
            cancellable: false
          }, async () => {
            try {
              await this._deps.refreshAll?.();
            } catch (err) {
              notifyUi('error', t('sbSwitchFail', err instanceof Error ? err.message : String(err)));
            }
          });
          this.update();
          break;
        case 'recheckHealth':
          await vscode.window.withProgress({
            location: vscode.ProgressLocation.Notification,
            title: t('qpRecheckHealth'),
            cancellable: false
          }, async () => {
            try {
              await this._deps.recheckHealth?.();
            } catch (err) {
              notifyUi('error', String(err instanceof Error ? err.message : err));
            }
          });
          this.update();
          break;
        case 'openPanel':
          await vscode.commands.executeCommand(OPEN_SIDEBAR_CMD);
          break;
        case 'openSettings':
          this._deps.openSettings?.();
          break;
      }
      return;
    }

    // ── 账号分支：完整切号链路 ──
    if (selected.type !== 'account' || !selected.email) return;
    const account = accounts.find(a => a.email === selected.email);
    if (!account) return;

    if (account.disabled) {
      notifyUi('warning', t('sbAccountDisabled', account.email));
      return;
    }
    if (account.email.toLowerCase() === curEmail.toLowerCase()) {
      notifyUi('info', t('sbAlreadyCurrent', account.email));
      return;
    }

    await vscode.window.withProgress({
      location: vscode.ProgressLocation.Notification,
      title: t('sbSwitching', account.email),
      cancellable: false
    }, async () => {
      // 复用侧栏完整切号链路（门控/token/凭据/状态库/agy/gemini/会话/引擎重载）
      try {
        await switchRequest?.(account.email);
        await onAccountSwitched?.(account.email);
        this.update();
        const cur = this._ctx.globalState.get<string>('currentEmail') || account.email;
        await this._deps.refreshCurrent?.(cur);
      } catch (err) {
        notifyUi('error', t('sbSwitchFail', err instanceof Error ? err.message : String(err)));
      }
    });
  }

  /**
   * 隐藏状态栏
   */
  hide(): void {
    this._main.hide();
    this._pool.hide();
  }

  /**
   * 显示状态栏
   */
  show(): void {
    this.update();
  }

  dispose(): void {
    if (this._refreshTimer) {
      clearInterval(this._refreshTimer);
      this._refreshTimer = null;
    }
    this._main.dispose();
    this._pool.dispose();
    for (const d of this._disposables) {
      try { d.dispose(); } catch { /* ignore */ }
    }
    this._disposables = [];
  }
}
