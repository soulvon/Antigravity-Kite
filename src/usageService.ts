/**
 * 额度查询服务
 * 调用 Cloud Code API 获取账号配额信息
 */

import * as https from 'https';
import { StoredAccount, UsageSnapshot, AccountHealth } from './types';
import * as accountStore from './accountStore';
import { t } from './i18n';

const CLOUDCODE_DAILY_URL = 'https://daily-cloudcode-pa.googleapis.com';
const CLOUDCODE_PROD_URL = 'https://cloudcode-pa.googleapis.com';
const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const CLIENT_ID = '1071006060591-tmhssin2h21lcre235vtolojh4g403ep.apps.googleusercontent.com';
const CLIENT_SECRET = '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';
const HTTP_TIMEOUT_MS = 15000;
const OFFICIAL_IDE_VERSION = '1.20.5';
const GOOGLE_API_CLIENT_VERSION = '10.3.0';
const NODE_VERSION = '22.21.1';

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

function getCloudCodeMetadata(): Record<string, string> {
  return {
    ideName: 'antigravity',
    ideType: 'ANTIGRAVITY',
    ideVersion: OFFICIAL_IDE_VERSION,
    pluginVersion: OFFICIAL_IDE_VERSION,
    platform: getCloudCodePlatform(),
    updateChannel: 'stable',
    pluginType: 'GEMINI',
  };
}

/** loadCodeAssist 用的 User-Agent（含 google-api-nodejs-client） */
function getLoadCodeAssistUA(): string {
  return `antigravity/${OFFICIAL_IDE_VERSION} ${getOsName()}/${getArchName()} google-api-nodejs-client/${GOOGLE_API_CLIENT_VERSION}`;
}

/** fetchAvailableModels 用的 User-Agent */
function getCloudCodeUA(): string {
  return `antigravity/${OFFICIAL_IDE_VERSION} ${getOsName()}/${getArchName()}`;
}

/**
 * retrieveUserQuotaSummary 用的 User-Agent。
 * 服务端按 UA 识别客户端身份，两者返回的分组不同（2026-11-06 实测，同一账号同一时刻）：
 * - IDE 格式 `antigravity/x.y.z win/amd64`          → 4 桶，缺 Gemini 4 Argon 组
 * - 客户端格式 `antigravity/x.y.z (aidev_client; …)` → 5 桶，多出 gemini-argon-wtu-weekly
 * 版本号影响 3p 组是否返回（1.20.5 缺 Gemini 组），故仍固定 2.25.0。
 */
const SUMMARY_IDE_VERSION = '2.25.0';
const SUMMARY_CLIENT_ID = '1003475615';
function getSummaryUA(): string {
  return `antigravity/${SUMMARY_IDE_VERSION} (aidev_client; os_type=${getOsName()}; arch=${getArchName()}; cl=${SUMMARY_CLIENT_ID})`;
}

/** 刷新 accessToken（Google 刷新响应可能携带 id_token，一并取回） */
export async function refreshAccessToken(refreshToken: string): Promise<{ accessToken: string; idToken?: string } | null> {
  return new Promise((resolve) => {
    const postData = new URLSearchParams({
      client_id: CLIENT_ID,
      client_secret: CLIENT_SECRET,
      refresh_token: refreshToken,
      grant_type: 'refresh_token'
    }).toString();
    const url = new URL(TOKEN_URL);
    const options = {
      hostname: url.hostname,
      path: url.pathname,
      method: 'POST' as const,
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'Content-Length': Buffer.byteLength(postData)
      }
    };
    const req = https.request(options, (res) => {
      // 严禁字符串拼接 chunk：多字节 UTF-8 跨切片会被截断成乱码
      const chunks: Buffer[] = [];
      res.on('data', (chunk: Buffer) => chunks.push(chunk));
      res.on('end', () => {
        try {
          const json = JSON.parse(Buffer.concat(chunks).toString('utf8'));
          if (!json.access_token) { resolve(null); return; }
          resolve({
            accessToken: json.access_token,
            idToken: typeof json.id_token === 'string' ? json.id_token : undefined,
          });
        } catch { resolve(null); }
      });
    });
    req.on('error', () => resolve(null));
    req.setTimeout(10000, () => { req.destroy(); resolve(null); });
    req.write(postData);
    req.end();
  });
}

