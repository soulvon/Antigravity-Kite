#!/usr/bin/env node
/**
 * 防泄漏门控 —— 内部资料不得进入公开仓库（Antigravity Kite）
 *
 *   node scripts/check-no-leak.mjs          全量（本地收工 / 发布前）
 *   node scripts/check-no-leak.mjs --fast   提交前（暂存区 + 仓库内物理检查）
 *
 * 五道闸：
 *   [A] 仓库内不得出现内部资料路径
 *   [B] 已跟踪文件不得命中黑名单
 *   [C] 已跟踪文本不得含本机绝对路径与隔离目录名
 *   [D] 暂存区新增文件不得命中黑名单
 *   [E] 远端已公开清单（仅告警）
 */
import fs from 'node:fs';
import path from 'node:path';
import { execSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const fast = process.argv.includes('--fast');
const SELF = 'scripts/check-no-leak.mjs';
let passed = 0, failed = 0, warned = 0;

function ok(name, cond, detail = '') {
  if (cond) { passed++; console.log(`  ✅ ${name}`); }
  else { failed++; console.log(`  ❌ ${name}${detail ? ' — ' + detail : ''}`); }
}
function warn(name, detail = '') {
  warned++;
  console.log(`  ⚠ 提示 ${name}${detail ? ' — ' + detail : ''}`);
}
function section(name) { console.log(`\n■ ${name}`); }
function git(cmd) {
  try { return execSync(`git ${cmd}`, { cwd: root, encoding: 'utf8', stdio: 'pipe' }); }
  catch { return ''; }
}
function lines(t) { return t.split('\n').filter(Boolean); }

const INTERNAL_PATHS = [
  ['.codebuddy/', 'IDE 的 AI 配置、模型密钥与技能资产', false],
  ['devloop.project.json', '本机工具绑定', false],
  ['x.identifier', '空占位文件', false],
  ['AGENTS.md', 'AI 操作手册（含本机路径）', true],
  ['反重力风筝.md', '内部笔记', true],
  ['spec.md', '设计文档', true],
];
const INTERNAL_PATTERNS = [
  [/^[^/]*alive\d*\.(json|zip)$/i, '账号池导出'],
  [/^.*\.(vsix|tgz)$/i, '本地构建产物'],
];

const LOCAL_PATH_RE = /[A-Za-z]:[\\/](?:Users|Ailoop|project|情报|内容生产|SCRAG)(?:[\\/]|$)/;
const LOCAL_PATH_ALLOW = [
  /[A-Za-z]:[\\/]Users[\\/]test(?![\w-])/i,
  /[A-Za-z]:[\\/]Users[\\/]Test User(?![\w-])/i,
  /[A-Za-z]:[\\/]Users[\\/]<user>(?![\w-])/i,
  /[A-Za-z]:[\\/]project[\\/]demo(?![\w-])/i,
];
const LOCAL_DIR_HINT = process.env.ANYBRIDGE_LOCAL_DIR || '仓库之外的本地资料目录';
const LOCAL_DIR_NAME_RE = new RegExp(['Antigravity-Kite', 'local'].join('-') + '[\\\\/]', 'i');

function realLocalPathLines(text) {
  const bad = [];
  text.split('\n').forEach((line, i) => {
    if (LOCAL_PATH_RE.test(line) && !LOCAL_PATH_ALLOW.some(re => re.test(line))) bad.push(i + 1);
  });
  return bad;
}
function matchInternal(file) {
  const norm = file.replace(/\\/g, '/').replace(/^"|"$/g, '');
  for (const [prefix, label, keepLocal] of INTERNAL_PATHS) {
    if (prefix.endsWith('/') ? norm.startsWith(prefix) : norm === prefix) return label;
  }
  for (const [re, label] of INTERNAL_PATTERNS) if (re.test(norm)) return label;
  return null;
}

console.log('🔒 防泄漏门控：内部资料不得进入公开仓库');
console.log(`   本地隔离区：${LOCAL_DIR_HINT}`);

section('物理隔离（内部资料不在仓库内）');
{
  const present = INTERNAL_PATHS.filter(([p, , keepLocal]) => !keepLocal && fs.existsSync(path.join(root, p)));
  ok('仓库内无内部资料路径', present.length === 0,
    present.map(([p, l]) => `${p}(${l})`).join(', '));
}

section('索引层（已跟踪文件）');
const tracked = lines(git('ls-files'));
ok('已跟踪文件总数可读', tracked.length > 0, 'git ls-files 返回空');
{
  const bad = tracked.map(f => [f, matchInternal(f)]).filter(([, l]) => l);
  ok('已跟踪文件无内部资料', bad.length === 0,
    bad.slice(0, 5).map(([f, l]) => `${f}(${l})`).join(', ') +
    (bad.length > 5 ? ` …共 ${bad.length} 个 → git rm --cached` : ''));
  const keyed = tracked.filter(f => /\.(json|env|key|pem)$/i.test(f) && !/package(-lock)?\.json|tsconfig/i.test(f));
  for (const f of keyed) {
    let text = '';
    try { text = fs.readFileSync(path.join(root, f), 'utf8'); } catch { continue; }
    if (/"?(apiKey|api_key|token|secret)"?\s*[:=]\s*["'][^"']{8,}["']/i.test(text)) {
      ok(`配置文件无真实凭据（${f}）`, false, '发现疑似 key，移出仓库');
    }
  }
}

section('内容层（本机绝对路径）');
{
  const scanRe = /\.(md|json|html|txt|mjs|cjs|ts|rs|toml)$/i;
  const hits = [], named = [];
  for (const f of tracked) {
    if (!scanRe.test(f) || f === SELF) continue;
    let text = '';
    try { text = fs.readFileSync(path.join(root, f), 'utf8'); } catch { continue; }
    const bad = realLocalPathLines(text);
    if (bad.length) hits.push(`${f}:${bad[0]}`);
    if (LOCAL_DIR_NAME_RE.test(text)) named.push(f);
  }
  ok('已跟踪文本无本机绝对路径', hits.length === 0,
    hits.slice(0, 5).join(', ') + (hits.length > 5 ? ` …共 ${hits.length} 个` : ''));
  ok('已跟踪文本未提及本地资料目录', named.length === 0, named.join(', '));
}

section('暂存区（本次提交）');
{
  const added = lines(git('diff --cached --name-only --diff-filter=AM'));
  const badInternal = added.map(f => [f, matchInternal(f)]).filter(([, l]) => l);
  ok('暂存区无新增内部资料', badInternal.length === 0,
    badInternal.map(([f, l]) => `${f}(${l})`).join(', '));
  const leaked = [], leakedNames = [];
  for (const f of added) {
    if (!/\.(md|json|html|mjs|cjs|ts|toml)$/i.test(f) || f === SELF) continue;
    let text = '';
    try { text = git(`show :${JSON.stringify(f)}`); } catch { continue; }
    const badLines = realLocalPathLines(text);
    if (badLines.length) leaked.push(`${f}:${badLines[0]}`);
    if (LOCAL_DIR_NAME_RE.test(text)) leakedNames.push(f);
  }
  ok('暂存内容无本机绝对路径', leaked.length === 0, leaked.join(', '));
  ok('暂存内容未提及本地资料目录', leakedNames.length === 0, leakedNames.join(', '));
}

if (!fast) {
  section('远端层（历史遗留，仅告警）');
  const hasRemote = git('rev-parse --verify origin/main').trim() !== '';
  if (!hasRemote) {
    console.log('  ℹ 无 origin/main 引用（干净检出或 CI），跳过远端核对');
  } else {
    const remoteFiles = lines(git('ls-tree -r --name-only origin/main'));
    const exposed = remoteFiles.filter(f => matchInternal(f));
    if (exposed.length === 0) { passed++; console.log('  ✅ 远端 main 无内部资料'); }
    else {
      const byLabel = {};
      for (const f of exposed) { const l = matchInternal(f) || '其他'; byLabel[l] = (byLabel[l] || 0) + 1; }
      warn(`远端 main 已公开 ${exposed.length} 个内部文件`,
        Object.entries(byLabel).map(([k, v]) => `${k} ${v} 个`).join('、') + '（历史不可回收，仅记录）');
    }
  }
}

console.log('\n════════════════════════════════════');
console.log(`通过 ${passed} ｜ 失败 ${failed} ｜ 提示 ${warned}`);
if (failed > 0) {
  console.log('❌ 防泄漏门控未通过。处置：迁到仓库之外的本地资料目录；已跟踪的用 git rm --cached。');
  process.exit(1);
}
console.log('✅ 防泄漏门控通过');
