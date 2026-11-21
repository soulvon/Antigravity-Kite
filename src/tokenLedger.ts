/**
 * 本地 Token 账本与模型测速归档器
 *
 * - 双源融合：优先读取 conversations/*.db (gen_metadata + steps) 联合 conversation_summaries.db，
 *   对纯 CLI / 早期缺失 SQLite usage 的会话自动衔接 transcript.jsonl 解析，O(1) 增量缓存。
 * - 增量沉淀 LiveContextMeter 实测流式速度与 TTFT，经 sqliteAnalytics 归一化并产出多维切片。
 */
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as readline from 'readline';
import { AccountTimeline, getAccountTimeline } from './accountTimeline';
import { atomicWriteJsonSync, readJsonFileSafe, withFileLockSync } from './atomicFile';
import { LiveContextSnapshot } from './liveContextMeter';
import { logWarn } from './logger';
import {
  ModelFamily,
  getConversationDbSig,
  normalizeModelIdentity,
  readConversationStepMeta,
} from './modelCatalog';
import {
  AccountTokenSummary,
  CachedCallBucket,
  CachedConversationEntry,
  CallScenarioKey,
  ConvSummaryMeta,
  LedgerFilterSlice,
  ModelFilterSlice,
  ScenarioBreakdownItem,
  ScenarioFilterSlice,
  SessionExplorerItem,
  SpeedModelEntry,
  buildTokenLedgerSummary,
  formatLocalDateKey,
  readConversationDbAnalytics,
  readConversationSummariesMap,
} from './sqliteAnalytics';
import { getSharedStorageDir } from './storage';

export { formatLocalDateKey };
export type {
  AccountTokenSummary,
  CallScenarioKey,
  LedgerFilterSlice,
  ModelFilterSlice,
  ScenarioBreakdownItem,
  ScenarioFilterSlice,
  SessionExplorerItem,
};

const LEDGER_CACHE_FILE = 'token-ledger-v1.json';
const MEMORY_TTL_MS = 25_000;
const UNTAGGED_MODEL = 'untagged';

export type LedgerSourceKind = 'desktop' | 'cli';

export interface TokenPeriodBucket {
  input: number;
  cacheRead: number;
  output: number;
  thinking: number;
  weighted: number;
  total: number;
  steps: number;
  cacheHitPct: number;
  desktopTotal: number;
  cliTotal: number;
  costUsd: number;
  savedByCacheUsd: number;
}

export interface TokenDailyRecord {
  date: string;
  input: number;
  cacheRead: number;
  output: number;
  weighted: number;
  total: number;
  steps: number;
  desktopTotal: number;
  cliTotal: number;
  topModel: string;
  topModelDisplay: string;
  costUsd: number;
  isFuture?: boolean;
}

export interface TokenModelRecord {
  model: string;
  displayName: string;
  family: ModelFamily;
  routes: string[];
  input: number;
  cacheRead: number;
  output: number;
  thinking: number;
  weighted: number;
  total: number;
  steps: number;
  sharePct: number;
  costUsd: number;
  avgStreamingTps: number | null;
  maxStreamingTps: number | null;
  avgTtftSec: number | null;
  speedSamples: number;
}

export interface TokenLedgerSummary {
  scannedAt: number;
  scanElapsedMs: number;
  scannedFiles: number;
  totalSessions: number;
  firstDate: string | null;
  todayKey: string;
  totals: {
    today: TokenPeriodBucket;
    last7d: TokenPeriodBucket;
    last30d: TokenPeriodBucket;
    allTime: TokenPeriodBucket;
  };
  heatmapDays: TokenDailyRecord[];
  daily30: TokenDailyRecord[];
  models: TokenModelRecord[];
  scenarios: ScenarioBreakdownItem[];
  projects: string[];
  accounts: string[];
  sessions: SessionExplorerItem[];
  slices: LedgerFilterSlice[];
  scenarioSlices: ScenarioFilterSlice[];
  modelSlices: ModelFilterSlice[];
  perAccount: Record<string, AccountTokenSummary>;
}

interface PersistedSpeedAgg extends SpeedModelEntry {
  lastUpdatedAt: number;
}

interface PersistedLedgerCache {
  version: 3;
  files: Record<string, CachedConversationEntry>;
  speeds: Record<string, PersistedSpeedAgg>;
  modelLabels?: Record<string, string>;
}

