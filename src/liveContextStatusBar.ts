/**
 * 底栏实时上下文与 Token 速度分段控制器（独立 StatusBarItem，不挤压号池额度段）
 */
import * as vscode from 'vscode';
import { LiveContextSnapshot } from './liveContextMeter';
import { t } from './i18n';
import { logWarn } from './logger';

export const LIVE_CONTEXT_CMD = 'antigravityKite.showLiveContextDetails';

export interface LiveContextBarOptions {
  showContext: boolean;
  showSpeed: boolean;
  pulseMode?: boolean;
}

export function formatCompactTokens(n: number): string {
  if (!Number.isFinite(n) || n < 0) return '0';
  if (n >= 1_000_000) {
    return `${(n / 1_000_000).toFixed(2).replace(/\.?0+$/, '')}M`;
  }
  if (n >= 10_000) {
    return `${Math.round(n / 1000)}K`;
  }
  if (n >= 1_000) {
    return `${(n / 1000).toFixed(1).replace(/\.0$/, '')}K`;
  }
  return String(Math.round(n));
}

export function formatLiveContextBarText(
  snapshot: LiveContextSnapshot | null,
  opts: LiveContextBarOptions,
): string | null {
  if (!snapshot || (!opts.showContext && !opts.showSpeed)) return null;

  // 灵动最佳视图：空闲健康时只静默呈现上下文百分比；高水位 (>=80%) 或生成中才动态展开速率与并发子 Agent
  if (opts.pulseMode) {
    const pct = snapshot.percent !== null ? Math.round(snapshot.percent) : null;
    const speedVal = snapshot.streamingTps ?? snapshot.tps;
    const subCount = snapshot.activeSubagents ?? 0;

    if (snapshot.isRunning) {
      const segs: string[] = [];
      if (opts.showContext) {
        const pctPart = pct !== null ? `${pct}%` : formatCompactTokens(snapshot.usedTokens ?? 0);
        segs.push(`$(sync~spin) ${pctPart}`);
      }
      if (opts.showSpeed) {
        segs.push(speedVal !== null ? `⚡ ${speedVal} tok/s` : '⚡ ...');
      }
      if (subCount > 0) segs.push(`+${subCount} sub`);
      return segs.length > 0 ? segs.join(' · ') : null;
    }

    if (opts.showContext && snapshot.usedTokens !== null) {
      if (pct !== null && pct >= 80) {
        const warnIcon = pct >= 90 ? '🟠' : '🟡';
        const usedStr = `${snapshot.isEstimated ? '~' : ''}${formatCompactTokens(snapshot.usedTokens)}`;
        const budgetStr = snapshot.budgetTokens ? `/${formatCompactTokens(snapshot.budgetTokens)}` : '';
        return `${warnIcon} ${usedStr}${budgetStr} (${pct}%)`;
      }
      return pct !== null ? `$(pulse) ${pct}%` : `$(pulse) ${formatCompactTokens(snapshot.usedTokens)}`;
    }
    if (opts.showSpeed && speedVal !== null) return `⚡ ${speedVal} tok/s`;
    return null;
  }

  const parts: string[] = [];
  if (opts.showContext && snapshot.usedTokens !== null) {
    const icon = snapshot.isRunning
      ? '$(sync~spin)'
      : (snapshot.percent !== null && snapshot.percent >= 90
        ? '🟠'
        : snapshot.percent !== null && snapshot.percent >= 75
          ? '🟡'
          : '$(pulse)');
    const estMark = snapshot.isEstimated ? '~' : '';
    const usedStr = `${estMark}${formatCompactTokens(snapshot.usedTokens)}`;
    const budgetStr = snapshot.budgetTokens ? `/${formatCompactTokens(snapshot.budgetTokens)}` : '';
    const pctStr = snapshot.percent !== null ? ` (${Math.round(snapshot.percent)}%)` : '';
    parts.push(`${icon} ${usedStr}${budgetStr}${pctStr}`);
  }

  if (opts.showSpeed) {
    const speedVal = snapshot.streamingTps ?? snapshot.tps;
    if (speedVal !== null) {
      parts.push(`⚡ ${speedVal} tok/s`);
    } else if (snapshot.isRunning) {
      parts.push('⚡ ...');
    }
  }

  return parts.length > 0 ? parts.join(' · ') : null;
}

