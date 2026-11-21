/**
 * 底部状态栏纯格式化与排序辅助模块（从 statusBar.ts 拆出以严控单文件规模）
 */
import { t } from './i18n';
import { AccountHealth, ModelQuota, StoredAccount, UsageSnapshot } from './types';

/** 状态栏左段信息密度：pulse 灵动最佳视图（推荐默认）；其余 7 档传统样式全保留 */
export type StatusBarStyle = 'pulse' | 'smart' | 'dot' | 'percent' | 'compact' | 'dual' | 'labeled' | 'full';
export type StatusBarPosition = 'left' | 'right';

export const VALID_STYLES: StatusBarStyle[] = ['pulse', 'smart', 'dot', 'percent', 'compact', 'dual', 'labeled', 'full'];
export const VALID_POSITIONS: StatusBarPosition[] = ['left', 'right'];

/** 样式白名单校验：非法值回退 pulse（默认灵动最佳视图） */
export function validateStyle(v: string): StatusBarStyle {
  return VALID_STYLES.includes(v as StatusBarStyle) ? (v as StatusBarStyle) : 'pulse';
}

export function pickHealthMark(health?: AccountHealth): { icon: string; bg: 'error' | 'warning' | undefined; banner: boolean } {
  switch (health?.status) {
    case 'banned':
      return { icon: '🚫', bg: 'error', banner: true };
    case 'auth_invalid':
      return { icon: '🔑', bg: 'warning', banner: true };
    case 'unknown':
      return { icon: '❓', bg: undefined, banner: false };
    case 'unreachable':
      return { icon: '$(cloud-offline)', bg: undefined, banner: false };
    default:
      return { icon: '', bg: undefined, banner: false };
  }
}

export function colorDot(pct: number): string {
  if (pct >= 50) return '🟢';
  if (pct >= 30) return '🟡';
  if (pct >= 10) return '🟠';
  return '🔴';
}

function windowShort(modelId: string): string {
  return modelId.endsWith(':weekly') ? t('quotaWeeklyShort') : '5h';
}

const FAMILY_LABELS: Record<string, string> = { claude: 'Claude', gemini: 'Gemini', argon: 'Gemini 4' };

export function fmtDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms <= 0) return '';
  const m = Math.round(ms / 60000);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 48) return `${h}h ${m % 60}m`;
  return `${Math.floor(h / 24)}d ${h % 24}h`;
}

export function formatResetHint(models: ModelQuota[]): string {
  const now = Date.now();
  let best: { m: ModelQuota; t: number } | null = null;
  for (const m of models) {
    const ts = m.resetTime ? new Date(m.resetTime).getTime() : NaN;
    if (!Number.isFinite(ts) || ts <= now) continue;
    if (!best || ts < best.t) best = { m, t: ts };
  }
  if (!best) return '';
  const famKey = (best.m.modelId || '').split(':')[0];
  return `🕐 ${FAMILY_LABELS[famKey] || famKey} ${windowShort(best.m.modelId)} ${fmtDuration(best.t - now)}`;
}

export function formatResetHintIn(models: ModelQuota[], familyKey: string): string {
  const now = Date.now();
  let best: { m: ModelQuota; t: number } | null = null;
  for (const m of models) {
    if ((m.modelId || '').split(':')[0] !== familyKey) continue;
    const ts = m.resetTime ? new Date(m.resetTime).getTime() : NaN;
    if (!Number.isFinite(ts) || ts <= now) continue;
    if (!best || ts < best.t) best = { m, t: ts };
  }
  if (!best) return '';
  return `🕐 ${windowShort(best.m.modelId)} ${fmtDuration(best.t - now)}`;
}

export function formatFamilySegments(models: ModelQuota[], families?: Set<string>, resetHints?: boolean): string {
  const FAMILIES: { key: string; label: string }[] = [
    { key: 'claude', label: 'Claude' },
    { key: 'gemini', label: 'Gemini' },
    { key: 'argon', label: 'Gemini 4' },
  ];
  const segments: string[] = [];
  for (const fam of FAMILIES) {
    if (families && !families.has(fam.key)) continue;
    const five = models.find(m => m.modelId === fam.key + ':5h');
    const week = models.find(m => m.modelId === fam.key + ':weekly');
    if (!five && !week) continue;
    const pcts = [five?.remainingPercent, week?.remainingPercent].filter((v): v is number => typeof v === 'number');
    const dot = colorDot(Math.min(...pcts));
    const pair = pcts.map(v => v + '%').join('/');
    const hint = resetHints ? formatResetHintIn(models, fam.key) : '';
    segments.push(dot + ' ' + fam.label + ' ' + pair + (hint ? ' ' + hint : ''));
  }
  return segments.join(' · ');
}

