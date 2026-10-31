// 覆盖检查：Kite HTML 用到的每个 class 能否在 final.css 中找到定义
const fs = require('fs');

const css = fs.readFileSync('e:/project/Antigravity Kite/tmp/css_diff/final.css', 'utf8');
const html = fs.readFileSync('e:/project/Antigravity Kite/src/extension.ts', 'utf8');

// 提取 class="..."
const classes = new Set();
for (const m of html.matchAll(/class="([^"]*)"/g)) {
  m[1].split(/\s+/).forEach(c => { if (c && /^[a-zA-Z_-][\w-]*$/.test(c)) classes.add(c); });
}
// 提取 class='...'
for (const m of html.matchAll(/class='([^']*)'/g)) {
  m[1].split(/\s+/).forEach(c => { if (c && /^[a-zA-Z_-][\w-]*$/.test(c)) classes.add(c); });
}
// 模板拼接里的 class 片段（closest('.grid-card') / classList 等动态类）
for (const m of html.matchAll(/(?:closest|querySelectorAll?)\(['"]\.([\w-]+)/g)) classes.add(m[1]);
for (const m of html.matchAll(/classList\.(?:add|toggle|remove)\(['"]([\w-]+)/g)) classes.add(m[1]);

const cssClassRe = (c) => new RegExp('\\.' + c.replace(/[-]/g, '\\-') + '(?![\\w-])');
const missing = [...classes].filter(c => !cssClassRe(c).test(css)).sort();

console.log('HTML 使用的 class 数:', classes.size);
console.log('在 final.css 中无定义的:', missing.length);
missing.forEach(m => console.log('  ✗ .' + m));
