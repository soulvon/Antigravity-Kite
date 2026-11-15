import { StoredAccount } from './types';

/** 历史版本在导入/扫描时自动写入的来源或状态标签（大小写不敏感匹配） */
const LEGACY_AUTO_TAG_KEYS = new Set([
  'cockpit-tools',
  'antigravity-manager',
  'json-import',
  '需要重新授权',
  'needs re-auth',
]);

/** 判断是否为历史版本自动添加的遗留标签 */
export function isLegacyAutoTag(tag: unknown): boolean {
  return typeof tag === 'string' && LEGACY_AUTO_TAG_KEYS.has(tag.trim().toLowerCase());
}

/** 读取账号当前有效标签来源（已有数组型 tags 时不再回退旧 tag 字段，防止删除后复活） */
function readRawTags(account: StoredAccount): unknown[] {
  if (Array.isArray(account.tags)) return account.tags;
  if (typeof account.tag === 'string' && account.tag.trim()) return [account.tag];
  return [];
}

function compactTags(raw: unknown[], stripLegacy: boolean, excludeTag?: string): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const item of raw) {
    if (typeof item !== 'string') continue;
    const cleaned = item.trim();
    if (!cleaned) continue;
    if (stripLegacy && isLegacyAutoTag(cleaned)) continue;
    if (excludeTag !== undefined && cleaned === excludeTag) continue;
    if (seen.has(cleaned)) continue;
    seen.add(cleaned);
    out.push(cleaned);
  }
  return out;
}

/**
 * 规范化单个账号的标签存储：
 * - 将旧单数 `tag` 字段收敛到 `tags` 后清除 `tag`，彻底消除删除标签后的回退复活隐患
 * - 默认剔除历史自动添加的脏标签（同时保留全部用户自定义标签）
 */
export function normalizeAccountTags(
  account: StoredAccount,
  options?: { stripLegacy?: boolean }
): boolean {
  const stripLegacy = options?.stripLegacy !== false;
  const origTags = Array.isArray(account.tags) ? account.tags : undefined;
  const cleaned = compactTags(readRawTags(account), stripLegacy);

  let changed = false;
  if (Object.prototype.hasOwnProperty.call(account, 'tag')) {
    delete account.tag;
    changed = true;
  }

  const prevList = origTags ?? [];
  const sameList =
    cleaned.length === prevList.length &&
    cleaned.every((val, idx) => val === prevList[idx]);

  if (cleaned.length > 0) {
    if (!origTags || !sameList) {
      account.tags = cleaned;
      changed = true;
    }
  } else if (Object.prototype.hasOwnProperty.call(account, 'tags')) {
    delete account.tags;
    changed = true;
  }

  return changed;
}

/** 批量自愈账号列表中的历史遗留标签，返回发生改动的账号数量 */
export function sanitizeStoredAccounts(
  accounts: StoredAccount[],
  options?: { stripLegacy?: boolean }
): number {
  let modified = 0;
  for (const account of accounts) {
    if (account && normalizeAccountTags(account, options)) {
      modified++;
    }
  }
  return modified;
}

/** 从全部账号中永久删除指定标签，返回受影响账号数量 */
export function removeTagFromAccounts(accounts: StoredAccount[], targetTag: string): number {
  const target = targetTag.trim();
  if (!target) return 0;

  let affected = 0;
  for (const account of accounts) {
    if (!account) continue;
    const hasInTags = Array.isArray(account.tags) && account.tags.some(t => typeof t === 'string' && t.trim() === target);
    const hasInLegacy = typeof account.tag === 'string' && account.tag.trim() === target;
    if (!hasInTags && !hasInLegacy) continue;

    const remaining = compactTags(readRawTags(account), false, target);
    delete account.tag;
    if (remaining.length > 0) {
      account.tags = remaining;
    } else {
      delete account.tags;
    }
    affected++;
  }
  return affected;
}

