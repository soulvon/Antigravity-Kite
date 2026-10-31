/**
 * 周限额度探针：实测 fetchAvailableModels 原始响应
 * 用法: node tmp/weekly-quota/probe_quota.mjs [email]
 * 输出: 每个模型的 key/model/displayName/quotaInfo 原始值，不输出 token
 */
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

const accountsPath = path.join(process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming'), '.antigravity-kite', 'accounts.json');
const accounts = JSON.parse(fs.readFileSync(accountsPath, 'utf8'));
const wantEmail = process.argv[2];
const account = wantEmail ? accounts.find(a => a.email === wantEmail) : accounts[0];
if (!account) { console.error('账号不存在:', wantEmail || '(取第一个)'); process.exit(1); }
console.log('探测账号:', account.email);

const CLIENT_ID = '1071006060591-tmhssin2h21lcre235vtolojh4g403ep.apps.googleusercontent.com';
const CLIENT_SECRET = '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';
const UA = 'antigravity/1.20.5 windows/amd64';
const METADATA = {
  ideName: 'antigravity', ideType: 'ANTIGRAVITY', ideVersion: '1.20.5',
  pluginVersion: '1.20.5', platform: 'WINDOWS_AMD64', updateChannel: 'stable', pluginType: 'GEMINI',
};

async function post(url, body, token, extraHeaders = {}) {
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${token}`, 'User-Agent': UA,
      'Content-Type': 'application/json', 'Accept-Encoding': 'gzip, deflate, br', ...extraHeaders,
    },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${text.slice(0, 300)}`);
  return text ? JSON.parse(text) : {};
}

// 1. 刷新 token
const tokenRes = await post('https://oauth2.googleapis.com/token', {
  client_id: CLIENT_ID, client_secret: CLIENT_SECRET,
  refresh_token: account.refreshToken, grant_type: 'refresh_token',
}, '', {});
const accessToken = tokenRes.access_token;
if (!accessToken) { console.error('刷新 token 失败'); process.exit(1); }

// 2. loadCodeAssist 拿 projectId
const lca = await post('https://daily-cloudcode-pa.googleapis.com/v1internal:loadCodeAssist',
  { metadata: METADATA, mode: 'FULL_ELIGIBILITY_CHECK' }, accessToken,
  { 'x-goog-api-client': 'gl-node/22.21.0' });
const proj = lca.cloudaicompanionProject;
const projectId = typeof proj === 'string' ? proj : proj?.id;
console.log('projectId:', projectId, '| paidTier:', lca.paidTier?.id || '(无)');

// 3. fetchAvailableModels（两种 payload 都试：带 project / 不带）
for (const [label, payload] of [['带project', { project: projectId }], ['不带project', {}]]) {
  console.log(`\n===== fetchAvailableModels (${label}) =====`);
  try {
    const models = await post('https://daily-cloudcode-pa.googleapis.com/v1internal:fetchAvailableModels', payload, accessToken);
    const entries = Object.entries(models.models || {});
    console.log('模型总数:', entries.length);
    for (const [key, m] of entries) {
      console.log(JSON.stringify({ key, model: m.model, displayName: m.displayName, quotaInfo: m.quotaInfo }));
    }
  } catch (e) {
    console.error(label, '失败:', e.message);
  }
}
