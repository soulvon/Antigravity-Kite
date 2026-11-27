/**
 * 额度查询服务
 * - 当前活跃账号优先通过本机 Language Server（127.0.0.1 Daemon Hub RPC）直读配额
 * - 仅在手动刷新非活跃账号或本机 LS 不可用时，调用精简的 Cloud Code 元数据接口
 */

import { StoredAccount, UsageSnapshot, AccountHealth } from './types';
import * as accountStore from './accountStore';
import { t } from './i18n';
import { computeTokenFingerprint, refreshGoogleAccessToken } from './googleOAuth';
import { DaemonHubInfo, daemonHubRpcPost, discoverAliveHubDaemons } from './liveContextMeter';

export { computeTokenFingerprint } from './googleOAuth';

const CLOUDCODE_DAILY_URL = 'https://daily-cloudcode-pa.googleapis.com';
const CLOUDCODE_PROD_URL = 'https://cloudcode-pa.googleapis.com';
const HTTP_TIMEOUT_MS = 15000;
const LOCAL_LS_STATUS_TIMEOUT_MS = 3000;
const LOCAL_LS_QUOTA_TIMEOUT_MS = 5000;
const FALLBACK_IDE_VERSION = '2.35.2';
const GOOGLE_API_CLIENT_VERSION = '10.3.0';
const NODE_VERSION = '22.21.1';
const SUMMARY_CLIENT_ID = '1003475615';

interface CloudCodeQuotaResponse {
  models?: Record<string, {
    displayName?: string;
    model?: string;
    quotaInfo?: {
      remainingFraction?: number;
      resetTime?: string;
    };
  }>;
}

interface AvailableCredit {
  creditType?: string;
  creditAmount?: string;
  minimumCreditAmountForUsage?: string;
}

interface LoadCodeAssistTier {
  id?: string;
  name?: string;
  availableCredits?: AvailableCredit[];
}

interface LoadCodeAssistResponse {
  currentTier?: LoadCodeAssistTier;
  paidTier?: LoadCodeAssistTier;
  cloudaicompanionProject?: string | { id?: string };
}

function getOsName(): string {
  return process.platform === 'win32' ? 'windows' : process.platform === 'darwin' ? 'darwin' : 'linux';
}

function getArchName(): string {
  return process.arch === 'x64' ? 'amd64' : process.arch === 'arm64' ? 'arm64' : process.arch;
}

function getCloudCodePlatform(): string {
  const combined = `${getOsName()}/${getArchName()}`;
  switch (combined) {
    case 'darwin/amd64': return 'DARWIN_AMD64';
    case 'darwin/arm64': return 'DARWIN_ARM64';
    case 'linux/amd64': return 'LINUX_AMD64';
    case 'linux/arm64': return 'LINUX_ARM64';
    case 'windows/amd64': return 'WINDOWS_AMD64';
    default: return 'PLATFORM_UNSPECIFIED';
  }
}

/** 动态对齐本机存活官方 LS 版本号，避免多个接口出现分裂或过时版本号 */
function resolveClientIdeVersion(): string {
  try {
    const hubs = discoverAliveHubDaemons();
    for (const hub of hubs) {
      const ver = typeof hub.lsVersion === 'string' ? hub.lsVersion.trim() : '';
      if (/^\d+\.\d+\.\d+/.test(ver)) return ver;
    }
  } catch {
    /* 读取本机 Hub 版本失败时使用默认基线版本 */
  }
  return FALLBACK_IDE_VERSION;
}

function getCloudCodeMetadata(ideVersion = resolveClientIdeVersion()): Record<string, string> {
  return {
    ideName: 'antigravity',
    ideType: 'ANTIGRAVITY',
    ideVersion,
    pluginVersion: ideVersion,
    platform: getCloudCodePlatform(),
    updateChannel: 'stable',
    pluginType: 'GEMINI',
  };
}

