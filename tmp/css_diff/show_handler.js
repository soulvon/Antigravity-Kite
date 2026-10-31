// 查看 message handler accounts 分支与 settings 相关运行时代码
const fs = require('fs');
const js = fs.readFileSync('e:/project/Antigravity Kite/tmp/css_diff/webview_script.js', 'utf8');
const lines = js.split('\n');

function show(from, count, label) {
  console.log(`\n=== ${label} ===`);
  for (let k = from; k < Math.min(lines.length, from + count); k++) {
    console.log((k + 1) + ': ' + lines[k]);
  }
}

const iAcc = lines.findIndex(l => l.includes("msg.type === 'accounts'"));
show(Math.max(0, iAcc - 12), 24, 'message handler accounts 分支');

const iSet = lines.findIndex(l => l.includes("type: 'getSettings'") || l.includes("'getSettings'"));
show(Math.max(0, iSet - 6), 14, 'getSettings 发送点');
