/**
 * 原子文件读写与跨进程文件锁原语（零 vscode 依赖）
 *
 * 原则：
 * - 读失败 = 未知（返回 missing / error），绝不伪造为空默认值
 * - 写操作一律走同目录随机临时文件 + renameSync（Windows 退避重试），失败清理临时文件并抛错
 * - 跨进程 read-modify-write 一律经由 wx 排他锁文件序列化，并在 finally 校验锁归属后释放
 */
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';

export type SafeReadResult<T> =
  | { status: 'ok'; data: T; rawBytes: number }
  | { status: 'missing' }
  | { status: 'error'; error: string };

const READ_RETRY_DELAYS_MS = [15, 30, 60, 120] as const;
const RENAME_RETRY_DELAYS_MS = [10, 25, 50, 100, 200] as const;
const RETRYABLE_IO_CODES = new Set(['EPERM', 'EBUSY', 'EACCES']);
const STALE_LOCK_AGE_MS = 10_000;
const activeInProcessLocks = new Map<string, number>();

function normalizeLockKey(filePath: string): string {
  const resolved = path.resolve(filePath);
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}

interface LockRecord {
  pid: number;
  ts: number;
  token: string;
}

function sleepSync(ms: number): void {
  if (ms <= 0) return;
  const sab = new SharedArrayBuffer(4);
  const view = new Int32Array(sab);
  Atomics.wait(view, 0, 0, ms);
}

function getErrnoCode(err: unknown): string {
  if (err && typeof err === 'object' && 'code' in err) {
    return String((err as NodeJS.ErrnoException).code || '');
  }
  return '';
}

function getErrorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function isProcessAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    const code = getErrnoCode(err);
    // ESRCH 表示进程已退出；EPERM 表示进程存活但当前无权限发信号
    return code === 'EPERM';
  }
}

function safeUnlinkTmp(tmpPath: string): void {
  try {
    if (fs.existsSync(tmpPath)) {
      fs.unlinkSync(tmpPath);
    }
  } catch (err) {
    if (getErrnoCode(err) !== 'ENOENT') {
      console.warn(`[atomicFile] Failed to cleanup temp file ${tmpPath}: ${getErrorMessage(err)}`);
    }
  }
}

function readLockMetadata(lockPath: string): { record: Partial<LockRecord> | null; ageMs: number; missing: boolean } {
  try {
    const stat = fs.statSync(lockPath);
    const raw = fs.readFileSync(lockPath, 'utf8').trim();
    let record: Partial<LockRecord> | null = null;
    if (raw) {
      try {
        const parsed = JSON.parse(raw);
        if (parsed && typeof parsed === 'object') {
          record = parsed as Partial<LockRecord>;
        }
      } catch (err) {
        // 锁文件可能尚未写完或已损坏，交由年龄判定兜底破除
        console.warn(`[atomicFile] Lock file parse pending/corrupt (${lockPath}): ${getErrorMessage(err)}`);
      }
    }
    const ts = typeof record?.ts === 'number' && Number.isFinite(record.ts) ? record.ts : stat.mtimeMs;
    return { record, ageMs: Date.now() - ts, missing: false };
  } catch (err) {
    if (getErrnoCode(err) === 'ENOENT') {
      return { record: null, ageMs: 0, missing: true };
    }
    return { record: null, ageMs: 0, missing: false };
  }
}

/**
 * 安全读取并解析 JSON 文件。
 * - ENOENT 返回 { status: 'missing' }
 * - EPERM/EBUSY/EACCES 使用 Atomics.wait 同步短退避重试最多 4 次（15/30/60/120ms）
 * - JSON 解析失败或其他 IO 错误返回 { status: 'error', error }
 */
export function readJsonFileSafe<T = unknown>(filePath: string): SafeReadResult<T> {
  let buf: Buffer | null = null;

  for (let attempt = 0; attempt <= READ_RETRY_DELAYS_MS.length; attempt++) {
    try {
      buf = fs.readFileSync(filePath);
      break;
    } catch (err) {
      const code = getErrnoCode(err);
      if (code === 'ENOENT') {
        return { status: 'missing' };
      }
      if (RETRYABLE_IO_CODES.has(code) && attempt < READ_RETRY_DELAYS_MS.length) {
        sleepSync(READ_RETRY_DELAYS_MS[attempt]);
        continue;
      }
      return { status: 'error', error: `${code || 'READ_ERR'}: ${getErrorMessage(err)}` };
    }
  }

  if (!buf) {
    return { status: 'error', error: 'Unexpected empty buffer after read retries' };
  }

  try {
    let text = buf.toString('utf8');
    if (text.charCodeAt(0) === 0xfeff) {
      text = text.slice(1);
    }
    const data = JSON.parse(text) as T;
    return { status: 'ok', data, rawBytes: buf.length };
  } catch (err) {
    return { status: 'error', error: `JSON_PARSE: ${getErrorMessage(err)}` };
  }
}

/**
 * 带 Windows 瞬时锁（EPERM/EBUSY/EACCES）退避重试的同步原子重命名。
 */
