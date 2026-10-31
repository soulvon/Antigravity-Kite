/**
 * 验证脚本：满额账号也必须产出 4 窗（Claude/Gemini × 5h/Weekly）
 * 旧代码上必失败（旧代码满额账号只有 2 窗 5h）；新代码上必须全绿。
 * 前置: npm run compile 后运行 node tmp/weekly-quota/verify.mjs
 */
import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const { fetchUsage } = require('../../out/usageService');
const fs = require('fs');
const path = require('path');

const accountsPath = path.join(process.env.APPDATA, '.antigravity-kite', 'accounts.json');
const accounts = JSON.parse(fs.readFileSync(accountsPath, 'utf8'));

async function main() {
  let failed = 0;
  for (const email of ['diggingtao@gmail.com', '893234884@qq.com']) {
    const account = accounts.find(a => a.email === email);
    if (!account) { console.error('跳过(无账号):', email); continue; }
    const snap = await fetchUsage(account);
    const ids = snap.models.map(m => m.modelId).sort();
    const expect = ['claude:5h', 'claude:weekly', 'gemini:5h', 'gemini:weekly'];
    const ok = expect.every(id => ids.includes(id));
    const detail = snap.models.map(m => `${m.modelId}=${m.remainingPercent}%(${m.resetTime || '无reset'})`).join(' | ');
    console.log(`${ok ? 'PASS' : 'FAIL'} ${email}: ${detail}${snap.loadError ? ' [loadError=' + snap.loadError + ']' : ''}`);
    if (!ok) failed++;
  }
  if (failed > 0) { console.error(`\n${failed} 个账号未产出完整 4 窗`); process.exit(1); }
  console.log('\n全部通过: 双账号均产出 Claude/Gemini × 5h/Weekly 四窗');
}
main().catch(e => { console.error('验证脚本异常:', e.message); process.exit(1); });
