/**
 * Antigravity 双 SQLite（conversation_summaries.db + conversations/*.db）只读分析与金字塔聚合引擎
 *
 * 职责：
 * - 解析全局索引 conversation_summaries.db（标题、项目路径、来源 CLI/桌面端、父子会话关系）
 * - 解析单会话 *.db（steps 类型与时间戳、gen_metadata 用量与 thinking、缓存压缩检查点）
 * - 产出 6 大场景归因、同名模型去重合并、父子会话树、多维过滤切片与按账号时间片汇总
 */
import * as fs from 'fs';
import * as path from 'path';
import type { AccountTimeline } from './accountTimeline';
import { loadSqlite } from './ideStateDb';
import {
  ModelFamily,
  computeWeightedTokens,
  estimateModelCostUsd,
  normalizeModelIdentity,
  parseGenMetadataBlob,
  parseStepTimestampSec,
} from './modelCatalog';
import type {
  LedgerSourceKind,
  TokenDailyRecord,
  TokenModelRecord,
  TokenPeriodBucket,
} from './tokenLedger';

export type CallScenarioKey = 'tools' | 'subagent' | 'chat' | 'planning' | 'memory' | 'internal';

export interface ConvSummaryMeta {
  conversationId: string;
  title: string;
  projectName: string;
  workspaceUri: string;
  source: LedgerSourceKind;
  agentName: string;
  parentConversationId: string;
  nestingDepth: number;
  lastModifiedMs: number;
}

export interface CachedCallBucket {
  dateKey: string;
  tsBucketSec: number;
  lastTsSec?: number;
  modelId: string;
  scenario: CallScenarioKey;
  input: number;
  cacheRead: number;
  output: number;
  thinking: number;
  steps: number;
  speedSamples?: number;
  tpsSum?: number;
  tpsMax?: number;
  ttftSum?: number;
  ttftCount?: number;
}

export interface CachedConversationEntry {
  fileKey: string;
  conversationId: string;
  source: LedgerSourceKind;
  title: string;
  projectName: string;
  agentName: string;
  parentConversationId: string;
  size: number;
  mtimeMs: number;
  dbSig: string;
  compactions: number;
  lastModifiedMs: number;
  labels?: Record<string, string>;
  buckets: CachedCallBucket[];
}

export interface ScenarioBreakdownItem {
  key: CallScenarioKey;
  input: number;
  cacheRead: number;
  output: number;
  weighted: number;
  costUsd: number;
  steps: number;
  sharePct: number;
}

export interface SessionSubagentItem {
  conversationId: string;
  agentName: string;
  title: string;
  input: number;
  cacheRead: number;
  output: number;
  weighted: number;
  costUsd: number;
  steps: number;
  cacheHitPct: number;
}

export interface SessionExplorerItem {
  conversationId: string;
  title: string;
  projectName: string;
  source: LedgerSourceKind;
  accountEmail: string;
  topModelDisplay: string;
  input: number;
  cacheRead: number;
  output: number;
  thinking: number;
  weighted: number;
  costUsd: number;
  steps: number;
  compactions: number;
  cacheHitPct: number;
  isLowCache: boolean;
  lastModifiedMs: number;
  activeDates: string[];
  subagents: SessionSubagentItem[];
}

export interface AccountTokenSummary {
  todayTokens: number;
  todayWeighted: number;
  todayCostUsd: number;
  totalTokens: number;
  totalWeighted: number;
  totalCostUsd: number;
  steps: number;
}

export interface LedgerFilterSlice {
  date: string;
  source: LedgerSourceKind;
  project: string;
  account: string;
  input: number;
  cacheRead: number;
  output: number;
  thinking: number;
  weighted: number;
  costUsd: number;
  savedUsd: number;
  steps: number;
}

export interface ScenarioFilterSlice {
  date: string;
  source: LedgerSourceKind;
  project: string;
  account: string;
  scenario: CallScenarioKey;
  input: number;
  cacheRead: number;
  output: number;
  weighted: number;
  costUsd: number;
  steps: number;
}

export interface ModelFilterSlice {
  date: string;
  source: LedgerSourceKind;
  project: string;
  account: string;
  modelKey: string;
  input: number;
  cacheRead: number;
  output: number;
  weighted: number;
  costUsd: number;
  steps: number;
}

export interface SpeedModelEntry {
  samples: number;
  tpsSum: number;
  tpsMax: number;
  ttftSum: number;
  ttftCount: number;
}