export function maskEmailStr(email: string): string {
  if (!email) return '';
  const at = email.indexOf('@');
  if (at <= 0) return email.slice(0, 2) + '***';
  const name = email.slice(0, at);
  const maskedName = name.length <= 2 ? name[0] + '***' : name.slice(0, 2) + '***' + name.slice(-1);
  return maskedName + '@***';
}

export function displayName(email: string, privacy: boolean): string {
  return privacy ? maskEmailStr(email) : email;
}

export function formatCredits(v: number | null | undefined): string {
  if (v === undefined || v === null || !Number.isFinite(v) || v <= 0) return '';
  const n = Number.isInteger(v) ? String(v) : String(Math.round(v * 100) / 100);
  return '🪙 ' + n;
}

export function displayTierLabel(tierId: string): string {
  const s = String(tierId);
  const low = s.toLowerCase();
  const mult = /(\d+x)/i.exec(s);
  if (low.includes('ultra') || low.includes('helium')) return 'Ultra' + (mult ? ' ' + mult[1] : '');
  if (low.includes('plus')) return 'Plus';
  if (low.includes('free') || low.includes('starter')) return 'Free';
  if (low.includes('pro') || low.includes('premium') || low.includes('advanced')) return 'Pro';
  if (low.includes('trial')) return 'Trial';
  if (low.includes('enterprise') || low.includes('standard') || low.includes('business') || low.startsWith('gcp_') || low.includes('vertex')) return 'Enterprise';
  if (low.includes('team')) return 'Team';
  return s;
}

export function degradeFlat(
  build: (withReset: boolean, withCredits: boolean) => string | null,
  fallback: string,
  limit = 180
): string {
  const effLen = (txt: string): number =>
    txt.replace(/\$\([a-z0-9-]+\)/gi, '@').replace(/[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/gu, '@@').length;
  for (const cand of [build(true, true), build(false, true), build(false, false)]) {
    if (cand !== null && cand.length > 0 && effLen(cand) <= limit) return cand;
  }
  return fallback;
}

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
    if (h === 'unknown' || h === 'unreachable') return 2;
    return 1;
  };
  return [...accounts].sort((a, b) => {
    const ra = rank(a);
    const rb = rank(b);
    if (ra !== rb) return ra - rb;
    if (ra === 1) {
      const pa = getUsage(a.email)?.minRemainingPercent ?? -1;
      const pb = getUsage(b.email)?.minRemainingPercent ?? -1;
      if (pb !== pa) return pb - pa;
    }
    return a.email.localeCompare(b.email);
  });
}

export function formatWindowShort(m: { label?: string; modelId?: string }): string {
  if (m.label) return m.label;
  const modelId = m.modelId || '';
  const family = modelId.startsWith('argon') ? 'Gemini 4'
    : modelId.startsWith('claude') ? 'Claude'
    : 'Gemini';
  const isWeekly = modelId.endsWith(':weekly');
  return `${family} ${isWeekly ? t('quotaWeekly') : t('quota5h')}`;
}

export function barColor(pct: number): string {
  if (pct >= 50) return '#10b981';
  if (pct >= 30) return '#f59e0b';
  if (pct >= 10) return '#f97316';
  return '#ef4444';
}

/** 灵动视图（pulse）主段格式化：健康充足保持呼吸感极简，低额(<30%)或异常自动展开提醒 */
export function formatPulseMainText(opts: {
  short: string;
  minPct: number;
  healthBanner: boolean;
  healthIcon: string;
  healthLabel: string;
  resetStr: string;
  showAccount: boolean;
  showModels: boolean;
}): string | null {
  if (opts.healthBanner) {
    return `${opts.healthIcon} ${opts.short} ${opts.healthLabel}`.trim();
  }
  const dot = colorDot(opts.minPct);
  const accPart = opts.showAccount ? `$(account) ${opts.short}` : '';
  const urgentReset = opts.minPct < 30 && opts.resetStr ? ` ${opts.resetStr}` : '';
  const quotaPart = opts.showModels ? `${dot} ${opts.minPct}%${urgentReset}` : '';
  if (accPart && quotaPart) return `${accPart} · ${quotaPart}`;
  if (accPart) return accPart;
  if (quotaPart) return quotaPart;
  return null;
}

