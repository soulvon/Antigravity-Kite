/**
 * 底部状态栏管理器
 * 
 * 设计：
 *   [左]  $(account) 邮箱前缀 · 🟢 D100% W100%   → 点击打开侧栏
 *   [右]  $(pulse) 池 3/5                         → 点击打开侧栏
 * 
 * 特性：
 * - 额度低于阈值时 emoji 变色警示
 * - 订阅账号变化事件，自动重绘
 * - 自动刷新额度（每 30 秒）
 */
import * as vscode from 'vscode';
import * as accountStore from './accountStore';
import { fetchUsage } from './usageService';
import { UsageSnapshot } from './types';

export type StatusBarStyle = 'dot' | 'percent' | 'compact' | 'dual' | 'labeled';

const OPEN_SIDEBAR_CMD = 'antigravityKite.openSidebar';

export class StatusBarManager implements vscode.Disposable {
  private _left: vscode.StatusBarItem;
  private _right: vscode.StatusBarItem;
  private _ctx: vscode.ExtensionContext;
  private _disposables: vscode.Disposable[] = [];
  private _style: StatusBarStyle = 'labeled';
  
  // 额度缓存
  private _usageCache: Map<string, UsageSnapshot> = new Map();
  private _refreshTimer: NodeJS.Timeout | null = null;
  private _isRefreshing = false;

  constructor(ctx: vscode.ExtensionContext) {
    this._ctx = ctx;

    // 右侧：配额 + 积分（对齐 Cockpit 风格）
    this._left = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
    this._left.command = OPEN_SIDEBAR_CMD;
    this._left.name = 'Kite Quota';

    // 右侧：号池统计
    this._right = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 99);
    this._right.command = OPEN_SIDEBAR_CMD;
    this._right.name = 'Kite Pool';

    // 注册打开侧栏命令
    this._disposables.push(
      vscode.commands.registerCommand(OPEN_SIDEBAR_CMD, () => {
        vscode.commands.executeCommand('antigravityKite.sidebar.focus');
      })
    );

    // 订阅账号变化
    accountStore.onChange(() => {
      this.update();
      this._refreshCurrentUsage(); // 账号变化时刷新额度
    });
    
    // 初始更新
    this.update();
    
    // 启动时刷新当前账号额度
    this._refreshCurrentUsage();
    
    // 每 30 秒刷新一次额度
    this._refreshTimer = setInterval(() => this._refreshCurrentUsage(), 30000);
  }

  /**
   * 设置显示样式
   */
  setStyle(style: StatusBarStyle): void {
    this._style = style;
    this.update();
  }

  /**
   * 更新额度缓存（供外部调用）
   */
  updateUsage(email: string, usage: UsageSnapshot): void {
    this._usageCache.set(email, usage);
    this.update();
  }

  /**
   * 刷新当前账号的额度
   */
  private async _refreshCurrentUsage(): Promise<void> {
    if (this._isRefreshing) return;
    
    const curEmail = this._ctx.globalState.get<string>('currentEmail');
    if (!curEmail) return;
    
    const account = accountStore.getByEmail(curEmail);
    if (!account || !account.accessToken) return;
    
    this._isRefreshing = true;
    try {
      const snapshot = await fetchUsage(account);
      this._usageCache.set(curEmail, snapshot);
      this.update();
    } catch (err) {
      // 静默失败，保持显示缓存或默认值
      console.error('[StatusBar] Failed to refresh usage:', err);
    } finally {
      this._isRefreshing = false;
    }
  }

  /**
   * 手动触发刷新额度
   */
  async refreshUsage(): Promise<void> {
    await this._refreshCurrentUsage();
  }

  /**
   * 刷新状态栏显示
   */
  update(): void {
    this._renderLeft();
    this._renderRight();
  }

  private _getStatusIcon(pct: number): string {
    if (pct < 10) return '🔴';
    if (pct < 30) return '🟡';
    if (pct < 50) return '🔵';
    return '🟢';
  }

  private _renderLeft(): void {
    const curEmail = this._ctx.globalState.get<string>('currentEmail') || '';
    const usage = curEmail ? this._usageCache.get(curEmail) : undefined;
    
    // 最低百分比决定背景色
    const min = usage?.minRemainingPercent ?? 100;
    if (min < 10) {
      this._left.backgroundColor = new vscode.ThemeColor('statusBarItem.errorBackground');
    } else if (min < 30) {
      this._left.backgroundColor = new vscode.ThemeColor('statusBarItem.warningBackground');
    } else {
      this._left.backgroundColor = undefined;
    }

    // 始终显示账号前缀
    const short = curEmail ? curEmail.split('@')[0] : '未登录';

    // Cockpit 风格：账号前缀 | 每组独立 emoji + 名称 + 百分比，| 分隔，最后积分
    if (usage && usage.models.length > 0) {
      const parts: string[] = [];
      for (const m of usage.models) {
        const icon = this._getStatusIcon(m.remainingPercent);
        parts.push(`${icon} ${m.label}: ${m.remainingPercent}%`);
      }
      // AI 积分
      const credits = usage.availableAICredits !== undefined && usage.availableAICredits !== null ? usage.availableAICredits : '-';
      parts.push(`💳 ${credits}`);
      this._left.text = `$(account) ${short} | ${parts.join(' | ')}`;
    } else {
      this._left.text = `$(account) ${short}`;
    }

    this._left.tooltip = this._buildTooltip(curEmail, usage);
    this._left.show();
  }

  private _buildTooltip(email: string, usage?: UsageSnapshot): vscode.MarkdownString {
    const md = new vscode.MarkdownString();
    md.isTrusted = true;
    
    if (!email) {
      md.appendMarkdown('**Antigravity Kite**\n\n未登录账号\n\n_点击打开号池面板_');
      return md;
    }

    md.appendMarkdown(`**${email}**\n\n`);
    
    if (usage && usage.models.length > 0) {
      // 显示订阅级别
      if (usage.tierId) {
        md.appendMarkdown(`**订阅**：${usage.tierId.toUpperCase()}\n\n`);
      }
      // 显示各分组配额（每组独立 emoji）
      for (const model of usage.models) {
        const icon = this._getStatusIcon(model.remainingPercent);
        md.appendMarkdown(`${icon} **${model.label}**：${model.remainingPercent}%\n\n`);
      }
      // AI 积分
      if (usage.availableAICredits !== undefined) {
        md.appendMarkdown(`---\n\n**💳 AI 积分**：${usage.availableAICredits}\n`);
      }
    } else {
      md.appendMarkdown('_暂无额度数据_\n');
    }
    
    md.appendMarkdown('\n_点击打开号池面板_');
    return md;
  }

  private _renderRight(): void {
    const accounts = accountStore.getAll();
    const curEmail = this._ctx.globalState.get<string>('currentEmail') || '';
    
    const total = accounts.filter(a => !a.disabled).length;
    const available = accounts.filter(a => !a.disabled && a.email !== curEmail).length;

    if (total === 0) {
      this._right.hide();
      return;
    }

    this._right.text = `$(pulse) 池 ${available}/${total}`;
    this._right.tooltip = `号池：${available} 个可用 / ${total} 个总计\n\n_点击打开号池面板_`;
    this._right.show();
  }

  /**
   * 隐藏状态栏
   */
  hide(): void {
    this._left.hide();
    this._right.hide();
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
    this._left.dispose();
    this._right.dispose();
    for (const d of this._disposables) {
      try { d.dispose(); } catch { /* ignore */ }
    }
    this._disposables = [];
  }
}
