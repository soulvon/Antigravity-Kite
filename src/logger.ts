/**
 * 阶段日志：把关键链路写入共享目录 kite.log，便于外部取证（不依赖 DevTools）。
 * 覆盖链路：activate → accountStore.init → resolveWebviewView → push(accounts/version) → 收到 webview 消息
 * 日志写失败绝不影响功能，但功能失败必须有日志可查。
 */
import * as fs from 'fs';
import * as path from 'path';
import { getSharedStorageDir } from './storage';

const LOG_NAME = 'kite.log';
const MAX_BYTES = 512 * 1024;

export function getLogFilePath(): string {
  return path.join(getSharedStorageDir(), LOG_NAME);
}

function stringify(value: unknown): string {
  if (typeof value === 'string') return value;
  if (value instanceof Error) return value.stack || value.message;
  try { return JSON.stringify(value); } catch { return String(value); }
}

export function log(level: 'INFO' | 'WARN' | 'ERROR', stage: string, detail?: unknown): void {
  const line = `[${new Date().toISOString()}] [${level}] [${stage}]${detail === undefined ? '' : ' ' + stringify(detail)}`;
  try {
    const file = getLogFilePath();
    try {
      if (fs.statSync(file).size > MAX_BYTES) fs.renameSync(file, file + '.1');
    } catch { /* 文件不存在即无需轮转 */ }
    fs.appendFileSync(file, line + '\n', 'utf8');
  } catch { /* 写日志失败不能影响功能 */ }
  if (level === 'ERROR') console.error(line);
  else console.log(line);
}

export const logInfo = (stage: string, detail?: unknown): void => log('INFO', stage, detail);
export const logWarn = (stage: string, detail?: unknown): void => log('WARN', stage, detail);
export const logError = (stage: string, detail?: unknown): void => log('ERROR', stage, detail);
