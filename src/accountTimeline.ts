/**
 * 账号激活时间轴追踪器（account-timeline.json）
 *
 * - 在扩展启动及每次成功切号时，仅记录 `{ startSec, email }` 切换切片；
 * - 供 Token 账本将历史 SQLite 步骤时间戳按实际使用区间归属到对应账号；
 * - 早于首次记录时间戳的历史消耗诚实返回 ''（未归属），绝不硬安给当前号。
 */
import * as path from 'path';
import { atomicWriteJsonSync, readJsonFileSafe, withFileLockSync } from './atomicFile';
import { logWarn } from './logger';
import { getSharedStorageDir } from './storage';

const TIMELINE_FILE = 'account-timeline.json';
const MAX_SLICES = 2000;

export interface AccountTimeSlice {
  startSec: number;
  email: string;
}

export interface SwitchEventMarker {
  ts: number; // ms
  email: string;
  fromEmail?: string;
}

interface PersistedTimeline {
  version: 1;
  slices: AccountTimeSlice[];
}

function normalizeEmail(raw: string): string {
  return String(raw || '').trim().toLowerCase();
}

export class AccountTimeline {
  private readonly _filePath: string;
  private _loaded = false;
  private _healthy = true;
  private _slices: AccountTimeSlice[] = [];

  constructor(filePath?: string) {
    this._filePath = filePath ?? path.join(getSharedStorageDir(), TIMELINE_FILE);
  }

  private _ensureLoaded(): void {
    if (this._loaded) return;
    this._loaded = true;
    const res = readJsonFileSafe<unknown>(this._filePath);
    if (res.status === 'ok' && res.data && typeof res.data === 'object') {
      const rawSlices = (res.data as Partial<PersistedTimeline>).slices;
      if (Array.isArray(rawSlices)) {
        const clean: AccountTimeSlice[] = [];
        for (const item of rawSlices) {
          if (!item || typeof item !== 'object') continue;
          const s = item as Partial<AccountTimeSlice>;
          const startSec = Number(s.startSec);
          const email = normalizeEmail(s.email || '');
          if (Number.isFinite(startSec) && startSec > 0 && email) {
            clean.push({ startSec: Math.floor(startSec), email });
          }
        }
        clean.sort((a, b) => a.startSec - b.startSec);
        this._slices = clean.slice(-MAX_SLICES);
        this._healthy = true;
        return;
      }
      this._healthy = false;
      logWarn('accountTimeline.loadInvalid', { file: this._filePath });
      return;
    }
    if (res.status === 'error') {
      this._healthy = false;
      logWarn('accountTimeline.loadFail', { file: this._filePath, error: res.error });
    }
  }

  recordActiveAccount(email: string, nowSec = Math.floor(Date.now() / 1000)): boolean {
    const cleanEmail = normalizeEmail(email);
    const tsSec = Math.floor(Number(nowSec));
    if (!cleanEmail || !Number.isFinite(tsSec) || tsSec <= 0) return false;

    this._ensureLoaded();
    const last = this._slices[this._slices.length - 1];
    if (last && last.email === cleanEmail) return false;

    const entry: AccountTimeSlice = { startSec: tsSec, email: cleanEmail };
    if (last && entry.startSec < last.startSec) {
      entry.startSec = last.startSec;
    }
    this._slices.push(entry);
    if (this._slices.length > MAX_SLICES) {
      this._slices = this._slices.slice(-MAX_SLICES);
    }

    if (this._healthy) {
      try {
        withFileLockSync(this._filePath, () => {
          const disk = readJsonFileSafe<unknown>(this._filePath);
          let merged = this._slices;
          if (disk.status === 'ok' && disk.data && typeof disk.data === 'object') {
            const diskSlices = Array.isArray((disk.data as Partial<PersistedTimeline>).slices)
              ? (disk.data as PersistedTimeline).slices
              : [];
            if (diskSlices.length > 0) {
              const seen = new Set<string>();
              const combined: AccountTimeSlice[] = [];
              for (const s of [...diskSlices, ...this._slices]) {
                if (!s || !s.email || !Number.isFinite(s.startSec)) continue;
                const key = `${Math.floor(s.startSec)}:${normalizeEmail(s.email)}`;
                if (seen.has(key)) continue;
                seen.add(key);
                combined.push({ startSec: Math.floor(s.startSec), email: normalizeEmail(s.email) });
              }
              combined.sort((a, b) => a.startSec - b.startSec);
              // 去重连续同号切片
              const compact: AccountTimeSlice[] = [];
              for (const s of combined) {
                const prev = compact[compact.length - 1];
                if (!prev || prev.email !== s.email) compact.push(s);
              }
              merged = compact.slice(-MAX_SLICES);
              this._slices = merged;
            }
          }
          atomicWriteJsonSync(this._filePath, { version: 1, slices: merged }, 0o600);
        }, 1200);
      } catch (err) {
        logWarn('accountTimeline.saveFail', err instanceof Error ? err.message : String(err));
      }
    }
    return true;
  }

  /** 根据秒级时间戳二分匹配当时激活账号；早于首条记录返回空串 */
  resolveEmailAt(tsSec: number): string {
    if (!Number.isFinite(tsSec) || tsSec <= 0) return '';
    this._ensureLoaded();
    const list = this._slices;
    if (list.length === 0 || tsSec < list[0].startSec) return '';

    let lo = 0;
    let hi = list.length - 1;
    let ans = 0;
    while (lo <= hi) {
      const mid = (lo + hi) >>> 1;
      if (list[mid].startSec <= tsSec) {
        ans = mid;
        lo = mid + 1;
      } else {
        hi = mid - 1;
      }
    }
    return list[ans]?.email || '';
  }

  /** 提取切号事件点，用于配额趋势图叠加竖向事件标线 */
  getSwitchEvents(sinceMs = 0): SwitchEventMarker[] {
    this._ensureLoaded();
    const out: SwitchEventMarker[] = [];
    for (let i = 1; i < this._slices.length; i++) {
      const cur = this._slices[i];
      const prev = this._slices[i - 1];
      if (!cur || !prev || cur.email === prev.email) continue;
      const tsMs = cur.startSec * 1000;
      if (sinceMs > 0 && tsMs < sinceMs) continue;
      out.push({ ts: tsMs, email: cur.email, fromEmail: prev.email });
    }
    return out;
  }

  getSliceCount(): number {
    this._ensureLoaded();
    return this._slices.length;
  }
}

let _sharedTimeline: AccountTimeline | null = null;
let _sharedTimelinePath = '';

export function getAccountTimeline(): AccountTimeline {
  const targetPath = path.join(getSharedStorageDir(), TIMELINE_FILE);
  if (!_sharedTimeline || _sharedTimelinePath !== targetPath) {
    _sharedTimeline = new AccountTimeline(targetPath);
    _sharedTimelinePath = targetPath;
  }
  return _sharedTimeline;
}

