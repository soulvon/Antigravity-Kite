/**
 * 本机实时上下文与 Token 速度探测器（直连 Antigravity daemon Hub RPC）
 *
 * 机制：
 * - 零 ASAR 补丁、零 CDP 侵入：直接读取 ~/.gemini/antigravity/daemon/hub_*.json，
 *   用 process.kill(pid, 0) 过滤出本机存活的 Language Server 实例。
 * - 调用 LanguageServerService/GetAllCascadeTrajectories 与 GetCascadeTrajectoryGeneratorMetadata
 *   获取当前工作区正在运行（或最近活跃）会话的上下文占用、预算上限、TTFT 与输出速度（tok/s）。
 * - 读失败 / 找不到活跃会话一律返回 null / unavailable，不伪造 0% 或虚假速度。
 */
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import { httpRequest } from './httpClient';
import { logWarn } from './logger';

export interface DaemonHubInfo {
  fileName: string;
  pid: number;
  httpPort: number;
  httpsPort?: number;
  csrfToken: string;
  lsVersion?: string;
  mtimeMs: number;
}

export interface RawWorkspaceRef {
  workspaceFolderAbsoluteUri?: string;
  gitRootAbsoluteUri?: string;
}

export interface RawTrajectorySummary {
  summary?: string;
  stepCount?: number;
  lastModifiedTime?: string;
  status?: string;
  workspaces?: RawWorkspaceRef[];
}

export interface TrajectoryCandidate {
  hub: DaemonHubInfo;
  cascadeId: string;
  summary: RawTrajectorySummary;
  workspaceMatched: boolean;
  isRunning: boolean;
  lastModifiedMs: number;
  activeSubagents?: number;
  totalSubagents?: number;
}

export interface TokenBreakdownGroup {
  groupLabel?: string;
  type?: string;
  tokenCount?: number;
  numTokens?: number;
  tokens?: number;
}

export interface LiveContextSnapshot {
  cascadeId: string;
  title: string;
  modelName: string;
  isRunning: boolean;
  workspaceMatched: boolean;
  usedTokens: number | null;
  budgetTokens: number | null;
  percent: number | null;
  isEstimated: boolean;
  estimatedTokens: number | null;
  inputTokens: number | null;
  cacheReadTokens: number | null;
  outputTokens: number | null;
  thinkingTokens: number | null;
  responseTokens: number | null;
  ttftSec: number | null;
  streamingSec: number | null;
  durationSec: number | null;
  streamingTps: number | null;
  tps: number | null;
  isPreviousSpeed: boolean;
  breakdownGroups: { label: string; tokens: number }[];
  remainingToCompactTokens?: number | null;
  turnStepCount?: number;
  turnThinkingTokens?: number | null;
  turnResponseTokens?: number | null;
  turnDurationSec?: number | null;
  activeSubagents?: number;
  totalSubagents?: number;
  updatedAt: number;
}

export interface LiveContextRpcDeps {
  daemonDir?: string;
  isPidAlive?: (pid: number) => boolean;
  rpcPost?: (hub: DaemonHubInfo, method: string, body: Record<string, unknown>, timeoutMs: number) => Promise<unknown>;
  getWorkspaceUris?: () => string[];
  isWindowFocused?: () => boolean;
}

const HUB_FILE_RE = /^hub_\d+\.json$/;
const RPC_TIMEOUT_MS = 1500;
const FAST_POLL_MS = 1500;
const IDLE_POLL_MS = 6000;
const DORMANT_POLL_MS = 15000;
const RECENT_ACTIVE_HOLD_MS = 15_000;

export function getDefaultDaemonDir(): string {
  return path.join(os.homedir(), '.gemini', 'antigravity', 'daemon');
}

export function isPidAliveDefault(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    const code = (err as NodeJS.ErrnoException)?.code;
    return code === 'EPERM';
  }
}

