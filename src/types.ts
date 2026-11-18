export interface StoredAccount {
  email: string;
  accessToken: string;
  refreshToken?: string;
  expiresAt?: string;
  /** OpenID 身份令牌（IDE 状态库 OAuthInfo f5），缺失时身份/头像显示可能滞后 */
  idToken?: string;
  apiServerUrl?: string;
  name?: string;
  disabled?: boolean;
  tag?: string;
  tags?: string[];
  importMeta?: {
    source: 'oauth' | 'local' | 'manual';
    importedAt: string;
  };
  /** 配额快照（运行时缓存，不持久化） */
  usage?: UsageSnapshot;
  /** Cloud Code 项目 ID（缓存以加速后续查询与健康探针） */
  projectId?: string;
  /** 健康状态（封禁/登录失效检测，持久化到 accounts.json） */
  health?: AccountHealth;
  /** Kite 自身通过 refreshToken 刷出当前 accessToken 的 SHA256 前 16 位指纹（防外部低权 token 混用） */
  verifiedAtHash?: string;
  /** 最近一次由 Kite 刷新验证该 accessToken 的毫秒时间戳 */
  verifiedAt?: number;
}

/** 账号健康状态：封禁检测结论（读失败 = unknown，绝不当 ok） */
export interface AccountHealth {
  /**
   * ok=服务正常 / banned=违反服务条款被封 / auth_invalid=凭据失效需重登 /
   * unknown=收到响应但无法定性（如 5xx、license 403）/ unreachable=本地网络失败，探针没发出去，不是账号结论
   */
  status: 'ok' | 'banned' | 'auth_invalid' | 'unknown' | 'unreachable';
  /** 最近一次检测时间（ISO） */
  checkedAt: string;
  /** 检测失败时的原始错误摘要（悬停可见） */
  detail?: string;
}

export interface WebviewMessage {
  type: string;
  email?: string;
  [key: string]: unknown;
}

/** 单个模型的配额信息 */
export interface ModelQuota {
  label: string;
  modelId: string;
  remainingPercent: number;
  resetTime?: string;
}

/** 配额快照 */
export interface UsageSnapshot {
  /** 所有模型中最低的配额百分比 */
  minRemainingPercent: number;
  /** 模型配额列表 */
  models: ModelQuota[];
  /** 订阅级别 (FREE/PRO/ULTRA) */
  tierId?: string;
  /** 可用 AI 积分 */
  availableAICredits?: number;
  /** 拉取过程中的非致命失败明细（部分成功也必须暴露） */
  loadError?: string;
  /** 更新时间戳 */
  updatedAt?: number;
}
