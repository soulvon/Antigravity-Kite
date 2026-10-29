/**
 * 额度查询服务
 * 调用 Cloud Code API 获取账号配额信息
 */

import * as https from 'https';
import { StoredAccount, UsageSnapshot } from './types';
import * as accountStore from './accountStore';

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

/** 刷新 accessToken */
async function refreshAccessToken(refreshToken: string): Promise<string | null> {
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
      let body = '';
      res.on('data', (chunk: Buffer | string) => body += chunk);
      res.on('end', () => {
        try {
          const json = JSON.parse(body);
          resolve(json.access_token || null);
        } catch { resolve(null); }
      });
    });
    req.on('error', () => resolve(null));
    req.setTimeout(10000, () => { req.destroy(); resolve(null); });
    req.write(postData);
    req.end();
  });
}

/** 确保 token 有效，必要时刷新 */
export async function ensureFreshToken(account: StoredAccount): Promise<string> {
  // 检查是否过期
  if (account.expiresAt) {
    const expiresMs = new Date(account.expiresAt).getTime();
    if (Date.now() < expiresMs - 60000) {
      return account.accessToken; // 还有效
    }
  }
  // 尝试刷新
  if (account.refreshToken) {
    const newToken = await refreshAccessToken(account.refreshToken);
    if (newToken) {
      // 更新存储
      const newExpiry = new Date(Date.now() + 3600000).toISOString();
      accountStore.update(account.email, { accessToken: newToken, expiresAt: newExpiry });
      return newToken;
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
 * 发送 fetchAvailableModels 请求（带重试）
 */
async function fetchModelsRequest<T>(
  body: object,
  accessToken: string,
  maxRetries = 3,
): Promise<T> {
  const baseUrl = CLOUDCODE_DAILY_URL;
  const url = `${baseUrl}/v1internal:fetchAvailableModels`;

  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), HTTP_TIMEOUT_MS);
    try {
      const response = await fetch(url, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${accessToken}`,
          'User-Agent': getCloudCodeUA(),
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
  throw new Error('fetchAvailableModels: max retries exceeded');
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

  // 提取订阅级别
  let tierId: string;
  if (data1.paidTier?.id) {
    const paidId = data1.paidTier.id.toLowerCase();
    if (paidId.includes('ultra')) {
      tierId = 'ULTRA';
    } else if (paidId.includes('pro')) {
      tierId = 'PRO';
    } else {
      tierId = data1.paidTier.name || data1.paidTier.id;
    }
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
      loadError = 'AI积分拉取失败: ' + (e instanceof Error ? e.message : String(e));
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
  return fetchModelsRequest<CloudCodeQuotaResponse>(payload, accessToken);
}

/** 黑名单模型（不计入配额显示） */
const MODEL_BLACKLIST = new Set([
  'chat_20706', 'chat_23310',
  'gemini-2.5-flash', 'gemini-2.5-flash-thinking', 'gemini-2.5-flash-lite', 'gemini-2.5-pro',
  'model_chat_20706', 'model_chat_23310',
  'model_google_gemini_2_5_flash', 'model_google_gemini_2_5_flash_thinking',
  'model_google_gemini_2_5_flash_lite', 'model_google_gemini_2_5_pro',
  'model_placeholder_m19',
]);

const GEMINI_PRO_PATTERN = /^gemini-\d+(?:\.\d+)?-pro-(high|low)/;
const GEMINI_FLASH_PATTERN = /^gemini-\d+(?:\.\d+)?-flash/;

/** 分组模型为 Claude / Gemini Pro / Gemini Flash，取每组最低百分比 */
function extractQuotaFromModels(response: CloudCodeQuotaResponse['models']): UsageSnapshot {
  const groups: Record<string, { minPct: number; resetTime?: string }> = {
    claude: { minPct: -1 },
    geminiPro: { minPct: -1 },
    geminiFlash: { minPct: -1 },
  };

  if (response) {
    for (const [key, model] of Object.entries(response)) {
      const modelId = (model.model || key).toLowerCase();
      const displayName = (model.displayName || '').toLowerCase();

      // 黑名单过滤
      if (MODEL_BLACKLIST.has(modelId)) continue;

      const quota = model.quotaInfo;
      const fraction = quota?.remainingFraction;
      const percent = typeof fraction === 'number' && fraction >= 0 && fraction <= 1
        ? Math.round(fraction * 100)
        : 100;

      // 分组
      let groupKey: string | null = null;
      if (modelId.startsWith('claude-') || modelId.startsWith('model_claude') || displayName.startsWith('claude ') || modelId.includes('gpt-oss')) {
        groupKey = 'claude';
      } else if (GEMINI_PRO_PATTERN.test(modelId) || displayName.includes(' pro')) {
        groupKey = 'geminiPro';
      } else if (GEMINI_FLASH_PATTERN.test(modelId) || displayName.includes(' flash')) {
        groupKey = 'geminiFlash';
      }

      if (groupKey) {
        const g = groups[groupKey];
        if (g.minPct === -1 || percent < g.minPct) {
          g.minPct = percent;
          g.resetTime = quota?.resetTime;
        }
      }
    }
  }

  const modelQuotas: import('./types').ModelQuota[] = [];
  const groupDefs: Array<{ key: string; label: string }> = [
    { key: 'claude', label: 'Claude' },
    { key: 'geminiPro', label: 'Gemini Pro' },
    { key: 'geminiFlash', label: 'Gemini Flash' },
  ];

  let minPercent = 100;
  for (const def of groupDefs) {
    const g = groups[def.key];
    if (g.minPct === -1) continue; // 没有该组模型
    const pct = g.minPct;
    modelQuotas.push({
      label: def.label,
      modelId: def.key,
      remainingPercent: pct,
      resetTime: g.resetTime,
    });
    if (pct < minPercent) minPercent = pct;
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

  // 2. 获取配额模型
  const modelsResponse = await fetchAvailableModels(accessToken, projectInfo.projectId);

  // 3. 提取配额信息
  const snapshot = extractQuotaFromModels(modelsResponse.models);

  // 4. 补充订阅级别和 AI 积分
  snapshot.tierId = projectInfo.tierId;
  snapshot.availableAICredits = projectInfo.availableAICredits;
  if (projectInfo.loadError) {
    snapshot.loadError = projectInfo.loadError;
  }
  if (snapshot.models.length === 0 && !snapshot.loadError) {
    snapshot.loadError = '响应中无可用配额模型（models 为空）';
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