export function parseDurationSec(value: unknown): number | null {
  if (value === undefined || value === null || value === '') return null;
  if (typeof value === 'number') {
    return Number.isFinite(value) && value >= 0 ? value : null;
  }
  const match = String(value).trim().match(/^([\d.]+)\s*s?$/i);
  if (!match) return null;
  const num = Number(match[1]);
  return Number.isFinite(num) && num >= 0 ? num : null;
}

function toNonNegInt(value: unknown): number | null {
  if (value === undefined || value === null || value === '') return null;
  const num = typeof value === 'number' ? value : Number(String(value).trim());
  if (!Number.isFinite(num) || num < 0) return null;
  return Math.round(num);
}

/** 规范化本地文件夹 URI，统一盘符与斜杠用于工作区比对 */
export function normalizeWorkspaceUri(rawUri: string): string {
  if (!rawUri || typeof rawUri !== 'string') return '';
  let decoded = rawUri.trim();
  try {
    decoded = decodeURIComponent(decoded);
  } catch {
    /* 保留原串 */
  }
  decoded = decoded.replace(/\\/g, '/').replace(/\/+$/, '');
  if (process.platform === 'win32' || /^file:\/\/\/[a-zA-Z]:/.test(decoded)) {
    decoded = decoded.toLowerCase();
  }
  return decoded;
}

function uriMatchesWorkspace(candidateUri: string, openUris: string[]): boolean {
  const norm = normalizeWorkspaceUri(candidateUri);
  if (!norm) return false;
  for (const open of openUris) {
    if (!open) continue;
    if (norm === open || norm.startsWith(open + '/') || open.startsWith(norm + '/')) {
      return true;
    }
  }
  return false;
}

export function parseDaemonHubJson(rawText: string, fileName: string, mtimeMs: number): DaemonHubInfo | null {
  try {
    const parsed = JSON.parse(rawText) as Record<string, unknown>;
    const pid = Number(parsed?.pid);
    const httpPort = Number(parsed?.httpPort);
    const httpsPort = parsed?.httpsPort !== undefined ? Number(parsed.httpsPort) : undefined;
    const csrfToken = typeof parsed?.csrfToken === 'string' ? parsed.csrfToken.trim() : '';
    if (!Number.isInteger(pid) || pid <= 0) return null;
    if (!Number.isInteger(httpPort) || httpPort <= 0 || httpPort > 65535) return null;
    if (!csrfToken) return null;
    return {
      fileName,
      pid,
      httpPort,
      ...(httpsPort && Number.isInteger(httpsPort) && httpsPort > 0 && httpsPort <= 65535 ? { httpsPort } : {}),
      csrfToken,
      lsVersion: typeof parsed?.lsVersion === 'string' ? parsed.lsVersion : undefined,
      mtimeMs,
    };
  } catch {
    return null;
  }
}

/** 发现本机正在运行的 daemon Hub（只保留 PID 存活的实例，按修改时间降序） */
export function discoverAliveHubDaemons(
  daemonDir = getDefaultDaemonDir(),
  isPidAlive: (pid: number) => boolean = isPidAliveDefault,
): DaemonHubInfo[] {
  if (!daemonDir || !fs.existsSync(daemonDir)) return [];
  let files: string[];
  try {
    files = fs.readdirSync(daemonDir);
  } catch (err) {
    logWarn('liveContext.readDaemonDirFail', { daemonDir, error: err instanceof Error ? err.message : String(err) });
    return [];
  }

  const alive: DaemonHubInfo[] = [];
  for (const fileName of files) {
    if (!HUB_FILE_RE.test(fileName)) continue;
    const fullPath = path.join(daemonDir, fileName);
    try {
      const st = fs.statSync(fullPath);
      if (!st.isFile()) continue;
      const raw = fs.readFileSync(fullPath, 'utf8');
      const parsed = parseDaemonHubJson(raw, fileName, st.mtimeMs);
      if (!parsed) continue;
      if (!isPidAlive(parsed.pid)) continue;
      alive.push(parsed);
    } catch {
      /* 忽略瞬态锁或权限文件 */
    }
  }
  alive.sort((a, b) => b.mtimeMs - a.mtimeMs);
  return alive;
}

