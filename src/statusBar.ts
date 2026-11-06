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
 * - 自动刷新额度（间隔可配置，改动即时生效）
 */
import * as vscode from 'vscode';
import * as accountStore from './accountStore';
import { fetchUsage } from './usageService';
import { UsageSnapshot } from './types';
import { t } from './i18n';
import { notifyUi } from './uiChannel';

function formatModelLabel(m: { modelId?: string; label?: string }): string {
  const isWeekly = m.modelId?.endsWith(':weekly') || /week/i.test(m.label || '');
  const family = /argon/i.test(m.modelId || '') ? 'Gemini 4'
    : /claude/i.test(m.modelId || m.label || '') ? 'Claude'
    : 'Gemini';
  return `${family} ${isWeekly ? t('quotaWeekly') : t('quota5h')}`;
}

/** 状态栏左段信息密度：dot/percent/compact 极简（只看最低额度）；labeled 账号+各模型；full 完整（加积分） */
export type StatusBarStyle = 'dot' | 'percent' | 'compact' | 'dual' | 'labeled' | 'full';

export type StatusBarPosition = 'left' | 'right';

const VALID_STYLES: StatusBarStyle[] = ['dot', 'percent', 'compact', 'dual', 'labeled', 'full'];
const VALID_POSITIONS: StatusBarPosition[] = ['left', 'right'];

const OPEN_SIDEBAR_CMD = 'antigravityKite.openSidebar';

export class StatusBarManager implements vscode.Disposable {
  private _left: vscode.StatusBarItem;
  private _right: vscode.StatusBarItem;
  private _ctx: vscode.ExtensionContext;
  private _disposables: vscode.Disposable[] = [];
  private _currentAlignment: vscode.StatusBarAlignment = vscode.StatusBarAlignment.Right;

  // 额度缓存
  private _usageCache: Map<string, UsageSnapshot> = new Map();
  private _refreshTimer: NodeJS.Timeout | null = null;
  private _isRefreshing = false;
  private _onAccountSwitched?: (email: string) => void | Promise<void>;
  private _switchRequest?: (email: string) => Promise<void>;