function roundUsd(val: number): number {
  return Math.round(Math.max(0, val) * 10000) / 10000;
}

export function formatLocalDateKey(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function addLocalDays(d: Date, deltaDays: number): Date {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate() + deltaDays);
}

export function extractProjectNameFromUris(rawUris: string): { projectName: string; workspaceUri: string } {
  if (!rawUris) return { projectName: '', workspaceUri: '' };
  let firstUri = '';
  try {
    const parsed = JSON.parse(rawUris);
    if (Array.isArray(parsed) && typeof parsed[0] === 'string') firstUri = parsed[0];
  } catch {
    const m = String(rawUris).match(/file:\/\/\/[^"'\s\]]+/);
    if (m) firstUri = m[0];
  }
  if (!firstUri) return { projectName: '', workspaceUri: '' };
  let clean = firstUri;
  try { clean = decodeURIComponent(clean); } catch {}
  clean = clean.replace(/\\/g, '/').replace(/\/+$/, '');
  const seg = clean.split('/').filter(Boolean).pop() || '';
  return { projectName: seg, workspaceUri: firstUri };
}

export function classifyCallScenario(opts: {
  source: LedgerSourceKind;
  agentName?: string;
  parentConversationId?: string;
  subagentType?: string;
  stepTypes: number[];
  modelId?: string;
}): CallScenarioKey {
  if (opts.parentConversationId || opts.agentName || opts.subagentType) return 'subagent';
  if (opts.stepTypes.includes(23)) return 'memory';
  if (opts.source === 'cli') return 'internal';
  if (opts.stepTypes.includes(132)) return 'tools';
  if (opts.stepTypes.includes(101) || /orchestrator/i.test(opts.modelId || '')) return 'planning';
  return 'chat';
}

export function readConversationSummariesMap(summariesDbPath: string): Map<string, ConvSummaryMeta> {
  const out = new Map<string, ConvSummaryMeta>();
  if (!summariesDbPath || !fs.existsSync(summariesDbPath)) return out;
  const sqlite = loadSqlite();
  if (!sqlite?.DatabaseSync) return out;

  let db: any = null;
  try {
    db = new sqlite.DatabaseSync(summariesDbPath, { readOnly: true });
    try { db.exec('PRAGMA busy_timeout = 200'); } catch {}
    const rows = db.prepare(
      'SELECT conversation_id, title, last_modified_time, workspace_uris, source, agent_name, parent_conversation_id, nesting_depth FROM conversation_summaries',
    ).all() as Array<Record<string, unknown>>;
    for (const r of rows) {
      const id = String(r.conversation_id || '').trim();
      if (!id) continue;
      const { projectName, workspaceUri } = extractProjectNameFromUris(String(r.workspace_uris || ''));
      const rawSrc = String(r.source || '');
      const source: LedgerSourceKind = rawSrc === 'CORTEX_TRAJECTORY_SOURCE_CLI' ? 'cli' : 'desktop';
      const tsMs = r.last_modified_time ? Date.parse(String(r.last_modified_time)) : NaN;
      out.set(id, {
        conversationId: id,
        title: String(r.title || '').trim(),
        projectName,
        workspaceUri,
        source,
        agentName: String(r.agent_name || '').trim(),
        parentConversationId: String(r.parent_conversation_id || '').trim(),
        nestingDepth: Number(r.nesting_depth) || 0,
        lastModifiedMs: Number.isFinite(tsMs) ? tsMs : 0,
      });
    }
    try {
      const pRows = db.prepare('SELECT conversation_id, parent_id FROM conversation_parents').all() as Array<{ conversation_id?: string; parent_id?: string }>;
      for (const p of pRows) {
        const cid = String(p.conversation_id || '').trim();
        const pid = String(p.parent_id || '').trim();
        const existing = cid && out.get(cid);
        if (existing && !existing.parentConversationId && pid) existing.parentConversationId = pid;
      }
    } catch {}
  } catch {
    // 锁表或结构差异时降级为空，不影响主流程
  } finally {
    try { db?.close(); } catch {}
  }
  return out;
}

export function readConversationDbAnalytics(
  dbPath: string,
  convId: string,
  fallbackMtimeMs: number,
  summaryMeta?: ConvSummaryMeta,
): {
  hasUsageData: boolean;
  compactions: number;
  labels: Record<string, string>;
  buckets: CachedCallBucket[];
} {
  const empty = { hasUsageData: false, compactions: 0, labels: {}, buckets: [] as CachedCallBucket[] };
  if (!dbPath || !fs.existsSync(dbPath)) return empty;
  const sqlite = loadSqlite();
  if (!sqlite?.DatabaseSync) return empty;

  let db: any = null;
  try {
    db = new sqlite.DatabaseSync(dbPath, { readOnly: true });
    try { db.exec('PRAGMA busy_timeout = 200'); } catch {}

    const stepMap = new Map<number, { stepType: number; tsSec: number }>();
    let compactions = 0;
    try {
      const stepRows = db.prepare('SELECT idx, step_type, metadata FROM steps').all() as Array<{
        idx?: number;
        step_type?: number;
        metadata?: Uint8Array | Buffer;
      }>;
      for (const sr of stepRows) {
        if (typeof sr.idx !== 'number') continue;
        const stepType = Number(sr.step_type) || 0;
        if (stepType === 23) compactions += 1;
        const tsSec = parseStepTimestampSec(sr.metadata);
        stepMap.set(sr.idx, { stepType, tsSec });
      }
    } catch {}

    const genRows = db.prepare('SELECT data FROM gen_metadata').all() as Array<{ data?: Uint8Array | Buffer }>;
    const bucketMap = new Map<string, CachedCallBucket>();
    const labels: Record<string, string> = {};
    let hasUsageData = false;
    const source: LedgerSourceKind = summaryMeta?.source ?? 'desktop';
    const fallbackSec = Math.floor((summaryMeta?.lastModifiedMs || fallbackMtimeMs || Date.now()) / 1000);

    for (const row of genRows) {
      if (!row?.data) continue;
      const buf = Buffer.isBuffer(row.data) ? row.data : Buffer.from(row.data);
      const { stepIndices, meta } = parseGenMetadataBlob(buf);
      const input = meta.inputTokens ?? 0;
      const cacheRead = meta.cacheReadTokens ?? 0;
      const output = meta.outputTokens ?? 0;
      if (input + cacheRead + output <= 0) continue;
      hasUsageData = true;

      const linkedIndices = [...stepIndices];
      if (meta.lastStepIndex !== undefined && !linkedIndices.includes(meta.lastStepIndex)) {
        linkedIndices.push(meta.lastStepIndex);
      }

      const stepTypes: number[] = [];
      let callTsSec = 0;
      for (const idx of linkedIndices) {
        const st = stepMap.get(idx);
        if (!st) continue;
        stepTypes.push(st.stepType);
        if (st.tsSec > callTsSec) callTsSec = st.tsSec;
      }
      if (callTsSec <= 0) callTsSec = fallbackSec;

      const ident = normalizeModelIdentity(meta.model, meta.label, meta.modelEnum);
      if (ident.id !== 'untagged' && ident.displayName !== 'untagged') {
        if (meta.label || !labels[ident.id]) labels[ident.id] = ident.displayName;
      }

      const scenario = classifyCallScenario({
        source,
        agentName: summaryMeta?.agentName,
        parentConversationId: meta.parentCascadeId || summaryMeta?.parentConversationId,
        subagentType: meta.subagentType,
        stepTypes,
        modelId: ident.id,
      });

      const dateKey = formatLocalDateKey(new Date(callTsSec * 1000));
      const tsBucketSec = Math.floor(callTsSec / 60) * 60;
      const bKey = `${dateKey}|${tsBucketSec}|${ident.id}|${scenario}`;
      let b = bucketMap.get(bKey);
      if (!b) {
        b = {
          dateKey,
          tsBucketSec,
          lastTsSec: callTsSec,
          modelId: ident.id,
          scenario,
          input: 0,
          cacheRead: 0,
          output: 0,
          thinking: 0,
          steps: 0,
        };
        bucketMap.set(bKey, b);
      } else if (callTsSec > (b.lastTsSec ?? 0)) {
        b.lastTsSec = callTsSec;
      }
      b.input += input;
      b.cacheRead += cacheRead;
      b.output += output;
      b.thinking += meta.thinkingTokens ?? 0;
      b.steps += 1;

      if (meta.streamingSec !== undefined && meta.streamingSec > 0.05 && output > 0) {
        const tps = output / meta.streamingSec;
        if (tps > 0 && tps <= 5000) {
          b.speedSamples = (b.speedSamples ?? 0) + 1;
          b.tpsSum = (b.tpsSum ?? 0) + tps;
          b.tpsMax = Math.max(b.tpsMax ?? 0, tps);
          if (meta.ttftSec !== undefined && meta.ttftSec >= 0 && meta.ttftSec <= 300) {
            b.ttftSum = (b.ttftSum ?? 0) + meta.ttftSec;
            b.ttftCount = (b.ttftCount ?? 0) + 1;
          }
        }
      }
    }

    return { hasUsageData, compactions, labels, buckets: Array.from(bucketMap.values()) };
  } catch {
    return empty;
  } finally {
    try { db?.close(); } catch {}
  }
}

export function buildTokenLedgerSummary(
  entries: CachedConversationEntry[],
  speedsCache: Record<string, SpeedModelEntry>,
  modelLabels: Record<string, string>,
  timeline: AccountTimeline | null,
  scanElapsedMs: number,
  scannedFiles: number,
) {
  const now = new Date();
  const todayDate = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const todayKey = formatLocalDateKey(todayDate);
  const key7dStart = formatLocalDateKey(addLocalDays(todayDate, -6));
  const key30dStart = formatLocalDateKey(addLocalDays(todayDate, -29));

  const dayMap = new Map<string, {
    input: number; cacheRead: number; output: number; thinking: number; weighted: number;
    steps: number; desktopTotal: number; cliTotal: number; costUsd: number; savedUsd: number;
    modelTotals: Map<string, number>;
  }>();
  const modelAggMap = new Map<string, {
    rawIds: Set<string>;
    primaryRawId: string;
    primaryTokens: number;
    displayName: string;
    family: ModelFamily;
    input: number; cacheRead: number; output: number; thinking: number; weighted: number;
    steps: number; costUsd: number;
    speedSamples: number; tpsSum: number; tpsMax: number; ttftSum: number; ttftCount: number;
  }>();
  const scenarioMap = new Map<CallScenarioKey, { input: number; cacheRead: number; output: number; weighted: number; costUsd: number; steps: number }>();
  const sliceMap = new Map<string, LedgerFilterSlice>();
  const scenarioSliceMap = new Map<string, ScenarioFilterSlice>();
  const modelSliceMap = new Map<string, ModelFilterSlice>();
  const perAccount: Record<string, AccountTokenSummary> = {};
  const projectSet = new Set<string>();
  const accountSet = new Set<string>();

  const sessionAggMap = new Map<string, {
    entry: CachedConversationEntry;
    input: number; cacheRead: number; output: number; thinking: number; weighted: number;
    costUsd: number; steps: number; primaryModel: string; primaryModelVal: number; accountEmail: string;
    dates: Set<string>;
  }>();

  let grandTotal = 0;
  let grandWeighted = 0;

  for (const entry of entries) {
    const project = entry.projectName || '';
    if (project) projectSet.add(project);

    let sIn = 0, sCache = 0, sOut = 0, sThink = 0, sWeighted = 0, sCost = 0, sSteps = 0;
    const sModelVals = new Map<string, number>();
    const sDates = new Set<string>();
    let sLastEmail = '';

    for (const b of entry.buckets) {
      const total = b.input + b.cacheRead + b.output;
      const weighted = computeWeightedTokens(b.input, b.cacheRead, b.output);
      const hint = modelLabels[b.modelId] || b.modelId;
      const { costUsd, savedByCacheUsd } = estimateModelCostUsd(hint, b);
      const ident = normalizeModelIdentity(b.modelId, modelLabels[b.modelId]);
      const mergeKey = ident.id === 'untagged' ? 'untagged' : ident.displayName.toLowerCase();
      const resolvedEmail = timeline ? timeline.resolveEmailAt(b.lastTsSec ?? b.tsBucketSec) : '';
      const accountKey = resolvedEmail || 'unattributed';
      if (resolvedEmail) accountSet.add(resolvedEmail);

      grandTotal += total;
      grandWeighted += weighted;
      sIn += b.input; sCache += b.cacheRead; sOut += b.output; sThink += b.thinking;
      sWeighted += weighted; sCost += costUsd; sSteps += b.steps;
      if (b.dateKey) sDates.add(b.dateKey);
      if (resolvedEmail) sLastEmail = resolvedEmail;
      sModelVals.set(b.modelId, (sModelVals.get(b.modelId) ?? 0) + total);

      // 日维
      let day = dayMap.get(b.dateKey);
      if (!day) {
        day = {
          input: 0, cacheRead: 0, output: 0, thinking: 0, weighted: 0,
          steps: 0, desktopTotal: 0, cliTotal: 0, costUsd: 0, savedUsd: 0, modelTotals: new Map(),
        };
        dayMap.set(b.dateKey, day);
      }
      day.input += b.input; day.cacheRead += b.cacheRead; day.output += b.output;
      day.thinking += b.thinking; day.weighted += weighted;
      day.steps += b.steps; day.costUsd += costUsd; day.savedUsd += savedByCacheUsd;
      if (entry.source === 'cli') day.cliTotal += total; else day.desktopTotal += total;
      day.modelTotals.set(b.modelId, (day.modelTotals.get(b.modelId) ?? 0) + total);

      // 模型维（按规范化 displayName 合并同名路由，避免排行榜重复）
      let mAgg = modelAggMap.get(mergeKey);
      if (!mAgg) {
        mAgg = {
          rawIds: new Set([b.modelId]),
          primaryRawId: b.modelId,
          primaryTokens: total,
          displayName: ident.displayName,
          family: ident.family,
          input: 0, cacheRead: 0, output: 0, thinking: 0, weighted: 0,
          steps: 0, costUsd: 0,
          speedSamples: 0, tpsSum: 0, tpsMax: 0, ttftSum: 0, ttftCount: 0,
        };
        modelAggMap.set(mergeKey, mAgg);
      } else {
        mAgg.rawIds.add(b.modelId);
        if (total > mAgg.primaryTokens) {
          mAgg.primaryTokens = total;
          mAgg.primaryRawId = b.modelId;
        }
      }
      mAgg.input += b.input; mAgg.cacheRead += b.cacheRead; mAgg.output += b.output;
      mAgg.thinking += b.thinking; mAgg.weighted += weighted;
      mAgg.steps += b.steps; mAgg.costUsd += costUsd;
      mAgg.speedSamples += b.speedSamples ?? 0;
      mAgg.tpsSum += b.tpsSum ?? 0;
      mAgg.tpsMax = Math.max(mAgg.tpsMax, b.tpsMax ?? 0);
      mAgg.ttftSum += b.ttftSum ?? 0;
      mAgg.ttftCount += b.ttftCount ?? 0;

      // 场景维
      let sc = scenarioMap.get(b.scenario);
      if (!sc) {
        sc = { input: 0, cacheRead: 0, output: 0, weighted: 0, costUsd: 0, steps: 0 };
        scenarioMap.set(b.scenario, sc);
      }
      sc.input += b.input; sc.cacheRead += b.cacheRead; sc.output += b.output;
      sc.weighted += weighted; sc.costUsd += costUsd; sc.steps += b.steps;

      // 多维筛选切片（日 × 端 × 项目 × 账号；含场景切片与模型切片）
      const baseSliceKey = `${b.dateKey}|${entry.source}|${project}|${accountKey}`;
      let sl = sliceMap.get(baseSliceKey);
      if (!sl) {
        sl = {
          date: b.dateKey, source: entry.source, project, account: accountKey,
          input: 0, cacheRead: 0, output: 0, thinking: 0, weighted: 0,
          costUsd: 0, savedUsd: 0, steps: 0,
        };
        sliceMap.set(baseSliceKey, sl);
      }
      sl.input += b.input; sl.cacheRead += b.cacheRead; sl.output += b.output;
      sl.thinking += b.thinking; sl.weighted += weighted;
      sl.costUsd += costUsd; sl.savedUsd += savedByCacheUsd; sl.steps += b.steps;

      const scKey = `${baseSliceKey}|${b.scenario}`;
      let scSl = scenarioSliceMap.get(scKey);
      if (!scSl) {
        scSl = {
          date: b.dateKey, source: entry.source, project, account: accountKey, scenario: b.scenario,
          input: 0, cacheRead: 0, output: 0, weighted: 0, costUsd: 0, steps: 0,
        };
        scenarioSliceMap.set(scKey, scSl);
      }
      scSl.input += b.input; scSl.cacheRead += b.cacheRead; scSl.output += b.output;
      scSl.weighted += weighted; scSl.costUsd += costUsd; scSl.steps += b.steps;

      const msKey = `${baseSliceKey}|${mergeKey}`;
      let mSl = modelSliceMap.get(msKey);
      if (!mSl) {
        mSl = {
          date: b.dateKey, source: entry.source, project, account: accountKey, modelKey: mergeKey,
          input: 0, cacheRead: 0, output: 0, weighted: 0, costUsd: 0, steps: 0,
        };
        modelSliceMap.set(msKey, mSl);
      }
      mSl.input += b.input; mSl.cacheRead += b.cacheRead; mSl.output += b.output;
      mSl.weighted += weighted; mSl.costUsd += costUsd; mSl.steps += b.steps;

      // 单账号卡汇总（只记可归属账号）
      if (resolvedEmail) {
        let acctSum = perAccount[resolvedEmail];
        if (!acctSum) {
          acctSum = { todayTokens: 0, todayWeighted: 0, todayCostUsd: 0, totalTokens: 0, totalWeighted: 0, totalCostUsd: 0, steps: 0 };
          perAccount[resolvedEmail] = acctSum;
        }
        acctSum.totalTokens += total;
        acctSum.totalWeighted += weighted;
        acctSum.totalCostUsd += costUsd;
        acctSum.steps += b.steps;
        if (b.dateKey === todayKey) {
          acctSum.todayTokens += total;
          acctSum.todayWeighted += weighted;
          acctSum.todayCostUsd += costUsd;
        }
      }
    }

    if (sSteps > 0 || entry.parentConversationId) {
      let topM = '';
      let topV = -1;
      for (const [m, v] of sModelVals.entries()) {
        if (m !== 'untagged' && v > topV) { topV = v; topM = m; }
      }
      sessionAggMap.set(entry.conversationId, {
        entry,
        input: sIn, cacheRead: sCache, output: sOut, thinking: sThink,
        weighted: sWeighted, costUsd: sCost, steps: sSteps,
        primaryModel: topM ? normalizeModelIdentity(topM, modelLabels[topM]).displayName : '',
        primaryModelVal: topV,
        accountEmail: sLastEmail,
        dates: sDates,
      });
    }
  }

  for (const k of Object.keys(perAccount)) {
    perAccount[k].todayCostUsd = roundUsd(perAccount[k].todayCostUsd);
    perAccount[k].totalCostUsd = roundUsd(perAccount[k].totalCostUsd);
  }

  // 合并 LiveContextMeter 实时测速样本到同名模型条目
  for (const [rawId, spd] of Object.entries(speedsCache)) {
    if (!spd || spd.samples <= 0) continue;
    const ident = normalizeModelIdentity(rawId, modelLabels[rawId]);
    const mergeKey = ident.id === 'untagged' ? 'untagged' : ident.displayName.toLowerCase();
    let mAgg = modelAggMap.get(mergeKey);
    if (!mAgg) {
      mAgg = {
        rawIds: new Set([rawId]),
        primaryRawId: rawId,
        primaryTokens: 0,
        displayName: ident.displayName,
        family: ident.family,
        input: 0, cacheRead: 0, output: 0, thinking: 0, weighted: 0,
        steps: 0, costUsd: 0,
        speedSamples: 0, tpsSum: 0, tpsMax: 0, ttftSum: 0, ttftCount: 0,
      };
      modelAggMap.set(mergeKey, mAgg);
    } else {
      mAgg.rawIds.add(rawId);
    }
    mAgg.speedSamples += spd.samples;
    mAgg.tpsSum += spd.tpsSum;
    mAgg.tpsMax = Math.max(mAgg.tpsMax, spd.tpsMax);
    mAgg.ttftSum += spd.ttftSum;
    mAgg.ttftCount += spd.ttftCount;
  }

  const models: TokenModelRecord[] = [];
  for (const agg of modelAggMap.values()) {
    const total = agg.input + agg.cacheRead + agg.output;
    models.push({
      model: agg.primaryRawId,
      displayName: agg.displayName,
      family: agg.family,
      routes: Array.from(agg.rawIds),
      input: agg.input,
      cacheRead: agg.cacheRead,
      output: agg.output,
      thinking: agg.thinking,
      weighted: agg.weighted,
      total,
      steps: agg.steps,
      sharePct: grandTotal > 0 ? Math.round((total / grandTotal) * 1000) / 10 : 0,
      costUsd: roundUsd(agg.costUsd),
      avgStreamingTps: agg.speedSamples > 0 ? Math.round((agg.tpsSum / agg.speedSamples) * 10) / 10 : null,
      maxStreamingTps: agg.tpsMax > 0 ? Math.round(agg.tpsMax * 10) / 10 : null,
      avgTtftSec: agg.ttftCount > 0 ? Math.round((agg.ttftSum / agg.ttftCount) * 100) / 100 : null,
      speedSamples: agg.speedSamples,
    });
  }
  models.sort((a, b) => (b.weighted - a.weighted) || (b.total - a.total) || ((b.avgStreamingTps ?? 0) - (a.avgStreamingTps ?? 0)));

  // 组装周期汇总
  const emptyAcc = () => ({ input: 0, cacheRead: 0, output: 0, thinking: 0, weighted: 0, steps: 0, desktopTotal: 0, cliTotal: 0, costUsd: 0, savedUsd: 0 });
  const addAcc = (acc: ReturnType<typeof emptyAcc>, d: NonNullable<ReturnType<typeof dayMap.get>>) => {
    acc.input += d.input; acc.cacheRead += d.cacheRead; acc.output += d.output;
    acc.thinking += d.thinking; acc.weighted += d.weighted;
    acc.steps += d.steps; acc.desktopTotal += d.desktopTotal; acc.cliTotal += d.cliTotal;
    acc.costUsd += d.costUsd; acc.savedUsd += d.savedUsd;
  };
  const toBucket = (acc: ReturnType<typeof emptyAcc>): TokenPeriodBucket => {
    const total = acc.input + acc.cacheRead + acc.output;
    const promptTotal = acc.input + acc.cacheRead;
    return {
      input: acc.input, cacheRead: acc.cacheRead, output: acc.output, thinking: acc.thinking,
      weighted: acc.weighted, total, steps: acc.steps,
      cacheHitPct: promptTotal > 0 ? Math.round((acc.cacheRead / promptTotal) * 1000) / 10 : 0,
      desktopTotal: acc.desktopTotal, cliTotal: acc.cliTotal,
      costUsd: roundUsd(acc.costUsd), savedByCacheUsd: roundUsd(acc.savedUsd),
    };
  };

  const accToday = emptyAcc(), acc7d = emptyAcc(), acc30d = emptyAcc(), accAll = emptyAcc();
  let firstDate: string | null = null;
  for (const [dk, d] of dayMap.entries()) {
    if (!firstDate || dk < firstDate) firstDate = dk;
    addAcc(accAll, d);
    if (dk >= key30dStart && dk <= todayKey) addAcc(acc30d, d);
    if (dk >= key7dStart && dk <= todayKey) addAcc(acc7d, d);
    if (dk === todayKey) addAcc(accToday, d);
  }

  const mkDaily = (date: string, d: ReturnType<typeof dayMap.get>, isFuture: boolean): TokenDailyRecord => {
    if (!d) {
      return { date, input: 0, cacheRead: 0, output: 0, weighted: 0, total: 0, steps: 0, desktopTotal: 0, cliTotal: 0, topModel: '', topModelDisplay: '', costUsd: 0, isFuture };
    }
    let topModel = ''; let topVal = -1;
    for (const [m, v] of d.modelTotals.entries()) {
      if (m !== 'untagged' && v > topVal) { topVal = v; topModel = m; }
    }
    if (!topModel && d.modelTotals.has('untagged')) topModel = 'untagged';
    return {
      date, input: d.input, cacheRead: d.cacheRead, output: d.output, weighted: d.weighted,
      total: d.input + d.cacheRead + d.output, steps: d.steps,
      desktopTotal: d.desktopTotal, cliTotal: d.cliTotal, topModel,
      topModelDisplay: topModel ? normalizeModelIdentity(topModel, modelLabels[topModel]).displayName : '',
      costUsd: roundUsd(d.costUsd), isFuture,
    };
  };

  const dayOfWeekMon0 = (todayDate.getDay() + 6) % 7;
  const gridStartDate = addLocalDays(addLocalDays(todayDate, -dayOfWeekMon0), -51 * 7);
  const heatmapDays: TokenDailyRecord[] = [];
  for (let i = 0; i < 52 * 7; i++) {
    const cur = addLocalDays(gridStartDate, i);
    heatmapDays.push(mkDaily(formatLocalDateKey(cur), dayMap.get(formatLocalDateKey(cur)), cur.getTime() > todayDate.getTime()));
  }
  const daily30: TokenDailyRecord[] = [];
  for (let i = 29; i >= 0; i--) {
    const dk = formatLocalDateKey(addLocalDays(todayDate, -i));
    daily30.push(mkDaily(dk, dayMap.get(dk), false));
  }

  // 场景列表（按加权降序）
  const scenarios: ScenarioBreakdownItem[] = Array.from(scenarioMap.entries())
    .map(([key, sc]) => ({
      key,
      input: sc.input,
      cacheRead: sc.cacheRead,
      output: sc.output,
      weighted: sc.weighted,
      costUsd: roundUsd(sc.costUsd),
      steps: sc.steps,
      sharePct: grandWeighted > 0 ? Math.round((sc.weighted / grandWeighted) * 1000) / 10 : 0,
    }))
    .sort((a, b) => b.weighted - a.weighted);

  // 父子会话树组装
  const rootSessions = new Map<string, SessionExplorerItem>();
  const rootDateSets = new Map<string, Set<string>>();
  const ensureRoot = (cid: string): SessionExplorerItem => {
    let r = rootSessions.get(cid);
    if (r) return r;
    const agg = sessionAggMap.get(cid);
    const pt = agg ? agg.input + agg.cacheRead : 0;
    const hit = pt > 0 ? Math.round((agg!.cacheRead / pt) * 1000) / 10 : 0;
    const dSet = new Set<string>(agg?.dates ?? []);
    rootDateSets.set(cid, dSet);
    r = {
      conversationId: cid,
      title: agg?.entry.title || cid.slice(0, 8),
      projectName: agg?.entry.projectName || '',
      source: agg?.entry.source || 'desktop',
      accountEmail: agg?.accountEmail || '',
      topModelDisplay: agg?.primaryModel || '',
      input: agg?.input || 0,
      cacheRead: agg?.cacheRead || 0,
      output: agg?.output || 0,
      thinking: agg?.thinking || 0,
      weighted: agg?.weighted || 0,
      costUsd: agg ? roundUsd(agg.costUsd) : 0,
      steps: agg?.steps || 0,
      compactions: agg?.entry.compactions || 0,
      cacheHitPct: hit,
      isLowCache: pt >= 1000 && hit < 50,
      lastModifiedMs: agg?.entry.lastModifiedMs || agg?.entry.mtimeMs || 0,
      activeDates: [],
      subagents: [],
    };
    rootSessions.set(cid, r);
    return r;
  };

  for (const [cid, agg] of sessionAggMap.entries()) {
    const pid = agg.entry.parentConversationId;
    if (pid && pid !== cid) {
      const parent = ensureRoot(pid);
      const pDates = rootDateSets.get(pid);
      if (pDates) {
        for (const dk of agg.dates) pDates.add(dk);
      }
      const pt = agg.input + agg.cacheRead;
      const hit = pt > 0 ? Math.round((agg.cacheRead / pt) * 1000) / 10 : 0;
      parent.subagents.push({
        conversationId: cid,
        agentName: agg.entry.agentName || 'subagent',
        title: agg.entry.title || agg.entry.agentName || cid.slice(0, 8),
        input: agg.input,
        cacheRead: agg.cacheRead,
        output: agg.output,
        weighted: agg.weighted,
        costUsd: roundUsd(agg.costUsd),
        steps: agg.steps,
        cacheHitPct: hit,
      });
      if (!parent.projectName && agg.entry.projectName) parent.projectName = agg.entry.projectName;
      if (!parent.accountEmail && agg.accountEmail) parent.accountEmail = agg.accountEmail;
      if (agg.entry.lastModifiedMs > parent.lastModifiedMs) parent.lastModifiedMs = agg.entry.lastModifiedMs;
    } else {
      ensureRoot(cid);
    }
  }

  for (const [cid, item] of rootSessions.entries()) {
    const dSet = rootDateSets.get(cid);
    if (dSet && dSet.size > 0) item.activeDates = Array.from(dSet).sort();
  }

  const sessions = Array.from(rootSessions.values())
    .filter((s) => s.steps > 0 || s.subagents.length > 0)
    .sort((a, b) => (b.lastModifiedMs - a.lastModifiedMs) || (b.weighted - a.weighted))
    .slice(0, 120);

  const scenarioSlices = Array.from(scenarioSliceMap.values()).map((s) => ({
    ...s,
    costUsd: roundUsd(s.costUsd),
  }));
  const modelSlices = Array.from(modelSliceMap.values()).map((m) => ({
    ...m,
    costUsd: roundUsd(m.costUsd),
  }));

  return {
    scannedAt: Date.now(),
    scanElapsedMs,
    scannedFiles,
    totalSessions: entries.length,
    firstDate,
    todayKey,
    totals: {
      today: toBucket(accToday),
      last7d: toBucket(acc7d),
      last30d: toBucket(acc30d),
      allTime: toBucket(accAll),
    },
    heatmapDays,
    daily30,
    models,
    scenarios,
    projects: Array.from(projectSet).sort(),
    accounts: Array.from(accountSet).sort(),
    sessions,
    slices: Array.from(sliceMap.values()),
    scenarioSlices,
    modelSlices,
    perAccount,
  };
}