/** 从多 Hub 返回的会话列表中挑选最匹配当前 IDE 窗口的对话 */
export function pickBestTrajectory(
  entries: { hub: DaemonHubInfo; summaries: Record<string, RawTrajectorySummary> }[],
  openWorkspaceUris: string[],
): TrajectoryCandidate | null {
  const normOpens = openWorkspaceUris.map(normalizeWorkspaceUri).filter(Boolean);
  const candidates: TrajectoryCandidate[] = [];

  for (const entry of entries) {
    if (!entry.summaries || typeof entry.summaries !== 'object') continue;
    for (const [cascadeId, summary] of Object.entries(entry.summaries)) {
      if (!summary || typeof summary !== 'object') continue;
      const wsRefs = Array.isArray(summary.workspaces) ? summary.workspaces : [];
      const workspaceMatched = normOpens.length > 0 && wsRefs.some((w) =>
        uriMatchesWorkspace(w?.workspaceFolderAbsoluteUri || '', normOpens) ||
        uriMatchesWorkspace(w?.gitRootAbsoluteUri || '', normOpens)
      );
      const isRunning = summary.status === 'CASCADE_RUN_STATUS_RUNNING';
      const parsedTs = summary.lastModifiedTime ? Date.parse(summary.lastModifiedTime) : NaN;
      const lastModifiedMs = Number.isFinite(parsedTs) ? parsedTs : 0;
      candidates.push({
        hub: entry.hub,
        cascadeId,
        summary,
        workspaceMatched,
        isRunning,
        lastModifiedMs,
      });
    }
  }

  if (candidates.length === 0) return null;

  candidates.sort((a, b) => {
    if (normOpens.length > 0 && a.workspaceMatched !== b.workspaceMatched) {
      return a.workspaceMatched ? -1 : 1;
    }
    if (a.isRunning !== b.isRunning) {
      return a.isRunning ? -1 : 1;
    }
    if (b.lastModifiedMs !== a.lastModifiedMs) {
      return b.lastModifiedMs - a.lastModifiedMs;
    }
    return b.hub.mtimeMs - a.hub.mtimeMs;
  });

  return candidates[0];
}

interface RawChatModel {
  model?: string;
  responseModel?: string;
  modelDisplayName?: string;
  error?: unknown;
  retryInfos?: { error?: unknown; usage?: Record<string, unknown> }[];
  usage?: Record<string, unknown>;
  timeToFirstToken?: unknown;
  streamingDuration?: unknown;
  chatStartMetadata?: {
    contextWindowMetadata?: {
      estimatedTokensUsed?: unknown;
      maxContextTokens?: unknown;
      tokenBreakdown?: {
        groups?: Record<string, unknown>[];
      };
    };
  };
}

function extractBreakdownGroups(cm: RawChatModel | null): { label: string; tokens: number }[] {
  const groups = cm?.chatStartMetadata?.contextWindowMetadata?.tokenBreakdown?.groups;
  if (!Array.isArray(groups)) return [];
  const out: { label: string; tokens: number }[] = [];
  for (const g of groups) {
    if (!g || typeof g !== 'object') continue;
    const rawLabel = g.groupLabel ?? g.label ?? g.type ?? g.groupType ?? g.category;
    const tokens = toNonNegInt(g.tokenCount ?? g.numTokens ?? g.tokens);
    if (tokens === null || tokens <= 0) continue;
    const label = typeof rawLabel === 'string' && rawLabel.trim() ? rawLabel.trim() : 'Other';
    out.push({ label, tokens });
  }
  return out;
}

