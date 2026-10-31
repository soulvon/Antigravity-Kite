/**
 * 探针2：实测 v1internal:retrieveUserQuotaSummary（双窗 bucket 数据源）
 * 用法: node tmp/weekly-quota/probe_summary.mjs [email]
 */
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

const accountsPath = path.join(process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming'), '.antigravity-kite', 'accounts.json');
const accounts = JSON.parse(fs.readFileSync(accountsPath, 'utf8'));
const wantEmail = process.argv[2];
const account = wantEmail ? accounts.find(a => a.email === wantEmail) : accounts[0];
if (!account) { console.error('账号不存在:', wantEmail); process.exit(1); }
console.log('探测账号:', account.email);

const CLIENT_ID = '1071006060591-tmhssin2h21lcre235vtolojh4g403ep.apps.googleusercontent.com';
const CLIENT_SECRET = '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';

async function post(url, body, token, headers = {}) {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${text.slice(0, 500)}`);
  return text ? JSON.parse(text) : {};
}

const tokenRes = await post('https://oauth2.googleapis.com/token', {
  client_id: CLIENT_ID, client_secret: CLIENT_SECRET,
  refresh_token: account.refreshToken, grant_type: 'refresh_token',
}, '', {});
const accessToken = tokenRes.access_token;
if (!accessToken) { console.error('刷新 token 失败'); process.exit(1); }

const UA = 'antigravity/2.25.0 (aidev_client; os_type=windows; arch=amd64; cl=1003475615)';

for (const base of ['https://daily-cloudcode-pa.googleapis.com', 'https://cloudcode-pa.googleapis.com']) {
  console.log(`\n===== ${base} : retrieveUserQuotaSummary =====`);
  for (const [label, payload] of [['带project', { project: 'aicode-consumers' }], ['空payload', {}]]) {
    try {
      const data = await post(`${base}/v1internal:retrieveUserQuotaSummary`, payload, accessToken, {
        'User-Agent': UA, 'Accept-Encoding': 'gzip',
      });
      console.log(`--- ${label} ---`);
      console.log(JSON.stringify(data, null, 1));
      break;
    } catch (e) {
      console.error(`${label} 失败:`, e.message.slice(0, 200));
    }
  }
}
