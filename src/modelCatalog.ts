/**
 * 模型身份规范化、API 等效费用估算与 conversations/*.db (gen_metadata) Protobuf 只读提取
 */
import * as fs from 'fs';
import { loadSqlite } from './ideStateDb';

export type ModelFamily = 'claude' | 'gemini' | 'gpt' | 'other';

export interface NormalizedModelIdentity {
  id: string;
  displayName: string;
  family: ModelFamily;
}

export interface ModelRatesPerMillion {
  input: number;
  cacheRead: number;
  output: number;
}

export interface ConversationStepMeta {
  model?: string;
  label?: string;
  modelEnum?: string;
  ttftSec?: number;
  streamingSec?: number;
  inputTokens?: number;
  cacheReadTokens?: number;
  outputTokens?: number;
  thinkingTokens?: number;
  responseTokens?: number;
  subagentType?: string;
  parentCascadeId?: string;
  rootCascadeId?: string;
  lastStepIndex?: number;
}

const KNOWN_TIER_RATES: Array<{ test: RegExp; family: ModelFamily; rates: ModelRatesPerMillion }> = [
  { test: /opus/i, family: 'claude', rates: { input: 15, cacheRead: 1.5, output: 75 } },
  { test: /sonnet/i, family: 'claude', rates: { input: 3, cacheRead: 0.3, output: 15 } },
  { test: /haiku/i, family: 'claude', rates: { input: 0.8, cacheRead: 0.08, output: 4 } },
  { test: /claude/i, family: 'claude', rates: { input: 3, cacheRead: 0.3, output: 15 } },
  { test: /(argon|flash|lite)/i, family: 'gemini', rates: { input: 0.3, cacheRead: 0.03, output: 2.5 } },
  { test: /(hydrogen|carbon|orchestrator|gemini.*pro|gemini)/i, family: 'gemini', rates: { input: 1.25, cacheRead: 0.125, output: 10 } },
  { test: /(gpt|openai|o[134]-?)/i, family: 'gpt', rates: { input: 2.5, cacheRead: 0.625, output: 10 } },
];

const FALLBACK_RATES: ModelRatesPerMillion = { input: 1.25, cacheRead: 0.125, output: 10 };

const ACRONYM_MAP: Record<string, string> = {
  gpt: 'GPT',
  oss: 'OSS',
  llm: 'LLM',
  xhigh: 'XHigh',
};

