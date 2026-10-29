/**
 * Antigravity IDE 状态库（state.vscdb）直写支持
 *
 * IDE 的登录态持久化在 <userDataDir>/User/globalStorage/state.vscdb 的 ItemTable：
 *   - antigravityUnifiedStateSync.oauthToken  → uss-oauth topic（key: oauthTokenInfoSentinelKey）
 *   - antigravityUnifiedStateSync.userStatus  → uss-userStatus topic（key: userStatusSentinelKey）
 * 扩展侧 API 对 UserStatus 只有读/清、无写（见 devloop: antigravity-seamless-switch-protocol），
 * 完整身份切换需要直写该库（协议参考 Draculabo/AntigravityManager 的开源实现）。
 *
 * SQLite 访问用 ext host 自带的 node:sqlite（Node 22.13+ 免 flag），零打包成本。
 * IDE 运行中写入的 userStatus 只要会话内无更新事件就不会被内存态覆盖，重启后生效。
 */
import * as fs from 'fs';
import * as path from 'path';

export interface IdeTokenInfo {
  accessToken: string;
  refreshToken?: string;
  expiryDateSeconds?: number;
  idToken?: string;
  isGcpTos?: boolean;
}

export interface IdeStateSwitchResult {
  dbWritten: boolean;
  dbPath: string;
  error?: string;
}

// ── protobuf 原语 ──

function encodeVarint(value: number): Buffer {
  const big = BigInt(Math.round(value));
  const bytes: number[] = [];
  let v = big;
  do {
    let byte = Number(v & 0x7fn);
    v >>= 7n;
    if (v > 0n) byte |= 0x80;
    bytes.push(byte);
  } while (v > 0n);
  return Buffer.from(bytes);
}

function encodeTag(fieldNum: number, wireType: number): Buffer {
  return encodeVarint((fieldNum << 3) | wireType);
}

function encodeLenDelim(fieldNum: number, bytes: Buffer): Buffer {
  return Buffer.concat([encodeTag(fieldNum, 2), encodeVarint(bytes.length), bytes]);
}

function encodeStringField(fieldNum: number, value: string): Buffer {
  return encodeLenDelim(fieldNum, Buffer.from(value, 'utf8'));
}

function encodeVarintField(fieldNum: number, value: number): Buffer {
  return Buffer.concat([encodeTag(fieldNum, 0), encodeVarint(value)]);
}

// ── UnifiedState 信封 ──

interface TopicEntry {
  sentinelKey: string;
  payload: Buffer;
}

function createTopicEntry(sentinelKey: string, payload: Buffer): Buffer {
  const row = encodeStringField(1, payload.toString('base64'));
  const dataEntry = Buffer.concat([encodeStringField(1, sentinelKey), encodeLenDelim(2, row)]);
  return encodeLenDelim(1, dataEntry);
}

function readVarint(buf: Buffer, offset: number): { value: number; next: number } {
  let result = 0;
  let shift = 0;
  let off = offset;
  let b: number;
  do {
    b = buf[off++];
    result += (b & 0x7f) * Math.pow(2, shift);
    shift += 7;
  } while (b & 0x80);
  return { value: result, next: off };
}

function readLenDelim(buf: Buffer, offset: number): { bytes: Buffer; next: number } {
  const { value: len, next } = readVarint(buf, offset);
  return { bytes: buf.subarray(next, next + len), next: next + len };
}

function decodeTopicEntries(blob: Buffer): TopicEntry[] {
  const entries: TopicEntry[] = [];
  let off = 0;
  while (off < blob.length) {
    const tag = readVarint(blob, off);
    if ((tag.value & 7) !== 2) break;
    const field = readLenDelim(blob, tag.next);
    off = field.next;
    const entry = field.bytes;
    // DataEntry: f1 = sentinelKey(string), f2 = Row(f1 = base64 payload string)
    let sentinelKey = '';
    let payloadB64 = '';
    let p = 0;
    while (p < entry.length) {
      const t = readVarint(entry, p);
      p = t.next;
      if ((t.value >> 3) === 1 && (t.value & 7) === 2) {
        const v = readLenDelim(entry, p);
        sentinelKey = v.bytes.toString('utf8');
        p = v.next;
      } else if ((t.value >> 3) === 2 && (t.value & 7) === 2) {
        const v = readLenDelim(entry, p);
        payloadB64 = v.bytes.toString('utf8');
        p = v.next;
      } else {
        break;
      }
    }
    if (sentinelKey) {
      entries.push({ sentinelKey, payload: Buffer.from(payloadB64, 'base64') });
    }
  }
  return entries;
}

function encodeTopicBlob(entries: TopicEntry[]): Buffer {
  return Buffer.concat(entries.map(e => createTopicEntry(e.sentinelKey, e.payload)));
}

function replaceTopicEntry(blob: Buffer, sentinelKey: string, newPayload: Buffer): Buffer {
  const entries = decodeTopicEntries(blob);
  let replaced = false;
  const next: TopicEntry[] = [];
  for (const e of entries) {
    if (e.sentinelKey === sentinelKey) {
      next.push({ sentinelKey, payload: newPayload });
      replaced = true;
    } else {
      next.push(e);
    }
  }
  if (!replaced) next.push({ sentinelKey, payload: newPayload });
  return encodeTopicBlob(next);
}

