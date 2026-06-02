export interface StoredAccount {
  email: string;
  accessToken: string;
  refreshToken?: string;
  expiresAt?: string;
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
}

export interface WebviewMessage {
  type: string;
  email?: string;
  accessToken?: string;
  refreshToken?: string;
  [key: string]: any;
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
  /** 更新时间戳 */
  updatedAt?: number;
}
