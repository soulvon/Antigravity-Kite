import * as fs from 'fs'; import * as path from 'path'; import * as os from 'os';
const accounts = JSON.parse(fs.readFileSync(path.join(process.env.APPDATA, '.antigravity-kite', 'accounts.json'), 'utf8'));
const account = accounts.find(a => a.email === 'diggingtao@gmail.com');
async function post(url, body, token, headers = {}) {
  const res = await fetch(url, { method: 'POST', headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body) });
  const text = await res.text();
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${text.slice(0, 200)}`);
  return text ? JSON.parse(text) : {};
}
const tokenRes = await post('https://oauth2.googleapis.com/token', { client_id: '1071006060591-tmhssin2h21lcre235vtolojh4g403ep.apps.googleusercontent.com', client_secret: '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', refresh_token: account.refreshToken, grant_type: 'refresh_token' }, '', {});
for (const ua of ['antigravity/1.20.5 windows/amd64', 'antigravity/2.25.0 windows/amd64 google-api-nodejs-client/10.3.0']) {
  try {
    const data = await post('https://daily-cloudcode-pa.googleapis.com/v1internal:retrieveUserQuotaSummary', {}, tokenRes.access_token, { 'User-Agent': ua });
    const buckets = (data.groups || []).flatMap(g => (g.buckets || []).map(b => b.bucketId + '=' + Math.round((b.remainingFraction || 0) * 100) + '%'));
    console.log('UA[' + ua + '] 成功:', buckets.join(', '));
  } catch (e) { console.log('UA[' + ua + '] 失败:', e.message.slice(0, 120)); }
}
