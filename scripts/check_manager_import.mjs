/**
 * Antigravity Manager 导入链路 — 检查脚本
 * 复用 check_cockpit_decrypt.mjs 的断言骨架（vscode 桩 + 沙盒 USERPROFILE/APPDATA），
 * 验证 importService.importFromAntigravityManager 全链路：
 *   真实本机冒烟（安装后数据目录存在 → 导入源可用）→ 目录缺失 → 明文/加密账号导入
 *   → 去重跳过 → 密钥缺失时加密文件必须逐个暴露为失败（绝不静默伪装成 0 账号）。
 * 运行：node scripts/check_manager_import.mjs （需先 npm run compile）
 */
import Module from 'node:module';
import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

let passed = 0;
let failed = 0;
function assert(name, cond, extra) {
  if (cond) { passed++; console.log(`  PASS ${name}`); }
  else { failed++; console.error(`  FAIL ${name}${extra ? ' — ' + extra : ''}`); }
}

function isWithinIso(iso, targetMs, toleranceMs = 90_000) {
  const parsed = Date.parse(iso);
  return !Number.isNaN(parsed) && Math.abs(parsed - targetMs) <= toleranceMs;
}

// ── vscode 桩（storage/accountStore/importService 顶层 import vscode，必须在首次 require 之前装好）──
const vscodeStub = {
  env: { language: 'zh-CN' },
  workspace: { getConfiguration: () => ({ get: () => 'auto' }) },
  window: { showOpenDialog: async () => undefined },
  commands: { registerCommand: () => ({ dispose() {} }) },
};
const origLoad = Module._load;
Module._load = function (request, parent, isMain) {
  if (request === 'vscode') return vscodeStub;
  return origLoad.apply(this, arguments);
};

// ── [0] 真实本机冒烟：必须在污染环境变量之前执行 ──
console.log('[0] 真实本机冒烟（Antigravity Manager 已安装）');
const importServiceReal = require('../out/importService.js');
const sources = importServiceReal.getAvailableImportSources();
const manager = sources.find(s => s.id === 'antigravity-manager');
assert('导入源列表包含 antigravity-manager', !!manager);
assert('本机 ~/.antigravity_tools 存在 → 导入源可用', manager?.available === true,
  `available=${manager?.available}`);

// ── 沙盒环境：USERPROFILE 管 ~/.antigravity_tools，APPDATA 管 Kite 账号库 ──
const sandboxHome = fs.mkdtempSync(path.join(os.tmpdir(), 'kite-manager-test-'));
process.env.USERPROFILE = sandboxHome;
process.env.APPDATA = path.join(sandboxHome, 'AppData', 'Roaming');
fs.mkdirSync(process.env.APPDATA, { recursive: true });
const sandboxAppData = process.env.APPDATA;

const importService = require('../out/importService.js');
const accountStore = require('../out/accountStore.js');
accountStore.init({ globalStorageUri: { fsPath: path.join(sandboxHome, 'legacy-storage') } });

function writeManagerData(home, { accounts, index, withKey = true, key = null }) {
  const dataDir = path.join(home, '.antigravity_tools');
  fs.mkdirSync(path.join(dataDir, 'accounts'), { recursive: true });
  if (withKey) {
    fs.writeFileSync(path.join(dataDir, 'secure-account-storage.key'),
      (key ?? crypto.randomBytes(32)).toString('base64'), 'utf8');
  }
  for (const { id, body } of accounts) {
    fs.writeFileSync(path.join(dataDir, 'accounts', `${id}.json`),
      typeof body === 'string' ? body : JSON.stringify(body), 'utf8');
  }
  if (index) {
    fs.writeFileSync(path.join(dataDir, 'accounts.json'), JSON.stringify(index), 'utf8');
  }
  return dataDir;
}

function encryptAccount(account) {
  const key = crypto.randomBytes(32);
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const body = Buffer.concat([cipher.update(JSON.stringify(account), 'utf8'), cipher.final()]);
  return {
    key,
    payload: {
      version: 1,
      kind: 'antigravity',
      algorithm: 'AES-256-GCM',
      key_id: 'local-secure-account-storage-v1',
      nonce: iv.toString('base64'),
      ciphertext: Buffer.concat([body, cipher.getAuthTag()]).toString('base64'),
      encrypted_at: Math.floor(Date.now() / 1000),
    },
  };
}

async function expectReject(name, promise, fragments) {
  try {
    await promise;
    assert(name, false, '本应抛错却成功返回');
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    assert(name, fragments.every(f => msg.includes(f)), `实际报错: ${msg}`);
  }
}