/** loadCodeAssist 用的 User-Agent（含 google-api-nodejs-client） */
function getLoadCodeAssistUA(ideVersion = resolveClientIdeVersion()): string {
  return `antigravity/${ideVersion} ${getOsName()}/${getArchName()} google-api-nodejs-client/${GOOGLE_API_CLIENT_VERSION}`;
}

/** fetchAvailableModels 用的 User-Agent */
function getCloudCodeUA(ideVersion = resolveClientIdeVersion()): string {
  return `antigravity/${ideVersion} ${getOsName()}/${getArchName()}`;
}

/**
 * retrieveUserQuotaSummary 用的 User-Agent。
 * 客户端格式 `antigravity/x.y.z (aidev_client; …)` 返回完整分桶（含 Gemini 4 组），
 * 版本号动态与本机官方 LS 对齐，避免不同接口间版本号割裂。
 */
function getSummaryUA(ideVersion = resolveClientIdeVersion()): string {
  return `antigravity/${ideVersion} (aidev_client; os_type=${getOsName()}; arch=${getArchName()}; cl=${SUMMARY_CLIENT_ID})`;
}

/** 刷新 accessToken（Google 刷新响应可能携带 id_token，一并取回） */
export async function refreshAccessToken(refreshToken: string): Promise<{ accessToken: string; idToken?: string } | null> {
  const refreshed = await refreshGoogleAccessToken(refreshToken);
  if (!refreshed) return null;
  return {
    accessToken: refreshed.accessToken,
    idToken: refreshed.idToken,
  };
}

const tokenRefreshInFlight = new Map<string, Promise<string | null>>();

/** 确保 token 有效，必要时刷新（按邮箱并发去重）。minValidityMs：剩余有效期低于该值即刷新；forceRefresh：遇 401 时绕过缓存强制重刷 */
export async function ensureFreshToken(account: StoredAccount, minValidityMs = 60000, forceRefresh = false): Promise<string> {
  // 检查非空 accessToken 是否仍在有效期内
  if (!forceRefresh && account.accessToken && account.expiresAt) {
    const expiresMs = new Date(account.expiresAt).getTime();
    if (Date.now() < expiresMs - minValidityMs) {
      return account.accessToken; // 还有效
    }
  }
  // 尝试刷新（并发单飞去重，避免同一账号在刷新池/切号期间重复请求）
  if (account.refreshToken) {
    const key = account.email.toLowerCase();
    let pending = tokenRefreshInFlight.get(key);
    if (!pending) {
      const refreshToken = account.refreshToken;
      pending = (async () => {
        const refreshed = await refreshAccessToken(refreshToken);
        if (!refreshed) return null;
        const newExpiry = new Date(Date.now() + 3600000).toISOString();
        const now = Date.now();
        const fingerprint = computeTokenFingerprint(refreshed.accessToken);
        const updates: Partial<StoredAccount> = {
          accessToken: refreshed.accessToken,
          expiresAt: newExpiry,
          verifiedAtHash: fingerprint,
          verifiedAt: now,
        };
        if (refreshed.idToken) updates.idToken = refreshed.idToken;
        account.accessToken = refreshed.accessToken;
        account.expiresAt = newExpiry;
        account.verifiedAtHash = fingerprint;
        account.verifiedAt = now;
        if (refreshed.idToken) account.idToken = refreshed.idToken;
        accountStore.update(account.email, updates);
        return refreshed.accessToken;
      })().finally(() => {
        tokenRefreshInFlight.delete(key);
      });
      tokenRefreshInFlight.set(key, pending);
    }
    const freshToken = await pending;
    if (freshToken) {
      account.accessToken = freshToken;
      return freshToken;
    }
  }
  return account.accessToken; // 无法刷新，用旧的试试
}

/**
 * 发送 loadCodeAssist 请求（含 x-goog-api-client）
 */
