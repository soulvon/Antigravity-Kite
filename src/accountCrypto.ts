/**
 * 账号凭据磁盘静态加密（AES-256-GCM，零 vscode 依赖）
 *
 * 格式：enc:v1:<iv_b64>:<tag_b64>:<cipher_b64>
 * 密钥存放在 master.key（32 字节 base64，0o600），可通过 KITE_MASTER_KEY_FILE 或 dirOverride 指定。
 */
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import type { StoredAccount } from './types';
import { getSharedStorageDir } from './storage';
import { atomicWriteFileSync, withFileLockSync } from './atomicFile';

export const ENC_PREFIX = 'enc:v1:';

const KEY_FILENAME = 'master.key';
const KEY_BYTES = 32;
const IV_BYTES = 12;
const TAG_BYTES = 16;

function resolveMasterKeyPath(dirOverride?: string): string {
  const envKeyFile = process.env.KITE_MASTER_KEY_FILE?.trim();
  if (envKeyFile) {
    return envKeyFile;
  }
  return path.join(dirOverride || getSharedStorageDir(), KEY_FILENAME);
}

function parseMasterKeyFile(keyPath: string): Buffer {
  const raw = fs.readFileSync(keyPath, 'utf8').trim();
  const key = Buffer.from(raw, 'base64');
  if (key.length !== KEY_BYTES) {
    throw new Error(`Invalid master key length (${key.length} bytes) at ${keyPath}`);
  }
  return key;
}

function readExistingMasterKey(dirOverride?: string): Buffer {
  const keyPath = resolveMasterKeyPath(dirOverride);
  if (!fs.existsSync(keyPath)) {
    throw new Error(`Master key file not found: ${keyPath}`);
  }
  return parseMasterKeyFile(keyPath);
}

function getOrCreateMasterKey(dirOverride?: string): Buffer {
  const keyPath = resolveMasterKeyPath(dirOverride);
  if (fs.existsSync(keyPath)) {
    return parseMasterKeyFile(keyPath);
  }
  return withFileLockSync(keyPath, () => {
    if (fs.existsSync(keyPath)) {
      return parseMasterKeyFile(keyPath);
    }
    const key = crypto.randomBytes(KEY_BYTES);
    atomicWriteFileSync(keyPath, key.toString('base64'), 0o600);
    return key;
  });
}

function encryptWithKey(plain: string, key: Buffer): string {
  if (!plain) return '';
  if (plain.startsWith(ENC_PREFIX)) return plain;

  const iv = crypto.randomBytes(IV_BYTES);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const encrypted = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `${ENC_PREFIX}${iv.toString('base64')}:${tag.toString('base64')}:${encrypted.toString('base64')}`;
}

function decryptWithKey(value: string, key: Buffer): string {
  if (!value) return '';
  if (!value.startsWith(ENC_PREFIX)) return value;

  const payload = value.slice(ENC_PREFIX.length);
  const parts = payload.split(':');
  if (parts.length !== 3 || !parts[0] || !parts[1]) {
    throw new Error('Malformed encrypted credential payload');
  }

  const iv = Buffer.from(parts[0], 'base64');
  const tag = Buffer.from(parts[1], 'base64');
  const cipherBuf = Buffer.from(parts[2], 'base64');

  if (iv.length !== IV_BYTES || tag.length !== TAG_BYTES) {
    throw new Error('Invalid encrypted credential IV or auth tag length');
  }

  const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(tag);
  const plainBuf = Buffer.concat([decipher.update(cipherBuf), decipher.final()]);
  return plainBuf.toString('utf8');
}

/**
 * 加密单个敏感凭据字符串。空串返回 ''，已含 enc:v1: 前缀原样返回。
 */
export function encryptSecret(plain: string, dirOverride?: string): string {
  if (!plain) return '';
  if (plain.startsWith(ENC_PREFIX)) return plain;
  const key = getOrCreateMasterKey(dirOverride);
  return encryptWithKey(plain, key);
}

/**
 * 解密单个凭据字符串。空串返回 ''，无 enc:v1: 前缀视为明文原样返回；
 * 含加密前缀时解密失败必须抛错，绝不静默返回空串或密文。
 */
export function decryptSecret(value: string, dirOverride?: string): string {
  if (!value) return '';
  if (!value.startsWith(ENC_PREFIX)) return value;
  const key = readExistingMasterKey(dirOverride);
  return decryptWithKey(value, key);
}

/**
 * 将账号对象转换为磁盘持久化形态：剥离运行时 usage，加密 accessToken/refreshToken/idToken。
 */
export function encryptAccountForDisk(acc: StoredAccount, dirOverride?: string): StoredAccount {
  const { usage: _usage, ...rest } = acc;
  const out: StoredAccount = { ...rest };

  const needsEncryption =
    (typeof out.accessToken === 'string' && out.accessToken.length > 0 && !out.accessToken.startsWith(ENC_PREFIX)) ||
    (typeof out.refreshToken === 'string' && out.refreshToken.length > 0 && !out.refreshToken.startsWith(ENC_PREFIX)) ||
    (typeof out.idToken === 'string' && out.idToken.length > 0 && !out.idToken.startsWith(ENC_PREFIX));

  if (!needsEncryption) {
    return out;
  }

  const key = getOrCreateMasterKey(dirOverride);
  if (typeof out.accessToken === 'string' && out.accessToken.length > 0) {
    out.accessToken = encryptWithKey(out.accessToken, key);
  }
  if (typeof out.refreshToken === 'string' && out.refreshToken.length > 0) {
    out.refreshToken = encryptWithKey(out.refreshToken, key);
  }
  if (typeof out.idToken === 'string' && out.idToken.length > 0) {
    out.idToken = encryptWithKey(out.idToken, key);
  }
  return out;
}

/**
 * 从磁盘记录还原内存可用账号对象，并标记是否包含任意非空未加密明文凭据（供平滑迁移触发备份与重写）。
 */
export function decryptAccountFromDisk(
  raw: StoredAccount,
  dirOverride?: string,
): { account: StoredAccount; wasPlaintext: boolean } {
  const fields: Array<'accessToken' | 'refreshToken' | 'idToken'> = ['accessToken', 'refreshToken', 'idToken'];
  let wasPlaintext = false;
  let hasEncrypted = false;

  for (const field of fields) {
    const val = raw[field];
    if (typeof val === 'string' && val.length > 0) {
      if (val.startsWith(ENC_PREFIX)) {
        hasEncrypted = true;
      } else {
        wasPlaintext = true;
      }
    }
  }

  const account: StoredAccount = { ...raw };
  if (hasEncrypted) {
    const key = readExistingMasterKey(dirOverride);
    for (const field of fields) {
      const val = account[field];
      if (typeof val === 'string' && val.startsWith(ENC_PREFIX)) {
        account[field] = decryptWithKey(val, key);
      }
    }
  }

  return { account, wasPlaintext };
}