function computeSpeedMetrics(cm: RawChatModel | null): {
  ttftSec: number | null;
  streamingSec: number | null;
  durationSec: number | null;
  streamingTps: number | null;
  tps: number | null;
} | null {
  if (!cm) return null;
  const retryArr = Array.isArray(cm.retryInfos) ? cm.retryInfos : [];
  const lastRetry = retryArr.length > 0 ? retryArr[retryArr.length - 1] : undefined;
  const usage = lastRetry?.usage || cm.usage;
  const output = toNonNegInt(usage?.outputTokens) ?? 0;
  const ttftSec = parseDurationSec(cm.timeToFirstToken);
  const streamingSec = parseDurationSec(cm.streamingDuration);
  const durationSec = (ttftSec !== null && streamingSec !== null)
    ? ttftSec + streamingSec
    : (ttftSec ?? streamingSec ?? null);
  const streamingTps = output > 0 && streamingSec !== null && streamingSec > 0.05
    ? Number((output / streamingSec).toFixed(1))
    : null;
  const tps = output > 0 && durationSec !== null && durationSec > 0
    ? Number((output / durationSec).toFixed(1))
    : null;
  if (streamingTps === null && tps === null && ttftSec === null) return null;
  return {
    ttftSec: ttftSec !== null ? Number(ttftSec.toFixed(2)) : null,
    streamingSec: streamingSec !== null ? Number(streamingSec.toFixed(2)) : null,
    durationSec: durationSec !== null ? Number(durationSec.toFixed(2)) : null,
    streamingTps,
    tps,
  };
}