/** 确保 token 有效，必要时刷新。minValidityMs：剩余有效期低于该值即刷新（切号链路要求 5 分钟） */
export async function ensureFreshToken(account: StoredAccount, minValidityMs = 60000): Promise<string> {
  // 检查是否过期
  if (account.expiresAt) {
    const expiresMs = new Date(account.expiresAt).getTime();
    if (Date.now() < expiresMs - minValidityMs) {
      return account.accessToken; // 还有效
    }
  }
  // 尝试刷新
  if (account.refreshToken) {
    const refreshed = await refreshAccessToken(account.refreshToken);
    if (refreshed) {
      // 更新存储
      const newExpiry = new Date(Date.now() + 3600000).toISOString();
      const updates: Partial<StoredAccount> = { accessToken: refreshed.accessToken, expiresAt: newExpiry };
      if (refreshed.idToken) updates.idToken = refreshed.idToken;
      accountStore.update(account.email, updates);
      return refreshed.accessToken;
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

/** 从官方摘要构建窗口级配额（全中文标签：5h / 周额度；没有的数据不生成条目） */
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
      const fraction = bucket.remainingFraction;
      const percent = typeof fraction === 'number' && fraction >= 0 && fraction <= 1
        ? Math.round(fraction * 100)
        : 100;
      const familyLabel = FAMILY_LABELS[mapped.family];
      modelQuotas.push({
        label: mapped.window === '5h' ? `${familyLabel} 5h` : `${familyLabel} 周额度`,
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
function extractQuotaFromModels(response: CloudCodeQuotaResponse['models']): UsageSnapshot {
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
      const fraction = quota?.remainingFraction;
      const percent = typeof fraction === 'number' && fraction >= 0 && fraction <= 1
        ? Math.round(fraction * 100)
        : 100;

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
    minRemainingPercent: minPercent,
    models: modelQuotas,
    updatedAt: Date.now(),
  };
}

/**
 * 查询单个账号的额度
 */
export async function fetchUsage(account: StoredAccount): Promise<UsageSnapshot> {
  if (!account.accessToken && !account.refreshToken) {
    throw new Error('No access token');
  }

  // 0. 确保 token 有效
  const accessToken = await ensureFreshToken(account);

  // 1. 获取项目信息（projectId、tierId、availableAICredits）
  const projectInfo = await loadProjectInfo(accessToken);

  // 2. 获取配额模型（模型级数据，作为摘要失败时的可见降级来源）
  const modelsResponse = await fetchAvailableModels(accessToken, projectInfo.projectId);

  // 3. 优先取官方窗口级摘要（retrieveUserQuotaSummary，含 5h/Weekly 双窗真数据）；
  //    摘要失败时退回模型级推断并显式标注错误，绝不静默吞掉失败
  let snapshot: UsageSnapshot;
  try {
    const summary = await fetchQuotaSummary(accessToken, projectInfo.projectId);
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
    console.warn('[UsageService] 周限摘要获取失败，退回模型级推断:', reason);
    snapshot = extractQuotaFromModels(modelsResponse.models);
    snapshot.loadError = t('errQuotaSummaryFallback') + reason;
  }

  // 4. 补充订阅级别和 AI 积分
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

/**
 * 批量查询多个账号的额度
 */
export async function fetchUsageBatch(
  accounts: StoredAccount[],
  onProgress?: (email: string, result: UsageSnapshot | Error) => void,
): Promise<Map<string, UsageSnapshot>> {
  const results = new Map<string, UsageSnapshot>();

  for (const account of accounts) {
    try {
      const snapshot = await fetchUsage(account);
      results.set(account.email, snapshot);
      onProgress?.(account.email, snapshot);
    } catch (err) {
      const error = err instanceof Error ? err : new Error(String(err));
      console.error(`[UsageService] Failed to fetch quota for ${account.email}:`, error.message);
      onProgress?.(account.email, error);
    }
  }

  return results;
}

// ── 账号健康检测（封号识别） ─────────────────────────────────────────────
// 2026-11-08 真机实测（8 号池 × {Node fetch, Chrome 指纹} × {gemini, claude} 对照 IDE 报错）定案：
// - 封禁（ToS）只在推理端点 generateContent 现形：403 + reason=TOS_VIOLATION；
//   ToS 检查先于配额检查（额度耗尽的号用 2.5-flash 探测照样 403 ToS），固定模型即可。
// - 元数据端点（loadCodeAssist/fetchAvailableModels/retrieveUserQuotaSummary）对封禁完全隐身，
//   被封号照样 200 + 额度满格——所以额度刷新成功绝不能当作健康依据。
// - 429 RESOURCE_EXHAUSTED = 配额耗尽/瞬时限流，与封禁无关（对齐 Antigravity-Manager 语义：
//   其反代对短 RetryInfo 的 429 做同号 grace retry，属日常现象）。
//   卡片额度满格仍可能 429：官方下发口径 ≠ 服务端真实准入池，勿拿额度反驳 429。
// 判定签名同时参照 Antigravity-Manager（lbjlaq）proxy/handlers/common.rs。

const TOS_BAN_PATTERN = /tos_violation|violation of terms of service|disabled in this account/i;
const AUTH_FAIL_PATTERN = /auth_expired|invalid_grant|invalid_credentials|unauthenticated|http 401\b|no access token/i;

/** 从错误文本归类健康状态：读失败 = unknown，绝不当 ok */
export function classifyAccountError(message: string): AccountHealth['status'] {
  if (TOS_BAN_PATTERN.test(message)) return 'banned';
  if (AUTH_FAIL_PATTERN.test(message)) return 'auth_invalid';
  return 'unknown';
}

/** 推理探针响应（只看状态码与错误签名，不打印 token） */
interface ProbeResult {
  status: number;
  body: string;
}

/** 推理端点探测：generateContent（prod），1 token 损耗；探测模型固定 2.5-flash（ToS 检查先于配额检查） */
async function probeGenerateContent(
  accessToken: string,
  project?: string,
): Promise<ProbeResult> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), HTTP_TIMEOUT_MS);
  try {
    const response = await fetch(`${CLOUDCODE_PROD_URL}/v1internal:generateContent`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${accessToken}`,
        'User-Agent': getCloudCodeUA(),
        'x-goog-api-client': `gl-node/${NODE_VERSION}`,
        'Content-Type': 'application/json',
        'Accept': '*/*',
        'Accept-Encoding': 'gzip, deflate, br',
      },
      body: JSON.stringify({
        project: project || 'aicode-consumers',
        model: 'gemini-2.5-flash',
        request: {
          contents: [{ role: 'user', parts: [{ text: 'hi' }] }],
          generationConfig: { maxOutputTokens: 1 },
        },
        userAgent: 'antigravity',
        requestId: `kite-health-${Date.now()}`,
      }),
      signal: controller.signal,
    });
    return { status: response.status, body: await response.text() };
  } finally {
    clearTimeout(timeout);
  }
}

/**
 * 单账号健康探针（两步，≈2s/号）：
 * 1) loadCodeAssist 拿 project + 抓凭据失效（401 在这里现形）
 * 2) generateContent 1-token 推理——封禁（ToS）唯一现形点
 * 分类：200/429=ok（429 是没量不是封）、403 ToS=banned、401=auth_invalid、其余=unknown。
 */
export async function checkAccountHealth(account: StoredAccount): Promise<AccountHealth> {
  const checkedAt = new Date().toISOString();
  const fail = (status: AccountHealth['status'], detail: string): AccountHealth =>
    ({ status, checkedAt, detail: detail.slice(0, 300) });
  try {
    if (!account.accessToken && !account.refreshToken) {
      return fail('auth_invalid', 'No access token');
    }
    const accessToken = await ensureFreshToken(account);

    // 1) project + 凭据层（401 在这里现形）
    let projectId: string | undefined;
    try {
      const data = await loadCodeAssistRequest<LoadCodeAssistResponse>(
        { metadata: getCloudCodeMetadata(), mode: 'FULL_ELIGIBILITY_CHECK' },
        accessToken,
      );
      const proj = data.cloudaicompanionProject;
      projectId = typeof proj === 'string' ? proj : proj?.id;
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      if (/auth_expired|http 401/i.test(msg)) return fail('auth_invalid', msg);
      // 元数据失败不致命：project 缺省走共享池，继续推理探测
    }

    // 2) 推理探测——封禁唯一现形点
    const res = await probeGenerateContent(accessToken, projectId);
    if (res.status >= 200 && res.status < 300) {
      return { status: 'ok', checkedAt };
    }
    const combined = `HTTP ${res.status}: ${res.body}`;
    if (TOS_BAN_PATTERN.test(combined)) return fail('banned', combined);
    if (res.status === 401) return fail('auth_invalid', combined);
    // 429 = 配额耗尽/限流：没封，量的事额度条负责（detail 留痕，悬停可见）
    if (res.status === 429) {
      return { status: 'ok', checkedAt, detail: combined.slice(0, 300) };
    }
    // 其余（license 403 / 5xx / 异常码）不装懂
    return fail('unknown', combined);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return { status: classifyAccountError(msg), checkedAt, detail: msg.slice(0, 300) };
  }
}