async function loadCodeAssistRequest<T>(
  body: object,
  accessToken: string,
  useProductionUrl = false,
): Promise<T> {
  const baseUrl = useProductionUrl ? CLOUDCODE_PROD_URL : CLOUDCODE_DAILY_URL;
  const url = `${baseUrl}/v1internal:loadCodeAssist`;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), HTTP_TIMEOUT_MS);

  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${accessToken}`,
        'User-Agent': getLoadCodeAssistUA(),
        'x-goog-api-client': `gl-node/${NODE_VERSION}`,
        'Content-Type': 'application/json',
        'Accept': '*/*',
        'Accept-Encoding': 'gzip, deflate, br',
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    });

    const text = await response.text();
    if (response.status === 401) throw new Error('AUTH_EXPIRED');
    if (!response.ok) throw new Error(`HTTP ${response.status}: ${text.slice(0, 200)}`);
    return text ? JSON.parse(text) as T : {} as T;
  } finally {
    clearTimeout(timeout);
  }
}

/**
 * 发送 Cloud Code v1internal 请求（带重试；fetchAvailableModels 与 retrieveUserQuotaSummary 共用）
 */
async function cloudCodePost<T>(
  methodPath: string,
  body: object,
  accessToken: string,
  userAgent: string,
  maxRetries = 3,
): Promise<T> {
  const url = `${CLOUDCODE_DAILY_URL}/v1internal:${methodPath}`;

  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), HTTP_TIMEOUT_MS);
    try {
      const response = await fetch(url, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${accessToken}`,
          'User-Agent': userAgent,
          'Content-Type': 'application/json',
          'Accept-Encoding': 'gzip',
        },
        body: JSON.stringify(body),
        signal: controller.signal,
      });

      const text = await response.text();
      if (response.status === 401) throw new Error('AUTH_EXPIRED');
      if (!response.ok) {
        if (attempt < maxRetries && (response.status === 429 || response.status >= 500)) {
          await new Promise(r => setTimeout(r, 1000 * attempt));
          continue;
        }
        throw new Error(`HTTP ${response.status}: ${text.slice(0, 200)}`);
      }
      return text ? JSON.parse(text) as T : {} as T;
    } finally {
      clearTimeout(timeout);
    }
  }
  throw new Error(`${methodPath}: max retries exceeded`);
}

/**
 * 汇总可用 AI 积分
 */
function sumAvailableCredits(credits?: AvailableCredit[]): number | undefined {
  if (!Array.isArray(credits) || credits.length === 0) {
    return undefined;
  }
  let total = 0;
  let hasValid = false;
  for (const c of credits) {
    if (c.creditAmount) {
      const parsed = parseFloat(c.creditAmount.replace(/,/g, ''));
      if (Number.isFinite(parsed) && parsed > 0) {
        total += parsed;
        hasValid = true;
      }
    }
  }
  return hasValid ? Math.round(total) : undefined;
}

interface ProjectInfo {
  projectId?: string;
  tierId: string;  // FREE / PRO / ULTRA
  availableAICredits?: number;
  /** 拉取过程中的非致命失败明细（读失败=未知，必须暴露而不是静默兜底） */
  loadError?: string;
}

/**
 * 获取项目信息（项目 ID、订阅级别、AI 积分）
 * 需要两次调用：第一次获取 projectId，第二次带上 projectId 获取 credits
 */