/** 从 generatorMetadata 尾部列表提取当前对话上下文与实时速度快照 */
export function extractLiveContextSnapshot(
  metadataList: { chatModel?: RawChatModel }[],
  candidate: Pick<TrajectoryCandidate, 'cascadeId' | 'summary' | 'workspaceMatched' | 'isRunning' | 'activeSubagents' | 'totalSubagents'>,
  previousValid?: LiveContextSnapshot | null,
  nowMs = Date.now(),
): LiveContextSnapshot | null {
  const sameConvPrev = previousValid && previousValid.cascadeId === candidate.cascadeId ? previousValid : null;
  const list = Array.isArray(metadataList) ? metadataList : [];

  let latestCm: RawChatModel | null = null;
  let reportedCm: RawChatModel | null = null;
  let speedMetrics: ReturnType<typeof computeSpeedMetrics> = null;
  let speedIsFromLatest = false;

  for (let i = list.length - 1; i >= 0; i--) {
    const cm = list[i]?.chatModel;
    if (!cm || typeof cm !== 'object') continue;
    if (!latestCm) latestCm = cm;

    const retryArr = Array.isArray(cm.retryInfos) ? cm.retryInfos : [];
    const lastRetry = retryArr.length > 0 ? retryArr[retryArr.length - 1] : undefined;
    const hasErr = Boolean(lastRetry?.error || cm.error);
    const usage = lastRetry?.usage || cm.usage;
    const inp = toNonNegInt(usage?.inputTokens);
    const cached = toNonNegInt(usage?.cacheReadTokens);
    const hasUsageInput = ((inp ?? 0) + (cached ?? 0)) > 0;

    if (!reportedCm && hasUsageInput && !hasErr) {
      reportedCm = cm;
    }
    if (!speedMetrics) {
      const sp = computeSpeedMetrics(cm);
      if (sp && (sp.streamingTps !== null || sp.tps !== null)) {
        speedMetrics = sp;
        speedIsFromLatest = cm === latestCm;
      }
    }
    if (reportedCm && speedMetrics) break;
  }

  if (!latestCm && !sameConvPrev) return null;

  const latestRetry = latestCm && Array.isArray(latestCm.retryInfos) && latestCm.retryInfos.length > 0
    ? latestCm.retryInfos[latestCm.retryInfos.length - 1]
    : undefined;
  const latestHasErr = Boolean(latestRetry?.error || latestCm?.error);
  const latestUsage = latestRetry?.usage || latestCm?.usage;
  const latestInp = toNonNegInt(latestUsage?.inputTokens);
  const latestCached = toNonNegInt(latestUsage?.cacheReadTokens);
  const latestOut = toNonNegInt(latestUsage?.outputTokens);
  const latestHasUsage = !latestHasErr && (((latestInp ?? 0) + (latestCached ?? 0)) > 0);

  const ctxMeta = latestCm?.chatStartMetadata?.contextWindowMetadata;
  const estimatedTokens = toNonNegInt(ctxMeta?.estimatedTokensUsed) ?? sameConvPrev?.estimatedTokens ?? null;
  const budgetTokens = toNonNegInt(ctxMeta?.maxContextTokens) ?? sameConvPrev?.budgetTokens ?? null;

  let usedTokens: number | null = null;
  let isEstimated = false;
  let inputTokens: number | null = null;
  let cacheReadTokens: number | null = null;
  let outputTokens: number | null = null;
  let thinkingTokens: number | null = null;
  let responseTokens: number | null = null;

  if (latestHasUsage) {
    inputTokens = latestInp ?? 0;
    cacheReadTokens = latestCached ?? 0;
    outputTokens = latestOut ?? 0;
    thinkingTokens = toNonNegInt(latestUsage?.thinkingOutputTokens);
    responseTokens = toNonNegInt(latestUsage?.responseOutputTokens) ?? outputTokens;
    usedTokens = inputTokens + cacheReadTokens + outputTokens;
    isEstimated = false;
  } else if (estimatedTokens !== null && estimatedTokens > 0) {
    usedTokens = estimatedTokens;
    isEstimated = true;
    inputTokens = sameConvPrev?.inputTokens ?? null;
    cacheReadTokens = sameConvPrev?.cacheReadTokens ?? null;
    outputTokens = sameConvPrev?.outputTokens ?? null;
    thinkingTokens = sameConvPrev?.thinkingTokens ?? null;
    responseTokens = sameConvPrev?.responseTokens ?? null;
  } else if (reportedCm) {
    const rUsage = (Array.isArray(reportedCm.retryInfos) && reportedCm.retryInfos.length > 0
      ? reportedCm.retryInfos[reportedCm.retryInfos.length - 1]?.usage
      : undefined) || reportedCm.usage;
    inputTokens = toNonNegInt(rUsage?.inputTokens) ?? 0;
    cacheReadTokens = toNonNegInt(rUsage?.cacheReadTokens) ?? 0;
    outputTokens = toNonNegInt(rUsage?.outputTokens) ?? 0;
    thinkingTokens = toNonNegInt(rUsage?.thinkingOutputTokens);
    responseTokens = toNonNegInt(rUsage?.responseOutputTokens) ?? outputTokens;
    usedTokens = inputTokens + cacheReadTokens + outputTokens;
    isEstimated = false;
  } else if (sameConvPrev && sameConvPrev.usedTokens !== null) {
    usedTokens = sameConvPrev.usedTokens;
    isEstimated = sameConvPrev.isEstimated;
    inputTokens = sameConvPrev.inputTokens;
    cacheReadTokens = sameConvPrev.cacheReadTokens;
    outputTokens = sameConvPrev.outputTokens;
    thinkingTokens = sameConvPrev.thinkingTokens;
    responseTokens = sameConvPrev.responseTokens;
  }

  let isPreviousSpeed = false;
  if (!speedMetrics && sameConvPrev && (sameConvPrev.streamingTps !== null || sameConvPrev.tps !== null)) {
    speedMetrics = {
      ttftSec: sameConvPrev.ttftSec,
      streamingSec: sameConvPrev.streamingSec,
      durationSec: sameConvPrev.durationSec,
      streamingTps: sameConvPrev.streamingTps,
      tps: sameConvPrev.tps,
    };
    isPreviousSpeed = true;
  } else if (speedMetrics && !speedIsFromLatest) {
    isPreviousSpeed = true;
  }

  const percent = usedTokens !== null && budgetTokens !== null && budgetTokens > 0
    ? Number(((usedTokens / budgetTokens) * 100).toFixed(1))
    : null;
  const remainingToCompactTokens = usedTokens !== null && budgetTokens !== null && budgetTokens > 0
    ? Math.max(0, Math.round(budgetTokens * 0.85) - usedTokens)
    : null;

  // 汇总尾部连续生成步骤，区分「当前单步」与「近期连续生成累计」
  let turnStepCount = 0;
  let turnThinkingAcc = 0;
  let turnResponseAcc = 0;
  let turnDurAcc = 0;
  for (let i = Math.max(0, list.length - 8); i < list.length; i++) {
    const cm = list[i]?.chatModel;
    if (!cm || typeof cm !== 'object') continue;
    const retryArr = Array.isArray(cm.retryInfos) ? cm.retryInfos : [];
    const lastRetry = retryArr.length > 0 ? retryArr[retryArr.length - 1] : undefined;
    const usage = lastRetry?.usage || cm.usage;
    const uIn = toNonNegInt(usage?.inputTokens) ?? 0;
    const uCache = toNonNegInt(usage?.cacheReadTokens) ?? 0;
    const uOut = toNonNegInt(usage?.outputTokens) ?? 0;
    if (uIn + uCache + uOut <= 0) continue;
    turnStepCount += 1;
    turnThinkingAcc += toNonNegInt(usage?.thinkingOutputTokens) ?? 0;
    turnResponseAcc += toNonNegInt(usage?.responseOutputTokens) ?? uOut;
    const tt = parseDurationSec(cm.timeToFirstToken) ?? 0;
    const st = parseDurationSec(cm.streamingDuration) ?? 0;
    turnDurAcc += tt + st;
  }

  const modelName = String(
    latestCm?.modelDisplayName || latestCm?.responseModel || latestCm?.model || sameConvPrev?.modelName || ''
  ).trim();
  const breakdownGroups = extractBreakdownGroups(latestCm);

  if (usedTokens === null && !speedMetrics) return null;

  return {
    cascadeId: candidate.cascadeId,
    title: String(candidate.summary?.summary || sameConvPrev?.title || '').trim(),
    modelName,
    isRunning: candidate.isRunning,
    workspaceMatched: candidate.workspaceMatched,
    usedTokens,
    budgetTokens,
    percent,
    isEstimated,
    estimatedTokens,
    inputTokens,
    cacheReadTokens,
    outputTokens,
    thinkingTokens,
    responseTokens,
    ttftSec: speedMetrics?.ttftSec ?? null,
    streamingSec: speedMetrics?.streamingSec ?? null,
    durationSec: speedMetrics?.durationSec ?? null,
    streamingTps: speedMetrics?.streamingTps ?? null,
    tps: speedMetrics?.tps ?? null,
    isPreviousSpeed,
    breakdownGroups: breakdownGroups.length > 0 ? breakdownGroups : (sameConvPrev?.breakdownGroups ?? []),
    remainingToCompactTokens,
    turnStepCount: turnStepCount > 0 ? turnStepCount : (sameConvPrev?.turnStepCount ?? 0),
    turnThinkingTokens: turnStepCount > 0 ? turnThinkingAcc : (sameConvPrev?.turnThinkingTokens ?? null),
    turnResponseTokens: turnStepCount > 0 ? turnResponseAcc : (sameConvPrev?.turnResponseTokens ?? null),
    turnDurationSec: turnStepCount > 0 && turnDurAcc > 0 ? Number(turnDurAcc.toFixed(1)) : (sameConvPrev?.turnDurationSec ?? null),
    activeSubagents: candidate.activeSubagents ?? 0,
    totalSubagents: candidate.totalSubagents ?? 0,
    updatedAt: nowMs,
  };
}

