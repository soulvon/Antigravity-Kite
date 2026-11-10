#!/usr/bin/env node
/**
 * 多开操作等待反馈门控（devloop 红线 4：改旧行为前先写一条能在旧代码上失败的检查）
 *
 * 背景：多开模块的创建/启动/停止/跳转/编辑/删除/刷新/导入全部是「点击后只发消息、不显示任何状态」，
 * 宿主侧要跑进程枚举、spawn IDE、taskkill、窗口置顶，耗时可达数秒甚至数十秒，
 * 期间弹窗已关闭、列表未刷新、无 toast、按钮无变化 —— 用户看到的就是「点了像死了一样」。
 * CSS 早已有 .inst-card-btn.is-loading 与 .btn-mini-spinner，i18n 也备好了阶段名，但 JS 端一次都没接线。
 *
 * 对应《方法/04_前端与交互.md》：
 *   - 反馈：点击后 100ms 内必须有视觉变化
 *   - 状态：进行中禁用重复点击；成功给终态；失败停在可重试态
 *   - 进度：超过 1 秒要显示已用时间或阶段名，只转圈不算进度
 *   - 硬约束：每个等待设超时上限（默认 30 秒），到点主动中断并报错
 *   - 硬约束：失败提示保护期 ≥ 10 秒，不能被自动刷新抹掉
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ext = fs.readFileSync(path.join(root, 'src', 'extension.ts'), 'utf8');
const css = fs.readFileSync(path.join(root, 'resources', 'webview', 'main.css'), 'utf8');
const i18n = fs.readFileSync(path.join(root, 'src', 'i18n.ts'), 'utf8');

const htmlStart = ext.indexOf('return `<!DOCTYPE html>');
if (htmlStart < 0) {
  console.error('  FAIL  找不到 webview 模板起点，无法切分宿主段与前端段');
  process.exit(1);
}
const host = ext.slice(0, htmlStart);
const view = ext.slice(htmlStart);

const WRITE_ACTIONS = [
  'createMultiWindow', 'startMultiWindow', 'stopMultiWindow', 'focusMultiWindow',
  'updateMultiWindow', 'deleteMultiWindow', 'importCockpitCandidate',
];
const ALL_ACTIONS = [...WRITE_ACTIONS, 'listMultiWindows'];

let failures = 0;
function gate(name, ok, detail = '') {
  console.log((ok ? '  PASS  ' : '  FAIL  ') + name + (ok || !detail ? '' : '  <- ' + detail));
  if (!ok) failures++;
}

function caseBody(name) {
  const start = host.indexOf("case '" + name + "':");
  if (start < 0) return '';
  const end = host.indexOf("\n      case '", start + 12);
  return host.slice(start, end < 0 ? host.length : end);
}

function renderBody() {
  const start = view.indexOf('function renderMultiWindows()');
  const end = view.indexOf('function selectMultiWindowCard(');
  return start < 0 ? '' : view.slice(start, end < 0 ? view.length : end);
}

console.log('[check_mw_feedback] 多开操作等待反馈闭环 …');

// ── V：Webview 前端 ──
gate('V1 前端存在 beginMwAction / endMwAction 生命周期',
  /function beginMwAction\(/.test(view) && /function endMwAction\(/.test(view),
  '旧代码点击后只 postMessage，没有任何等待态');
gate('V2 每个等待设 30 秒超时上限并主动收口报错',
  /MW_ACTION_TIMEOUT_MS\s*=\s*30000/.test(view) && /setTimeout\(\(\)\s*=>\s*endMwAction/.test(view),
  '旧代码没有超时上限，宿主挂起就是永久无响应');
gate('V3 等待超过 1 秒显示已用时间（进度，不只转圈）',
  /mwActionElapsed/.test(view) && /setInterval\(/.test(view),
  '旧代码没有进度反馈');
gate('V4 加载态按 mwPending 状态驱动渲染（列表重绘不丢反馈）',
  /mwPending/.test(view) && /is-loading/.test(renderBody()),
  '旧代码 renderMultiWindows 会重建 innerHTML，直接改 DOM class 会被冲掉');
gate('V5 失败提示保护期不少于 10 秒',
  /MW_ERROR_TOAST_MS\s*=\s*(?:1[0-9]{4}|[2-9][0-9]{4})/.test(view),
  '旧代码 error toast 默认 3 秒且会被顶掉');
gate('V6 前端接收宿主终态回报 mwActionDone',
  /msg\.type === 'mwActionDone'/.test(view) && /endMwAction\(msg\.key/.test(view),
  '旧代码操作结束前端无从判断，按钮/弹窗无法收口');

for (const action of ALL_ACTIONS) {
  gate(`V7.${action} 请求携带 actionKey`,
    new RegExp("type:\\s*'" + action + "'[^}]*actionKey").test(view),
    '缺 actionKey，终态回报无法与请求配对');
}

// ── H：宿主回报 ──
gate('H1 宿主存在统一的 mwActionDone 回报通道',
  /private _mwDone\(/.test(host) && /type:\s*'mwActionDone'/.test(host),
  '旧代码只有部分成功/失败弹 toast，其余静默');
for (const action of WRITE_ACTIONS) {
  const body = caseBody(action);
  gate(`H2.${action} 成功与失败都回报终态`,
    body.length > 0 && /_mwDone\(msg,\s*true/.test(body) && /_mwDone\(msg,\s*false/.test(body),
    '缺终态回报，前端等待态永远收不了口');
}
gate('H2.listMultiWindows 刷新完成回报终态',
  /_mwDone\(msg,\s*true/.test(caseBody('listMultiWindows')),
  '刷新按钮同样需要收口');

// ── C：现成资产接线与死代码 ──
gate('C1 CSS 已有 .inst-card-btn.is-loading 与 .btn-mini-spinner（复用不重造）',
  /\.inst-card-btn\.is-loading/.test(css) && /\.btn-mini-spinner/.test(css));
gate('C2 弹窗提交按钮补齐加载态样式',
  /\.primary\.is-loading/.test(css) && /\.primary\s+\.btn-mini-spinner/.test(css),
  '弹窗按钮不在 .mw-expand-drawer 作用域内，旧样式覆盖不到');
gate('C3 卡片按钮禁用态可见',
  /\.inst-card-btn:disabled/.test(css));
gate('C4 死代码 getAllKnownTags 已清理',
  !/getAllKnownTags/.test(ext),
  '该函数与 getTagList 完全重复且零引用');

// ── I：交互心智与双语 ──
const createFn = (() => {
  const s = view.indexOf('function submitCreateMultiWindow()');
  const e = view.indexOf('function openEditMultiWindow(');
  return s < 0 ? '' : view.slice(s, e < 0 ? view.length : e);
})();
gate('I1 新建提交前端防重名且不关闭弹窗',
  /multiWindows\.some\(/.test(createFn) && /mwNameDuplicate/.test(createFn) && !/closeCreateMultiWindow\(\);/.test(createFn),
  '旧代码提交后立刻关弹窗，重名报错时用户手输的名字全丢');
// ── X：多开核心交互（自愈切号 / 配置克隆 / 枚举可靠性）──
const mwSrc = fs.readFileSync(path.join(root, 'src', 'multiWindowManager.ts'), 'utf8');
const rtSrc = fs.readFileSync(path.join(root, 'src', 'ideRuntime.ts'), 'utf8');
gate('X1 自愈切号用 globalStorageUri 反推目录（扩展宿主 argv 没有 --user-data-dir）',
  /getAutoSwitchTargetForCurrentWindow[\s\S]{0,420}getEffectiveCurrentUserDataDir/.test(mwSrc),
  '旧实现读 process.argv，多开窗口会被误判成主窗口而跳过自动切号');
gate('X2 新建多开克隆主环境配置（排除缓存）',
  /PROFILE_COPY_EXCLUDE/.test(mwSrc) && /copyProfileDir/.test(mwSrc),
  '只建空目录会让新窗口像个刚装好的 IDE，设置/扩展状态全丢');
gate('X3 克隆过程有阶段进度回调',
  /onProgress\?\.\(t\('mwCopyProgress'/.test(mwSrc) && /mwProgress/.test(ext),
  '十几 MB 的复制没有进度反馈，用户会以为卡死');
gate('X4 克隆失败显式告知而非静默',
  /mwCopyFailed/.test(mwSrc), '失败后悄悄给空环境属于静默降级');
gate('X5 进程枚举清理 PowerShell BOM',
  /replace\(\/\^\\uFEFF\/, ''\)/.test(rtSrc),
  'BOM 会让 JSON.parse 抛错并被吞掉，枚举结果恒为空 → 卡片全显示已停止');
gate('X6 进程枚举失败留痕（不静默吞异常）',
  /ideRuntime\.enum\.wmic/.test(rtSrc) && /ideRuntime\.enum\.powershell/.test(rtSrc));

gate('I2 阶段名与超时文案中英双语齐全',
  ["'ui.mwActionTimeout'", "'ui.mwActionElapsed'", "'ui.mwNameDuplicate'", "'ui.mwDeleting'", "'ui.mwUpdating'", "'ui.mwRefreshing'", "'ui.mwImporting'"]
    .every(k => i18n.includes(k)),
  '缺 ui.* 词条，check-i18n 会 FAIL');

console.log(failures === 0
  ? '[check_mw_feedback] 全部通过 ✔'
  : `[check_mw_feedback] ${failures} 项失败 ✘`);
process.exit(failures === 0 ? 0 : 1);