export function buildLiveContextTooltip(snapshot: LiveContextSnapshot | null): vscode.MarkdownString {
  const md = new vscode.MarkdownString();
  md.isTrusted = true;
  md.supportThemeIcons = true;

  if (!snapshot) {
    md.appendMarkdown(`**Antigravity Kite**\n\n_${t('sbCtxNoData')}_`);
    return md;
  }

  const stateTag = snapshot.isRunning ? t('sbCtxRunning') : t('sbCtxIdle');
  const titleLine = snapshot.title || snapshot.cascadeId.slice(0, 8);
  md.appendMarkdown(`**$(comment-discussion) ${titleLine}** · ${stateTag}\n\n`);
  if (snapshot.modelName) {
    md.appendMarkdown(`${t('sbCtxModel')}: \`${snapshot.modelName}\`\n\n`);
  }

  if (snapshot.usedTokens !== null) {
    const estHint = snapshot.isEstimated ? ` _(${t('sbCtxEstimated')})_` : '';
    const budgetText = snapshot.budgetTokens ? ` / ${snapshot.budgetTokens.toLocaleString()}` : '';
    const pctText = snapshot.percent !== null ? ` (**${snapshot.percent}%**)` : '';
    md.appendMarkdown(`---\n\n**$(pulse) ${t('sbCtxUsageTitle')}**: ${snapshot.usedTokens.toLocaleString()}${budgetText}${pctText}${estHint}\n\n`);

    if (typeof snapshot.remainingToCompactTokens === 'number') {
      const compactNote = snapshot.remainingToCompactTokens > 0
        ? t('sbCtxCompactRemain', formatCompactTokens(snapshot.remainingToCompactTokens))
        : t('sbCtxCompactDue');
      md.appendMarkdown(`- ${compactNote}\n`);
    }

    const detailCols: string[] = [];
    if (snapshot.inputTokens !== null) detailCols.push(`Input ${formatCompactTokens(snapshot.inputTokens)}`);
    if (snapshot.cacheReadTokens !== null) detailCols.push(`Cache ${formatCompactTokens(snapshot.cacheReadTokens)}`);
    if (snapshot.outputTokens !== null) detailCols.push(`Output ${formatCompactTokens(snapshot.outputTokens)}`);
    if (snapshot.thinkingTokens !== null && snapshot.thinkingTokens > 0) {
      detailCols.push(`Thinking ${formatCompactTokens(snapshot.thinkingTokens)}`);
    }
    if (detailCols.length > 0) {
      md.appendMarkdown(`- ${detailCols.join(' · ')}\n`);
    }
    if ((snapshot.activeSubagents ?? 0) > 0) {
      md.appendMarkdown(`- ${t('sbCtxSubagents', snapshot.activeSubagents ?? 0)}\n`);
    }
    md.appendMarkdown('\n');
  }

  const hasSpeed = snapshot.streamingTps !== null || snapshot.tps !== null || snapshot.ttftSec !== null;
  if (hasSpeed) {
    const prevNote = snapshot.isPreviousSpeed ? ` _(${t('sbCtxPrevTurn')})_` : '';
    md.appendMarkdown(`---\n\n**⚡ ${t('sbCtxSpeedTitle')}**${prevNote}\n\n`);
    if (snapshot.streamingTps !== null) {
      md.appendMarkdown(`- ${t('sbCtxStreamingSpeed')}: **${snapshot.streamingTps} tok/s**\n`);
    }
    if (snapshot.tps !== null) {
      md.appendMarkdown(`- ${t('sbCtxOverallSpeed')}: ${snapshot.tps} tok/s\n`);
    }
    if (snapshot.ttftSec !== null) {
      md.appendMarkdown(`- TTFT: ${snapshot.ttftSec}s`);
      if (snapshot.durationSec !== null) {
        md.appendMarkdown(` · ${t('sbCtxTotalDur')}: ${snapshot.durationSec}s`);
      }
      md.appendMarkdown('\n');
    }
    md.appendMarkdown('\n');
  }

  md.appendMarkdown(
    `---\n\n[$(sliders) ${t('sbJumpViewSettings')}](command:antigravityKite.openAppearanceSettings)`
    + (snapshot.updatedAt ? ` · _${t('sbUpdated')} ${new Date(snapshot.updatedAt).toLocaleTimeString()}_` : '')
    + ` · _${t('sbCtxClickTip')}_`
  );
  return md;
}

export class LiveContextStatusBar implements vscode.Disposable {
  private _item: vscode.StatusBarItem;
  private _alignment: vscode.StatusBarAlignment;

  constructor(alignment: vscode.StatusBarAlignment) {
    this._alignment = alignment;
    this._item = this._createItem(alignment);
  }

  private _createItem(alignment: vscode.StatusBarAlignment): vscode.StatusBarItem {
    const item = vscode.window.createStatusBarItem(alignment, 98);
    item.command = LIVE_CONTEXT_CMD;
    item.name = 'Kite Live Context';
    return item;
  }

  setAlignment(alignment: vscode.StatusBarAlignment): void {
    if (alignment === this._alignment) return;
    try {
      this._item.dispose();
    } catch (err) {
      logWarn('liveContextBar.dispose', { error: err instanceof Error ? err.message : String(err) });
    }
    this._alignment = alignment;
    this._item = this._createItem(alignment);
  }

  render(enabled: boolean, snapshot: LiveContextSnapshot | null, opts: LiveContextBarOptions): void {
    if (!enabled || (!opts.showContext && !opts.showSpeed)) {
      this._item.hide();
      return;
    }
    const text = formatLiveContextBarText(snapshot, opts);
    if (!text) {
      this._item.hide();
      return;
    }
    this._item.text = text;
    this._item.tooltip = buildLiveContextTooltip(snapshot);
    this._item.show();
  }

  hide(): void {
    this._item.hide();
  }

  dispose(): void {
    try {
      this._item.dispose();
    } catch {
      /* ignore */
    }
  }
}
