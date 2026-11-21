// ── AK Webview 加固门控: 防御 CodeBuddy/Antigravity 类宿主的兜底 CSP 拦截 ──
// 背景: 宿主壳页模板自带严格 CSP (script-src 'sha256-固定hash' 'self'),
//       未自声明 CSP 的扩展 webview inline 脚本全灭 (BuddyRelay v1.0.0 事故).
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
let passed = 0, failed = 0;
function gate(name, ok) {
  console.log((ok ? '  PASS  ' : '  FAIL  ') + name);
  ok ? passed++ : failed++;
}

const sidebarHtml = fs.readFileSync(path.join(ROOT, 'resources', 'webview', 'sidebar.html'), 'utf8');
const sidebarProvider = fs.readFileSync(path.join(ROOT, 'src', 'sidebarProvider.ts'), 'utf8');
const lp = fs.readFileSync(path.join(ROOT, 'src', 'logPanelProvider.ts'), 'utf8');
const css = fs.readFileSync(path.join(ROOT, 'resources', 'webview', 'main.css'), 'utf8');

gate(
  'H1 侧栏 CSP: sidebar.html 自声明严格 Nonce Content-Security-Policy',
  /Content-Security-Policy[^>]*script-src 'nonce-\{\{NONCE\}\}'/.test(sidebarHtml)
    && !/script-src[^;"]*unsafe-inline/.test(sidebarHtml)
);
gate(
  'H1 侧栏 CSP: sidebarProvider.ts 注入 webview.cspSource 与随机 nonce',
  sidebarHtml.includes('{{CSP_SOURCE}}')
    && sidebarProvider.includes("split('{{CSP_SOURCE}}').join(webview.cspSource)")
    && sidebarProvider.includes("split('{{NONCE}}').join(nonce)")
);
gate(
  'H1 统计面板 CSP: buildHtml 自声明严格 Nonce CSP + cspSource 参数',
  /Content-Security-Policy[^`]*script-src 'nonce-\$\{nonce\}'/.test(lp)
    && !/script-src[^;"]*unsafe-inline/.test(lp)
    && lp.includes('cspSource: string')
    && lp.includes('${cspSource}')
);
gate('H2 flex 塌陷: modal-body 使用 flex-basis auto (纵向容器禁 0)', /\.modal-body\s*\{[^}]*flex:\s*1\s+1\s+auto/.test(css));
gate('H2 flex 塌陷: 无纵向容器 flex-basis 0 残留 (排除横向等宽按钮组)', !/\.modal-body\s*\{[^}]*flex:\s*1\s+1\s+0/.test(css));
gate('H3 打包卫生: .vscodeignore 排除 tmp/', fs.readFileSync(path.join(ROOT, '.vscodeignore'), 'utf8').includes('tmp/**'));

// ── H4 搜索框无内阴影/灰底污染（跨状态 CSS 特异性守卫） ──
function stripCssComments(text) {
  return text.replace(/\/\*[\s\S]*?\*\//g, '');
}
function splitTopLevelRules(text) {
  const rules = [];
  let i = 0;
  const n = text.length;
  while (i < n) {
    while (i < n && /\s/.test(text[i])) i++;
    if (i >= n) break;
    if (text[i] === '@') {
      const start = i;
      while (i < n && text[i] !== '{' && text[i] !== ';') i++;
      if (text[i] === ';') { i++; continue; }
      const header = text.slice(start, i).trim();
      i++;
      let depth = 1;
      const bodyStart = i;
      while (i < n && depth > 0) {
        if (text[i] === '{') depth++;
        else if (text[i] === '}') depth--;
        i++;
      }
      const body = text.slice(bodyStart, i - 1);
      if (/^@media\b/i.test(header)) {
        rules.push(...splitTopLevelRules(body));
      }
      continue;
    }
    const selStart = i;
    while (i < n && text[i] !== '{') i++;
    if (i >= n) break;
    const selText = text.slice(selStart, i).trim();
    i++;
    const bodyStart = i;
    let depth = 1;
    while (i < n && depth > 0) {
      if (text[i] === '{') depth++;
      else if (text[i] === '}') depth--;
      i++;
    }
    const declText = text.slice(bodyStart, i - 1);
    rules.push({ selectors: selText, decls: declText });
  }
  return rules;
}
function calcSpecificity(sel) {
  // 简化但精确处理 :not(...) 内参数权重、ID、类/属性/伪类、元素名
  let a = 0, b = 0, c = 0;
  let cleaned = sel.replace(/::[a-zA-Z-]+/g, () => { c++; return ''; });
  cleaned = cleaned.replace(/:not\(([^()]+)\)/g, (_, inner) => {
    const [ia, ib, ic] = calcSpecificity(inner);
    a += ia; b += ib; c += ic;
    return '';
  });
  cleaned = cleaned.replace(/#[a-zA-Z_-][a-zA-Z0-9_-]*/g, () => { a++; return ''; });
  cleaned = cleaned.replace(/\[[^\]]+\]/g, () => { b++; return ''; });
  cleaned = cleaned.replace(/\.[a-zA-Z_-][a-zA-Z0-9_-]*/g, () => { b++; return ''; });
  cleaned = cleaned.replace(/:[a-zA-Z-]+(\([^)]*\))?/g, () => { b++; return ''; });
  cleaned = cleaned.replace(/\b[a-zA-Z][a-zA-Z0-9-]*\b/g, () => { c++; return ''; });
  return [a, b, c];
}
function cmpSpec(s1, s2) {
  for (let k = 0; k < 3; k++) {
    if (s1[k] !== s2[k]) return s1[k] - s2[k];
  }
  return 0;
}
function matchesSearchInput(sel, targetState) {
  if (/::/.test(sel)) return false;
  const parts = sel.trim().split(/\s*(?:>|~|\+|\s)\s*/);
  const subject = parts[parts.length - 1] || '';
  const notBlocks = [...subject.matchAll(/:not\(([^()]+)\)/g)].map((m) => m[1]);
  if (notBlocks.some((b) => /\.search-input|#searchInput/.test(b))) return false;
  const subjectWithoutNot = subject.replace(/:not\([^()]+\)/g, '');
  if (!/(?:^|\b)input(?=\b|[:.\[#]|$)|\.search-input|#searchInput/.test(subjectWithoutNot)) return false;
  const selWithoutNot = sel.replace(/:not\([^()]+\)/g, '');
  if (/(?:select|button|\[type="(?:checkbox|radio|hidden|number)"\]|\.v2-|\.modal-body|\.as-switch|\.grid-check|#tagEditInput)/i.test(selWithoutNot)) return false;
  const ancestors = parts.slice(0, -1).join(' ');
  if (ancestors && !/^(?:html|body(?:\.vscode-[a-z-]+)?|#tabAccounts|\.app|\.list-body|\.search-bar|\s)*$/.test(ancestors)) {
    return false;
  }
  const states = subjectWithoutNot.match(/:(hover|focus-visible|focus|active)\b/g) || [];
  if (states.length === 0) return true;
  return states.every((st) => st.slice(1) === targetState);
}
function parseDeclMap(declText) {
  const out = {};
  for (const item of declText.split(';')) {
    const idx = item.indexOf(':');
    if (idx <= 0) continue;
    const prop = item.slice(0, idx).trim().toLowerCase();
    const rawVal = item.slice(idx + 1).trim();
    const imp = /!important\s*$/i.test(rawVal);
    const val = rawVal.replace(/!important\s*$/i, '').trim();
    out[prop] = { val, imp };
  }
  return out;
}

const parsedRules = splitTopLevelRules(stripCssComments(css));
const statesToCheck = ['base', 'hover', 'focus', 'focus-visible'];
const searchInputResults = {};
for (const st of statesToCheck) {
  const winners = {};
  parsedRules.forEach((rule, order) => {
    const decls = parseDeclMap(rule.decls);
    const relevantProps = ['background', 'background-color', 'background-image', 'box-shadow'].filter((p) => p in decls);
    if (relevantProps.length === 0) return;
    for (const rawSel of rule.selectors.split(',')) {
      const sel = rawSel.trim();
      if (!sel || !matchesSearchInput(sel, st)) continue;
      const spec = calcSpecificity(sel);
      for (const prop of relevantProps) {
        const cur = decls[prop];
        // background 简写与 background-color 共用有效背景颜色槽，在 CSS 中后赢/高权重者覆盖
        const slot = prop === 'background' ? 'background-color' : prop;
        const cand = { imp: cur.imp ? 1 : 0, spec, order, val: cur.val, sel };
        const prev = winners[slot];
        const better = !prev
          || cand.imp > prev.imp
          || (cand.imp === prev.imp && (cmpSpec(cand.spec, prev.spec) > 0 || (cmpSpec(cand.spec, prev.spec) === 0 && cand.order >= prev.order)));
        if (better) winners[slot] = cand;
      }
    }
  });
  const bgVal = (winners['background-color'] || {}).val || 'transparent';
  const bgImgVal = (winners['background-image'] || {}).val || 'none';
  const shVal = (winners['box-shadow'] || {}).val || 'none';
  searchInputResults[st] = {
    ok: bgVal === 'transparent' && bgImgVal === 'none' && shVal === 'none',
    bg: bgVal,
    bgSource: (winners['background-color'] || {}).sel,
    shadow: shVal,
  };
}
const allSearchStatesClean = statesToCheck.every((st) => searchInputResults[st].ok);
gate(
  'H4 搜索框内部输入 (#searchInput) 在常态与 :hover/:focus/:focus-visible 下均保持透明零阴影（无高权重通用 input 污染）',
  allSearchStatesClean,
);
if (!allSearchStatesClean) {
  console.log('        详情:', JSON.stringify(searchInputResults));
}

const searchBarHasShadowRule = parsedRules.some((r) =>
  r.selectors.split(',').some((s) => /\.search-bar\b/.test(s) && !/:focus-within/.test(s))
  && (() => {
    const d = parseDeclMap(r.decls);
    return d['box-shadow'] && d['box-shadow'].val !== 'none';
  })()
);
gate('H4.2 搜索栏外容器 (.search-bar 非聚焦态) 无多余 box-shadow 规则残留', !searchBarHasShadowRule);

console.log(`\n加固门控结果: ${passed} 通过, ${failed} 失败`);
process.exit(failed > 0 ? 1 : 0);