  constructor(
    ctx: vscode.ExtensionContext,
    onAccountSwitched?: (email: string) => void | Promise<void>,
    switchRequest?: (email: string) => Promise<void>
  ) {
    this._ctx = ctx;
    this._onAccountSwitched = onAccountSwitched;
    this._switchRequest = switchRequest;

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
          notifyUi('warning', t('sbPoolEmpty'));
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
              detailsParts.push(`${formatModelLabel(m)}: ${m.remainingPercent}%`);
            }
            details = detailsParts.join(' | ');
          }

          return {
            label: `${isCurrent ? '$(check) ' : ''}${a.email}`,
            description: a.name || '',
            detail: details ? `(${details})` : (a.disabled ? t('sbDisabled') : t('sbAvailable')),
            account: a,
            picked: isCurrent
          };
        });

        const selected = await vscode.window.showQuickPick(items, {
          placeHolder: t('sbPickAccount'),
          matchOnDescription: true,
          matchOnDetail: true
        });

        if (selected) {
          if (selected.account.disabled) {
            notifyUi('warning', t('sbAccountDisabled', selected.account.email));
            return;
          }

          const email = selected.account.email;
          if (email.toLowerCase() === curEmail.toLowerCase()) {
            notifyUi('info', t('sbAlreadyCurrent', email));
            return;
          }

          await vscode.window.withProgress({
            location: vscode.ProgressLocation.Notification,
            title: t('sbSwitching', email),
            cancellable: false
          }, async () => {
            // 复用侧栏完整切号链路（门控/token/凭据/状态库/agy/gemini/会话/引擎重载），
            // 不再单独调 seamlessSwitch——那会只切会话不切凭据
            try {
              await this._switchRequest?.(email);
              await this._onAccountSwitched?.(email);
              this.update();
              await this._refreshCurrentUsage();
            } catch (err) {
              notifyUi('error', t('sbSwitchFail', err instanceof Error ? err.message : String(err)));
            }
          });
        }
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

    // 订阅账号变化
    accountStore.onChange(() => {
      this.update();
      this._refreshCurrentUsage(); // 账号变化时刷新额度
    });
    
    // 初始更新
    this.update();
    
    // 启动时刷新当前账号额度
    this._refreshCurrentUsage();
    
    // 定时刷新当前账号额度（间隔可配置，改动即时生效）
    this._startRefreshTimer();
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

  private _sbCfg<T>(key: string, dft: T): T {
    return vscode.workspace.getConfiguration('antigravityKite.statusBar').get<T>(key, dft);
  }

  private _getStyle(): StatusBarStyle {
    const v = this._sbCfg<string>('style', 'full');
    return VALID_STYLES.includes(v as StatusBarStyle) ? (v as StatusBarStyle) : 'full';
  }

  private _getPosition(): StatusBarPosition {
    const v = this._sbCfg<string>('position', 'right');
    return VALID_POSITIONS.includes(v as StatusBarPosition) ? (v as StatusBarPosition) : 'right';
  }

  private _getRefreshSeconds(): number {
    const n = this._sbCfg<number>('refreshSeconds', 30);
    return Number.isFinite(n) ? Math.min(600, Math.max(10, Math.floor(n))) : 30;
  }

  /** 启动/重启当前账号额度定时刷新 */
  private _startRefreshTimer(): void {
    if (this._refreshTimer) clearInterval(this._refreshTimer);
    this._refreshTimer = setInterval(() => this._refreshCurrentUsage(), this._getRefreshSeconds() * 1000);
  }

  /** 按配置重建两个状态栏项的对齐方向（对齐仅创建时可指定，需重建 item） */
  private _ensureAlignment(position: StatusBarPosition): void {
    const target = position === 'left' ? vscode.StatusBarAlignment.Left : vscode.StatusBarAlignment.Right;
    if (target === this._currentAlignment) return;
    try { this._left.dispose(); } catch { /* ignore */ }
    try { this._right.dispose(); } catch { /* ignore */ }
    this._left = vscode.window.createStatusBarItem(target, 100);
    this._right = vscode.window.createStatusBarItem(target, 99);
    this._left.command = 'antigravityKite.quickSwitchAccount';
    this._right.command = OPEN_SIDEBAR_CMD;
    this._currentAlignment = target;
  }

  /**
   * 刷新状态栏显示
   */
  update(): void {
    if (!this._sbCfg('enabled', true)) {
      this._left.hide();
      this._right.hide();
      return;
    }
    this._ensureAlignment(this._getPosition());
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

    const style = this._getStyle();
    const icon = this._getStatusIcon(min);
    const credits = usage && usage.availableAICredits !== undefined && usage.availableAICredits !== null
      ? String(usage.availableAICredits) : '-';
    const showCredits = this._sbCfg('showCredits', true);

    // 极简样式（dot/percent/compact/dual）：只看最低额度，不含账号；无额度数据时回退账号前缀
    let text: string | null = null;
    if (usage && usage.models.length > 0) {
      switch (style) {
        case 'dot':
          text = icon;
          break;
        case 'percent':
          text = `${min}%`;
          break;
        case 'compact':
          text = `${icon} ${min}%`;
          break;
        case 'dual':
          text = showCredits ? `${icon} ${min}% | $(credit-card) ${credits}` : `${icon} ${min}%`;
          break;
      }
    }

    // labeled / full（及无数据回退）：账号前缀 | 各模型额度 | AI 积分
    if (text === null) {
      const segments: string[] = [];
      if (this._sbCfg('showAccount', true)) {
        const short = curEmail ? curEmail.split('@')[0] : t('sbNotLoggedIn');
        segments.push(`$(account) ${short}`);
      }
      if (usage && usage.models.length > 0 && this._sbCfg('showModels', true)) {
        for (const m of usage.models) {
          segments.push(`${this._getStatusIcon(m.remainingPercent)} ${formatModelLabel(m)}: ${m.remainingPercent}%`);
        }
        if (style === 'full' && showCredits) {
          segments.push(`$(credit-card) ${credits}`);
        }
      }
      if (segments.length > 0) {
        text = segments.join(' | ');
      }
    }

    if (text === null) {
      this._left.hide();
      return;
    }

    this._left.text = text;
    this._left.tooltip = this._buildTooltip(curEmail, usage);
    this._left.show();
  }

  private _buildTooltip(email: string, usage?: UsageSnapshot): vscode.MarkdownString {
    const md = new vscode.MarkdownString();
    md.isTrusted = true;
    md.supportThemeIcons = true;

    if (!email) {
      md.appendMarkdown(`**Antigravity Kite**\n\n${t('sbNotSignedInTip')}\n\n_${t('sbOpenPoolTip')}_`);
      return md;
    }

    md.appendMarkdown(`**${email}**\n\n`);

    if (usage && usage.models.length > 0) {
      // 显示订阅级别
      if (usage.tierId) {
        md.appendMarkdown(`**${t('sbSubscription')}**：${usage.tierId.toUpperCase()}\n\n`);
      }
      // 显示各分组配额（每组独立状态图标）
      for (const model of usage.models) {
        const icon = this._getStatusIcon(model.remainingPercent);
        md.appendMarkdown(`${icon} **${formatModelLabel(model)}**：${model.remainingPercent}%\n\n`);
      }
      // AI 积分
      if (usage.availableAICredits !== undefined) {
        md.appendMarkdown(`---\n\n**$(credit-card) ${t('sbAiCredits')}**：${usage.availableAICredits}\n`);
      }
    } else {
      md.appendMarkdown(`_${t('sbNoQuotaData')}_\n`);
    }

    md.appendMarkdown(`\n_${t('sbOpenPoolTip')}_`);
    return md;
  }

  private _renderRight(): void {
    if (!this._sbCfg('showPool', true)) {
      this._right.hide();
      return;
    }

    const accounts = accountStore.getAll();
    const curEmail = this._ctx.globalState.get<string>('currentEmail') || '';
    
    const total = accounts.filter(a => !a.disabled).length;
    const available = accounts.filter(a => !a.disabled && a.email !== curEmail).length;

    if (total === 0) {
      this._right.hide();
      return;
    }

    this._right.text = `$(pulse) ${t('sbPool')} ${available}/${total}`;
    this._right.tooltip = `${t('sbPoolTooltip', available, total)}\n\n_${t('sbOpenPoolTip')}_`;
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
