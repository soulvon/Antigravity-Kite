/**
 * Cockpit Tools / Antigravity Manager 外部加密账号存储的解密支持
 *
 * 注意：本模块专用于导入阶段读取外部工具（Cockpit Tools / Antigravity Manager）的加密账号文件，
 * 与 Kite 自身 accounts.json 的磁盘静态加密（src/accountCrypto.ts）相互独立。
 *
 * Cockpit Tools / Manager 账号加密格式：
 *   { version, kind, algorithm: 'AES-256-GCM', key_id, nonce, ciphertext, encrypted_at }
 * 密钥存放在其数据目录下的 secure-account-storage.key（base64 文本，32 字节 AES-256 密钥）。
 * ciphertext = base64(body || GCM authTag(16B))，nonce = base64(12B IV)。
 * 解密后的明文即账号 JSON：{ id, email, name, token: {...}, disabled, ... }
 */
import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import { t } from './i18n';

export const SECURE_KEY_FILENAME = 'secure-account-storage.key';
export const SECURE_KEY_ID = 'local-secure-account-storage-v1';

export interface EncryptedPayload {
  version?: number;
  kind?: string;
  algorithm?: string;
  key_id?: string;
  nonce?: string;
  ciphertext?: string;
  encrypted_at?: number;
}

/** 读取并解码本机密钥；读失败返回 null（语义=未知，由调用方决定如何暴露） */
export function readSecureStorageKey(dataDir: string): Buffer | null {
  const keyPath = path.join(dataDir, SECURE_KEY_FILENAME);
  let raw: string;
  try {
    raw = fs.readFileSync(keyPath, 'utf8').trim();
  } catch (err) {
    // 密钥缺失（ENOENT）或不可读时按「未知」返回 null，由上层导入流程按加密文件逐一报错
    const code = (err as NodeJS.ErrnoException)?.code;
    if (code && code !== 'ENOENT') {
      console.warn(`[secureAccounts] Failed to read key file ${keyPath}:`, err instanceof Error ? err.message : String(err));
    }
    return null;
  }
  try {
    const key = Buffer.from(raw, 'base64');
    return key.length === 32 ? key : null;
  } catch (err) {
    console.warn(`[secureAccounts] Invalid base64 key in ${keyPath}:`, err instanceof Error ? err.message : String(err));
    return null;
  }
}

export function isEncryptedPayload(data: unknown): data is EncryptedPayload {
  if (!data || typeof data !== 'object') return false;
  const d = data as Record<string, unknown>;
  return typeof d.ciphertext === 'string' && typeof d.nonce === 'string';
}

/**
 * 解密单个加密账号文件，返回明文 JSON 对象。
 * 失败抛错（含原因），调用方负责逐文件收集暴露，绝不静默吞掉。
 */
export function decryptSecureAccount(data: EncryptedPayload, key: Buffer): Record<string, unknown> {
  if (data.algorithm && data.algorithm !== 'AES-256-GCM') {
    throw new Error(t('secureBadAlgorithm', data.algorithm));
  }
  if (data.key_id && data.key_id !== SECURE_KEY_ID) {
    throw new Error(t('secureUnknownKeyId', data.key_id));
  }
  const iv = Buffer.from(data.nonce || '', 'base64');
  const boxed = Buffer.from(data.ciphertext || '', 'base64');
  if (iv.length < 8 || boxed.length <= 16) {
    throw new Error(t('errCredLength'));
  }
  const tag = boxed.subarray(boxed.length - 16);
  const body = boxed.subarray(0, boxed.length - 16);
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(tag);
  const out = Buffer.concat([decipher.update(body), decipher.final()]);
  return JSON.parse(out.toString('utf8'));
}
