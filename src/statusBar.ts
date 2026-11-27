/**
 * 底部状态栏管理器（v1.5.4：保留 7 档传统样式 + 默认 pulse 灵动最佳视图）
 */
import * as vscode from 'vscode';
import * as accountStore from './accountStore';
import { t } from './i18n';
import { LiveContextSnapshot } from './liveContextMeter';
import { LIVE_CONTEXT_CMD, LiveContextStatusBar } from './liveContextStatusBar';
import { logWarn } from './logger';
import {
  StatusBarPosition,
  StatusBarStyle,
  VALID_POSITIONS,
  barColor,
  colorDot,
  degradeFlat,
  displayName,
  displayTierLabel,
  fmtDuration,
  formatCredits,
  formatFamilySegments,
  formatPulseMainText,
  formatResetHint,
  formatResetHintIn,
  formatWindowShort,
  maskEmailStr,
  pickHealthMark,
  sortPoolForQuickPick,
  validateStyle,
} from './statusBarFormat';
import { AccountHealth, ModelQuota, StoredAccount, UsageSnapshot } from './types';
import { notifyUi } from './uiChannel';

export * from './statusBarFormat';

function safeDispose(item: vscode.Disposable | undefined, label: string): void {
  if (!item) return;
  try {
    item.dispose();
  } catch (err) {
    logWarn('statusBar.dispose', { label, error: err instanceof Error ? err.message : String(err) });
  }
}

const OPEN_SIDEBAR_CMD = 'antigravityKite.openSidebar';

export interface StatusBarDeps {
  getUsage?: (email: string) => UsageSnapshot | undefined;
  refreshCurrent?: (email: string) => Promise<void>;
  refreshAll?: () => Promise<void>;
  openSettings?: () => void;
  openAppearanceSettings?: () => void;
  getPrivacy?: () => boolean;
  getUsageError?: (email: string) => string | undefined;
  getLiveContext?: () => LiveContextSnapshot | null;
  refreshLiveContext?: () => Promise<LiveContextSnapshot | null>;
  setLiveContextEnabled?: (enabled: boolean) => void;
  openLogPanel?: () => void;
}

export class StatusBarManager implements vscode.Disposable {
  private _main: vscode.StatusBarItem;
  private _pool: vscode.StatusBarItem;
  private _liveContext: LiveContextStatusBar;
  private _ctx: vscode.ExtensionContext;
  private _deps: StatusBarDeps;
  private _disposables: vscode.Disposable[] = [];
  private _currentAlignment: vscode.StatusBarAlignment = vscode.StatusBarAlignment.Right;
  private _redrawTimer: NodeJS.Timeout | null = null;

  constructor(
    ctx: vscode.ExtensionContext,
    onAccountSwitched?: (email: string) => void | Promise<void>,
    switchRequest?: (email: string) => Promise<void>,
    deps: StatusBarDeps = {}
  ) {
    this._ctx = ctx;
    this._deps = deps;

    this._main = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
    this._main.command = 'antigravityKite.quickSwitchAccount';
    this._main.name = 'Kite Quota';

    this._pool = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 99);
    this._pool.command = OPEN_SIDEBAR_CMD;
    this._pool.name = 'Kite Pool';

    this._liveContext = new LiveContextStatusBar(vscode.StatusBarAlignment.Right);

    this._disposables.push(
      vscode.commands.registerCommand(OPEN_SIDEBAR_CMD, () => {
        vscode.commands.executeCommand('antigravityKite.sidebar.focus');
      }),
      vscode.commands.registerCommand(LIVE_CONTEXT_CMD, () => {
        void this.showLiveContextDetails();
      }),
      vscode.commands.registerCommand('antigravityKite.quickSwitchAccount', async () => {
        await this._showQuickSwitch(onAccountSwitched, switchRequest);
      }),
      vscode.workspace.onDidChangeConfiguration(e => {
        if (e.affectsConfiguration('antigravityKite.statusBar')) {
          this.update();
        }
      }),
      accountStore.onChange(() => this.update()),
    );

    this._redrawTimer = setInterval(() => this.update(), 60 * 1000);
    this._disposables.push({
      dispose: () => {
        if (this._redrawTimer) { clearInterval(this._redrawTimer); this._redrawTimer = null; }
      },
    });