async function run() {
  // ── [1] 数据目录缺失 ──
  console.log('[1] 数据目录缺失必须报错');
  await expectReject('目录缺失 → impManagerDirMissing',
    importService.importFromAntigravityManager(),
    ['Antigravity Manager 数据目录不存在']);

  // ── [2] 明文账号导入（无索引 → 目录扫描路径；秒/毫秒 expiry 自适应）──
  console.log('[2] 明文账号导入（目录扫描路径）');
  const secNow = Math.floor(Date.now() / 1000) + 3600;   // 秒
  const msNow = Date.now() + 7_200_000;                   // 毫秒
  writeManagerData(sandboxHome, {
    accounts: [
      { id: 'plain-1', body: { id: 'plain-1', email: 'plain.one@example.com', name: '明文一',
        token: { access_token: 'a1', refresh_token: 'r1', expiry_timestamp: secNow }, disabled: false } },
      { id: 'plain-2', body: { id: 'plain-2', email: 'plain.two@example.com', name: '明文二',
        token: { access_token: 'a2', refresh_token: 'r2', expiry_timestamp: msNow }, disabled: false } },
    ],
  });
  const r1 = await importService.importFromAntigravityManager();
  assert('明文账号导入 2 条', r1.imported === 2 && r1.skipped === 0, JSON.stringify(r1));
  const stored = accountStore.getAll();
  const s1 = stored.find(a => a.email === 'plain.one@example.com');
  const s2 = stored.find(a => a.email === 'plain.two@example.com');
  assert('秒单位 expiry → 正确换算 ISO', !!s1 && isWithinIso(s1.expiresAt, secNow * 1000), s1?.expiresAt);
  assert('毫秒单位 expiry → 不再错误 *1000', !!s2 && isWithinIso(s2.expiresAt, msNow), s2?.expiresAt);
  assert('tag = antigravity-manager / importMeta.source = local',
    stored.every(a => a.tag === 'antigravity-manager' && a.importMeta?.source === 'local'),
    JSON.stringify(stored.map(a => ({ tag: a.tag, src: a.importMeta?.source }))));

  // ── [3] 去重：重导必须跳过，不得重复入库 ──
  console.log('[3] 重导去重');
  const r2 = await importService.importFromAntigravityManager();
  assert('重导全部 skipped', r2.imported === 0 && r2.skipped === 2, JSON.stringify(r2));
  assert('库存仍为 2 条', accountStore.getAll().length === 2);

  // ── [4] 加密账号 + 密钥（有索引 → 索引路径；version 为字符串 "2.0" 与真实格式一致）──
  console.log('[4] 加密账号导入（索引路径）');
  const enc = encryptAccount({ id: 'enc-1', email: 'enc.one@example.com', name: '加密一',
    token: { access_token: 'a3', refresh_token: 'r3', expiry_timestamp: secNow }, disabled: false });
  writeManagerData(sandboxHome, {
    accounts: [{ id: 'enc-1', body: enc.payload }],
    index: { version: '2.0', accounts: [{ id: 'enc-1', email: 'enc.one@example.com', name: '加密一' }], current_account_id: null },
    key: enc.key,
  });
  const r3 = await importService.importFromAntigravityManager();
  assert('加密账号解密并导入 1 条', r3.imported === 1 && r3.skipped === 0, JSON.stringify(r3));
  const s3 = accountStore.getAll().find(a => a.email === 'enc.one@example.com');
  assert('解密后 refreshToken 一致', s3?.refreshToken === 'r3');
  assert('库存共 3 条', accountStore.getAll().length === 3);

  // ── [5] 加密但密钥缺失 → 逐文件暴露失败，绝不静默伪装成 0 账号 ──
  console.log('[5] 密钥缺失时加密文件必须暴露为失败');
  const home2 = fs.mkdtempSync(path.join(os.tmpdir(), 'kite-manager-nokey-'));
  process.env.USERPROFILE = home2;
  process.env.APPDATA = path.join(home2, 'AppData', 'Roaming');
  writeManagerData(home2, { accounts: [{ id: 'locked-1', body: enc.payload }], withKey: false });
  await expectReject('无密钥 → 报错同时点名文件与密钥缺失',
    importService.importFromAntigravityManager(),
    ['没有找到账号', 'locked-1.json', '为加密存储但无法解密（密钥缺失）']);

  // ── [6] 沙盒库存落盘位置正确（APPDATA/.antigravity-kite/accounts.json；注意第一个沙盒的 APPDATA）──
  console.log('[6] 账号库落盘位置');
  const storeFile = path.join(sandboxAppData, '.antigravity-kite', 'accounts.json');
  const onDisk = JSON.parse(fs.readFileSync(storeFile, 'utf8'));
  assert('沙盒库中恰好 3 条', Array.isArray(onDisk) && onDisk.length === 3,
    `实际 ${Array.isArray(onDisk) ? onDisk.length : typeof onDisk}`);
}

try {
  await run();
} finally {
  accountStore.dispose();
}

console.log(`\n结果: ${passed} 通过, ${failed} 失败`);
process.exit(failed > 0 ? 1 : 0);