async function defaultRpcPost(
  hub: DaemonHubInfo,
  method: string,
  body: Record<string, unknown>,
  timeoutMs: number,
): Promise<unknown> {
  const url = `http://127.0.0.1:${hub.httpPort}/exa.language_server_pb.LanguageServerService/${method}`;
  const res = await httpRequest(url, {
    method: 'POST',
    timeoutMs,
    headers: {
      'Content-Type': 'application/json',
      'x-codeium-csrf-token': hub.csrfToken,
      'Connect-Protocol-Version': '1',
    },
    body: JSON.stringify(body || {}),
  });
  if (res.status !== 200) {
    throw new Error(`HTTP ${res.status}`);
  }
  return JSON.parse(res.body);
}

/** 实时上下文与速度监听控制器（负责自调度生命周期与事件推送） */
export class LiveContextMeter implements vscode.Disposable {
  private _deps: LiveContextRpcDeps;
  private _snapshot: LiveContextSnapshot | null = null;
  private _knownOffsetMap = new Map<string, number>();
  private _lastRunningAt = 0;
  private _inFlight: Promise<LiveContextSnapshot | null> | null = null;
  private _timer: NodeJS.Timeout | null = null;
  private _active = false;
  private _disposed = false;
  private _disposables: vscode.Disposable[] = [];
  private _emitter = new vscode.EventEmitter<LiveContextSnapshot | null>();