interface ScanTarget {
  fileKey: string;
  conversationId: string;
  transcriptPath?: string;
  source: LedgerSourceKind;
  size: number;
  mtimeMs: number;
  dbPath?: string;
  dbSig: string;
}

function parseTimestampSec(rawTs: unknown, fallbackMs: number): number {
  if (typeof rawTs === 'string' && rawTs.trim()) {
    const parsed = Date.parse(rawTs);
    if (Number.isFinite(parsed) && parsed > 0) return Math.floor(parsed / 1000);
  } else if (typeof rawTs === 'number' && Number.isFinite(rawTs) && rawTs > 0) {
    return rawTs > 1e12 ? Math.floor(rawTs / 1000) : Math.floor(rawTs);
  }
  return Math.floor(fallbackMs / 1000);
}

function toSafeInt(v: unknown): number {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? Math.round(n) : 0;
}

function yieldToEventLoop(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

export interface TokenLedgerRoots {
  desktopBrainDir?: string;
  cliBrainDir?: string;
  cacheFilePath?: string;
  conversationsDir?: string;
  summariesDbPath?: string;
  timeline?: AccountTimeline;
}

export class TokenLedger {
  private readonly _desktopBrainDir: string;
  private readonly _cliBrainDir: string;
  private readonly _conversationsDir: string;
  private readonly _summariesDbPath: string;
  private readonly _cacheFilePath: string;
  private readonly _timeline?: AccountTimeline;
  private _cache: PersistedLedgerCache;
  private _cacheLoaded = false;
  private _cacheHealthy = true;
  private _dirty = false;
  private _saveTimer: NodeJS.Timeout | null = null;
  private _lastSummary: TokenLedgerSummary | null = null;
  private _lastScanAt = 0;
  private _inFlight: Promise<TokenLedgerSummary> | null = null;
  private readonly _seenSpeedKeys = new Set<string>();
  private _disposed = false;

  constructor(roots: TokenLedgerRoots = {}) {
    const home = os.homedir();
    const isIsolated = Boolean(roots.desktopBrainDir || roots.cliBrainDir || roots.cacheFilePath);
    this._desktopBrainDir = roots.desktopBrainDir ?? path.join(home, '.gemini', 'antigravity', 'brain');
    this._cliBrainDir = roots.cliBrainDir ?? path.join(home, '.gemini', 'antigravity-cli', 'brain');
    this._conversationsDir = roots.conversationsDir ?? (isIsolated ? '' : path.join(home, '.gemini', 'antigravity', 'conversations'));
    this._summariesDbPath = roots.summariesDbPath ?? (isIsolated ? '' : path.join(home, '.gemini', 'antigravity', 'conversation_summaries.db'));
    this._cacheFilePath = roots.cacheFilePath ?? path.join(getSharedStorageDir(), LEDGER_CACHE_FILE);
    this._timeline = roots.timeline;
    this._cache = { version: 3, files: {}, speeds: {}, modelLabels: {} };
  }

  private _activeTimeline(): AccountTimeline {
    return this._timeline ?? getAccountTimeline();
  }

  getCachedPerAccount(): Record<string, AccountTokenSummary> {
    if (this._lastSummary) return this._lastSummary.perAccount;
    return {};
  }

  invalidateSummaryCache(): void {
    this._lastSummary = null;
  }

  recordSpeedSample(snapshot: LiveContextSnapshot | null): boolean {
    if (!snapshot || this._disposed || snapshot.isEstimated) return false;
    const tps = snapshot.streamingTps;
    if (tps === null || !Number.isFinite(tps) || tps <= 0 || tps > 5000) return false;

    const identity = normalizeModelIdentity(snapshot.modelName);
    const modelKey = identity.id;
    const dedupKey = `${snapshot.cascadeId}|${modelKey}|${snapshot.outputTokens ?? 0}|${snapshot.durationSec ?? 0}|${tps}`;
    if (this._seenSpeedKeys.has(dedupKey)) return false;
    if (this._seenSpeedKeys.size > 500) this._seenSpeedKeys.clear();
    this._seenSpeedKeys.add(dedupKey);

    this._ensureCacheLoaded();
    const cur = this._cache.speeds[modelKey] ?? {
      samples: 0, tpsSum: 0, tpsMax: 0, ttftSum: 0, ttftCount: 0, lastUpdatedAt: 0,
    };
    cur.samples += 1;
    cur.tpsSum += tps;
    if (tps > cur.tpsMax) cur.tpsMax = tps;
    if (snapshot.ttftSec !== null && Number.isFinite(snapshot.ttftSec) && snapshot.ttftSec >= 0) {
      cur.ttftSum += snapshot.ttftSec;
      cur.ttftCount += 1;
    }
    cur.lastUpdatedAt = Date.now();
    this._cache.speeds[modelKey] = cur;
    if (identity.displayName && identity.displayName !== UNTAGGED_MODEL) {
      this._cache.modelLabels = this._cache.modelLabels ?? {};
      this._cache.modelLabels[modelKey] = this._cache.modelLabels[modelKey] || identity.displayName;
    }
    this._dirty = true;
    this._lastSummary = null;
    this._scheduleSave();
    return true;
  }

  async getSummary(forceRescan = false): Promise<TokenLedgerSummary> {
    if (!forceRescan && this._lastSummary && Date.now() - this._lastScanAt < MEMORY_TTL_MS) {
      return this._lastSummary;
    }
    if (this._inFlight) return this._inFlight;
    this._inFlight = this._runIncrementalScan(forceRescan)
      .catch((err) => {
        logWarn('tokenLedger.scan.fail', err instanceof Error ? err.message : String(err));
        return this._lastSummary ?? this._buildSummary(0);
      })
      .finally(() => {
        this._inFlight = null;
      });
    return this._inFlight;
  }

  private _ensureCacheLoaded(): void {
    if (this._cacheLoaded) return;
    this._cacheLoaded = true;
    const res = readJsonFileSafe<unknown>(this._cacheFilePath);
    if (res.status === 'ok' && res.data && typeof res.data === 'object') {
      const raw = res.data as {
        version?: number;
        files?: Record<string, CachedConversationEntry>;
        speeds?: Record<string, PersistedSpeedAgg>;
        modelLabels?: Record<string, string>;
      };
      const migratedSpeeds: Record<string, PersistedSpeedAgg> = {};
      if (raw.speeds && typeof raw.speeds === 'object') {
        for (const [rawKey, spd] of Object.entries(raw.speeds)) {
          if (!spd || typeof spd !== 'object') continue;
          const id = normalizeModelIdentity(rawKey).id;
          const prev = migratedSpeeds[id];
          if (!prev) migratedSpeeds[id] = { ...spd };
          else {
            prev.samples += spd.samples;
            prev.tpsSum += spd.tpsSum;
            prev.tpsMax = Math.max(prev.tpsMax, spd.tpsMax);
            prev.ttftSum += spd.ttftSum;
            prev.ttftCount += spd.ttftCount;
            prev.lastUpdatedAt = Math.max(prev.lastUpdatedAt, spd.lastUpdatedAt);
          }
        }
      }
      if (raw.version === 3 && raw.files && typeof raw.files === 'object') {
        this._cache = {
          version: 3,
          files: raw.files,
          speeds: migratedSpeeds,
          modelLabels: raw.modelLabels && typeof raw.modelLabels === 'object' ? raw.modelLabels : {},
        };
        this._cacheHealthy = true;
        return;
      }
      // v1/v2 -> v3：保留测速记录，触发增量重建以补全场景/父子会话/项目归因
      this._cache = { version: 3, files: {}, speeds: migratedSpeeds, modelLabels: {} };
      this._dirty = true;
      this._cacheHealthy = true;
      return;
    }
    if (res.status === 'error') {
      this._cacheHealthy = false;
      logWarn('tokenLedger.cache.loadFail', { file: this._cacheFilePath, error: res.error });
    }
  }

  private _scheduleSave(): void {
    if (this._disposed || !this._cacheHealthy) return;
    if (this._saveTimer) return;
    this._saveTimer = setTimeout(() => {
      this._saveTimer = null;
      this._flushCacheSync();
    }, 2500);
  }

  private _flushCacheSync(): void {
    if (!this._dirty || !this._cacheHealthy) return;
    this._dirty = false;
    try {
      withFileLockSync(this._cacheFilePath, () => {
        atomicWriteJsonSync(this._cacheFilePath, this._cache, 0o600);
      }, 1500);
    } catch (err) {
      logWarn('tokenLedger.cache.saveFail', err instanceof Error ? err.message : String(err));
    }
  }

  private async _runIncrementalScan(forceRescan: boolean): Promise<TokenLedgerSummary> {
    const startMs = Date.now();
    this._ensureCacheLoaded();

    const summariesMap = readConversationSummariesMap(this._summariesDbPath);
    const targets = collectScanTargets(this._desktopBrainDir, this._cliBrainDir, this._conversationsDir, summariesMap);
    const aliveKeys = new Set<string>();
    let changed = false;
    let processed = 0;

    for (const target of targets) {
      aliveKeys.add(target.fileKey);
      const cached = this._cache.files[target.fileKey];
      const mtimeRounded = Math.floor(target.mtimeMs);
      const sMeta = summariesMap.get(target.conversationId);
      const metaTitle = sMeta?.title || '';
      const metaProj = sMeta?.projectName || '';
      const metaParent = sMeta?.parentConversationId || '';
      const metaAgent = sMeta?.agentName || '';

      if (
        !forceRescan &&
        cached &&
        cached.size === target.size &&
        cached.mtimeMs === mtimeRounded &&
        (cached.dbSig ?? '') === target.dbSig &&
        cached.title === metaTitle &&
        cached.projectName === metaProj &&
        cached.parentConversationId === metaParent &&
        cached.agentName === metaAgent
      ) {
        continue;
      }

      const parsed = await parseScanTarget(target, sMeta);
      this._cache.files[target.fileKey] = parsed;
      if (parsed.labels && Object.keys(parsed.labels).length > 0) {
        this._cache.modelLabels = this._cache.modelLabels ?? {};
        Object.assign(this._cache.modelLabels, parsed.labels);
      }
      changed = true;
      processed += 1;
      if (processed % 25 === 0) await yieldToEventLoop();
    }

    for (const key of Object.keys(this._cache.files)) {
      if (!aliveKeys.has(key)) {
        delete this._cache.files[key];
        changed = true;
      }
    }

    if (changed) {
      this._dirty = true;
      this._scheduleSave();
    }

    const elapsedMs = Date.now() - startMs;
    const summary = this._buildSummary(elapsedMs);
    this._lastSummary = summary;
    this._lastScanAt = Date.now();
    return summary;
  }

  private _buildSummary(scanElapsedMs: number): TokenLedgerSummary {
    const entries = Object.values(this._cache.files);
    return buildTokenLedgerSummary(
      entries,
      this._cache.speeds,
      this._cache.modelLabels ?? {},
      this._activeTimeline(),
      scanElapsedMs,
      entries.length,
    );
  }

  dispose(): void {
    if (this._disposed) return;
    this._disposed = true;
    if (this._saveTimer) {
      clearTimeout(this._saveTimer);
      this._saveTimer = null;
    }
    this._flushCacheSync();
  }
}

function collectScanTargets(
  desktopBrainDir: string,
  cliBrainDir: string,
  conversationsDir: string,
  summariesMap: Map<string, ConvSummaryMeta>,
): ScanTarget[] {
  const out: ScanTarget[] = [];
  const seenDbConvs = new Set<string>();

  const scanBrain = (brainDir: string, source: LedgerSourceKind) => {
    if (!brainDir || !fs.existsSync(brainDir)) return;
    let entries: fs.Dirent[];
    try { entries = fs.readdirSync(brainDir, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      if (entry.isSymbolicLink()) continue;
      const full = path.join(brainDir, entry.name);
      if (entry.isFile() && entry.name === 'transcript.jsonl') {
        try {
          const st = fs.lstatSync(full);
          if (st.isFile() && !st.isSymbolicLink() && st.size > 0) {
            out.push({ fileKey: full, conversationId: 'root', transcriptPath: full, source, size: st.size, mtimeMs: st.mtimeMs, dbSig: '' });
          }
        } catch {}
        continue;
      }
      if (!entry.isDirectory()) continue;
      const convId = entry.name;
      const dbPath = source === 'desktop' && conversationsDir ? path.join(conversationsDir, `${convId}.db`) : undefined;
      const dbSig = dbPath ? getConversationDbSig(dbPath) : '';
      if (dbSig) seenDbConvs.add(convId);

      const candidates = [
        path.join(full, '.system_generated', 'logs', 'transcript.jsonl'),
        path.join(full, 'transcript.jsonl'),
      ];
      let foundFile = false;
      for (const fp of candidates) {
        try {
          const st = fs.lstatSync(fp);
          if (st.isFile() && !st.isSymbolicLink() && st.size > 0) {
            foundFile = true;
            out.push({
              fileKey: fp,
              conversationId: convId,
              transcriptPath: fp,
              source,
              size: st.size,
              mtimeMs: st.mtimeMs,
              dbPath: dbSig ? dbPath : undefined,
              dbSig,
            });
          }
        } catch {}
      }
      if (!foundFile && dbSig && dbPath) {
        const sMeta = summariesMap.get(convId);
        out.push({
          fileKey: dbPath,
          conversationId: convId,
          source: sMeta?.source ?? source,
          size: 0,
          mtimeMs: sMeta?.lastModifiedMs || Date.now(),
          dbPath,
          dbSig,
        });
      }
    }
  };

  scanBrain(desktopBrainDir, 'desktop');
  scanBrain(cliBrainDir, 'cli');

  // 扫入仅存在于 conversations/*.db（没有建 brain transcript）的会话或子 Agent 对话
  if (conversationsDir && fs.existsSync(conversationsDir)) {
    let files: string[] = [];
    try { files = fs.readdirSync(conversationsDir); } catch {}
    for (const f of files) {
      if (!f.endsWith('.db')) continue;
      const convId = f.slice(0, -3);
      if (seenDbConvs.has(convId)) continue;
      const dbPath = path.join(conversationsDir, f);
      const dbSig = getConversationDbSig(dbPath);
      if (!dbSig) continue;
      const sMeta = summariesMap.get(convId);
      let mtimeMs = sMeta?.lastModifiedMs || 0;
      if (!mtimeMs) {
        try { mtimeMs = fs.statSync(dbPath).mtimeMs; } catch { mtimeMs = Date.now(); }
      }
      out.push({
        fileKey: dbPath,
        conversationId: convId,
        source: sMeta?.source ?? 'desktop',
        size: 0,
        mtimeMs,
        dbPath,
        dbSig,
      });
    }
  }

  return out;
}

function extractFallbackModelSelection(line: string): string | undefined {
  if (!line.includes('Model Selection')) return undefined;
  const match = line.match(/Model Selection[\s\S]{0,120}?\bto\s+([A-Za-z0-9][A-Za-z0-9 ._()-]{2,48}?)(?:\.|,|\\n|"|$)/i);
  const candidate = match?.[1]?.trim();
  return candidate && candidate.length >= 3 ? candidate : undefined;
}

async function parseScanTarget(target: ScanTarget, summaryMeta?: ConvSummaryMeta): Promise<CachedConversationEntry> {
  const baseEntry = {
    fileKey: target.fileKey,
    conversationId: target.conversationId,
    source: summaryMeta?.source ?? target.source,
    title: summaryMeta?.title || '',
    projectName: summaryMeta?.projectName || '',
    agentName: summaryMeta?.agentName || '',
    parentConversationId: summaryMeta?.parentConversationId || '',
    size: target.size,
    mtimeMs: Math.floor(target.mtimeMs),
    dbSig: target.dbSig,
    compactions: 0,
    lastModifiedMs: summaryMeta?.lastModifiedMs || Math.floor(target.mtimeMs),
  };

  if (target.dbPath) {
    const dbRes = readConversationDbAnalytics(target.dbPath, target.conversationId, target.mtimeMs, summaryMeta);
    if (dbRes.hasUsageData && dbRes.buckets.length > 0) {
      return {
        ...baseEntry,
        compactions: dbRes.compactions,
        labels: dbRes.labels,
        buckets: dbRes.buckets,
      };
    }
  }

  if (!target.transcriptPath) {
    return { ...baseEntry, buckets: [] };
  }

  const parsed = await parseTranscriptFile(target, summaryMeta);
  return {
    ...baseEntry,
    labels: parsed.labels,
    buckets: parsed.buckets,
  };
}

async function parseTranscriptFile(
  target: ScanTarget,
  summaryMeta?: ConvSummaryMeta,
): Promise<{ buckets: CachedCallBucket[]; labels: Record<string, string> }> {
  const labels: Record<string, string> = {};
  const stepMeta = target.dbPath ? readConversationStepMeta(target.dbPath) : new Map();
  const stepBest = new Map<string, {
    dateKey: string;
    tsBucketSec: number;
    tsSec: number;
    modelId: string;
    scenario: CallScenarioKey;
    input: number;
    cacheRead: number;
    output: number;
    streamingSec?: number;
    ttftSec?: number;
  }>();
  let fallbackIdx = 0;
  let activeFallbackModel: string | undefined;
  const fallbackScenario: CallScenarioKey = (summaryMeta?.parentConversationId || summaryMeta?.agentName)
    ? 'subagent'
    : (target.source === 'cli' ? 'internal' : 'chat');

  try {
    const stream = fs.createReadStream(target.transcriptPath!, { encoding: 'utf8' });
    const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });
    for await (const line of rl) {
      if (!line || line.length < 16) continue;
      const selected = extractFallbackModelSelection(line);
      if (selected) activeFallbackModel = selected;
      if (!line.includes('input_tokens') && !line.includes('output_tokens') && !line.includes('cache_read') && !line.includes('"usage"')) {
        continue;
      }
      let obj: Record<string, unknown>;
      try { obj = JSON.parse(line) as Record<string, unknown>; } catch { continue; }
      const usageObj = obj.usage && typeof obj.usage === 'object' ? (obj.usage as Record<string, unknown>) : null;
      const input = toSafeInt(obj.input_tokens ?? usageObj?.input_tokens ?? usageObj?.prompt_tokens)
        + toSafeInt(obj.cache_creation_tokens ?? usageObj?.cache_creation_input_tokens);
      const cacheRead = toSafeInt(obj.cache_read_tokens ?? obj.cache_read_input_tokens ?? usageObj?.cache_read_input_tokens ?? usageObj?.cached_tokens);
      const output = toSafeInt(obj.output_tokens ?? usageObj?.output_tokens ?? usageObj?.completion_tokens);
      if (input === 0 && cacheRead === 0 && output === 0) continue;

      const rawStep = obj.step_index;
      const stepNum = typeof rawStep === 'number'
        ? rawStep
        : (rawStep !== undefined && rawStep !== null && Number.isFinite(Number(rawStep)) ? Number(rawStep) : undefined);
      const meta = stepNum !== undefined ? stepMeta.get(stepNum) : undefined;
      const rawModel = typeof obj.model === 'string' ? obj.model.trim() : '';
      const identity = normalizeModelIdentity(rawModel || meta?.model || activeFallbackModel, meta?.label, meta?.modelEnum);
      if (identity.id !== UNTAGGED_MODEL && identity.displayName !== UNTAGGED_MODEL) {
        if (meta?.label || !labels[identity.id]) labels[identity.id] = identity.displayName;
      }

      const tsSec = parseTimestampSec(obj.created_at ?? obj.timestamp, target.mtimeMs);
      const dateKey = formatLocalDateKey(new Date(tsSec * 1000));
      const tsBucketSec = Math.floor(tsSec / 60) * 60;
      const stepKey = rawStep !== undefined && rawStep !== null ? `s:${String(rawStep)}` : `line:${fallbackIdx++}`;
      stepBest.set(stepKey, {
        dateKey,
        tsBucketSec,
        tsSec,
        modelId: identity.id,
        scenario: fallbackScenario,
        input,
        cacheRead,
        output,
        streamingSec: meta?.streamingSec,
        ttftSec: meta?.ttftSec,
      });
    }
  } catch {
    return { buckets: [], labels };
  }

  const bucketMap = new Map<string, CachedCallBucket>();
  for (const item of stepBest.values()) {
    const bKey = `${item.dateKey}|${item.tsBucketSec}|${item.modelId}|${item.scenario}`;
    let b = bucketMap.get(bKey);
    if (!b) {
      b = {
        dateKey: item.dateKey,
        tsBucketSec: item.tsBucketSec,
        lastTsSec: item.tsSec,
        modelId: item.modelId,
        scenario: item.scenario,
        input: 0,
        cacheRead: 0,
        output: 0,
        thinking: 0,
        steps: 0,
      };
      bucketMap.set(bKey, b);
    } else if (item.tsSec > (b.lastTsSec ?? 0)) {
      b.lastTsSec = item.tsSec;
    }
    b.input += item.input;
    b.cacheRead += item.cacheRead;
    b.output += item.output;
    b.steps += 1;
    if (item.streamingSec !== undefined && item.streamingSec > 0.05 && item.output > 0) {
      const tps = item.output / item.streamingSec;
      if (tps > 0 && tps <= 5000) {
        b.speedSamples = (b.speedSamples ?? 0) + 1;
        b.tpsSum = (b.tpsSum ?? 0) + tps;
        b.tpsMax = Math.max(b.tpsMax ?? 0, tps);
        if (item.ttftSec !== undefined && item.ttftSec >= 0 && item.ttftSec <= 300) {
          b.ttftSum = (b.ttftSum ?? 0) + item.ttftSec;
          b.ttftCount = (b.ttftCount ?? 0) + 1;
        }
      }
    }
  }

  return { buckets: Array.from(bucketMap.values()), labels };
}
