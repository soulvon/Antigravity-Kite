import * as fs from 'fs';
import * as path from 'path';
import * as https from 'https';
import initSqlJs from 'sql.js';
import { StoredAccount } from './types';

const USERINFO_URL = 'https://www.googleapis.com/oauth2/v2/userinfo';
const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const CLIENT_ID = '1071006060591-tmhssin2h21lcre235vtolojh4g403ep.apps.googleusercontent.com';
const CLIENT_SECRET = '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';
const OAUTH_TOKEN_KEY = 'antigravityUnifiedStateSync.oauthToken';
const USER_STATUS_KEY = 'antigravityUnifiedStateSync.userStatus';

// sql.js 单例
let sqlJsInstance: Awaited<ReturnType<typeof initSqlJs>> | null = null;

async function getSqlJs() {
  if (!sqlJsInstance) {
    sqlJsInstance = await initSqlJs();
  }
  return sqlJsInstance;
}

// 用 SQL 读取 state 值
async function readStateValue(dbPath: string, key: string): Promise<string> {
  const SQL = await getSqlJs();
  const fileBuffer = fs.readFileSync(dbPath);
  const db = new SQL.Database(fileBuffer);
  try {
    const result = db.exec(`SELECT value FROM ItemTable WHERE key = '${key.replace(/'/g, "''")}'`);
    if (result.length > 0 && result[0].values.length > 0) {
      return String(result[0].values[0][0]).trim();
    }
    throw new Error('未找到 token');
  } finally {
    db.close();
  }
}

// state.vscdb 路径（仅支持 Antigravity IDE 2.0）
function getStateDbPath(): string {
  const platform = process.platform;
  const home = process.env.HOME || require('os').homedir();
  
  if (platform === 'win32') {
    const appData = process.env.APPDATA || path.join(home, 'AppData', 'Roaming');
    return path.join(appData, 'Antigravity IDE', 'User', 'globalStorage', 'state.vscdb');
  } else if (platform === 'darwin') {
    return path.join(home, 'Library', 'Application Support', 'Antigravity IDE', 'User', 'globalStorage', 'state.vscdb');
  } else {
    return path.join(home, '.config', 'Antigravity IDE', 'User', 'globalStorage', 'state.vscdb');
  }
}

// Protobuf varint 解码
function readVarint(buf: Buffer, offset: number): [number, number] {
  let result = 0, shift = 0, pos = offset;
  while (pos < buf.length) {
    const byte = buf[pos];
    result |= (byte & 0x7f) << shift;
    pos++;
    if ((byte & 0x80) === 0) return [result, pos];
    shift += 7;
  }
  throw new Error('Incomplete varint');
}

// 解析 protobuf 字段
function parseFields(data: Buffer): Array<{ fieldNum: number; wireType: number; value: Buffer | number }> {
  const fields: Array<{ fieldNum: number; wireType: number; value: Buffer | number }> = [];
  let pos = 0;
  while (pos < data.length) {
    try {
      const [tag, newPos] = readVarint(data, pos);
      pos = newPos;
      const fieldNum = tag >> 3;
      const wireType = tag & 0x7;
      if (wireType === 0) {
        const [val, endPos] = readVarint(data, pos);
        fields.push({ fieldNum, wireType, value: val });
        pos = endPos;
      } else if (wireType === 2) {
        const [len, dataPos] = readVarint(data, pos);
        fields.push({ fieldNum, wireType, value: data.subarray(dataPos, dataPos + len) });
        pos = dataPos + len;
      } else break;
    } catch { break; }
  }
  return fields;
}

// 查找指定字段
function findField(data: Buffer, targetField: number): Buffer | undefined {
  let offset = 0;
  while (offset < data.length) {
    try {
      const [tag, newOffset] = readVarint(data, offset);
      const wireType = tag & 7;
      const fieldNum = tag >> 3;
      offset = newOffset;
      
      if (wireType === 2) {
        const [len, contentOffset] = readVarint(data, offset);
        if (fieldNum === targetField) {
          return data.subarray(contentOffset, contentOffset + len);
        }
        offset = contentOffset + len;
      } else if (wireType === 0) {
        const [, endOffset] = readVarint(data, offset);
        offset = endOffset;
      } else {
        break;
      }
    } catch { break; }
  }
  return undefined;
}

