#!/usr/bin/env node
/**
 * 标签策略门控（禁止导入乱打默认标签 + 历史自愈清洗 + 全局删除闭环）
 *
 * 检查项：
 *   1. 导入源码（importService.ts / localReader.ts）严禁向账号自动写入默认 tag/tags
 *   2. 账号存储（accountStore.ts）在加载/写入路径强制接入自愈规范化，提供 removeTagEverywhere
 *   3. 宿主与前端具备全局 deleteTag 闭环（含二次确认、i18n 与已有标签删除入口）
 *   4. 编译产物 out/tagSanitizer.js 运行时断言：历史脏标签清理 + 用户标签保留 + 防复活 + 全局删除
 */
import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);

let failures = 0;
function gate(name, ok, detail = '') {
  console.log((ok ? '  PASS  ' : '  FAIL  ') + name + (ok || !detail ? '' : '  <- ' + detail));
  if (!ok) failures++;
}

const impSrc = fs.readFileSync(path.join(root, 'src', 'importService.ts'), 'utf8');
const lrSrc = fs.readFileSync(path.join(root, 'src', 'localReader.ts'), 'utf8');
const storeSrc = fs.readFileSync(path.join(root, 'src', 'accountStore.ts'), 'utf8');
const extSrc = fs.readFileSync(path.join(root, 'src', 'extension.ts'), 'utf8');

console.log('[check_tags] 标签自愈、导入零污染与全局删除闭环 …');

// 1. 导入路径禁写入默认标签
gate(
  'importService.ts 不自动写入 tag / tags 字段',
  !/\btags?\s*:/.test(impSrc),
  '发现 importService.ts 仍在赋值 tag/tags'
);
gate(
  'localReader.ts 不自动写入 tag / tags 字段',
  !/\btags?\s*:/.test(lrSrc),
  '发现 localReader.ts 仍在赋值 tag/tags'
);

// 2. 存储自愈与全局删除接口
gate(
  'accountStore.ts 加载时调用 sanitizeStoredAccounts 自愈历史标签',
  storeSrc.includes('sanitizeStoredAccounts') && storeSrc.includes('removeTagEverywhere'),
  '缺少 sanitizeStoredAccounts 或 removeTagEverywhere'
);

// 3. 宿主与 Webview 全局删除闭环
const htmlStart = extSrc.indexOf('return `<!DOCTYPE html>');
const host = htmlStart >= 0 ? extSrc.slice(0, htmlStart) : extSrc;
const view = htmlStart >= 0 ? extSrc.slice(htmlStart) : '';

gate(
  'extension.ts 宿主处理 deleteTag 消息并清理全量账号',
  host.includes("case 'deleteTag':") && host.includes('accountStore.removeTagEverywhere('),
  "宿主未接入 case 'deleteTag' 或未调用 accountStore.removeTagEverywhere"
);
gate(
  'extension.ts 前端已有标签渲染全局删除按钮并经二次确认发 deleteTag',
  view.includes('tag-edit-opt-del') && view.includes("type: 'deleteTag'") && view.includes("tl('confirmDeleteTag'"),
  '前端缺少 .tag-edit-opt-del、showConfirm 二次确认或 deleteTag 消息'
);

// 4. 运行时行为断言（编译产物 out/tagSanitizer.js）
const sanitizerJsPath = path.join(root, 'out', 'tagSanitizer.js');
if (!fs.existsSync(sanitizerJsPath)) {
  gate('out/tagSanitizer.js 运行时自愈与删除断言', false, '缺少编译产物 out/tagSanitizer.js');
} else {
  try {
    const mod = require(sanitizerJsPath);
    const sample = [
      { email: 'a@x.com', accessToken: 't', tag: 'cockpit-tools' },
      { email: 'b@x.com', accessToken: 't', tag: 'antigravity-manager' },
      { email: 'c@x.com', accessToken: 't', tag: 'json-import' },
      { email: 'd@x.com', accessToken: 't', tag: '需要重新授权' },
      { email: 'e@x.com', accessToken: 't', tags: ['Needs re-auth', 'VIP', '主力', 'VIP'] },
      // 曾编辑清空 tags 但旧 tag 残留（老 bug 复活触发器）
      { email: 'f@x.com', accessToken: 't', tag: 'cockpit-tools', tags: [] },
      // 老版单数自定义标签，应保留且迁入 tags
      { email: 'g@x.com', accessToken: 't', tag: '手工旧标签' },
    ];

    const cleanedCount = mod.sanitizeStoredAccounts(sample);
    assert.equal(cleanedCount, 7, '应将 7 条含脏数据/旧字段账号全部自愈规范');
    assert.equal(sample[0].tag, undefined);
    assert.equal(sample[0].tags, undefined);
    assert.equal(sample[1].tags, undefined);
    assert.equal(sample[2].tags, undefined);
    assert.equal(sample[3].tags, undefined);
    assert.deepEqual(sample[4].tags, ['VIP', '主力']);
    assert.equal(sample[5].tag, undefined);
    assert.equal(sample[5].tags, undefined);
    assert.equal(sample[6].tag, undefined);
    assert.deepEqual(sample[6].tags, ['手工旧标签']);

    // 幂等性验证：二次执行零修改
    assert.equal(mod.sanitizeStoredAccounts(sample), 0, '自愈后再次扫描应返回 0（幂等）');

    // 全局删除验证：删掉 'VIP'
    const affected = mod.removeTagFromAccounts(sample, 'VIP');
    assert.equal(affected, 1);
    assert.deepEqual(sample[4].tags, ['主力']);

    // 再删掉仅剩单个标签的账号上的 '手工旧标签'
    const affected2 = mod.removeTagFromAccounts(sample, '手工旧标签');
    assert.equal(affected2, 1);
    assert.equal(sample[6].tag, undefined);
    assert.equal(sample[6].tags, undefined);

    gate('out/tagSanitizer.js 运行时自愈、防复活与全局删除断言', true);
  } catch (err) {
    gate('out/tagSanitizer.js 运行时自愈、防复活与全局删除断言', false, err instanceof Error ? err.message : String(err));
  }
}

if (failures > 0) {
  console.error(`[check_tags] 失败 ${failures} 项`);
  process.exit(1);
}
console.log('[check_tags] ALL PASSED');