async function loadProjectInfo(accessToken: string): Promise<ProjectInfo> {
  // 第一次调用：获取 projectId
  const data1 = await loadCodeAssistRequest<LoadCodeAssistResponse>(
    {
      metadata: getCloudCodeMetadata(),
      mode: 'FULL_ELIGIBILITY_CHECK',
    },
    accessToken,
  );

  // 提取 projectId
  let projectId: string | undefined;
  const proj = data1.cloudaicompanionProject;
  if (typeof proj === 'string' && proj) {
    projectId = proj;
  } else if (proj && typeof proj === 'object' && 'id' in proj) {
    projectId = (proj as { id?: string }).id;
  }

  // 提取订阅级别：一律透传上游原始值（name 优先——"Google AI Ultra 5x" 的倍数信息只在 name 里；
  // id 兜底），分类统一交给展示层（planTierClass/planTierLabel/displayTierLabel，与 Manager
  // normalize_subscription_tier 同款关键词表：helium/5x/20x/plus/starter/standard/gcp_ 全覆盖）。
  // 旧版在此归一 ULTRA/PRO 会压丢倍数与 Plus 档——v1.1.23 起废弃。
  let tierId: string;
  if (data1.paidTier?.id) {
    tierId = data1.paidTier.name || data1.paidTier.id;
  } else {
    tierId = 'FREE';
  }

  // 第二次调用：带上 projectId 获取 credits（使用 prod URL）
  let availableAICredits: number | undefined;
  let loadError: string | undefined;
  if (projectId && tierId !== 'FREE') {
    try {
      const data2 = await loadCodeAssistRequest<LoadCodeAssistResponse>(
        {
          metadata: getCloudCodeMetadata(),
          mode: 'FULL_ELIGIBILITY_CHECK',
          cloudaicompanionProject: projectId,
        },
        accessToken,
        true, // 使用 prod URL
      );
      availableAICredits = sumAvailableCredits(data2.paidTier?.availableCredits);
    } catch (e) {
      // 积分拉取失败不再静默：进快照 loadError，卡片可见
      loadError = t('errCreditsFetch') + (e instanceof Error ? e.message : String(e));
      console.warn('[UsageService]', loadError);
    }
  }

  return { projectId, tierId, availableAICredits, loadError };
}

/**
 * 获取配额模型信息
 */
async function fetchAvailableModels(
  accessToken: string,
  projectId?: string,
): Promise<CloudCodeQuotaResponse> {
  const payload = projectId ? { project: projectId } : {};
  return cloudCodePost<CloudCodeQuotaResponse>('fetchAvailableModels', payload, accessToken, getCloudCodeUA());
}

/** retrieveUserQuotaSummary 响应：官方窗口级配额摘要（5h + Weekly 双窗真数据） */
interface QuotaSummaryResponse {
  groups?: Array<{
    displayName?: string;
    description?: string;
    buckets?: Array<{
      bucketId?: string;
      displayName?: string;
      window?: string;
      resetTime?: string;
      remainingFraction?: number;
    }>;
  }>;
}

/**
 * 获取官方窗口级配额摘要（Claude/Gemini 各自的 5h 窗与周窗）
 */
async function fetchQuotaSummary(
  accessToken: string,
  projectId?: string,
): Promise<QuotaSummaryResponse> {
  const payload = projectId ? { project: projectId } : {};
  return cloudCodePost<QuotaSummaryResponse>('retrieveUserQuotaSummary', payload, accessToken, getSummaryUA());
}

/**
 * 官方 bucketId → 模型族 × 时间窗口。
 * 实测 bucketId：3p-5h / 3p-weekly（Claude 与 GPT 组）、gemini-5h / gemini-weekly（Gemini 组）；
 * gemini-argon-* 为 Gemini 4（Argon）独立配额池（包含 5h 与 Weekly 双窗，按前缀通配）。
 */
const SUMMARY_BUCKET_MAP: Record<string, { family: 'claude' | 'gemini' | 'argon'; window: '5h' | 'weekly' }> = {
  '3p-5h': { family: 'claude', window: '5h' },
  '3p-weekly': { family: 'claude', window: 'weekly' },
  'gemini-5h': { family: 'gemini', window: '5h' },
  'gemini-weekly': { family: 'gemini', window: 'weekly' },
  'gemini-argon-5h': { family: 'argon', window: '5h' },
  'gemini-argon-wtu-weekly': { family: 'argon', window: 'weekly' },
};

const FAMILY_LABELS: Record<'claude' | 'gemini' | 'argon', string> = {
  claude: 'Claude',
  gemini: 'Gemini',
  argon: 'Gemini 4',
};

function mapSummaryBucket(bucketId: string): { family: 'claude' | 'gemini' | 'argon'; window: '5h' | 'weekly' } | undefined {
  const direct = SUMMARY_BUCKET_MAP[bucketId];
  if (direct) return direct;
  if (bucketId.startsWith('gemini-argon-')) {
    if (bucketId.endsWith('-weekly') || bucketId.endsWith('weekly')) {
      return { family: 'argon', window: 'weekly' };
    }
    if (bucketId.endsWith('-5h') || bucketId.endsWith('5h')) {
      return { family: 'argon', window: '5h' };
    }
  }
  return undefined;
}