export function renameWithRetrySync(srcPath: string, destPath: string): void {
  let lastErr: unknown;
  for (let attempt = 0; attempt <= RENAME_RETRY_DELAYS_MS.length; attempt++) {
    try {
      fs.renameSync(srcPath, destPath);
      return;
    } catch (err) {
      lastErr = err;
      const code = getErrnoCode(err);
      if (RETRYABLE_IO_CODES.has(code) && attempt < RENAME_RETRY_DELAYS_MS.length) {
        sleepSync(RENAME_RETRY_DELAYS_MS[attempt]);
        continue;
      }
      break;
    }
  }
  throw lastErr;
}

/**
 * 原子写文本文件：同目录写随机临时文件，再 renameSync 替换目标文件（Windows 遇锁重试最多 5 次）。
 */
export function atomicWriteFileSync(filePath: string, content: string, mode = 0o600): void {
  const dir = path.dirname(filePath);
  fs.mkdirSync(dir, { recursive: true });

  const tmpPath = `${filePath}.tmp.${process.pid}.${Date.now()}.${crypto.randomBytes(4).toString('hex')}`;
  try {
    fs.writeFileSync(tmpPath, content, { encoding: 'utf8', mode });
    renameWithRetrySync(tmpPath, filePath);
  } catch (err) {
    safeUnlinkTmp(tmpPath);
    throw err;
  }
}

/**
 * 原子写 JSON 文件（缩进 2 空格，默认权限 0o600）。
 */
export function atomicWriteJsonSync(filePath: string, data: unknown, mode = 0o600): void {
  atomicWriteFileSync(filePath, JSON.stringify(data, null, 2), mode);
}

/**
 * 跨进程 + 同进程可重入文件锁：在 `${filePath}.lock` 上使用 O_CREAT|O_EXCL ('wx') 创建排他锁。
 * - 同进程嵌套调用同一目标路径时直接重入计数，避免等待自身 PID 死锁超时
 * - 遇已存在时检测锁龄 (>10s) 或持有进程已死亡 (ESRCH)，满足其一则破除旧锁重试
 * - finally 校验锁内容归属后仅清理自身持有的锁
 */
export function withFileLockSync<T>(filePath: string, fn: () => T, timeoutMs = 3000): T {
  const lockKey = normalizeLockKey(filePath);
  const currentDepth = activeInProcessLocks.get(lockKey) || 0;
  if (currentDepth > 0) {
    activeInProcessLocks.set(lockKey, currentDepth + 1);
    try {
      return fn();
    } finally {
      activeInProcessLocks.set(lockKey, currentDepth);
    }
  }

  const lockPath = `${filePath}.lock`;
  fs.mkdirSync(path.dirname(filePath), { recursive: true });

  const deadline = Date.now() + Math.max(0, timeoutMs);
  const myRecord: LockRecord = {
    pid: process.pid,
    ts: Date.now(),
    token: crypto.randomBytes(8).toString('hex'),
  };

  let acquired = false;
  while (!acquired) {
    let fd: number | null = null;
    try {
      myRecord.ts = Date.now();
      fd = fs.openSync(lockPath, 'wx', 0o600);
      fs.writeSync(fd, JSON.stringify(myRecord), 0, 'utf8');
      acquired = true;
    } catch (err) {
      const code = getErrnoCode(err);
      if (code === 'EEXIST') {
        const meta = readLockMetadata(lockPath);
        if (meta.missing) {
          continue;
        }
        const holderPid = typeof meta.record?.pid === 'number' ? meta.record.pid : 0;
        const pidDead = holderPid > 0 && !isProcessAlive(holderPid);
        const isStale = meta.ageMs > STALE_LOCK_AGE_MS;

        if (isStale || pidDead) {
          try {
            fs.unlinkSync(lockPath);
            continue;
          } catch (unlinkErr) {
            const unlinkCode = getErrnoCode(unlinkErr);
            if (unlinkCode === 'ENOENT') {
              continue;
            }
            console.warn(`[atomicFile] Failed to break stale lock ${lockPath}: ${getErrorMessage(unlinkErr)}`);
          }
        }
      } else if (!RETRYABLE_IO_CODES.has(code)) {
        throw err;
      }

      const remaining = deadline - Date.now();
      if (remaining <= 0) {
        throw new Error(`Timed out waiting for file lock: ${lockPath} (${code || 'LOCK_BUSY'})`);
      }
      sleepSync(Math.min(25, remaining));
    } finally {
      if (fd !== null) {
        try {
          fs.closeSync(fd);
        } catch (closeErr) {
          console.warn(`[atomicFile] Failed to close lock fd for ${lockPath}: ${getErrorMessage(closeErr)}`);
        }
      }
    }
  }

  activeInProcessLocks.set(lockKey, 1);
  try {
    return fn();
  } finally {
    activeInProcessLocks.delete(lockKey);
    try {
      const currentRaw = fs.readFileSync(lockPath, 'utf8').trim();
      const current = JSON.parse(currentRaw) as Partial<LockRecord>;
      if (current.pid === myRecord.pid && current.token === myRecord.token) {
        fs.unlinkSync(lockPath);
      }
    } catch (err) {
      if (getErrnoCode(err) !== 'ENOENT') {
        console.warn(`[atomicFile] Failed to release lock ${lockPath}: ${getErrorMessage(err)}`);
      }
    }
  }
}