  public readonly onDidChange = this._emitter.event;

  constructor(deps: LiveContextRpcDeps = {}) {
    this._deps = deps;
    this._disposables.push(
      this._emitter,
      vscode.window.onDidChangeWindowState((state) => {
        if (state.focused && this._active) {
          void this.refreshNow();
        }
      }),
      vscode.workspace.onDidChangeWorkspaceFolders(() => {
        if (this._active) {
          void this.refreshNow();
        }
      }),
    );
  }

  getSnapshot(): LiveContextSnapshot | null {
    return this._snapshot;
  }

  setEnabled(enabled: boolean): void {
    if (this._disposed) return;
    if (enabled === this._active) return;
    this._active = enabled;
    if (!enabled) {
      this._clearTimer();
      return;
    }
    this._scheduleNext(300);
  }

  async refreshNow(): Promise<LiveContextSnapshot | null> {
    if (this._disposed) return null;
    if (this._inFlight) return this._inFlight;
    this._inFlight = this._pollOnce().finally(() => {
      this._inFlight = null;
      if (this._active && !this._disposed) {
        this._scheduleNext(this._computeNextIntervalMs());
      }
    });
    return this._inFlight;
  }

  private _computeNextIntervalMs(): number {
    const focused = this._deps.isWindowFocused ? this._deps.isWindowFocused() : vscode.window.state.focused;
    if (!focused) return DORMANT_POLL_MS;
    if (this._snapshot?.isRunning) return FAST_POLL_MS;
    if (Date.now() - this._lastRunningAt < RECENT_ACTIVE_HOLD_MS) return FAST_POLL_MS;
    return this._snapshot ? IDLE_POLL_MS : DORMANT_POLL_MS;
  }

  private _clearTimer(): void {
    if (this._timer) {
      clearTimeout(this._timer);
      this._timer = null;
    }
  }

  private _scheduleNext(delayMs: number): void {
    this._clearTimer();
    if (!this._active || this._disposed) return;
    this._timer = setTimeout(() => {
      this._timer = null;
      void this.refreshNow();
    }, delayMs);
  }