/**
 * 解析官方 remainingFraction 为百分比（0~100）：
 * - 合法有限数值 [0, 1] → Math.round(fraction * 100)
 * - Protobuf3 JSON 会省略零值字段，缺失 fraction 但存在有效 resetTime → 已耗尽（0%）
 * - 既无合法 fraction 又无有效 resetTime → 返回 null（跳过该条目，避免虚报 100%）
 */
function resolveQuotaPercent(fraction: unknown, resetTime?: string): number | null {
  if (typeof fraction === 'number' && Number.isFinite(fraction) && fraction >= 0 && fraction <= 1) {
    return Math.round(fraction * 100);
  }
  if (typeof resetTime === 'string' && resetTime.trim().length > 0 && Number.isFinite(Date.parse(resetTime))) {
    return 0;
  }
  return null;
}

/** 从官方摘要构建窗口级配额（标签跟随当前语言：5h / quotaWeekly；没有的数据不生成条目） */
export function extractQuotaFromSummary(response: QuotaSummaryResponse): import('./types').ModelQuota[] {
  const modelQuotas: import('./types').ModelQuota[] = [];
  const unmapped: string[] = [];
  for (const group of response?.groups || []) {
    for (const bucket of group.buckets || []) {
      const mapped = bucket.bucketId ? mapSummaryBucket(bucket.bucketId) : undefined;
      if (!mapped) {
        // 官方新增分组时必须暴露而不是静默少显示（历史上 Gemini 4 Argon 组就是这样丢失的）
        unmapped.push(`${group.displayName || '?'}/${bucket.bucketId || '(no id)'}`);
        continue;
      }
      const percent = resolveQuotaPercent(bucket.remainingFraction, bucket.resetTime);
      if (percent === null) continue;
      const familyLabel = FAMILY_LABELS[mapped.family];
      modelQuotas.push({
        label: mapped.window === '5h' ? `${familyLabel} 5h` : `${familyLabel} ${t('quotaWeekly')}`,
        modelId: `${mapped.family}:${mapped.window}`,
        remainingPercent: percent,
        resetTime: bucket.resetTime,
      });
    }
  }
  if (unmapped.length > 0) {
    console.warn('[UsageService] 未识别的配额分组（已忽略）:', unmapped.join(', '));
  }
  return modelQuotas;
}

/** 黑名单模型（不计入配额显示）：后台 tab 预览与内置 chat 占位模型 */
const MODEL_BLACKLIST = new Set([
  'chat_20706', 'chat_23310',
  'gemini-2.5-flash', 'gemini-2.5-flash-thinking', 'gemini-2.5-flash-lite', 'gemini-2.5-pro',
  'model_chat_20706', 'model_chat_23310',
  'model_google_gemini_2_5_flash', 'model_google_gemini_2_5_flash_thinking',
  'model_google_gemini_2_5_flash_lite', 'model_google_gemini_2_5_pro',
  'model_placeholder_m19', 'model_placeholder_m28',
]);

const WEEKLY_WINDOW_MS = 24 * 60 * 60 * 1000; // reset 距今超过 24h 视为周窗（CPA 同款语义：Claude 5h 窗 / Gemini 周窗）

interface FamilyWindow {
  family: 'claude' | 'gemini';
  window: '5h' | 'weekly';
  minPct: number;
  resetTime?: string;
}

/**
 * 按模型族 × 时间窗口分组（对齐 CPA Manager Plus 的显示语义）：
 * - 族：Claude（claude/anthropic/gpt/openai）与 Gemini（gemini）
 * - 窗口：resetTime 距今 < 24h 视为 5 小时窗，否则视为周窗
 * 每族每窗取最低百分比。
 */
