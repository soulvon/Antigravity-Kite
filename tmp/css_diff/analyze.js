// 对比 Antigravity Kite 与 BuddyRelay 的 CSS 选择器 / HTML 类名覆盖关系
const fs = require('fs');

const KITE_ROOT = 'e:/project/Antigravity Kite';
const RELAY_ROOT = 'E:/project/BuddyRelay';

function read(p) { return fs.readFileSync(p, 'utf8'); }

// 从 CSS 里提取 class 名 (只取 .foo 形式，忽略 .5 这种数字)
function cssClasses(css) {
  const set = new Set();
  const re = /\.(-?[_a-zA-Z][\w-]*)/g;
  let m;
  while ((m = re.exec(css))) set.add(m[1]);
  return set;
}

// 从 CSS 里提取 id 选择器
function cssIds(css) {
  const set = new Set();
  const re = /#(-?[_a-zA-Z][\w-]*)/g;
  let m;
  while ((m = re.exec(css))) set.add(m[1]);
  return set;
}

// 从 HTML/TS 模板字符串里提取 class="..." 中的类名
function htmlClasses(src) {
  const set = new Set();
  const re = /class="([^"$`]*)"/g;
  let m;
  while ((m = re.exec(src))) {
    m[1].split(/\s+/).forEach(c => { if (c) set.add(c); });
  }
  // 也抓 class='...' 与 class=\`...\` 简单形式
  const re2 = /class='([^'$`]*)'/g;
  while ((m = re2.exec(src))) {
    m[1].split(/\s+/).forEach(c => { if (c) set.add(c); });
  }
  return set;
}

function htmlIds(src) {
  const set = new Set();
  const re = /\sid="([^"$`]*?)"/g;
  let m;
  while ((m = re.exec(src))) set.add(m[1]);
  return set;
}

const kiteCss = read(`${KITE_ROOT}/resources/webview/main.css`);
const relayCss = read(`${RELAY_ROOT}/resources/webview/main.css`);
const kiteHtml = read(`${KITE_ROOT}/src/extension.ts`);
const relayHtml = read(`${RELAY_ROOT}/resources/webview/sidebar.html`);

const kc = cssClasses(kiteCss), rc = cssClasses(relayCss);
const kid = cssIds(kiteCss), rid = cssIds(relayCss);
const kh = htmlClasses(kiteHtml), rh = htmlClasses(relayHtml);
const khi = htmlIds(kiteHtml), rhi = htmlIds(relayHtml);

const sort = s => [...s].sort();

console.log('=== 规模 ===');
console.log('Kite  main.css 行数:', kiteCss.split('\n').length, '字节:', kiteCss.length);
console.log('Relay main.css 行数:', relayCss.split('\n').length, '字节:', relayCss.length);
console.log('Kite  CSS class 数:', kc.size, '| Relay CSS class 数:', rc.size);
console.log('Kite  HTML class 数:', kh.size, '| Relay HTML class 数:', rh.size);

console.log('\n=== 1. Kite HTML 用到但 Kite CSS 没定义的 class（真·裸奔） ===');
console.log(sort([...kh].filter(c => !kc.has(c))).join('\n') || '(无)');

console.log('\n=== 2. Kite HTML 用到，Relay CSS 有定义（迁移后可复用） ===');
console.log(sort([...kh].filter(c => rc.has(c))).join('\n') || '(无)');

console.log('\n=== 3. Kite HTML 用到，Relay CSS 没有定义（迁移后必须补） ===');
console.log(sort([...kh].filter(c => !rc.has(c))).join('\n') || '(无)');

console.log('\n=== 4. Relay CSS 有、Kite CSS 没有的 class（说明 Kite 缺哪些体系） ===');
const onlyRelay = sort([...rc].filter(c => !kc.has(c)));
console.log('共', onlyRelay.length, '个：');
console.log(onlyRelay.join('\n'));

console.log('\n=== 5. ID 选择器：Relay 用了哪些 ID，Kite HTML 是否存在 ===');
const relayIdList = sort(rid);
for (const id of relayIdList) {
  console.log(`  #${id}  -> Kite HTML ${khi.has(id) ? '有' : '【缺】'}`);
}

console.log('\n=== 6. Kite CSS 里出现但 Kite HTML 当前没用到的 class（死代码候选，前80个） ===');
const dead = sort([...kc].filter(c => !kh.has(c)));
console.log('共', dead.length, '个');
console.log(dead.slice(0, 80).join('\n'));