  private async _pollOnce(): Promise<LiveContextSnapshot | null> {
    const rpcPost = this._deps.rpcPost || defaultRpcPost;
    const daemonDir = this._deps.daemonDir || getDefaultDaemonDir();
    const isPidAlive = this._deps.isPidAlive || isPidAliveDefault;

    const hubs = discoverAliveHubDaemons(daemonDir, isPidAlive);
    if (hubs.length === 0) {
      this._setSnapshot(null);
      return null;
    }

    const summaryResults = await Promise.all(
      hubs.slice(0, 4).map(async (hub) => {
        try {
          const resp = (await rpcPost(hub, 'GetAllCascadeTrajectories', {}, RPC_TIMEOUT_MS)) as {
            trajectorySummaries?: Record<string, RawTrajectorySummary>;
          };
          return { hub, summaries: resp?.trajectorySummaries || {} };
        } catch {
          return null;
        }
      }),
    );

    const validEntries = summaryResults.filter(
      (r): r is { hub: DaemonHubInfo; summaries: Record<string, RawTrajectorySummary> } => r !== null,
    );
    if (validEntries.length === 0) {
      this._setSnapshot(null);
      return null;
    }

    const openUris = this._deps.getWorkspaceUris
      ? this._deps.getWorkspaceUris()
      : (vscode.workspace.workspaceFolders || []).map((f) => f.uri.toString());

    const best = pickBestTrajectory(validEntries, openUris);
    if (!best) {
      this._setSnapshot(null);
      return null;
    }

    // 统计同工作区/同 Hub 正在并发运行或活跃的子轨迹数（不增加额外 RPC）
    let activeSubagents = 0;
    let totalSubagents = 0;
    const normOpens = openUris.map(normalizeWorkspaceUri).filter(Boolean);
    for (const entry of validEntries) {
      if (!entry.summaries || typeof entry.summaries !== 'object') continue;
      for (const [cid, sum] of Object.entries(entry.summaries)) {
        if (!sum || cid === best.cascadeId) continue;
        const wsRefs = Array.isArray(sum.workspaces) ? sum.workspaces : [];
        const sameWs = normOpens.length > 0 && wsRefs.some((w) =>
          uriMatchesWorkspace(w?.workspaceFolderAbsoluteUri || '', normOpens) ||
          uriMatchesWorkspace(w?.gitRootAbsoluteUri || '', normOpens)
        );
        if (!sameWs && normOpens.length > 0) continue;
        totalSubagents += 1;
        if (sum.status === 'CASCADE_RUN_STATUS_RUNNING') activeSubagents += 1;
      }
    }
    best.activeSubagents = activeSubagents;
    best.totalSubagents = totalSubagents;

    if (best.isRunning) {
      this._lastRunningAt = Date.now();
    }

    let list: { chatModel?: RawChatModel }[] = [];
    const knownCount = this._knownOffsetMap.get(best.cascadeId) || 0;
    const offset = knownCount > 4 ? knownCount - 4 : 0;

    try {
      const metaResp = (await rpcPost(
        best.hub,
        'GetCascadeTrajectoryGeneratorMetadata',
        { cascadeId: best.cascadeId, generatorMetadataOffset: offset, includeMessages: false },
        RPC_TIMEOUT_MS,
      )) as { generatorMetadata?: { chatModel?: RawChatModel }[] };
      list = Array.isArray(metaResp?.generatorMetadata) ? metaResp.generatorMetadata : [];

      if (offset > 0 && list.length === 0) {
        const fullResp = (await rpcPost(
          best.hub,
          'GetCascadeTrajectoryGeneratorMetadata',
          { cascadeId: best.cascadeId, generatorMetadataOffset: 0, includeMessages: false },
          RPC_TIMEOUT_MS,
        )) as { generatorMetadata?: { chatModel?: RawChatModel }[] };
        list = Array.isArray(fullResp?.generatorMetadata) ? fullResp.generatorMetadata : [];
        this._knownOffsetMap.set(best.cascadeId, list.length);
      } else {
        this._knownOffsetMap.set(best.cascadeId, offset + list.length);
      }
    } catch {
      /* RPC 瞬断时保留已知上下文，若已有运行状态则更新 running 标记，绝不凭空置零 */
      return this._snapshot;
    }

    const next = extractLiveContextSnapshot(list, best, this._snapshot);
    this._setSnapshot(next);
    return next;
  }

  private _setSnapshot(next: LiveContextSnapshot | null): void {
    const prevJson = this._snapshot ? JSON.stringify({ ...this._snapshot, updatedAt: 0 }) : '';
    const nextJson = next ? JSON.stringify({ ...next, updatedAt: 0 }) : '';
    this._snapshot = next;
    if (prevJson !== nextJson) {
      this._emitter.fire(next);
    }
  }

  dispose(): void {
    this._disposed = true;
    this._active = false;
    this._clearTimer();
    for (const d of this._disposables) {
      try {
        d.dispose();
      } catch {
        /* ignore */
      }
    }
    this._disposables = [];
  }
}