export function extractQuotaFromModels(response: CloudCodeQuotaResponse['models']): UsageSnapshot {
  const windows = new Map<string, FamilyWindow>();

  if (response) {
    for (const [key, model] of Object.entries(response)) {
      const rawKey = key.toLowerCase();
      const rawModel = (model.model || '').toLowerCase();
      // 响应里 model 字段可能是服务端占位符 ID（MODEL_PLACEHOLDER_*），以 key 为正规模型 ID
      const modelId = rawKey.startsWith('model_') ? rawModel : rawKey;
      const displayName = (model.displayName || '').toLowerCase();
      const haystack = `${rawKey} ${rawModel} ${displayName}`;

      if (MODEL_BLACKLIST.has(rawKey) || MODEL_BLACKLIST.has(rawModel)) continue;

      const isClaudeFamily = /claude|anthropic|gpt|openai/.test(haystack);
      const isGeminiFamily = /gemini/.test(haystack);
      if (!isClaudeFamily && !isGeminiFamily) continue;

      const quota = model.quotaInfo;
      const percent = resolveQuotaPercent(quota?.remainingFraction, quota?.resetTime);
      if (percent === null) continue;

      const resetMs = quota?.resetTime ? Date.parse(quota.resetTime) : NaN;
      const window: '5h' | 'weekly' = Number.isFinite(resetMs) && (resetMs - Date.now()) > WEEKLY_WINDOW_MS ? 'weekly' : '5h';
      const family: 'claude' | 'gemini' = isClaudeFamily ? 'claude' : 'gemini';
      const mapKey = `${family}:${window}`;

      const existing = windows.get(mapKey);
      if (!existing || percent < existing.minPct) {
        windows.set(mapKey, { family, window, minPct: percent, resetTime: quota?.resetTime });
      }
    }
  }

  const modelQuotas: import('./types').ModelQuota[] = [];
  const familyOrder: Array<{ family: 'claude' | 'gemini'; label: string }> = [
    { family: 'claude', label: 'Claude' },
    { family: 'gemini', label: 'Gemini' },
  ];
  const windowOrder: Array<{ window: '5h' | 'weekly'; label: string }> = [
    { window: '5h', label: '5h' },
    { window: 'weekly', label: t('quotaWeekly') },
  ];

  let minPercent = 100;
  for (const f of familyOrder) {
    for (const w of windowOrder) {
      const entry = windows.get(`${f.family}:${w.window}`);
      if (!entry) continue;
      const label = `${f.label} ${w.label}`;
      modelQuotas.push({
        label,
        modelId: `${f.family}:${w.window}`,
        remainingPercent: entry.minPct,
        resetTime: entry.resetTime,
      });
      if (entry.minPct < minPercent) minPercent = entry.minPct;
    }
  }

  return {
    minRemainingPercent: modelQuotas.length > 0 ? minPercent : 0,
    models: modelQuotas,
    updatedAt: Date.now(),
  };
}

export interface LocalLsQuotaDeps {
  discoverHubs?: () => DaemonHubInfo[];
  rpcPost?: (
    hub: DaemonHubInfo,
    method: string,
    body: Record<string, unknown>,
    timeoutMs: number,
  ) => Promise<unknown>;
}

interface LocalUserStatusResponse {
  userStatus?: {
    email?: string;
    name?: string;
    userTier?: {
      id?: string;
      name?: string;
      availableCredits?: AvailableCredit[];
    };
    planStatus?: {
      planInfo?: {
        planName?: string;
        teamsTier?: string;
      };
    };
  };
}

interface LocalQuotaSummaryRpcResponse {
  response?: QuotaSummaryResponse;
  groups?: QuotaSummaryResponse['groups'];
}

/**
 * 零外网直连：通过本机存活的官方 Antigravity Language Server（127.0.0.1 Daemon Hub RPC）
 * 读取当前登录账号的订阅档位与双窗配额摘要。
 *
 * 严格校对 `userStatus.email === targetEmail`（忽略大小写）；
 * 若本机无存活 LS 或登录邮箱不匹配，一律 Fail-Closed 返回 null，绝不串号。
 */
