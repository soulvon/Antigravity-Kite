/**
 * Enhancement Injector — 向 Antigravity IDE 的 workbench.html 注入增强功能
 * 支持: LaTeX 渲染、气泡选项、界面汉化
 */
import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';

// ===== 注入标记 =====
const INJECT_START = '<!-- [KITE-ENHANCEMENT-START] -->';
const INJECT_END = '<!-- [KITE-ENHANCEMENT-END] -->';

export interface EnhancementSettings {
  latexEnabled: boolean;
  bubblesEnabled: boolean;
  bubblesAutoSend: boolean;
  bubblesTheme: string;
  bubblesShape: string;
  localizationEnabled: boolean;
  autoAcceptEnabled: boolean;
  autoAcceptPatterns: { [key: string]: boolean };
  autoAcceptRemaining: number;
  autoAcceptUnlimited: boolean;
  bannedCommands: string[];
  autoAcceptStats: { clicks: number; blocked: number; verified: number };
  autoRetryEnabled: boolean;
  autoRetryMaxAttempts: number;
  autoRetryDelay: number;
}

export const DEFAULT_SETTINGS: EnhancementSettings = {
  latexEnabled: true,
  bubblesEnabled: true,
  bubblesAutoSend: true,
  bubblesTheme: 'emerald',
  bubblesShape: 'rounded',
  localizationEnabled: true,
  autoAcceptEnabled: true,
  autoAcceptPatterns: {
    'accept': false,
    'accept all': true,
    'always allow': true,
    'allow this conversation': true,
    'retry': true,
    'run': true,
    'apply': true,
    'execute': true,
    'confirm': true,
    'allow': true,
    'continue': true,
    'continue response': true,
  },
  autoAcceptRemaining: 30,
  autoAcceptUnlimited: true,
  bannedCommands: ['rm -rf /', 'rm -rf ~', 'rm -rf *', 'format c:', 'del /f /s /q', 'rmdir /s /q', ':(){:|:&};:', 'dd if=', 'mkfs.', '> /dev/sda', 'chmod -R 777 /'],
  autoAcceptStats: { clicks: 0, blocked: 0, verified: 0 },
  autoRetryEnabled: true,
  autoRetryMaxAttempts: 5,
  autoRetryDelay: 3,
};