function sanitizeRawString(raw?: string): string {
  return (raw ?? '').trim().replace(/^models\//i, '');
}

function humanizeKebabName(rawId: string): string {
  const cleaned = rawId
    .replace(/^MODEL_(GOOGLE_|ANTHROPIC_|VERTEX_)?/i, '')
    .replace(/_/g, '-');
  const tierMatch = cleaned.match(/^(.+?)-(xhigh|high|medium|low|thinking)$/i);
  const baseParts = (tierMatch ? tierMatch[1] : cleaned).split('-').filter(Boolean);
  const words: string[] = [];
  for (let i = 0; i < baseParts.length; i++) {
    const part = baseParts[i];
    const next = baseParts[i + 1];
    // 将连续数字段（如 4-6、3-1）合并为 4.6 / 3.1
    if (/^\d+$/.test(part) && next && /^\d+$/.test(next)) {
      words.push(`${part}.${next}`);
      i++;
      continue;
    }
    const lower = part.toLowerCase();
    words.push(ACRONYM_MAP[lower] ?? (lower.charAt(0).toUpperCase() + lower.slice(1)));
  }
  const base = words.join(' ');
  if (!tierMatch) return base || rawId;
  const tagLower = tierMatch[2].toLowerCase();
  const tag = ACRONYM_MAP[tagLower] ?? (tagLower.charAt(0).toUpperCase() + tagLower.slice(1));
  return `${base} (${tag})`;
}

function toCanonicalSlug(input: string): string {
  return input
    .trim()
    .replace(/^models\//i, '')
    .replace(/(\d+)\.(\d+)/g, '$1-$2')
    .replace(/[()]/g, ' ')
    .replace(/[_\s/]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
    .toLowerCase();
}

export function detectModelFamily(hint: string): ModelFamily {
  const lower = hint.toLowerCase();
  if (!lower || lower === 'untagged' || lower === 'unknown') return 'other';
  for (const rule of KNOWN_TIER_RATES) {
    if (rule.test.test(lower)) return rule.family;
  }
  return 'other';
}

/**
 * 合并 transcript.jsonl 的 rawModel 与 gen_metadata 的 label/modelEnum，产出稳定的 canonical ID 与展示名
 */
export function normalizeModelIdentity(rawModel?: string, label?: string, modelEnum?: string): NormalizedModelIdentity {
  const cleanLabel = sanitizeRawString(label);
  const cleanRaw = sanitizeRawString(rawModel);
  const cleanEnum = sanitizeRawString(modelEnum);

  if ((!cleanRaw || cleanRaw === 'untagged' || cleanRaw === 'unknown') && !cleanLabel && !cleanEnum) {
    return { id: 'untagged', displayName: 'untagged', family: 'other' };
  }

  const preferRaw = cleanRaw && !/^MODEL_PLACEHOLDER/i.test(cleanRaw) && cleanRaw !== 'untagged' && cleanRaw !== 'unknown';
  const slugSource = preferRaw ? cleanRaw : (cleanLabel || cleanEnum || cleanRaw);
  const id = toCanonicalSlug(slugSource) || 'untagged';

  const displayName = cleanLabel || (id === 'untagged' ? 'untagged' : humanizeKebabName(preferRaw ? cleanRaw : slugSource));
  const family = detectModelFamily(`${id} ${displayName} ${cleanEnum}`);
  return { id, displayName, family };
}

export function getModelRates(modelHint: string): ModelRatesPerMillion {
  const lower = modelHint.toLowerCase();
  for (const rule of KNOWN_TIER_RATES) {
    if (rule.test.test(lower)) return rule.rates;
  }
  return FALLBACK_RATES;
}

export function computeWeightedTokens(input: number, cacheRead: number, output: number): number {
  return Math.round(Math.max(0, input) + 0.1 * Math.max(0, cacheRead) + 6 * Math.max(0, output));
}

export function estimateModelCostUsd(
  modelHint: string,
  tokens: { input: number; cacheRead: number; output: number },
): { costUsd: number; savedByCacheUsd: number } {
  const rates = getModelRates(modelHint);
  const inputUsd = (Math.max(0, tokens.input) / 1_000_000) * rates.input;
  const cacheUsd = (Math.max(0, tokens.cacheRead) / 1_000_000) * rates.cacheRead;
  const outputUsd = (Math.max(0, tokens.output) / 1_000_000) * rates.output;
  const savedByCacheUsd = Math.max(0, (Math.max(0, tokens.cacheRead) / 1_000_000) * (rates.input - rates.cacheRead));
  return {
    costUsd: inputUsd + cacheUsd + outputUsd,
    savedByCacheUsd,
  };
}

// ─── Protobuf 二进制极简解码（针对 conversations/*.db gen_metadata） ─────

function readVarint(buf: Buffer, offset: number): [number, number] | null {
  let result = 0n;
  let shift = 0n;
  let pos = offset;
  while (pos < buf.length && shift < 64n) {
    const byte = buf[pos++];
    result |= BigInt(byte & 0x7f) << shift;
    if ((byte & 0x80) === 0) {
      return [Number(result), pos];
    }
    shift += 7n;
  }
  return null;
}

function skipField(buf: Buffer, offset: number, wireType: number): number {
  if (wireType === 0) {
    const v = readVarint(buf, offset);
    return v ? v[1] : buf.length;
  }
  if (wireType === 1) return Math.min(buf.length, offset + 8);
  if (wireType === 5) return Math.min(buf.length, offset + 4);
  if (wireType === 2) {
    const len = readVarint(buf, offset);
    if (!len) return buf.length;
    return Math.min(buf.length, len[1] + Math.max(0, len[0]));
  }
  return buf.length;
}

function parseDurationSec(buf: Buffer): number | undefined {
  let pos = 0;
  let sec = 0;
  let nanos = 0;
  let hasField = false;
  while (pos < buf.length) {
    const tagRes = readVarint(buf, pos);
    if (!tagRes) break;
    const [tag, nextPos] = tagRes;
    pos = nextPos;
    const fieldNum = tag >>> 3;
    const wireType = tag & 7;
    if (wireType === 0 && (fieldNum === 1 || fieldNum === 2)) {
      const val = readVarint(buf, pos);
      if (!val) break;
      pos = val[1];
      if (fieldNum === 1) sec = val[0];
      else nanos = val[0];
      hasField = true;
    } else {
      pos = skipField(buf, pos, wireType);
    }
  }
  if (!hasField) return undefined;
  const total = sec + nanos / 1e9;
  return Number.isFinite(total) && total >= 0 && total <= 86400 ? total : undefined;
}

function parseKeyValue(buf: Buffer): { key?: string; value?: string } {
  let pos = 0;
  let key: string | undefined;
  let value: string | undefined;
  while (pos < buf.length) {
    const tagRes = readVarint(buf, pos);
    if (!tagRes) break;
    const [tag, nextPos] = tagRes;
    pos = nextPos;
    const fieldNum = tag >>> 3;
    const wireType = tag & 7;
    if (wireType === 2 && (fieldNum === 1 || fieldNum === 2)) {
      const lenRes = readVarint(buf, pos);
      if (!lenRes) break;
      const [len, strStart] = lenRes;
      const strEnd = Math.min(buf.length, strStart + Math.max(0, len));
      const str = buf.subarray(strStart, strEnd).toString('utf8');
      if (fieldNum === 1) key = str;
      else value = str;
      pos = strEnd;
    } else {
      pos = skipField(buf, pos, wireType);
    }
  }
  return { key, value };
}

interface UsageFields {
  inputTokens?: number;
  outputTokens?: number;
  cacheReadTokens?: number;
  thinkingTokens?: number;
  responseTokens?: number;
}

function parseUsageMsg(buf: Buffer): UsageFields {
  const out: UsageFields = {};
  let pos = 0;
  while (pos < buf.length) {
    const tagRes = readVarint(buf, pos);
    if (!tagRes) break;
    const [tag, nextPos] = tagRes;
    pos = nextPos;
    const fieldNum = tag >>> 3;
    const wireType = tag & 7;
    if (wireType === 0) {
      const v = readVarint(buf, pos);
      if (!v) break;
      pos = v[1];
      const val = Math.max(0, v[0]);
      if (fieldNum === 2) out.inputTokens = val;
      else if (fieldNum === 3) out.outputTokens = val;
      else if (fieldNum === 5) out.cacheReadTokens = val;
      else if (fieldNum === 9) out.thinkingTokens = val;
      else if (fieldNum === 10) out.responseTokens = val;
    } else {
      pos = skipField(buf, pos, wireType);
    }
  }
  return out;
}

function parseRetryUsage(buf: Buffer): UsageFields | undefined {
  let pos = 0;
  let last: UsageFields | undefined;
  while (pos < buf.length) {
    const tagRes = readVarint(buf, pos);
    if (!tagRes) break;
    const [tag, nextPos] = tagRes;
    pos = nextPos;
    const fieldNum = tag >>> 3;
    const wireType = tag & 7;
    if (wireType === 2 && fieldNum === 2) {
      const lenRes = readVarint(buf, pos);
      if (!lenRes) break;
      const [len, start] = lenRes;
      const end = Math.min(buf.length, start + Math.max(0, len));
      const u = parseUsageMsg(buf.subarray(start, end));
      if ((u.inputTokens ?? 0) + (u.cacheReadTokens ?? 0) + (u.outputTokens ?? 0) > 0) {
        last = u;
      }
      pos = end;
    } else {
      pos = skipField(buf, pos, wireType);
    }
  }
  return last;
}

export function parseStepTimestampSec(buf: Buffer | Uint8Array | null | undefined): number {
  if (!buf || buf.length === 0) return 0;
  const b = Buffer.isBuffer(buf) ? buf : Buffer.from(buf);
  let pos = 0;
  while (pos < b.length) {
    const tagRes = readVarint(b, pos);
    if (!tagRes) break;
    const [tag, nextPos] = tagRes;
    pos = nextPos;
    const fieldNum = tag >>> 3;
    const wireType = tag & 7;
    if (fieldNum === 1 && wireType === 2) {
      const lenRes = readVarint(b, pos);
      if (!lenRes) break;
      const [len, start] = lenRes;
      const end = Math.min(b.length, start + Math.max(0, len));
      let p = start;
      while (p < end) {
        const innerTag = readVarint(b, p);
        if (!innerTag) break;
        p = innerTag[1];
        const f = innerTag[0] >>> 3;
        const w = innerTag[0] & 7;
        if (f === 1 && w === 0) {
          const tsVal = readVarint(b, p);
          if (tsVal && tsVal[0] > 1_500_000_000 && tsVal[0] < 4_000_000_000) {
            return tsVal[0];
          }
          break;
        }
        p = skipField(b, p, w);
      }
      pos = end;
    } else {
      pos = skipField(b, pos, wireType);
    }
  }
  return 0;
}

function parseInnerMeta(buf: Buffer): ConversationStepMeta {
  const meta: ConversationStepMeta = {};
  let retryUsage: UsageFields | undefined;
  let pos = 0;
  while (pos < buf.length) {
    const tagRes = readVarint(buf, pos);
    if (!tagRes) break;
    const [tag, nextPos] = tagRes;
    pos = nextPos;
    const fieldNum = tag >>> 3;
    const wireType = tag & 7;
    if (wireType !== 2) {
      pos = skipField(buf, pos, wireType);
      continue;
    }
    const lenRes = readVarint(buf, pos);
    if (!lenRes) break;
    const [len, bodyStart] = lenRes;
    const bodyEnd = Math.min(buf.length, bodyStart + Math.max(0, len));
    const slice = buf.subarray(bodyStart, bodyEnd);
    pos = bodyEnd;

    if (fieldNum === 4) {
      const u = parseUsageMsg(slice);
      if ((u.inputTokens ?? 0) + (u.cacheReadTokens ?? 0) + (u.outputTokens ?? 0) > 0) {
        meta.inputTokens = u.inputTokens;
        meta.outputTokens = u.outputTokens;
        meta.cacheReadTokens = u.cacheReadTokens;
        meta.thinkingTokens = u.thinkingTokens;
        meta.responseTokens = u.responseTokens;
      }
    } else if (fieldNum === 11) meta.ttftSec = parseDurationSec(slice);
    else if (fieldNum === 12) meta.streamingSec = parseDurationSec(slice);
    else if (fieldNum === 17) {
      const ru = parseRetryUsage(slice);
      if (ru) retryUsage = ru;
    } else if (fieldNum === 19) meta.model = slice.toString('utf8').trim() || meta.model;
    else if (fieldNum === 21) meta.label = slice.toString('utf8').trim() || meta.label;
    else if (fieldNum === 20) {
      const kv = parseKeyValue(slice);
      if (kv.key === 'model_enum' && kv.value) meta.modelEnum = kv.value.trim();
      else if (kv.key === 'subagent_type' && kv.value) meta.subagentType = kv.value.trim();
      else if (kv.key === 'parent_cascade_id' && kv.value) meta.parentCascadeId = kv.value.trim();
      else if (kv.key === 'root_cascade_id' && kv.value) meta.rootCascadeId = kv.value.trim();
      else if (kv.key === 'last_step_index' && kv.value) {
        const n = Number(kv.value);
        if (Number.isInteger(n) && n >= 0) meta.lastStepIndex = n;
      }
    }
  }
  if (
    retryUsage &&
    ((meta.inputTokens ?? 0) + (meta.cacheReadTokens ?? 0) + (meta.outputTokens ?? 0) === 0)
  ) {
    meta.inputTokens = retryUsage.inputTokens;
    meta.outputTokens = retryUsage.outputTokens;
    meta.cacheReadTokens = retryUsage.cacheReadTokens;
    meta.thinkingTokens = retryUsage.thinkingTokens;
    meta.responseTokens = retryUsage.responseTokens;
  }
  return meta;
}

export function parseGenMetadataBlob(buf: Buffer): { stepIndices: number[]; meta: ConversationStepMeta } {
  const stepIndices: number[] = [];
  let meta: ConversationStepMeta = {};
  let pos = 0;
  while (pos < buf.length) {
    const tagRes = readVarint(buf, pos);
    if (!tagRes) break;
    const [tag, nextPos] = tagRes;
    pos = nextPos;
    const fieldNum = tag >>> 3;
    const wireType = tag & 7;

    if (fieldNum === 2 && wireType === 0) {
      const v = readVarint(buf, pos);
      if (!v) break;
      pos = v[1];
      if (v[0] >= 0) stepIndices.push(v[0]);
    } else if (fieldNum === 2 && wireType === 2) {
      const lenRes = readVarint(buf, pos);
      if (!lenRes) break;
      const [len, start] = lenRes;
      const end = Math.min(buf.length, start + Math.max(0, len));
      let p = start;
      while (p < end) {
        const v = readVarint(buf, p);
        if (!v) break;
        p = v[1];
        if (v[0] >= 0) stepIndices.push(v[0]);
      }
      pos = end;
    } else if (fieldNum === 1 && wireType === 2) {
      const lenRes = readVarint(buf, pos);
      if (!lenRes) break;
      const [len, start] = lenRes;
      const end = Math.min(buf.length, start + Math.max(0, len));
      const parsed = parseInnerMeta(buf.subarray(start, end));
      meta = { ...meta, ...parsed };
      pos = end;
    } else {
      pos = skipField(buf, pos, wireType);
    }
  }
  return { stepIndices, meta };
}

export function getConversationDbSig(dbPath: string): string {
  try {
    const st = fs.statSync(dbPath);
    let sig = `${st.size}:${Math.trunc(st.mtimeMs)}`;
    const walPath = `${dbPath}-wal`;
    if (fs.existsSync(walPath)) {
      const wst = fs.statSync(walPath);
      sig += `|${wst.size}:${Math.trunc(wst.mtimeMs)}`;
    }
    return sig;
  } catch {
    return '';
  }
}

export function readConversationStepMeta(dbPath: string): Map<number, ConversationStepMeta> {
  const result = new Map<number, ConversationStepMeta>();
  if (!fs.existsSync(dbPath)) return result;
  const sqlite = loadSqlite();
  if (!sqlite?.DatabaseSync) return result;

  let db: any = null;
  try {
    db = new sqlite.DatabaseSync(dbPath, { readOnly: true });
    try { db.exec('PRAGMA busy_timeout = 200'); } catch {}
    const rows = db.prepare('SELECT data FROM gen_metadata').all() as Array<{ data?: Uint8Array | Buffer }>;
    for (const row of rows) {
      if (!row?.data) continue;
      const buf = Buffer.isBuffer(row.data) ? row.data : Buffer.from(row.data);
      const { stepIndices, meta } = parseGenMetadataBlob(buf);
      for (const idx of stepIndices) {
        const prev = result.get(idx);
        result.set(idx, prev ? { ...prev, ...meta } : meta);
      }
    }
  } catch {
    // 正在写入锁定、无表或损坏文件时静默降级，绝不中断台账统计
  } finally {
    try { db?.close(); } catch {}
  }
  return result;
}