    this.update();
  }

  updateUsage(_email: string, _usage: UsageSnapshot): void {
    this.update();
  }

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
    return validateStyle(this._sbCfg<string>('style', 'pulse'));
  }

  private _getPosition(): StatusBarPosition {
    const v = this._sbCfg<string>('position', 'right');
    return VALID_POSITIONS.includes(v as StatusBarPosition) ? (v as StatusBarPosition) : 'right';
  }

  private _ensureAlignment(position: StatusBarPosition): void {
    const target = position === 'left' ? vscode.StatusBarAlignment.Left : vscode.StatusBarAlignment.Right;
    if (target === this._currentAlignment) return;
    safeDispose(this._main, 'main');
    safeDispose(this._pool, 'pool');
    this._main = vscode.window.createStatusBarItem(target, 100);
    this._pool = vscode.window.createStatusBarItem(target, 99);
    this._main.command = 'antigravityKite.quickSwitchAccount';
    this._main.name = 'Kite Quota';
    this._pool.command = OPEN_SIDEBAR_CMD;
    this._pool.name = 'Kite Pool';
    this._currentAlignment = target;
    this._liveContext.setAlignment(target);
  }

  update(): void {
    if (!this._sbCfg('enabled', true)) {
      this._main.hide();
      this._pool.hide();
      this._liveContext.hide();
      this._deps.setLiveContextEnabled?.(false);
      return;
    }
    this._ensureAlignment(this._getPosition());
    this._renderMain();
    this._renderPool();
    this.updateLiveContext();
  }

  updateLiveContext(): void {
    const enabled = this._sbCfg('enabled', true);
    const showContext = this._sbCfg('showLiveContext', true);
    const showSpeed = this._sbCfg('showLiveSpeed', true);
    const active = enabled && (showContext || showSpeed);
    this._deps.setLiveContextEnabled?.(active);
    this._liveContext.render(active, this._deps.getLiveContext?.() ?? null, {
      showContext,
      showSpeed,
      pulseMode: this._getStyle() === 'pulse',
    });
  }

  async showLiveContextDetails(): Promise<void> {
    this._deps.openLogPanel?.();
  }

  private _getFamilies(): Set<string> {
    const v = this._sbCfg<string[]>('families', ['claude', 'gemini', 'argon']);
    const all = new Set(['claude', 'gemini', 'argon']);
    if (!Array.isArray(v)) return all;
    const set = new Set(v.filter((x): x is string => typeof x === 'string' && all.has(x)));
    return set.size > 0 ? set : all;
  }

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

    const health = pickHealthMark(account?.health);
    const healthIcon = health.banner ? health.icon : '';
    const healthLabel = this._healthShortLabel(account?.health);

    const models = rawUsage ? this._filteredModels(rawUsage) : [];
    const hasQuota = showModels && models.length > 0;
    const pcts = models.map(m => m.remainingPercent).filter(v => typeof v === 'number');
    const min = hasQuota && pcts.length > 0 ? Math.min(...pcts) : 100;
    const quotaIcon = colorDot(min);
    const creditsStr = showCredits && rawUsage ? formatCredits(rawUsage.availableAICredits) : '';
    const tier = rawUsage?.tierId ? displayTierLabel(String(rawUsage.tierId)) : '';
    const tierStr = showTier && tier && tier !== 'Free' ? ` ·${tier}` : '';
    const resetStr = showReset && hasQuota ? formatResetHint(models) : '';

    this._main.backgroundColor = health.bg === 'error'
      ? new vscode.ThemeColor('statusBarItem.errorBackground')
      : health.bg === 'warning'
        ? new vscode.ThemeColor('statusBarItem.warningBackground')
        : undefined;

    const smartText = (): string | null => {
      if (health.banner) return `${health.icon} ${short} ${healthLabel}`.trim();
      const parts: string[] = [];
      if (showAccount) parts.push(`$(account) ${short}${tierStr}`);
      if (hasQuota) parts.push(`${quotaIcon} ${min}%${resetStr ? ' ' + resetStr : ''}`);
      if (creditsStr) parts.push(creditsStr);
      return parts.length > 0 ? parts.join(' ').trim() : null;
    };

    let text: string | null = null;
    if (rawUsage && models.length > 0) {
      switch (style) {
        case 'pulse':
          text = formatPulseMainText({
            short,
            minPct: min,
            healthBanner: health.banner,
            healthIcon,
            healthLabel,
            resetStr,
            showAccount,
            showModels,
          });
          break;
        case 'dot':
          text = healthIcon || (hasQuota ? quotaIcon : null);
          break;
        case 'percent':
          text = hasQuota ? `${min}%` : null;
          break;
        case 'compact':
          text = hasQuota ? `${healthIcon || quotaIcon} ${min}%${resetStr ? ' ' + resetStr : ''}` : null;
          break;
        case 'dual':
          text = hasQuota
            ? `${healthIcon || quotaIcon} ${min}%${resetStr ? ' ' + resetStr : ''}${creditsStr ? ' | ' + creditsStr : ''}`
            : (creditsStr || null);
          break;
        case 'smart':
          text = smartText();
          break;
        case 'labeled':
        case 'full':
          text = this._flatText(style, models, rawUsage, short, showAccount, showModels, showCredits, healthIcon, quotaIcon, tierStr, resetStr);
          break;
      }
    }

    if (text === null) {
      text = smartText();
      if (text === null) {
        this._main.hide();
        return;
      }
    }

    if (!health.banner && this._deps.getUsageError?.(curEmail)) {
      text = `${text} $(history)`;
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
      case 'unreachable': return t('sbHealthUnreachable');
      default: return '';
    }
  }

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
        const famSegs = formatFamilySegments(models, undefined, !!resetStr);
        if (famSegs) segments.push(famSegs);
      }
      if (style === 'full' && showCredits) {
        const c = formatCredits(usage.availableAICredits);
        if (c) segments.push(c);
      }
    }
    if (segments.length === 0) return null;
    const minPct = models.length > 0 ? Math.min(...models.map(m => m.remainingPercent)) : 100;
    return degradeFlat(
      (withReset, withCredits) => {
        const segs: string[] = [];
        if (healthIcon) {
          segs.push(`${healthIcon} ${short} ${this._healthShortLabel(accountStore.getByEmail(this._ctx.globalState.get<string>('currentEmail') || '')?.health)}`.trim());
        } else {
          if (showAccount) segs.push(`$(account) ${short}${tierStr}`);
          if (showModels) {
            const famSegs = formatFamilySegments(models, undefined, withReset);
            if (famSegs) segs.push(famSegs);
          }
          if (style === 'full' && showCredits && withCredits) {
            const c = formatCredits(usage.availableAICredits);
            if (c) segs.push(c);
          }
        }
        return segs.length > 0 ? segs.join(' | ') : null;
      },
      `${quotaIcon} ${minPct}% | $(account) ${short}`
    );
  }

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

    const allAccounts = accountStore.getAll();
    const total = allAccounts.filter(a => !a.disabled).length;
    const available = allAccounts.filter(a => !a.disabled && a.email !== email).length;

    if (!email) {
      md.appendMarkdown(`**Antigravity Kite**\n\n${t('sbNotSignedInTip')}\n\n[$(sliders) ${t('sbJumpViewSettings')}](command:antigravityKite.openAppearanceSettings)`);
      return md;
    }

    const account = accountStore.getByEmail(email);
    const privacy = this._deps.getPrivacy?.() ?? false;
    const poolChip = total > 0 ? ` · ${t('sbPool')} ${available}/${total}` : '';
    md.appendMarkdown(`**$(account) ${displayName(email, privacy)}**${account?.name ? ` · ${account.name}` : ''}${usage?.tierId ? ` · ${usage.tierId.toUpperCase()}` : ''}${poolChip}\n\n`);

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
      if (typeof usage.availableAICredits === 'number' && usage.availableAICredits > 0) {
        md.appendMarkdown(`---\n\n**🪙 ${t('sbAiCredits')}**：${usage.availableAICredits}\n\n`);
      }
      if (usage.updatedAt) {
        md.appendMarkdown(`_${t('sbUpdated')} ${new Date(usage.updatedAt).toLocaleTimeString()}_\n\n`);
      }
      const cacheError = this._deps.getUsageError?.(email);
      if (cacheError) {
        const at = usage.updatedAt ? new Date(usage.updatedAt).toLocaleTimeString() : t('ui.unknown');
        md.appendMarkdown(`$(history) **${t('sbCached')}** —— ${t('sbRefreshFailedTip', at, cacheError.replace(/\|/g, '/'))}\n\n`);
      }
    } else {
      md.appendMarkdown(`_${t('sbNoQuotaData')}_\n\n`);
    }

    md.appendMarkdown(
      `---\n\n[$(sliders) ${t('sbJumpViewSettings')}](command:antigravityKite.openAppearanceSettings)`
      + ` &nbsp;·&nbsp; [$(graph) ${t('sbOpenStatsPanel')}](command:antigravityKite.openLogPanel)`
      + `\n\n_${t('sbTooltipClick')}_`
    );
    return md;
  }

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
    // 灵动视图下号池可用数收进 Tooltip 与 QuickPick 标题，避免底栏零碎分段
    if (this._getStyle() === 'pulse' || !this._sbCfg('showPool', true)) {
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
    const totalActive = accounts.filter(a => !a.disabled).length;
    const availBackup = accounts.filter(a => !a.disabled && a.email !== curEmail).length;

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
      else if (a.health?.status === 'unreachable') details.push(t('sbHealthUnreachable'));
      if (usage && usage.models.length > 0) {
        details.push(usage.models.map(m => `${formatWindowShort(m)} ${m.remainingPercent}%`).join(' · '));
        if (typeof usage.availableAICredits === 'number' && usage.availableAICredits > 0) {
          details.push(formatCredits(usage.availableAICredits));
        }
      }
      const qpTierRaw = usage?.tierId;
      const qpTier = qpTierRaw ? displayTierLabel(String(qpTierRaw)) : '';
      return {
        label: `${healthIconOf(a)} ${displayName(a.email, privacy)}`,
        description: [isCurrent ? t('sbCurrent') : (a.name || ''), qpTier && qpTier !== 'Free' ? qpTier : ''].filter(Boolean).join(' · ') || undefined,
        detail: details.length > 0 ? details.join(' | ') : (a.disabled ? t('sbDisabled') : t('sbAvailable')),
        type: 'account' as const,
        email: a.email,
      };
    });

    items.push({ label: t('qpQuickActions'), kind: vscode.QuickPickItemKind.Separator, type: 'action' });
    items.push({
      label: `$(sliders) ${t('qpOpenAppearanceSettings')}`,
      detail: t('qpOpenAppearanceSettingsDesc'),
      actionId: 'openAppearanceSettings',
      type: 'action',
    });
    items.push({
      label: `$(refresh) ${t('qpRefreshAll')}`,
      detail: t('qpRefreshAllDesc'),
      actionId: 'refreshAll',
      type: 'action',
    });
    items.push({
      label: `$(layout-sidebar-left) ${t('qpOpenPanel')}`,
      detail: t('qpOpenPanelDesc'),
      actionId: 'openPanel',
      type: 'action',
    });
    items.push({
      label: `$(graph) ${t('sbOpenStatsPanel')}`,
      detail: t('sbCtxClickTip'),
      actionId: 'openLogPanel',
      type: 'action',
    });

    const selected = await vscode.window.showQuickPick(items, {
      title: `Antigravity Kite · ${t('sbPool')} ${availBackup}/${totalActive}`,
      placeHolder: t('sbPickAccount'),
      matchOnDescription: true,
      matchOnDetail: true,
    });

    if (!selected) return;

    if (selected.type === 'action') {
      switch (selected.actionId) {
        case 'openAppearanceSettings':
          if (this._deps.openAppearanceSettings) this._deps.openAppearanceSettings();
          else this._deps.openSettings?.();
          break;
        case 'openLogPanel':
          this._deps.openLogPanel?.();
          break;
        case 'refreshAll':
          await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: t('qpRefreshAll'), cancellable: false }, async () => {
            try { await this._deps.refreshAll?.(); } catch (err) { notifyUi('error', t('sbSwitchFail', err instanceof Error ? err.message : String(err))); }
          });
          this.update();
          break;
        case 'openPanel':
          await vscode.commands.executeCommand(OPEN_SIDEBAR_CMD);
          break;
      }
      return;
    }

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

    await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: t('sbSwitching', account.email), cancellable: false }, async () => {
      try {
        await switchRequest?.(account.email);
        await onAccountSwitched?.(account.email);
        this.update();
      } catch (err) {
        notifyUi('error', t('sbSwitchFail', err instanceof Error ? err.message : String(err)));
      }
    });
  }

  hide(): void {
    this._main.hide();
    this._pool.hide();
    this._liveContext.hide();
  }

  show(): void { this.update(); }

  dispose(): void {
    safeDispose(this._main, 'main');
    safeDispose(this._pool, 'pool');
    safeDispose(this._liveContext, 'liveContext');
    for (const d of this._disposables) { safeDispose(d, 'subscription'); }
    this._disposables = [];
  }
}
