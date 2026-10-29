/**
 * 底部状态栏管理器
 *
 * 设计（对齐 BuddyRelay 的 codicon 体系，100% 无 Emoji）：
 *   [左]  $(account) 邮箱前缀 | $(check) Claude: 92% | ... | $(credit-card) 87.5
 *   [右]  $(pulse) 池 3/5
 *
 * 特性：
 * - 额度低于阈值时切换警告/错误图标与背景色
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
  private _onAccountSwitched?: (email: string) => void | Promise<void>;

  constructor(ctx: vscode.ExtensionContext, onAccountSwitched?: (email: string) => void | Promise<void>) {
    this._ctx = ctx;
    this._onAccountSwitched = onAccountSwitched;

    // 左侧：配额 + 积分（对齐 Cockpit 风格），点击直接弹出切号列表
    this._left = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
    this._left.command = 'antigravityKite.quickSwitchAccount';
    this._left.name = 'Kite Quota';

    // 右侧：号池统计，点击打开侧栏
    this._right = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 99);
    this._right.command = OPEN_SIDEBAR_CMD;
    this._right.name = 'Kite Pool';

    // 注册打开侧栏命令
    this._disposables.push(
      vscode.commands.registerCommand(OPEN_SIDEBAR_CMD, () => {
        vscode.commands.executeCommand('antigravityKite.sidebar.focus');
      })
    );

    // 注册状态栏点击快速切号命令
    this._disposables.push(
      vscode.commands.registerCommand('antigravityKite.quickSwitchAccount', async () => {
        const accounts = accountStore.getAll();
        if (accounts.length === 0) {
          vscode.window.showWarningMessage('Kite 号池为空，请先在侧栏面板中添加账号。');
          return;
        }

        const curEmail = this._ctx.globalState.get<string>('currentEmail') || '';

        const items = accounts.map(a => {
          const isCurrent = a.email.toLowerCase() === curEmail.toLowerCase();
          const usage = this._usageCache.get(a.email);
          let details = '';
          if (usage) {
            const detailsParts: string[] = [];
            if (usage.availableAICredits !== undefined && usage.availableAICredits !== null) {
              detailsParts.push(`$(credit-card) ${usage.availableAICredits}`);
            }
            for (const m of usage.models) {
              detailsParts.push(`${m.label}: ${m.remainingPercent}%`);
            }
            details = detailsParts.join(' | ');
          }

          return {
            label: `${isCurrent ? '$(check) ' : ''}${a.email}`,
            description: a.name || '',
            detail: details ? `(${details})` : (a.disabled ? '已禁用' : '可用'),
            account: a,
            picked: isCurrent
          };
        });

        const selected = await vscode.window.showQuickPick(items, {
          placeHolder: '选择要无感切换的反重力账号',
          matchOnDescription: true,
          matchOnDetail: true
        });

        if (selected) {
          if (selected.account.disabled) {
            vscode.window.showWarningMessage(`账号 ${selected.account.email} 已被禁用，无法切换。`);
            return;
          }

          const email = selected.account.email;
          if (email.toLowerCase() === curEmail.toLowerCase()) {
            vscode.window.showInformationMessage(`当前已处于账号 ${email} 登录状态`);
            return;
          }

          await vscode.window.withProgress({
            location: vscode.ProgressLocation.Notification,
            title: `正在无感切换账号至: ${email}...`,
            cancellable: false
          }, async () => {
            const { seamlessSwitch } = require('./seamlessSwitcher');
            const res = await seamlessSwitch(selected.account);
            if (res.success) {
              await this._ctx.globalState.update('currentEmail', email);
              await this._onAccountSwitched?.(email);
              this.update();
              await this._refreshCurrentUsage();
              vscode.window.showInformationMessage(`[Kite] 无感切号成功: ${email}`);
            } else {
              vscode.window.showErrorMessage(`无感切号失败: ${res.message}`);
            }
          });
        }
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
    if (pct < 10) return '$(error)';
    if (pct < 30) return '$(warning)';
    return '$(check)';
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
      parts.push(`$(credit-card) ${credits}`);
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
    md.supportThemeIcons = true;

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
      // 显示各分组配额（每组独立状态图标）
      for (const model of usage.models) {
        const icon = this._getStatusIcon(model.remainingPercent);
        md.appendMarkdown(`${icon} **${model.label}**：${model.remainingPercent}%\n\n`);
      }
      // AI 积分
      if (usage.availableAICredits !== undefined) {
        md.appendMarkdown(`---\n\n**$(credit-card) AI 积分**：${usage.availableAICredits}\n`);
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
