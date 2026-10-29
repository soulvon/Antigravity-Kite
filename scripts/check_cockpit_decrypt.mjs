/**
 * Cockpit Tools 加密账号导入 — 检查脚本
 * 构造假数据的加密账号目录，验证 secureAccounts 解密链路；
 * 并断言旧的"明文 email+token"判定在同一文件上必然失败（回归锚点）。
 * 运行：node scripts/test_cockpit_decrypt.mjs （需先 npm run compile）
 */
import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const secure = require('../out/secureAccounts.js');

let passed = 0;
let failed = 0;
function assert(name, cond, extra) {
  if (cond) { passed++; console.log(`  PASS ${name}`); }
  else { failed++; console.error(`  FAIL ${name}${extra ? ' — ' + extra : ''}`); }
}

// ── 构造假数据临时目录 ──
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kite-cockpit-test-'));
const accountsDir = path.join(dataDir, 'accounts');
fs.mkdirSync(accountsDir);

const key = crypto.randomBytes(32);
fs.writeFileSync(path.join(dataDir, secure.SECURE_KEY_FILENAME), key.toString('base64'), 'utf8');

function encryptAccount(account) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const body = Buffer.concat([cipher.update(JSON.stringify(account), 'utf8'), cipher.final()]);
  const boxed = Buffer.concat([body, cipher.getAuthTag()]);
  return {
    version: 1,
    kind: 'antigravity',
    algorithm: 'AES-256-GCM',
    key_id: secure.SECURE_KEY_ID,
    nonce: iv.toString('base64'),
    ciphertext: boxed.toString('base64'),
    encrypted_at: Math.floor(Date.now() / 1000),
  };
}

const fakeAccount = {
  id: 'test-id-1',
  email: 'fake.account@example.com',
  name: '假账号',
  token: {
    access_token: 'fake-access-token',
    refresh_token: 'fake-refresh-token',
    expiry_timestamp: Math.floor(Date.now() / 1000) + 3600,
  },
  disabled: false,
};
const payload = encryptAccount(fakeAccount);
fs.writeFileSync(path.join(accountsDir, 'test-id-1.json'), JSON.stringify(payload), 'utf8');
fs.writeFileSync(path.join(dataDir, 'accounts.json'), JSON.stringify({
  version: 1,
  accounts: [{ id: 'test-id-1', email: fakeAccount.email, name: '假账号' }],
  current_account_id: 'test-id-1',
}), 'utf8');

console.log('[1] 密钥读取');
const loadedKey = secure.readSecureStorageKey(dataDir);
assert('密钥解析为 32 字节', Buffer.isBuffer(loadedKey) && loadedKey.length === 32);

console.log('[2] 加密载荷识别');
assert('isEncryptedPayload 识别加密格式', secure.isEncryptedPayload(payload));
assert('isEncryptedPayload 不误判明文', !secure.isEncryptedPayload(fakeAccount));

console.log('[3] 解密回读');
const decrypted = secure.decryptSecureAccount(payload, loadedKey);
assert('email 一致', decrypted.email === fakeAccount.email);
assert('token.access_token 一致', decrypted.token?.access_token === fakeAccount.token.access_token);
assert('refresh_token 一致', decrypted.token?.refresh_token === fakeAccount.token.refresh_token);

console.log('[4] 失败必须暴露（不许静默）');
const tampered = { ...payload, ciphertext: Buffer.from('tampered-data-!').toString('base64') };
let threw = false;
try { secure.decryptSecureAccount(tampered, loadedKey); } catch { threw = true; }
assert('密文被篡改时解密必须抛错', threw);
threw = false;
try { secure.decryptSecureAccount({ ...payload, algorithm: 'AES-128-CBC' }, loadedKey); } catch { threw = true; }
assert('未知算法必须抛错', threw);
assert('密钥缺失时读取返回 null（未知语义）',
  secure.readSecureStorageKey(path.join(dataDir, 'no-such-dir')) === null);

console.log('[5] 旧实现回归锚点：明文判定在加密文件上必然 0 账号');
const oldLogicAccounts = [payload].filter(d => d.email && d.token);
assert('旧判定（data.email && data.token）在加密文件上失败 → 旧代码 0 账号', oldLogicAccounts.length === 0);

// 清理
fs.rmSync(dataDir, { recursive: true, force: true });

console.log(`\n结果: ${passed} 通过, ${failed} 失败`);
process.exit(failed > 0 ? 1 : 0);