// 解析 OAuth token 信息（参考 vscode-antigravity-cockpit）
function parseOAuthTokenInfo(data: Buffer): { accessToken?: string; refreshToken?: string } {
  const result: { accessToken?: string; refreshToken?: string } = {};
  let offset = 0;
  
  while (offset < data.length) {
    try {
      const [tag, newOffset] = readVarint(data, offset);
      const wireType = tag & 7;
      const fieldNum = tag >> 3;
      offset = newOffset;
      
      if (wireType === 2) {
        const [len, contentOffset] = readVarint(data, offset);
        const value = data.subarray(contentOffset, contentOffset + len);
        offset = contentOffset + len;
        
        if (fieldNum === 1) result.accessToken = value.toString('utf8');
        else if (fieldNum === 3) result.refreshToken = value.toString('utf8');
      } else if (wireType === 0) {
        const [, endOffset] = readVarint(data, offset);
        offset = endOffset;
      } else {
        break;
      }
    } catch { break; }
  }
  return result;
}

// 解码统一状态同步条目，返回 sentinel key 和 payload
function decodeUnifiedStateEntry(stateValue: string): { sentinelKey: string; payload: Buffer } | null {
  try {
    const outerRaw = Buffer.from(stateValue.trim(), 'base64');
    
    // 遍历查找包含 sentinel key 的条目
    let offset = 0;
    while (offset < outerRaw.length) {
      const inner = findField(outerRaw.subarray(offset), 1);
      if (!inner) break;
      
      const sentinelKey = findField(inner, 1)?.toString('utf8');
      if (sentinelKey) {
        const inner2 = findField(inner, 2);
        if (inner2) {
          const payloadB64 = findField(inner2, 1)?.toString('utf8');
          if (payloadB64) {
            const payload = Buffer.from(payloadB64.trim(), 'base64');
            return { sentinelKey, payload };
          }
        }
      }
      
      // 移动到下一个字段
      const [tag, newOffset] = readVarint(outerRaw, offset);
      const wireType = tag & 7;
      offset = newOffset;
      if (wireType === 2) {
        const [len, contentOffset] = readVarint(outerRaw, offset);
        offset = contentOffset + len;
      } else break;
    }
  } catch { /* ignore */ }
  return null;
}

// 解析统一格式的 OAuth token（base64 protobuf）
function parseUnifiedOAuthToken(stateValue: string): { accessToken?: string; refreshToken?: string } {
  const entry = decodeUnifiedStateEntry(stateValue);
  if (!entry || entry.sentinelKey !== 'oauthTokenInfoSentinelKey') {
    throw new Error('未找到 oauthTokenInfoSentinelKey');
  }
  return parseOAuthTokenInfo(entry.payload);
}

// 解析 userStatus，提取 email 和 name
// 结构: field 3 = name, field 7 = email
function parseUserStatus(stateValue: string): { email?: string; name?: string } {
  const entry = decodeUnifiedStateEntry(stateValue);
  if (!entry || entry.sentinelKey !== 'userStatusSentinelKey') {
    return {};
  }
  
  const result: { email?: string; name?: string } = {};
  const fields = parseFields(entry.payload);
  
  for (const field of fields) {
    if (field.wireType === 2 && Buffer.isBuffer(field.value)) {
      const str = field.value.toString('utf8');
      if (field.fieldNum === 3 && str) result.name = str;
      if (field.fieldNum === 7 && str && str.includes('@')) result.email = str;
    }
  }
  
  return result;
}

// 从 SQLite 文件读取 token
async function readTokenFromDb(dbPath: string): Promise<{ accessToken?: string; refreshToken?: string }> {
  const stateValue = await readStateValue(dbPath, OAUTH_TOKEN_KEY);
  return parseUnifiedOAuthToken(stateValue);
}

// 从 SQLite 文件读取 userStatus（email 和 name）
async function readUserStatusFromDb(dbPath: string): Promise<{ email?: string; name?: string }> {
  try {
    const stateValue = await readStateValue(dbPath, USER_STATUS_KEY);
    return parseUserStatus(stateValue);
  } catch {
    return {};
  }
}