export async function fetchUsageFromLocalLs(
  email: string,
  deps: LocalLsQuotaDeps = {},
): Promise<UsageSnapshot | null> {
  const targetLower = String(email || '').trim().toLowerCase();
  if (!targetLower) return null;

  const discoverHubs = deps.discoverHubs || (() => discoverAliveHubDaemons());
  const rpcPost = deps.rpcPost || daemonHubRpcPost;
  const hubs = discoverHubs();
  if (hubs.length === 0) return null;

  for (const hub of hubs.slice(0, 4)) {
    let statusRes: LocalUserStatusResponse;
    try {
      statusRes = (await rpcPost(hub, 'GetUserStatus', {}, LOCAL_LS_STATUS_TIMEOUT_MS)) as LocalUserStatusResponse;
    } catch {
      continue;
    }

    const userStatus = statusRes?.userStatus;
    const hubEmail = typeof userStatus?.email === 'string' ? userStatus.email.trim().toLowerCase() : '';
    if (!hubEmail || hubEmail !== targetLower) {
      continue;
    }

    const summaryRpc = (await rpcPost(
      hub,
      'RetrieveUserQuotaSummary',
      {},
      LOCAL_LS_QUOTA_TIMEOUT_MS,
    )) as LocalQuotaSummaryRpcResponse;
    const summaryPayload: QuotaSummaryResponse = summaryRpc?.response ?? { groups: summaryRpc?.groups };
    const summaryModels = extractQuotaFromSummary(summaryPayload);
    if (summaryModels.length === 0) {
      throw new Error(t('usNoQuotaBuckets'));
    }

    const userTier = userStatus?.userTier;
    const tierId = userTier?.name || userTier?.id || userStatus?.planStatus?.planInfo?.planName || 'FREE';
    const availableAICredits = sumAvailableCredits(userTier?.availableCredits);

    return {
      minRemainingPercent: Math.min(...summaryModels.map((m) => m.remainingPercent)),
      models: summaryModels,
      tierId,
      availableAICredits,
      updatedAt: Date.now(),
    };
  }

  return null;
}

export interface FetchUsageOptions {
  /** 已缓存的订阅级别（存在且已缓存 projectId 时可免重复打 loadCodeAssist） */
  existingTierId?: string;
  /** 已缓存的 AI 积分 */
  existingCredits?: number;
}

/**
 * 查询单个账号的额度（云端元数据路径，仅供用户手动查询非活跃备用号或本地 LS 不可用时的手动刷新）
 */