// ── OAuthInfo / UserStatus payload ──

function createOAuthInfo(token: IdeTokenInfo): Buffer {
  const parts: Buffer[] = [];
  parts.push(encodeStringField(1, token.accessToken));
  parts.push(encodeStringField(2, 'Bearer'));
  if (token.refreshToken) parts.push(encodeStringField(3, token.refreshToken));
  if (typeof token.expiryDateSeconds === 'number' && Number.isFinite(token.expiryDateSeconds)) {
    const timestampMsg = Buffer.concat([
      encodeVarintField(1, Math.round(token.expiryDateSeconds)),
      encodeVarintField(2, 0),
    ]);
    parts.push(encodeLenDelim(4, timestampMsg));
  }
  if (token.idToken) parts.push(encodeStringField(5, token.idToken));
  if (token.isGcpTos) parts.push(encodeVarintField(6, 1));
  return Buffer.concat(parts);
}

/** 最小 UserStatus：身份字段 3 与 7 均为 email（AntigravityManager 同款） */
function createMinimalUserStatus(email: string): Buffer {
  return Buffer.concat([encodeStringField(3, email), encodeStringField(7, email)]);
}

// ── 状态库定位与写入 ──

function resolveIdeStateDbPaths(): string[] {
  const appData = process.env.APPDATA || '';
  const home = process.env.USERPROFILE || process.env.HOME || '';
  const candidates: string[] = [];
  if (appData) {
    candidates.push(path.join(appData, 'Antigravity IDE', 'User', 'globalStorage', 'state.vscdb'));
    candidates.push(path.join(appData, 'Antigravity', 'User', 'globalStorage', 'state.vscdb'));
  }
  if (home) {
    candidates.push(path.join(home, '.antigravity-ide', 'User', 'globalStorage', 'state.vscdb'));
  }
  return candidates;
}

const OAUTH_TOKEN_KEY = 'antigravityUnifiedStateSync.oauthToken';
const USER_STATUS_KEY = 'antigravityUnifiedStateSync.userStatus';
const OAUTH_SENTINEL = 'oauthTokenInfoSentinelKey';
const USER_STATUS_SENTINEL = 'userStatusSentinelKey';

function loadSqlite(): { DatabaseSync: any } | null {
  try {
    // Node 22.13+/23.4+ 内置 node:sqlite（ext host Node 22.21 可用）；@types/node 未收录，动态 require
    const moduleName = 'node:sqlite';
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    return require(moduleName);
  } catch {
    return null;
  }
}

function upsertItem(db: any, key: string, value: string): void {
  db.prepare(
    'INSERT INTO ItemTable (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value'
  ).run(key, value);
}

/**
 * 将指定账号身份写入 IDE 状态库（oauthToken + userStatus）。
 * 失败返回 { dbWritten: false, error }，绝不静默吞掉。
 */
export function switchIdeStateIdentity(email: string, token: IdeTokenInfo): IdeStateSwitchResult {
  const sqlite = loadSqlite();
  if (!sqlite) {
    return { dbWritten: false, dbPath: '', error: 'node:sqlite 不可用（ext host Node 版本过低）' };
  }

  const dbPath = resolveIdeStateDbPaths().find(p => fs.existsSync(p));
  if (!dbPath) {
    return { dbWritten: false, dbPath: '', error: '未找到 IDE 状态库 state.vscdb' };
  }

  let db: any;
  try {
    db = new sqlite.DatabaseSync(dbPath);
    db.exec('PRAGMA busy_timeout = 3000');

    // 校验目标库确实承载 antigravity 状态（防误写别的库）
    const probe = db.prepare(`SELECT value FROM ItemTable WHERE key = '${OAUTH_TOKEN_KEY}'`).get();
    if (!probe || !probe.value) {
      return { dbWritten: false, dbPath, error: '目标库缺少 oauthToken 条目，跳过写入' };
    }

    // 1) oauthToken topic：保留其他条目，替换 oauthTokenInfoSentinelKey
    const blob = Buffer.from(probe.value, 'base64');
    const newBlob = replaceTopicEntry(blob, OAUTH_SENTINEL, createOAuthInfo(token));
    upsertItem(db, OAUTH_TOKEN_KEY, newBlob.toString('base64'));

    // 2) userStatus topic：全量替换为最小身份载荷（与官方登出/登录语义一致）
    const statusEntry = createTopicEntry(USER_STATUS_SENTINEL, createMinimalUserStatus(email));
    const statusB64 = statusEntry.toString('base64');
    upsertItem(db, USER_STATUS_KEY, statusB64);

    // 写入确认：整串读回比对（payload 由本模块构造，字节级一致即写入成功）
    const back = db.prepare(`SELECT value FROM ItemTable WHERE key = '${USER_STATUS_KEY}'`).get();
    if (!back || String(back.value) !== statusB64) {
      throw new Error('身份写入读回校验不一致（IDE 可能占库或写入被覆盖）');
    }
    return { dbWritten: true, dbPath };
  } catch (e) {
    return { dbWritten: false, dbPath, error: e instanceof Error ? e.message : String(e) };
  } finally {
    try { db?.close(); } catch { /* 已关闭 */ }
  }
}