// 通过 accessToken 获取用户信息
async function getUserInfo(accessToken: string): Promise<{ email?: string; name?: string }> {
  return new Promise((resolve) => {
    const req = https.get(`${USERINFO_URL}?access_token=${accessToken}`, (res) => {
      let body = '';
      res.on('data', chunk => body += chunk);
      res.on('end', () => {
        try {
          const json = JSON.parse(body);
          resolve({ email: json.email, name: json.name });
        } catch { resolve({}); }
      });
    });
    req.on('error', () => resolve({}));
    req.setTimeout(5000, () => { req.destroy(); resolve({}); });
  });
}

// 用 refreshToken 刷新 accessToken
async function refreshAccessToken(refreshToken: string): Promise<string | null> {
  return new Promise((resolve) => {
    const postData = new URLSearchParams({
      client_id: CLIENT_ID,
      client_secret: CLIENT_SECRET,
      refresh_token: refreshToken,
      grant_type: 'refresh_token'
    }).toString();

    const url = new URL(TOKEN_URL);
    const options = {
      hostname: url.hostname,
      path: url.pathname,
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'Content-Length': Buffer.byteLength(postData)
      }
    };

    const req = https.request(options, (res) => {
      let body = '';
      res.on('data', chunk => body += chunk);
      res.on('end', () => {
        try {
          const json = JSON.parse(body);
          resolve(json.access_token || null);
        } catch { resolve(null); }
      });
    });
    req.on('error', () => resolve(null));
    req.setTimeout(10000, () => { req.destroy(); resolve(null); });
    req.write(postData);
    req.end();
  });
}

// 缓存预览的凭证，供确认导入时使用
let pendingCredential: StoredAccount | null = null;

// 预览本地账号（检测是否存在）
// 优先使用 token 获取 email，失败时从 userStatus 读取
export async function previewLocalAccount(existingEmails: string[]): Promise<{ email: string; exists: boolean; tokenExpired?: boolean }> {
  const dbPath = getStateDbPath();
  if (!fs.existsSync(dbPath)) {
    throw new Error('未找到本地登录信息');
  }

  let accessToken: string | undefined;
  let refreshToken: string | undefined;
  let tokenExpired = false;
  
  // 1. 读取 token
  try {
    const tokens = await readTokenFromDb(dbPath);
    accessToken = tokens.accessToken;
    refreshToken = tokens.refreshToken;
  } catch {
    // token 解析失败，继续尝试从 userStatus 获取
  }

  // 2. 先尝试用 accessToken 获取用户信息
  let userInfo: { email?: string; name?: string } = {};
  if (accessToken) {
    userInfo = await getUserInfo(accessToken);
  }
  
  // 3. 如果 accessToken 失效，尝试用 refreshToken 刷新
  if (!userInfo.email && refreshToken) {
    const newAccessToken = await refreshAccessToken(refreshToken);
    if (newAccessToken) {
      accessToken = newAccessToken;
      userInfo = await getUserInfo(newAccessToken);
    } else {
      tokenExpired = true; // refresh token 也失效了
    }
  }

  // 4. 如果 API 调用失败，从 userStatus 读取 email
  if (!userInfo.email) {
    const statusInfo = await readUserStatusFromDb(dbPath);
    if (statusInfo.email) {
      userInfo.email = statusInfo.email;
      userInfo.name = statusInfo.name;
      tokenExpired = true; // 标记 token 失效
    }
  }

  if (!userInfo.email) {
    throw new Error('无法获取用户邮箱（未登录或数据损坏）');
  }

  // 缓存凭证供后续使用
  pendingCredential = {
    email: userInfo.email,
    accessToken: accessToken || '',
    refreshToken,
    name: userInfo.name || userInfo.email.split('@')[0],
    disabled: tokenExpired, // token 失效的账号默认禁用
    importMeta: {
      source: 'local',
      importedAt: new Date().toISOString()
    },
    tag: tokenExpired ? '需要重新授权' : undefined
  };

  const exists = existingEmails.some(e => e.toLowerCase() === userInfo.email!.toLowerCase());
  return { email: userInfo.email, exists, tokenExpired };
}

// 确认导入（使用缓存的凭证）
export function confirmImport(): StoredAccount | null {
  const credential = pendingCredential;
  pendingCredential = null;
  return credential;
}

// 取消导入
export function cancelImport(): void {
  pendingCredential = null;
}