export async function fetchUsage(account: StoredAccount, opts: FetchUsageOptions = {}): Promise<UsageSnapshot> {
  if (!account.accessToken && !account.refreshToken) {
    throw new Error('No access token');
  }

  // 0. 确保 token 有效；若缓存 AT 被服务端提前 401 吊销且持有 refreshToken，自动强制重刷重试一次
  let accessToken = await ensureFreshToken(account);

  // 1. 已有 projectId 与订阅级别缓存时跳过 loadCodeAssist，单次查询仅发 1 次摘要请求
  let projectInfo: ProjectInfo;
  if (account.projectId && opts.existingTierId) {
    projectInfo = {
      projectId: account.projectId,
      tierId: opts.existingTierId,
      availableAICredits: opts.existingCredits,
    };
  } else {
    try {
      projectInfo = await loadProjectInfo(accessToken);
    } catch (firstErr) {
      const errText = firstErr instanceof Error ? firstErr.message : String(firstErr);
      if (account.refreshToken && /AUTH_EXPIRED|HTTP 401\b/i.test(errText)) {
        const refreshedToken = await ensureFreshToken(account, 60000, true);
        if (refreshedToken && refreshedToken !== accessToken) {
          accessToken = refreshedToken;
          projectInfo = await loadProjectInfo(accessToken);
        } else {
          throw firstErr;
        }
      } else {
        throw firstErr;
      }
    }
    if (projectInfo.projectId && projectInfo.projectId !== account.projectId) {
      account.projectId = projectInfo.projectId;
      accountStore.update(account.email, { projectId: projectInfo.projectId });
    }
  }

  // 2. 优先取官方窗口级摘要（retrieveUserQuotaSummary，含 5h/Weekly 双窗真数据）；
  //    遇 401 时强制刷新令牌重试一次；仅当摘要失败时才退回模型级推断并显式标注错误
  const fetchSummaryWithAuthRetry = async (): Promise<QuotaSummaryResponse> => {
    try {
      return await fetchQuotaSummary(accessToken, projectInfo.projectId);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (account.refreshToken && /AUTH_EXPIRED|HTTP 401\b/i.test(msg)) {
        const renewed = await ensureFreshToken(account, 60000, true);
        if (renewed && renewed !== accessToken) {
          accessToken = renewed;
          return fetchQuotaSummary(accessToken, projectInfo.projectId);
        }
      }
      throw err;
    }
  };

  let snapshot: UsageSnapshot;
  try {
    const summary = await fetchSummaryWithAuthRetry();
    const summaryModels = extractQuotaFromSummary(summary);
    if (summaryModels.length === 0) {
      throw new Error(t('usNoQuotaBuckets'));
    }
    snapshot = {
      minRemainingPercent: Math.min(...summaryModels.map(m => m.remainingPercent)),
      models: summaryModels,
      updatedAt: Date.now(),
    };
  } catch (e) {
    const reason = e instanceof Error ? e.message : String(e);
    if (/AUTH_EXPIRED|HTTP 401\b|TOS_VIOLATION/i.test(reason)) {
      throw e;
    }
    console.warn('[UsageService] 周限摘要获取失败，退回模型级推断:', reason);
    const modelsResponse = await fetchAvailableModels(accessToken, projectInfo.projectId);
    snapshot = extractQuotaFromModels(modelsResponse.models);
    snapshot.loadError = t('errQuotaSummaryFallback') + reason;
  }

  // 3. 补充订阅级别和 AI 积分
  snapshot.tierId = projectInfo.tierId;
  snapshot.availableAICredits = projectInfo.availableAICredits;
  if (projectInfo.loadError) {
    snapshot.loadError = snapshot.loadError
      ? snapshot.loadError + '；' + projectInfo.loadError
      : projectInfo.loadError;
  }
  if (snapshot.models.length === 0 && !snapshot.loadError) {
    snapshot.loadError = t('usNoQuotaModels');
  }

  return snapshot;
}

// ── 错误归类（供配额刷新异常留痕，不主动发起推理探测） ───────────────────

const TOS_BAN_PATTERN = /tos_violation|violation of terms of service|disabled in this account/i;
const AUTH_FAIL_PATTERN = /auth_expired|invalid_grant|invalid_credentials|unauthenticated|http 401\b|no access token/i;
/**
 * 本地网络/代理层失败签名。这类错误说明请求根本没拿到服务端响应，
 * 不能归类为账号封禁或凭据失效。
 */
const NETWORK_FAIL_PATTERN = /fetch failed|und_err_|econnreset|econnrefused|etimedout|enotfound|eai_again|epipe|ehostunreach|enetunreach|socket hang up|network (error|unavailable|unreachable)|proxy|tls|ssl|certificate|timeout|timed out|aborted|abort/i;

/** 展开 undici 的 error.cause，避免 detail 只剩无信息量的 "fetch failed" */
export function describeError(e: unknown): string {
  const err = e instanceof Error ? e : new Error(String(e));
  const cause = (err as Error & { cause?: { code?: string; message?: string } }).cause;
  if (!cause) return err.message;
  const parts = [cause.code, cause.message].filter(Boolean).join(' ');
  return parts ? `${err.message} | cause: ${parts}` : err.message;
}

/** 从错误文本归类健康状态：网络失败=unreachable（不是账号结论）；读失败绝不当 ok */
export function classifyAccountError(message: string): AccountHealth['status'] {
  if (TOS_BAN_PATTERN.test(message)) return 'banned';
  if (AUTH_FAIL_PATTERN.test(message)) return 'auth_invalid';
  if (NETWORK_FAIL_PATTERN.test(message)) return 'unreachable';
  return 'unknown';
}