/** 解析 IDE 主目录到 resources/app 目录，支持 Win/Mac/Linux */
export function resolveAppRoot(customPath?: string): string {
  if (!customPath) {
    return vscode.env.appRoot;
  }

  const cleanPath = customPath.trim().replace(/^["']|["']$/g, '');
  if (!cleanPath) {
    return vscode.env.appRoot;
  }

  // 1. 如果路径本身就是 app 目录 (例如 /resources/app)
  if (fs.existsSync(path.join(cleanPath, 'out', 'vs', 'code'))) {
    return cleanPath;
  }

  // 2. macOS: .app 目录
  const macAppPath = path.join(cleanPath, 'Contents', 'Resources', 'app');
  if (fs.existsSync(path.join(macAppPath, 'out', 'vs', 'code'))) {
    return macAppPath;
  }

  // 3. Windows & Linux: 安装目录/resources/app
  const winLinuxAppPath = path.join(cleanPath, 'resources', 'app');
  if (fs.existsSync(path.join(winLinuxAppPath, 'out', 'vs', 'code'))) {
    return winLinuxAppPath;
  }

  return cleanPath;
}

/** 获取所有需要注入的 workbench HTML（主窗口 + jetski 智能体 webview 等） */
export function getWorkbenchHtmlPaths(customPath?: string): string[] {
  const appRoot = resolveAppRoot(customPath); // e.g. F:\Program\Antigravity IDE\resources\app
  const dirs = [
    path.join(appRoot, 'out', 'vs', 'code', 'electron-sandbox', 'workbench'),
    path.join(appRoot, 'out', 'vs', 'code', 'electron-browser', 'workbench'),
  ];
  const results: string[] = [];
  for (const dir of dirs) {
    if (!fs.existsSync(dir)) continue;
    let entries: string[] = [];
    try { entries = fs.readdirSync(dir); } catch { continue; }
    for (const name of entries) {
      // 匹配 workbench.html / workbench-jetski-agent.html 等
      if (/^workbench.*\.html$/i.test(name)) results.push(path.join(dir, name));
    }
  }
  return results;
}

/** 兼容旧调用：返回主 workbench.html */
export function getWorkbenchHtmlPath(customPath?: string): string | null {
  const all = getWorkbenchHtmlPaths(customPath);
  const main = all.find(p => /[\\/]workbench\.html$/i.test(p));
  return main || all[0] || null;
}

/** 放宽 CSP，使内联 <script> 可执行（jetski webview 默认禁止内联脚本） */
function relaxCspScriptSrc(content: string): string {
  // 仅修改 CSP meta 中的 script-src 指令，追加 'unsafe-inline'
  return content.replace(/(script-src\b)([^;"']*(?:'[^']*'[^;"']*)*)/i, (full, head, body) => {
    if (/'unsafe-inline'/i.test(body)) return full; // 已包含
    return head + body + " 'unsafe-inline'";
  });
}

/** 获取 product.json 路径 */
export function getProductJsonPath(customPath?: string): string | null {
  const appRoot = resolveAppRoot(customPath);
  const p = path.join(appRoot, 'product.json');
  return fs.existsSync(p) ? p : null;
}

/** 检查是否已注入（所有目标 file 都注入才算完整注入） */
export function isInjected(customPath?: string): boolean {
  const paths = getWorkbenchHtmlPaths(customPath);
  if (paths.length === 0) return false;
  try {
    return paths.every(p => fs.readFileSync(p, 'utf-8').includes(INJECT_START));
  } catch { return false; }
}

/** 生成注入内容 */
function generateInjectionCode(settings: EnhancementSettings): string {
  const css = generateCSS(settings);
  const js = generateJS(settings);
  return `\n${INJECT_START}\n<style>\n${css}\n</style>\n<script>\n${js}\n</script>\n${INJECT_END}\n`;
}

/** 注入增强功能到所有 workbench HTML（主窗口 + jetski 智能体 webview） */
export async function inject(settings: EnhancementSettings, customPath?: string): Promise<{ success: boolean; message: string }> {
  const paths = getWorkbenchHtmlPaths(customPath);
  if (paths.length === 0) return { success: false, message: '找不到 workbench.html' };

  const injection = generateInjectionCode(settings);
  let injectedCount = 0;
  const failures: string[] = [];

  for (const htmlPath of paths) {
    try {
      let content = fs.readFileSync(htmlPath, 'utf-8');

      // 如果已有旧注入，先移除
      if (content.includes(INJECT_START)) content = removeInjection(content);

      // 放宽 CSP，确保内联脚本可执行（jetski webview 必需）
      content = relaxCspScriptSrc(content);

      // 在 </html> 前注入（若无 </html> 则追加到末尾）
      const insertPos = content.lastIndexOf('</html>');
      if (insertPos === -1) content = content + injection;
      else content = content.slice(0, insertPos) + injection + content.slice(insertPos);

      fs.writeFileSync(htmlPath, content, 'utf-8');
      fixChecksum(htmlPath, customPath);
      injectedCount++;
    } catch (err: any) {
      if (err.code === 'EPERM' || err.code === 'EACCES') {
        return { success: false, message: '权限不足，请以管理员身份运行 IDE 或手动授权' };
      }
      failures.push(path.basename(htmlPath));
    }
  }

  if (injectedCount === 0) return { success: false, message: '注入失败: ' + failures.join(', ') };
  const suffix = failures.length ? `（${failures.length} 个文件失败）` : '';
  return { success: true, message: `增强功能已注入 ${injectedCount} 个窗口${suffix}，重启 IDE 生效` };
}

/** 移除所有 workbench HTML 中的注入 */
export async function remove(customPath?: string): Promise<{ success: boolean; message: string }> {
  const paths = getWorkbenchHtmlPaths(customPath);
  if (paths.length === 0) return { success: false, message: '找不到 workbench.html' };

  let removedCount = 0;
  for (const htmlPath of paths) {
    try {
      let content = fs.readFileSync(htmlPath, 'utf-8');
      if (!content.includes(INJECT_START)) continue;
      content = removeInjection(content);
      fs.writeFileSync(htmlPath, content, 'utf-8');
      fixChecksum(htmlPath, customPath);
      removedCount++;
    } catch (err: any) {
      if (err.code === 'EPERM' || err.code === 'EACCES') {
        return { success: false, message: '权限不足，请以管理员身份运行 IDE' };
      }
    }
  }

  return { success: true, message: removedCount > 0 ? `增强功能已从 ${removedCount} 个窗口移除，重启 IDE 生效` : '未检测到注入内容' };
}

function removeInjection(content: string): string {
  const startIdx = content.indexOf(INJECT_START);
  const endIdx = content.indexOf(INJECT_END);
  if (startIdx === -1 || endIdx === -1) return content;
  return content.slice(0, startIdx) + content.slice(endIdx + INJECT_END.length + 1);
}

/** 修复 product.json 中的校验值 */
function fixChecksum(modifiedFilePath: string, customPath?: string) {
  const productPath = getProductJsonPath(customPath);
  if (!productPath) return;

  try {
    const product = JSON.parse(fs.readFileSync(productPath, 'utf-8'));
    if (!product.checksums) return;

    const appRoot = resolveAppRoot(customPath);
    // 计算新的 checksum（VSCode 校验和使用去除 '=' padding 的 base64 sha256）
    const fileContent = fs.readFileSync(modifiedFilePath);
    const hash = crypto.createHash('sha256').update(fileContent).digest('base64').replace(/=+$/, '');

    // product.json 的 checksums 键相对于 out 目录，例如：
    //   vs/code/electron-sandbox/workbench/workbench.html
    // 而文件实际路径带 out/ 前缀，需尝试多种 key 变体
    const relFromApp = path.relative(appRoot, modifiedFilePath).replace(/\\/g, '/');
    const relFromOut = path.relative(path.join(appRoot, 'out'), modifiedFilePath).replace(/\\/g, '/');
    const baseName = path.basename(modifiedFilePath);

    const candidates = [
      relFromOut,
      relFromApp,
      relFromApp.replace(/^out\//, ''),
    ];

    let matchedKey: string | null = null;
    for (const c of candidates) {
      if (c && Object.prototype.hasOwnProperty.call(product.checksums, c)) { matchedKey = c; break; }
    }
    // 兜底：按文件名匹配（适用于 key 路径格式差异）
    if (!matchedKey) {
      matchedKey = Object.keys(product.checksums).find(k => k.endsWith('/' + baseName) || k === baseName) || null;
    }

    if (matchedKey) {
      product.checksums[matchedKey] = hash;
      fs.writeFileSync(productPath, JSON.stringify(product, null, '\t'), 'utf-8');
      console.log('[Kite] 已更新校验和:', matchedKey);
    } else {
      console.warn('[Kite] 未找到匹配的校验和键，文件:', baseName);
    }
  } catch (e) {
    console.warn('[Kite] 校验和修复失败:', e);
  }
}

// ===================== CSS 生成 =====================
function generateCSS(settings: EnhancementSettings): string {
  let css = `/* Kite Enhancement v1.0 */\n`;

  // LaTeX CSS
  if (settings.latexEnabled) {
    css += `
.latex-block { display: block; text-align: center; margin: 1em 0; overflow-x: auto; }
.latex-inline { display: inline; }
.latex-inline .katex { font-size: 1em; }
.latex-error { color: #f87171; font-size: 12px; background: rgba(248,113,113,.1); padding: 2px 6px; border-radius: 3px; font-family: monospace; }
.latex-code-rendered { padding: 16px; text-align: center; overflow-x: auto; }
.latex-code-rendered .katex { font-size: 1.1em; }
`;
  }

  // Bubbles CSS
  if (settings.bubblesEnabled) {
    css += `
.ab-bubbles { position: relative !important; z-index: 5 !important; margin: 16px 0 24px !important; padding: 0; background: none; border: none; border-radius: 0; animation: abBubbleFadeIn .35s ease; }
@keyframes abBubbleFadeIn { from { opacity: 0; transform: translateY(8px); } to { opacity: 1; transform: translateY(0); } }
.ab-bubbles-header { display: flex; align-items: center; justify-content: space-between; margin-bottom: 12px; }
.ab-bubbles-title { font-size: 13px; font-weight: 600; color: #0ea5e9 !important; display: flex; align-items: center; gap: 6px; }
.ab-bubbles-title svg { width: 14px; height: 14px; fill: #0ea5e9; }
.ab-bubbles-question { font-size: 13px; color: #0ea5e9 !important; font-weight: 500; margin-bottom: 12px; display: flex; align-items: center; justify-content: space-between; }
.ab-bubbles-mode-tag { font-size: 10px; color: #fff; background: linear-gradient(135deg, #22c55e, #06b6d4, #3b82f6); padding: 2px 8px; border-radius: 10px; user-select: none; font-weight: 500; }
.ab-bubble-option { display: flex !important; align-items: center !important; gap: 12px !important; padding: 11px 14px !important; margin-bottom: 6px !important; background: linear-gradient(135deg, #22c55e, #06b6d4, #3b82f6) !important; border: none !important; border-radius: 10px !important; cursor: pointer !important; transition: all .2s ease !important; box-shadow: 0 2px 8px rgba(34,197,94,.2); }
.ab-bubble-option:hover { background: linear-gradient(135deg, #16a34a, #0891b2, #2563eb) !important; box-shadow: 0 4px 12px rgba(34,197,94,.3); transform: translateX(3px); }
.ab-bubble-option-letter { width: 26px; height: 26px; border-radius: 8px; background: rgba(255,255,255,.2) !important; display: flex !important; align-items: center !important; justify-content: center !important; font-size: 12px !important; font-weight: 700 !important; color: #fff !important; flex-shrink: 0; }
.ab-bubble-option-text { font-size: 13px !important; color: #fff !important; font-weight: 500 !important; flex: 1; }
.ab-bubbles-chips { display: flex; flex-direction: column; align-items: flex-start; gap: 6px; }
.ab-bubble-chip { display: inline-flex !important; align-items: center !important; gap: 6px !important; padding: 8px 16px !important; background: linear-gradient(135deg, #22c55e, #06b6d4, #3b82f6) !important; border: none !important; border-radius: 20px !important; cursor: pointer !important; font-size: 12px !important; color: #fff !important; font-weight: 500 !important; transition: all .2s ease !important; max-width: 100%; line-height: 1.4 !important; font-family: inherit !important; box-shadow: 0 2px 8px rgba(34,197,94,.2); }
.ab-bubble-chip::before { content: '✦'; font-size: 8px; color: var(--ab-arrow-color, rgba(255,255,255,.8)); flex-shrink: 0; }
.ab-bubble-chip:hover { background: linear-gradient(135deg, #16a34a, #0891b2, #2563eb) !important; transform: translateY(-1px); box-shadow: 0 4px 12px rgba(34,197,94,.3); }
.ab-bubble-related { display: flex !important; align-items: center !important; padding: 11px 14px !important; margin-bottom: 6px !important; background: linear-gradient(135deg, #22c55e, #06b6d4, #3b82f6) !important; border: none !important; border-radius: 10px !important; cursor: pointer !important; font-size: 13px !important; color: #fff !important; font-weight: 500 !important; transition: all .2s ease !important; text-align: left !important; width: auto !important; box-sizing: border-box !important; font-family: inherit !important; line-height: 1.4 !important; box-shadow: 0 2px 8px rgba(34,197,94,.2); }
.ab-bubble-related::before { content: '→'; margin-right: 10px; color: var(--ab-arrow-color, rgba(255,255,255,.8)); flex-shrink: 0; font-size: 14px; }
.ab-bubble-related:hover { background: linear-gradient(135deg, #ca8a04, #16a34a, #0891b2, #2563eb) !important; box-shadow: 0 4px 12px rgba(34,197,94,.3); transform: translateX(3px); }
.ab-text-input { width: 100%; background: rgba(0,0,0,.3); border: 1px solid #3c3c3c; border-radius: 6px; color: #ccc; font-size: 12px; padding: 6px 10px; outline: none; box-sizing: border-box; }
.ab-text-input:focus { border-color: #667eea; }
.ab-fetch-models-btn { padding: 5px 8px; border: 1px solid rgba(255,255,255,.12); border-radius: 6px; background: rgba(255,255,255,.06); color: rgba(255,255,255,.6); cursor: pointer; font-size: 11px; transition: all .2s; white-space: nowrap; flex-shrink: 0; }
.ab-fetch-models-btn:hover { color: #a78bfa; border-color: rgba(167,139,250,.4); background: rgba(167,139,250,.1); }
`;
  }

  return css;
}

// ===================== JS 生成 =====================
function generateJS(settings: EnhancementSettings): string {
  const settingsJSON = JSON.stringify(settings);

  let js = `(function() {
'use strict';
// Kite Enhancement Runtime
const KITE_SETTINGS = ${settingsJSON};
const INPUT_SELECTOR = [
  'div[contenteditable="true"][data-lexical-editor="true"]',
  'textarea.monaco-editor-background',
  '.antigravity-chat-input',
  'textarea[placeholder*="Ask"]',
  'textarea[placeholder*="输入"]',
  'textarea'
].join(',');
const SEND_BTN_SELECTOR = [
  'button[data-tooltip-id="input-send-button-send-tooltip"]',
  'button[aria-label="Send"]',
  'button[aria-label="发送"]',
  '.antigravity-send-button',
  'button.input-send-button'
].join(',');

// TrustedTypes policy
let kitePolicy = null;
try { if (window.trustedTypes && window.trustedTypes.createPolicy) { kitePolicy = window.trustedTypes.createPolicy('kiteEnhancement', { createHTML: s => s, createScriptURL: s => s }); } } catch(e) {}
function safeSetHTML(el, html) { if (kitePolicy) { el.innerHTML = kitePolicy.createHTML(html); } else { el.innerHTML = html; } }

function getChatPanel() {
  return document.querySelector('.antigravity-agent-side-panel') 
      || document.querySelector('.antigravity-chat-panel') 
      || document.querySelector('.ag-chat-container') 
      || document.querySelector('[data-view-id="antigravity.chatPanel"]')
      || document.querySelector('.antigravity-chat-view');
}
`;

  // LaTeX Runtime
  if (settings.latexEnabled) {
    js += generateLatexJS();
  }

  // Bubbles Runtime
  if (settings.bubblesEnabled) {
    js += generateBubblesJS(settings);
  }

  // Localization Runtime
  if (settings.localizationEnabled) {
    js += generateLocalizationJS();
  }

  // Auto Accept Runtime
  if (settings.autoAcceptEnabled) {
    js += generateAutoAcceptJS();
  }

  // Auto Retry Runtime
  if (settings.autoRetryEnabled) {
    js += generateAutoRetryJS(settings);
  }

  // Lifecycle
  js += `
function kiteOnPanelReady(panelEl) {
  console.log('[Kite] ✅ AI 面板已检测到');
${settings.latexEnabled ? '  applyLatexSettings(panelEl);' : ''}
${settings.bubblesEnabled ? '  applyBubblesSettings(panelEl);' : ''}
${settings.autoAcceptEnabled ? '  applyAutoAcceptSettings(panelEl);' : ''}
}

function kiteWaitForPanel() {
  const p = getChatPanel();
  if (p) { kiteOnPanelReady(p); return; }
  const obs = new MutationObserver((_, o) => {
    const p = getChatPanel();
    if (p) { o.disconnect(); kiteOnPanelReady(p); }
  });
  obs.observe(document.body, { childList: true, subtree: true });
  console.log('[Kite] ⏳ 等待 AI 面板...');
}

function suppressCorruptWarning() {
  const targetTexts = ['安装似乎损坏', 'appears to be corrupt', 'checksums'];
  function checkAndHide(node) {
    if (!node || node.nodeType !== Node.ELEMENT_NODE) return false;
    const isToast = node.classList.contains('notification-toast') || 
                    node.classList.contains('notification-list-item') ||
                    node.classList.contains('monaco-list-row');
    if (isToast) {
      const text = node.textContent || '';
      if (targetTexts.some(t => text.includes(t))) {
        node.style.setProperty('display', 'none', 'important');
        const closeBtn = node.querySelector('.action-label.codicon-close, .notification-toast-close, a.clear-action, button[aria-label*="Close"]');
        if (closeBtn) { try { closeBtn.click(); } catch(e){} }
        return true;
      }
    }
    return false;
  }
  document.querySelectorAll('.notification-toast, .notification-list-item, .monaco-list-row').forEach(node => { checkAndHide(node); });
  const observer = new MutationObserver((mutations) => {
    for (const mutation of mutations) {
      for (const node of mutation.addedNodes) {
        if (node.nodeType !== Node.ELEMENT_NODE) continue;
        if (checkAndHide(node)) continue;
        node.querySelectorAll('.notification-toast, .notification-list-item, .monaco-list-row').forEach(t => checkAndHide(t));
      }
    }
  });
  observer.observe(document.documentElement, { childList: true, subtree: true });
}

function kiteBootstrap() {
  try { suppressCorruptWarning(); } catch(e) {}
  // 汉化独立启动，不依赖 AI 面板（设置窗口等也需要汉化）
${settings.localizationEnabled ? '  try { startLocalization(); } catch (e) { console.warn("[Kite] 汉化启动失败:", e); }' : ''}
  // LaTeX / 气泡 / 自动操作 等仍需等待 AI 面板
${settings.latexEnabled || settings.bubblesEnabled || settings.autoAcceptEnabled ? '  setTimeout(kiteWaitForPanel, 1000);' : ''}
  // 自动重试独立启动，不依赖 AI 面板（错误弹窗在全局范围）
${settings.autoRetryEnabled ? '  try { startAutoRetry(); } catch (e) { console.warn("[Kite] 自动重试启动失败:", e); }' : ''}
}

if (document.body) { setTimeout(kiteBootstrap, 300); }
else { document.addEventListener('DOMContentLoaded', () => setTimeout(kiteBootstrap, 300)); }
})();`;

  return js;
}

function generateLatexJS(): string {
  return `
// ===== LaTeX 渲染 =====
let katexLoaded = false, katexLoading = false, latexObserver = null;
const KATEX_CSS = 'https://cdn.jsdelivr.net/npm/katex@0.16.9/dist/katex.min.css';
const KATEX_JS = 'https://cdn.jsdelivr.net/npm/katex@0.16.9/dist/katex.min.js';

function loadKaTeX() {
  return new Promise((resolve, reject) => {
    if (katexLoaded) { resolve(); return; }
    if (katexLoading) { const iv = setInterval(() => { if (katexLoaded) { clearInterval(iv); resolve(); } }, 100); return; }
    katexLoading = true;
    Promise.all([
      fetch(KATEX_CSS).then(r => r.text()),
      fetch(KATEX_JS).then(r => r.text())
    ]).then(([css, js]) => {
      const style = document.createElement('style'); style.textContent = css; document.head.appendChild(style);
      const wrappedJs = '(function(module, exports, define) {\\n' + js + '\\n}).call(window, undefined, undefined, undefined);';
      const blob = new Blob([wrappedJs], { type: 'application/javascript' });
      const blobUrl = URL.createObjectURL(blob);
      const script = document.createElement('script');
      script.src = kitePolicy ? kitePolicy.createScriptURL(blobUrl) : blobUrl;
      script.onload = () => { URL.revokeObjectURL(blobUrl); katexLoaded = true; katexLoading = false; console.log('[Kite] ✅ KaTeX loaded'); resolve(); };
      script.onerror = () => { URL.revokeObjectURL(blobUrl); katexLoading = false; reject(new Error('KaTeX load failed')); };
      document.head.appendChild(script);
    }).catch(e => { katexLoading = false; reject(e); });
  });
}

const LATEX_PATTERN = /(\\$\\$[\\s\\S]+?\\$\\$|\\$(?!\\$)(?:[^$\\n]|\\n(?!\\n))+?\\$(?!\\$)|\\\\\\[[\\s\\S]+?\\\\\\]|\\\\\\((?:[^\\\\\\\\]|\\\\\\\\(?!\\)))+?\\\\\\))/g;

function normalizeLatexInElement(elem) {
  const text = elem.textContent;
  LATEX_PATTERN.lastIndex = 0;
  if (!LATEX_PATTERN.test(text)) return;
  const fmtEls = elem.querySelectorAll('em, strong, i, b');
  if (fmtEls.length === 0) return;
  let changed = false;
  fmtEls.forEach(fmt => {
    if (fmt.closest('pre, .latex-rendered')) return;
    let dollars = 0;
    const tw = document.createTreeWalker(elem, NodeFilter.SHOW_TEXT);
    let nd;
    while (nd = tw.nextNode()) {
      if (fmt.compareDocumentPosition(nd) & Node.DOCUMENT_POSITION_PRECEDING) {
        dollars += (nd.textContent.match(/\\$/g) || []).length;
      }
    }
    if (dollars % 2 === 1) {
      const delim = (fmt.tagName === 'EM' || fmt.tagName === 'I') ? '_' : '**';
      const tn = document.createTextNode(delim + fmt.textContent + delim);
      fmt.parentNode.replaceChild(tn, fmt);
      changed = true;
    }
  });
  if (changed) elem.normalize();
}

function processLatexInElement(elem) {
  if (elem.dataset.latexElemProcessed) return false;
  normalizeLatexInElement(elem);
  const text = elem.textContent;
  LATEX_PATTERN.lastIndex = 0;
  if (!LATEX_PATTERN.test(text)) return false; LATEX_PATTERN.lastIndex = 0;
  const blockPattern = /^\\s*(?:\\$\\$([\\s\\S]+?)\\$\\$|\\\\\\[([\\s\\S]+?)\\\\\\])\\s*$/;
  const blockMatch = text.match(blockPattern);
  if (blockMatch) {
    try {
      const formula = (blockMatch[1] || blockMatch[2]).trim();
      const html = window.katex.renderToString(formula, { throwOnError: false, displayMode: true });
      const wrap = document.createElement('div');
      wrap.className = 'latex-block latex-rendered';
      wrap.dataset.latexOriginal = text;
      safeSetHTML(wrap, html);
      elem.parentNode.replaceChild(wrap, elem);
      return true;
    } catch (e) { return false; }
  }
  elem.querySelectorAll('code').forEach(code => {
    if (code.closest('pre')) return;
    const ct = code.textContent;
    LATEX_PATTERN.lastIndex = 0;
    if (LATEX_PATTERN.test(ct) && ct.replace(LATEX_PATTERN, '').trim() === '') {
      code.replaceWith(document.createTextNode(ct));
    }
  });
  const walker = document.createTreeWalker(elem, NodeFilter.SHOW_TEXT, null, false);
  const nodes = []; let n;
  while (n = walker.nextNode()) {
    if (n.parentNode && /^(code|pre|script|style)$/i.test(n.parentNode.tagName)) continue;
    if (n.parentNode && n.parentNode.classList && n.parentNode.classList.contains('latex-rendered')) continue;
    if (n.textContent.includes('$') || n.textContent.includes('\\\\(') || n.textContent.includes('\\\\[')) nodes.push(n);
  }
  let has = false;
  for (let i = nodes.length - 1; i >= 0; i--) {
    const textNode = nodes[i];
    const nodeText = textNode.textContent;
    LATEX_PATTERN.lastIndex = 0;
    if (!LATEX_PATTERN.test(nodeText)) continue; LATEX_PATTERN.lastIndex = 0;
    const frag = document.createDocumentFragment(); let last = 0, m;
    while ((m = LATEX_PATTERN.exec(nodeText)) !== null) {
      if (m.index > last) frag.appendChild(document.createTextNode(nodeText.slice(last, m.index)));
      const full = m[0];
      const isBlock = full.startsWith('$$') || full.startsWith('\\\\[');
      let formula;
      if (full.startsWith('$$')) formula = full.slice(2, -2).trim();
      else if (full.startsWith('\\\\[')) formula = full.slice(2, -2).trim();
      else if (full.startsWith('\\\\(')) formula = full.slice(2, -2).trim();
      else formula = full.slice(1, -1).trim();
      try {
        const html = window.katex.renderToString(formula, { throwOnError: false, displayMode: isBlock });
        const wrap = document.createElement(isBlock ? 'div' : 'span');
        wrap.className = isBlock ? 'latex-block latex-rendered' : 'latex-inline latex-rendered';
        wrap.dataset.latexOriginal = full; safeSetHTML(wrap, html); frag.appendChild(wrap);
      } catch (e) { frag.appendChild(document.createTextNode(full)); }
      last = m.index + full.length;
    }
    if (last < nodeText.length) frag.appendChild(document.createTextNode(nodeText.slice(last)));
    textNode.parentNode.replaceChild(frag, textNode); has = true;
  }
  if (has) elem.dataset.latexElemProcessed = 'true';
  return has;
}

function processLatexCodeBlocks(scope) {
  scope.querySelectorAll('pre').forEach(pre => {
    if (pre.dataset.latexCodeProcessed) return;
    const codeContainer = pre.querySelector('div');
    if (!codeContainer) return;
    const langLabel = codeContainer.querySelector('.font-sans.text-sm');
    if (!langLabel || langLabel.textContent.trim().toLowerCase() !== 'latex') return;
    const codeBody = codeContainer.querySelector('.p-3');
    if (!codeBody) return;
    const lineContents = codeBody.querySelectorAll('.line-content');
    const formula = lineContents.length > 0
      ? Array.from(lineContents).map(l => l.textContent).join('\\n').trim()
      : codeBody.textContent.trim();
    if (!formula) return;
    try {
      const html = window.katex.renderToString(formula, { throwOnError: false, displayMode: true });
      const rendered = document.createElement('div');
      rendered.className = 'latex-code-rendered latex-rendered';
      safeSetHTML(rendered, html);
      codeBody.dataset.latexCodeOriginalDisplay = codeBody.style.display || '';
      codeBody.style.display = 'none';
      codeBody.parentNode.insertBefore(rendered, codeBody.nextSibling);
      pre.dataset.latexCodeProcessed = 'true';
    } catch (e) {}
  });
}

function scanAndRenderLatex(panelEl) {
  if (!katexLoaded) return;
  const scope = panelEl || getChatPanel();
  if (!scope) return;
  const proseSelectors = [
    '.leading-relaxed.select-text:not(.opacity-70)',
    '.select-text.leading-relaxed:not(.opacity-70)',
    '[class*="leading-relaxed"][class*="select-text"]:not([class*="opacity"])',
  ];
  const proseSet = new Set();
  proseSelectors.forEach(sel => { try { scope.querySelectorAll(sel).forEach(e => proseSet.add(e)); } catch(e){} });
  const elemSelector = 'p, li, td, th, h1, h2, h3, h4, h5, h6';
  proseSet.forEach(prose => { prose.querySelectorAll(elemSelector).forEach(elem => { processLatexInElement(elem); }); });
  if (proseSet.size === 0) {
    scope.querySelectorAll(elemSelector).forEach(elem => {
      if (elem.closest('#ab-overlay') || elem.closest('#ab-modal')) return;
      processLatexInElement(elem);
    });
  }
  processLatexCodeBlocks(scope);
}

async function applyLatexSettings(panelEl) {
  if (latexObserver) { latexObserver.disconnect(); latexObserver = null; }
  try {
    await loadKaTeX();
    const scope = panelEl || getChatPanel();
    if (scope) {
      latexObserver = new MutationObserver(() => { clearTimeout(window._kiteLTTimer); window._kiteLTTimer = setTimeout(() => scanAndRenderLatex(panelEl), 300); });
      latexObserver.observe(scope, { childList: true, subtree: true });
    }
    scanAndRenderLatex(panelEl);
  } catch (e) { console.warn('[Kite] LaTeX init failed:', e.message); }
}
`;
}

function generateBubblesJS(settings: EnhancementSettings): string {
  return `
// ===== 气泡选项 =====
let bubblesObserver = null;
const LETTERS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';

async function setInputText(text) {
  const inputEl = document.querySelector(INPUT_SELECTOR);
  if (!inputEl) return false;
  inputEl.focus();
  if (inputEl.tagName === 'TEXTAREA') {
    inputEl.value = text;
    inputEl.dispatchEvent(new Event('input', { bubbles: true }));
    inputEl.dispatchEvent(new Event('change', { bubbles: true }));
    return true;
  }
  const sel = window.getSelection();
  const range = document.createRange();
  range.selectNodeContents(inputEl);
  sel.removeAllRanges(); sel.addRange(range);
  try {
    await navigator.clipboard.writeText(text);
    const ok = document.execCommand('paste');
    await new Promise(r => setTimeout(r, 50));
    if (ok && (inputEl.textContent || '').trim().length > 0) return true;
  } catch(e) {}
  try {
    range.selectNodeContents(inputEl); sel.removeAllRanges(); sel.addRange(range);
    const dt = new DataTransfer(); dt.setData('text/plain', text);
    inputEl.dispatchEvent(new ClipboardEvent('paste', { bubbles: true, cancelable: true, clipboardData: dt }));
    await new Promise(r => setTimeout(r, 50));
    if ((inputEl.textContent || '').trim().length > 0) return true;
  } catch(e) {}
  try {
    range.selectNodeContents(inputEl); sel.removeAllRanges(); sel.addRange(range);
    const ok = document.execCommand('insertText', false, text);
    await new Promise(r => setTimeout(r, 50));
    if (ok && (inputEl.textContent || '').trim().length > 0) return true;
  } catch(e) {}
  inputEl.innerHTML = '';
  text.split('\\n').forEach(line => { const p = document.createElement('p'); p.textContent = line || '\\u200B'; inputEl.appendChild(p); });
  inputEl.dispatchEvent(new Event('input', { bubbles: true }));
  return true;
}

function submitBubbleText(text) {
  if (!text) return;
  console.log('[Kite] 🫧 气泡点击 →', text);
  setInputText(text);
  if (${settings.bubblesAutoSend ? 'true' : 'false'}) {
    let retries = 0;
    const trySend = () => {
      const sendBtn = document.querySelector(SEND_BTN_SELECTOR);
      if (sendBtn && !sendBtn.disabled) { sendBtn.click(); return; }
      if (++retries < 6) setTimeout(trySend, 500);
    };
    setTimeout(trySend, 400);
  }
}

function renderBubblesCard(data, container) {
  const wrapper = document.createElement('div');
  wrapper.className = 'ab-bubbles';
  wrapper.dataset.abBubblesRendered = '1';
  wrapper.style.cssText = 'pointer-events:all!important;position:relative;z-index:10;';
  if (data.title || data.type === 'clarify') {
    const header = document.createElement('div'); header.className = 'ab-bubbles-header';
    const titleEl = document.createElement('div'); titleEl.className = 'ab-bubbles-title';
    const sparkSvg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    sparkSvg.setAttribute('viewBox', '0 0 24 24');
    const sparkPath = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    sparkPath.setAttribute('d', 'M12 2L15.09 8.26L22 9.27L17 14.14L18.18 21.02L12 17.77L5.82 21.02L7 14.14L2 9.27L8.91 8.26L12 2Z');
    sparkPath.setAttribute('fill', 'currentColor');
    sparkSvg.appendChild(sparkPath); titleEl.appendChild(sparkSvg);
    titleEl.appendChild(document.createTextNode(data.title || '建议'));
    header.appendChild(titleEl); wrapper.appendChild(header);
  }
  if (data.type === 'clarify' && data.question) {
    const qEl = document.createElement('div'); qEl.className = 'ab-bubbles-question';
    qEl.appendChild(document.createTextNode(data.question));
    const modeTag = document.createElement('span'); modeTag.className = 'ab-bubbles-mode-tag';
    modeTag.textContent = data.mode === 'multi' ? '多选' : '单选';
    qEl.appendChild(modeTag); wrapper.appendChild(qEl);
  }
  if (data.type === 'clarify') {
    data.items.forEach((item, i) => {
      const opt = document.createElement('div'); opt.className = 'ab-bubble-option';
      const letter = document.createElement('span'); letter.className = 'ab-bubble-option-letter'; letter.textContent = LETTERS[i] || String(i+1);
      const text = document.createElement('span'); text.className = 'ab-bubble-option-text'; text.textContent = item;
      opt.appendChild(letter); opt.appendChild(text);
      opt.style.pointerEvents = 'all';
      opt.addEventListener('click', (e) => { e.stopPropagation(); e.stopImmediatePropagation(); submitBubbleText(LETTERS[i] + '. ' + item); wrapper.remove(); });
      opt.addEventListener('mousedown', (e) => { e.stopPropagation(); });
      wrapper.appendChild(opt);
    });
    // 自定义回答
    const customOpt = document.createElement('div'); customOpt.className = 'ab-bubble-option';
    const customLetter = document.createElement('span'); customLetter.className = 'ab-bubble-option-letter'; customLetter.textContent = '✏'; customLetter.style.fontSize = '13px';
    const customLabel = document.createElement('span'); customLabel.className = 'ab-bubble-option-text'; customLabel.textContent = '自定义回答...'; customLabel.style.opacity = '0.5'; customLabel.style.fontStyle = 'italic';
    customOpt.appendChild(customLetter); customOpt.appendChild(customLabel);
    const customInputRow = document.createElement('div'); customInputRow.style.cssText = 'display:none;gap:6px;align-items:center;margin-top:6px;';
    const customInput = document.createElement('input'); customInput.type = 'text'; customInput.className = 'ab-text-input'; customInput.placeholder = '输入你的回答...'; customInput.style.flex = '1';
    const customSendBtn = document.createElement('button'); customSendBtn.className = 'ab-fetch-models-btn'; customSendBtn.textContent = '发送';
    customSendBtn.addEventListener('click', () => { const val = customInput.value.trim(); if (val) { submitBubbleText(val); wrapper.remove(); } });
    customInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') customSendBtn.click(); });
    customInputRow.appendChild(customInput); customInputRow.appendChild(customSendBtn);
    customOpt.addEventListener('click', (e) => {
      if (e.target === customInput || e.target === customSendBtn) return;
      customInputRow.style.display = customInputRow.style.display === 'none' ? 'flex' : 'none';
      if (customInputRow.style.display === 'flex') setTimeout(() => customInput.focus(), 50);
    });
    wrapper.appendChild(customOpt); wrapper.appendChild(customInputRow);
  } else if (data.type === 'suggest') {
    const chips = document.createElement('div'); chips.className = 'ab-bubbles-chips';
    data.items.forEach(item => {
      const chip = document.createElement('button'); chip.className = 'ab-bubble-chip'; chip.style.pointerEvents = 'all'; chip.textContent = item;
      chip.addEventListener('click', (e) => { e.stopPropagation(); e.stopImmediatePropagation(); submitBubbleText(item); wrapper.remove(); });
      chip.addEventListener('mousedown', (e) => { e.stopPropagation(); });
      chips.appendChild(chip);
    });
    wrapper.appendChild(chips);
  } else {
    data.items.forEach(item => {
      const bubble = document.createElement('button'); bubble.className = 'ab-bubble-related'; bubble.style.pointerEvents = 'all'; bubble.textContent = item;
      bubble.addEventListener('click', (e) => { e.stopPropagation(); e.stopImmediatePropagation(); submitBubbleText(item); wrapper.remove(); });
      bubble.addEventListener('mousedown', (e) => { e.stopPropagation(); });
      wrapper.appendChild(bubble);
    });
  }
  container.appendChild(wrapper);
}

function parseBubbleMetaFromText(text, data) {
  const typeM = text.match(/\\btype:\\s*(clarify|suggest|related)/);
  if (typeM) data.type = typeM[1];
  const titleM = text.match(/\\btitle:\\s*(.+?)(?:\\s+(?:type|question|mode|items):|$)/);
  if (titleM) data.title = titleM[1].trim();
  const questionM = text.match(/\\bquestion:\\s*(.+?)(?:\\s+(?:type|title|mode|items):|$)/);
  if (questionM) data.question = questionM[1].trim();
  const modeM = text.match(/\\bmode:\\s*(single|multi)/);
  if (modeM) data.mode = modeM[1];
}

function scanForBubbles(panelEl) {
  const scope = panelEl || getChatPanel();
  if (!scope) return;
  const allPs = scope.querySelectorAll('p');
  allPs.forEach(p => {
    if (p.dataset.abBubblesProcessed) return;
    const ct = (p.textContent || '').trim();
    if (!ct.includes(':::bubbles')) return;
    let hasClosing = false;
    let sib = p.nextElementSibling;
    while (sib) {
      const st = (sib.textContent || '').trim();
      if (st === ':::' || /:{3}\\s*$/.test(st)) { hasClosing = true; break; }
      sib = sib.nextElementSibling;
    }
    if (!hasClosing) return;
    p.dataset.abBubblesProcessed = '1';
    const data = { type: 'suggest', title: '', question: '', mode: 'single', items: [] };
    const elementsToHide = [p];
    parseBubbleMetaFromText(ct.replace(':::bubbles', ''), data);
    sib = p.nextElementSibling;
    while (sib) {
      const st = (sib.textContent || '').trim();
      if (st === ':::' || /^:{3}\\s*$/.test(st)) { elementsToHide.push(sib); break; }
      elementsToHide.push(sib);
      if (sib.tagName === 'UL' || sib.tagName === 'OL') {
        const lis = sib.querySelectorAll('li');
        lis.forEach((li, idx) => {
          let itemText = (li.textContent || '').trim();
          if (idx === lis.length - 1) itemText = itemText.replace(/\\s*:{3}\\s*$/, '');
          if (itemText) data.items.push(itemText);
        });
        const lastLi = lis[lis.length - 1];
        if (lastLi && (lastLi.textContent || '').trim().endsWith(':::')) break;
      } else if (st.endsWith(':::')) {
        const beforeClose = st.slice(0, -3).trim();
        if (beforeClose) parseBubbleMetaFromText(beforeClose, data);
        break;
      } else {
        if (st.includes(':::bubbles')) break;
        parseBubbleMetaFromText(st, data);
      }
      sib = sib.nextElementSibling;
    }
    if (data.items.length > 0) {
      const lastHidden = elementsToHide[elementsToHide.length - 1];
      const nextEl = lastHidden.nextElementSibling;
      if (nextEl && nextEl.dataset.abBubbleCard) return;
      elementsToHide.forEach(el => el.style.display = 'none');
      const cardHost = document.createElement('div'); cardHost.dataset.abBubbleCard = '1';
      renderBubblesCard(data, cardHost);
      lastHidden.parentElement.insertBefore(cardHost, lastHidden.nextSibling);
    }
  });
}

function applyBubblesSettings(panelEl) {
  if (bubblesObserver) { bubblesObserver.disconnect(); bubblesObserver = null; }
  const scope = panelEl || getChatPanel();
  if (scope) {
    bubblesObserver = new MutationObserver(() => { clearTimeout(window._kiteBubTimer); window._kiteBubTimer = setTimeout(() => scanForBubbles(panelEl), 500); });
    bubblesObserver.observe(scope, { childList: true, subtree: true });
  }
  scanForBubbles(panelEl);
}
`;
}

function generateLocalizationJS(): string {
  const locFilePath = path.join(__dirname, '..', 'resources', 'localization.js');
  try {
    return '\n// ===== 汉化模块 =====\n' + fs.readFileSync(locFilePath, 'utf-8') + '\n';
  } catch (e) {
    console.warn('[Kite] Failed to read localization.js:', e);
    return '\n// [Kite] localization.js not found\nfunction startLocalization() { console.warn("[Kite] localization resource missing"); }\n';
  }
}

function generateAutoAcceptJS(): string {
  return `
// ===== 自动操作与自动继续 =====
const LOCAL_STORAGE_KEY = 'kite-auto-accept-settings';

function loadDynamicSettings() {
  try {
    const saved = localStorage.getItem(LOCAL_STORAGE_KEY);
    if (saved) {
      const parsed = JSON.parse(saved);
      if (!parsed.stats) parsed.stats = { clicks: 0, blocked: 0, verified: 0 };
      if (parsed.remaining === undefined) parsed.remaining = KITE_SETTINGS.autoAcceptRemaining;
      if (parsed.unlimited === undefined) parsed.unlimited = KITE_SETTINGS.autoAcceptUnlimited;
      return parsed;
    }
  } catch(e){}
  return {
    remaining: KITE_SETTINGS.autoAcceptRemaining,
    unlimited: KITE_SETTINGS.autoAcceptUnlimited,
    stats: { clicks: 0, blocked: 0, verified: 0 }
  };
}

function saveDynamicSettings(ds) {
  try {
    localStorage.setItem(LOCAL_STORAGE_KEY, JSON.stringify(ds));
  } catch(e){}
  // 触发 storage 事件以同步各窗口
  window.dispatchEvent(new Event('storage'));
}

function isAutoAcceptButton(btn) {
  const text = (btn.textContent || '').trim().toLowerCase();
  if (!text || text.length > 50) return false;
  if (btn.hasAttribute('aria-haspopup')) return false;
  if (btn.title && btn.classList.contains('grow')) return false;
  
  const patterns = Object.entries(KITE_SETTINGS.autoAcceptPatterns)
    .filter(([_, v]) => v)
    .map(([k]) => k.toLowerCase());
  if (!patterns.length) return false;
  
  const rejects = ['skip', 'reject', 'cancel', 'close', 'refine', 'dismiss', 'always'];
  if (rejects.some(r => text.includes(r))) return false;
  if (!patterns.some(p => text.includes(p))) return false;
  
  const style = window.getComputedStyle(btn);
  const rect = btn.getBoundingClientRect();
  return style.display !== 'none' && rect.width > 0 && !btn.disabled;
}

function findNearbyCommandText(btnEl) {
  let cmd = ''; let container = btnEl.parentElement; let depth = 0;
  while (container && depth < 10) {
    let sib = container.previousElementSibling; let sc = 0;
    while (sib && sc < 5) {
      if (/^(PRE|CODE)$/.test(sib.tagName)) cmd += ' ' + sib.textContent.trim();
      sib.querySelectorAll('pre, code').forEach(e => cmd += ' ' + e.textContent.trim());
      sib = sib.previousElementSibling; sc++;
    }
    if (cmd.length > 10) break; container = container.parentElement; depth++;
  }
  return cmd.trim().toLowerCase();
}

function isCommandBanned(text) {
  if (!text) return false;
  const list = KITE_SETTINGS.bannedCommands || [];
  return list.some(p => p && text.toLowerCase().includes(p.toLowerCase()));
}

function isDiffConfirmationArea(btn) {
  let node = btn;
  for (let depth = 0; node && depth < 6; depth++) {
    const text = (node.textContent || '').toLowerCase();
    const className = typeof node.className === 'string' ? node.className : '';
    if (className.includes('outline-solid') && className.includes('justify-between') && text.includes('file with changes') && text.includes('reject all') && text.includes('accept all')) return true;
    node = node.parentElement;
  }
  return false;
}

function findDiffAcceptAllTarget(scope) {
  const root = scope || getChatPanel();
  if (!root) return null;
  return Array.from(root.querySelectorAll('span')).find(el => {
    const text = (el.textContent || '').trim().toLowerCase();
    const className = typeof el.className === 'string' ? el.className : '';
    return text === 'accept all' && className.includes('cursor-pointer') && isDiffConfirmationArea(el);
  });
}

function normalizeAutoAcceptText(text) {
  return (text || '').toLowerCase().replace(/[\\u200B-\\u200D\\uFEFF]/g, '').replace(/\\s+/g, '').trim();
}

function isVisibleEnabledActionElement(el) {
  if (!el) return false;
  const style = window.getComputedStyle(el);
  const rect = el.getBoundingClientRect();
  return style.display !== 'none' && style.visibility !== 'hidden' && rect.width > 0 && rect.height > 0 && !el.disabled && el.getAttribute('aria-disabled') !== 'true';
}

function resolvePermissionClickTarget(candidate, root) {
  if (!candidate) return null;
  const directButton = candidate.matches('button, [role="button"]') ? candidate : null;
  const nestedButton = candidate.querySelector('button, [role="button"]');
  const clickableSelf = typeof candidate.className === 'string' && candidate.className.includes('cursor-pointer') ? candidate : null;
  const targets = [directButton, nestedButton, candidate.closest('button, [role="button"]'), candidate.closest('[class*="cursor-pointer"]'), clickableSelf].filter(Boolean);
  return targets.find(el => root.contains(el) && !el.closest('#ab-overlay') && !el.closest('#ab-modal') && isVisibleEnabledActionElement(el));
}

function findScopedPermissionTarget(scope, expectedText) {
  const root = scope || getChatPanel();
  if (!root) return null;
  const normalizedExpected = normalizeAutoAcceptText(expectedText);
  const candidates = Array.from(root.querySelectorAll('button, [role="button"], span, div')).filter(el => {
    if (el.closest('#ab-overlay') || el.closest('#ab-modal')) return false;
    const norm = normalizeAutoAcceptText(el.textContent);
    return norm === normalizedExpected || (normalizedExpected.length >= 3 && norm.startsWith(normalizedExpected) && norm.length <= normalizedExpected.length + 3);
  });
  for (const candidate of candidates) {
    const target = resolvePermissionClickTarget(candidate, root);
    if (target) return target;
  }
  return null;
}

async function performScopedPermissionAutoAccept(scope) {
  if (!scope || !KITE_SETTINGS.autoAcceptEnabled) return;
  const ds = loadDynamicSettings();
  if (!ds.unlimited && ds.remaining <= 0) return;
  const permissionSequence = [
    { pattern: 'allow this conversation', settingKey: 'allow this conversation' },
    { pattern: 'always allow', settingKey: 'always allow' },
    { pattern: 'allow once', settingKey: 'allow' },
    { pattern: 'allow', settingKey: 'allow' },
  ];
  for (const { pattern, settingKey } of permissionSequence) {
    if (!ds.unlimited && ds.remaining <= 0) break;
    if (!KITE_SETTINGS.autoAcceptPatterns[settingKey]) continue;
    const target = findScopedPermissionTarget(scope, pattern);
    if (target) {
      target.click();
      ds.stats.clicks++;
      if (!ds.unlimited) ds.remaining = Math.max(0, ds.remaining - 1);
      saveDynamicSettings(ds);
      await new Promise(r => setTimeout(r, 100));
    }
  }
}

async function performScopedCommandAutoAccept(scope) {
  if (!scope || !KITE_SETTINGS.autoAcceptEnabled) return;
  const ds = loadDynamicSettings();
  if (!ds.unlimited && ds.remaining <= 0) return;
  const buttons = scope.querySelectorAll('button');
  for (const btn of buttons) {
    if (!ds.unlimited && ds.remaining <= 0) break;
    const text = (btn.textContent || '').trim().toLowerCase();
    if (!/run|execute/i.test(text)) continue;
    if (!isAutoAcceptButton(btn)) continue;
    const nearby = findNearbyCommandText(btn);
    if (isCommandBanned(nearby)) {
      ds.stats.blocked++;
      saveDynamicSettings(ds);
      continue;
    }
    btn.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
    ds.stats.clicks++;
    if (!ds.unlimited) ds.remaining = Math.max(0, ds.remaining - 1);
    saveDynamicSettings(ds);
    await new Promise(r => setTimeout(r, 100));
  }
}

async function performAutoAccept(panelEl) {
  if (!KITE_SETTINGS.autoAcceptEnabled) return;
  const ds = loadDynamicSettings();
  if (!ds.unlimited && ds.remaining <= 0) return;
  const scope = panelEl || getChatPanel();
  if (!scope) return;
  const buttons = scope.querySelectorAll('button');
  for (const btn of buttons) {
    if (!ds.unlimited && ds.remaining <= 0) break;
    if (!isAutoAcceptButton(btn)) continue;
    const text = (btn.textContent || '').trim().toLowerCase();
    if (text === 'accept all' && !isDiffConfirmationArea(btn)) continue;
    if (text === 'allow this conversation' || text === 'always allow' || text === 'allow once' || text === 'allow') continue;
    if (/run|execute/i.test(text)) {
      const nearby = findNearbyCommandText(btn);
      if (isCommandBanned(nearby)) {
        ds.stats.blocked++;
        saveDynamicSettings(ds);
        continue;
      }
    }
    btn.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
    ds.stats.clicks++;
    if (!ds.unlimited) ds.remaining = Math.max(0, ds.remaining - 1);
    saveDynamicSettings(ds);
    await new Promise(r => setTimeout(r, 100));
  }
  
  if (KITE_SETTINGS.autoAcceptPatterns['accept all'] && (ds.unlimited || ds.remaining > 0)) {
    const acceptAllTarget = findDiffAcceptAllTarget(scope);
    if (acceptAllTarget) {
      acceptAllTarget.click();
      ds.stats.clicks++;
      if (!ds.unlimited) ds.remaining = Math.max(0, ds.remaining - 1);
      saveDynamicSettings(ds);
      await new Promise(r => setTimeout(r, 100));
    }
  }
  await performScopedCommandAutoAccept(scope);
  await performScopedPermissionAutoAccept(scope);
}

let autoAcceptObserver = null, autoAcceptPermissionTimer = null, autoAcceptCommandTimer = null;
function applyAutoAcceptSettings(panelEl) {
  if (autoAcceptObserver) { autoAcceptObserver.disconnect(); autoAcceptObserver = null; }
  if (autoAcceptPermissionTimer) { clearInterval(autoAcceptPermissionTimer); autoAcceptPermissionTimer = null; }
  if (autoAcceptCommandTimer) { clearInterval(autoAcceptCommandTimer); autoAcceptCommandTimer = null; }
  if (!KITE_SETTINGS.autoAcceptEnabled) return;
  const scope = panelEl || getChatPanel();
  if (!scope) return;
  
  autoAcceptObserver = new MutationObserver(() => {
    clearTimeout(window._kiteAATimer);
    window._kiteAATimer = setTimeout(() => performAutoAccept(panelEl), 500);
  });
  autoAcceptObserver.observe(scope, { childList: true, subtree: true, attributes: true, characterData: true });
  autoAcceptPermissionTimer = setInterval(() => { performScopedPermissionAutoAccept(scope).catch(() => { }); }, 1000);
  autoAcceptCommandTimer = setInterval(() => { performScopedCommandAutoAccept(scope).catch(() => { }); }, 1000);
  performAutoAccept(panelEl);
}
`;
}


function generateAutoRetryJS(settings: EnhancementSettings): string {
  return `
// ===== 自动重试 =====
const AUTO_RETRY_STORAGE_KEY = 'kite-auto-retry-settings';
let _autoRetryObserver = null;
let _autoRetryConsecutive = 0; // 连续重试计数
let _autoRetryLastErrorHash = ''; // 上次错误的 hash，用于去重
let _autoRetryPending = false; // 防止并发重试

function loadRetrySettings() {
  try {
    const saved = localStorage.getItem(AUTO_RETRY_STORAGE_KEY);
    if (saved) return JSON.parse(saved);
  } catch(e){}
  return { totalRetries: 0 };
}

function saveRetrySettings(rs) {
  try { localStorage.setItem(AUTO_RETRY_STORAGE_KEY, JSON.stringify(rs)); } catch(e){}
  window.dispatchEvent(new Event('storage'));
}

/**
 * 检测错误状态区域并点击重试按钮
 * 目标：底部错误弹窗中的「重试」/「Retry」按钮
 */
function findRetryButton() {
  // 策略1: 查找包含错误信息的区域内的重试按钮
  const errorKeywords = [
    '因错误终止', 'error', 'failed', 'high traffic', 'try again',
    '请重试', '出错', '错误', 'terminated', 'aborted',
    'rate limit', 'timeout', 'timed out', '超时'
  ];
  const retryTexts = ['重试', 'retry', 'try again'];

  // 搜索所有按钮
  const allButtons = document.querySelectorAll('button, [role="button"]');
  for (const btn of allButtons) {
    const btnText = (btn.textContent || '').trim().toLowerCase();
    if (!retryTexts.some(rt => btnText === rt || btnText.includes(rt))) continue;
    // 确保按钮可见且可点击
    const style = window.getComputedStyle(btn);
    const rect = btn.getBoundingClientRect();
    if (style.display === 'none' || style.visibility === 'hidden' || rect.width === 0 || rect.height === 0) continue;
    if (btn.disabled) continue;

    // 向上查找是否在错误上下文中（最多 15 层）
    let parent = btn.parentElement;
    let depth = 0;
    while (parent && depth < 15) {
      const parentText = (parent.textContent || '').toLowerCase();
      if (errorKeywords.some(kw => parentText.includes(kw))) {
        return btn;
      }
      parent = parent.parentElement;
      depth++;
    }
  }
  return null;
}

/**
 * 生成一个简易 hash 用于标记「同一错误」
 */
function errorContextHash(btn) {
  let parent = btn.parentElement;
  for (let d = 0; d < 10 && parent; d++) {
    const text = (parent.textContent || '').trim();
    if (text.length > 20) {
      // 取前100字符作为 hash 源
      return text.slice(0, 100);
    }
    parent = parent.parentElement;
  }
  return 'unknown';
}

function attemptAutoRetry() {
  if (_autoRetryPending) return;
  const maxAttempts = ${settings.autoRetryMaxAttempts};
  const delayMs = ${settings.autoRetryDelay} * 1000;

  const retryBtn = findRetryButton();
  if (!retryBtn) {
    // 没有找到重试按钮，重置连续计数
    _autoRetryConsecutive = 0;
    _autoRetryLastErrorHash = '';
    return;
  }

  const hash = errorContextHash(retryBtn);

  // 如果是同一个错误，递增连续计数；否则重置
  if (hash === _autoRetryLastErrorHash) {
    _autoRetryConsecutive++;
  } else {
    _autoRetryConsecutive = 1;
    _autoRetryLastErrorHash = hash;
  }

  // 检查是否超过最大重试次数
  if (_autoRetryConsecutive > maxAttempts) {
    console.warn('[Kite] ⛔ 自动重试已达上限 (' + maxAttempts + ' 次)，停止重试');
    return;
  }

  _autoRetryPending = true;
  const attempt = _autoRetryConsecutive;
  console.log('[Kite] 🔄 检测到错误，' + (delayMs / 1000) + '秒后自动重试 (' + attempt + '/' + maxAttempts + ')');

  setTimeout(() => {
    _autoRetryPending = false;
    // 再次确认按钮还在
    const btn = findRetryButton();
    if (btn) {
      console.log('[Kite] 🔄 执行自动重试 (' + attempt + '/' + maxAttempts + ')');
      btn.click();
      // 更新统计
      const rs = loadRetrySettings();
      rs.totalRetries = (rs.totalRetries || 0) + 1;
      saveRetrySettings(rs);
    }
  }, delayMs);
}

function startAutoRetry() {
  if (_autoRetryObserver) { _autoRetryObserver.disconnect(); _autoRetryObserver = null; }
  console.log('[Kite] 🔄 自动重试已启动 (最大 ${settings.autoRetryMaxAttempts} 次, 间隔 ${settings.autoRetryDelay}s)');

  // 使用 MutationObserver 监听全局 DOM 变化来检测错误弹窗
  _autoRetryObserver = new MutationObserver(() => {
    clearTimeout(window._kiteRetryTimer);
    window._kiteRetryTimer = setTimeout(attemptAutoRetry, 800);
  });
  _autoRetryObserver.observe(document.body, { childList: true, subtree: true, attributes: true });

  // 初始扫描一次
  setTimeout(attemptAutoRetry, 2000);
}
`;
}
