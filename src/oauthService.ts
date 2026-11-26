/**
 * Google OAuth 登录流程服务
 * 支持本机浏览器自动回调与跨设备（iPad / 手机 / 其他浏览器）复制链接 + 手动粘贴回调 URL
 */
import * as vscode from 'vscode';
import * as crypto from 'crypto';
import * as http from 'http';
import { StoredAccount } from './types';
import { t } from './i18n';
import { logWarn } from './logger';
import { httpRequest } from './httpClient';
import {
  OAUTH_CLIENT_ID,
  OAUTH_CLIENT_SECRET,
  OAUTH_SCOPES,
  OAUTH_TOKEN_URL,
  OAUTH_AUTH_URL,
  computeTokenFingerprint,
  fetchGoogleUserInfo,
} from './googleOAuth';

const CALLBACK_PORT_START = 11451;
const CALLBACK_PORT_RANGE = 100;
const OAUTH_TIMEOUT_MS = 10 * 60 * 1000;

export class OAuthCancelledError extends Error {
  constructor() {
    super(t('oauthCancelled'));
    this.name = 'OAuthCancelledError';
  }
}

export function isOAuthCancelledError(err: unknown): boolean {
  return err instanceof OAuthCancelledError || (err instanceof Error && err.name === 'OAuthCancelledError');
}

export interface ParsedOAuthCallback {
  ok: boolean;
  code?: string;
  state?: string;
  oauthError?: string;
  reason?: 'empty' | 'auth_url_not_callback' | 'oauth_error' | 'missing_code' | 'invalid_url';
}

export interface OAuthSessionOptions {
  openBrowser?: boolean;
  timeoutMs?: number;
}

export interface OAuthSession {
  readonly port: number;
  readonly redirectUri: string;
  readonly state: string;
  readonly authUrl: string;
  readonly promise: Promise<StoredAccount>;
  openInBrowser(): Promise<void>;
  submitCallbackUrl(rawInput: string): Promise<StoredAccount>;
  cancel(): void;
}

function randomState(): string {
  return crypto.randomBytes(24).toString('hex');
}

function successHtml(): string {
  return `<!DOCTYPE html><html><head><meta charset="utf-8"><title>${t('oauthSuccessTitle')}</title>
<style>body{font-family:-apple-system,sans-serif;display:flex;align-items:center;justify-content:center;height:100vh;margin:0;background:#1a1a2e;color:#eee}.box{max-width:400px;padding:24px;border-radius:12px;background:#16213e;text-align:center}h1{color:#4ade80;margin:0 0 10px;font-size:24px}p{margin:0;opacity:.85}</style></head>
<body><div class="box"><h1>${t('oauthSuccessTitle')}</h1><p>${t('oauthSuccessDesc')}</p></div></body></html>`;
}

function escapeHtml(s: string): string {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

export function failHtml(message: string): string {
  return `<!DOCTYPE html><html><head><meta charset="utf-8"><title>${t('oauthFailTitle')}</title>
<style>body{font-family:-apple-system,sans-serif;display:flex;align-items:center;justify-content:center;height:100vh;margin:0;background:#1a1a2e;color:#eee}.box{max-width:400px;padding:24px;border-radius:12px;background:#16213e;text-align:center}h1{color:#ef4444;margin:0 0 10px;font-size:24px}p{margin:0;opacity:.85}</style></head>
<body><div class="box"><h1>${t('oauthFailTitle')}</h1><p>${escapeHtml(message)}</p></div></body></html>`;
}

/**
 * 解析用户粘贴的 OAuth 回调内容：
 * - 完整回调 URL（如 http://127.0.0.1:11451/callback?state=...&code=...）
 * - 缺协议 loopback URL（如 127.0.0.1:11451/callback?state=...&code=...）
 * - 仅 query 串（如 ?state=...&code=... 或 state=...&code=...）
 */
export function parseOAuthCallbackInput(rawInput: string): ParsedOAuthCallback {
  const trimmed = String(rawInput || '').trim().replace(/^<+|>+$/g, '').trim();
  if (!trimmed) return { ok: false, reason: 'empty' };

  let params: URLSearchParams | null = null;
  if (/^https?:\/\//i.test(trimmed)) {
    try {
      const parsed = new URL(trimmed);
      if (parsed.hostname === 'accounts.google.com' && parsed.pathname.includes('/oauth2')) {
        return { ok: false, reason: 'auth_url_not_callback' };
      }
      params = parsed.searchParams;
    } catch {
      return { ok: false, reason: 'invalid_url' };
    }
  } else if (/^(?:127\.0\.0\.1|localhost)(?::\d+)?\//i.test(trimmed)) {
    try {
      const parsed = new URL(`http://${trimmed}`);
      params = parsed.searchParams;
    } catch {
      return { ok: false, reason: 'invalid_url' };
    }
  } else if (trimmed.startsWith('?') || /(?:^|&)(?:code|error)=/i.test(trimmed)) {
    params = new URLSearchParams(trimmed.startsWith('?') ? trimmed.slice(1) : trimmed);
  } else {
    return { ok: false, reason: 'invalid_url' };
  }

  const oauthError = params.get('error') || '';
  const state = params.get('state') || undefined;
  if (oauthError) {
    return { ok: false, reason: 'oauth_error', oauthError, state };
  }
  const code = params.get('code') || '';
  if (!code) {
    return { ok: false, reason: 'missing_code', state };
  }
  return { ok: true, code, state };
}

async function exchangeCodeForAccount(code: string, redirectUri: string): Promise<StoredAccount> {
  const tokenData = new URLSearchParams({
    code,
    client_id: OAUTH_CLIENT_ID,
    client_secret: OAUTH_CLIENT_SECRET,
    redirect_uri: redirectUri,
    grant_type: 'authorization_code',
  }).toString();

  const tokenRes = await httpRequest(OAUTH_TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: tokenData,
    timeoutMs: 15_000,
  });
  if (tokenRes.status !== 200) {
    throw new Error(`Token exchange failed: HTTP ${tokenRes.status}`);
  }

  const tokenJson = JSON.parse(tokenRes.body) as Record<string, unknown>;
  const accessToken = typeof tokenJson.access_token === 'string' ? tokenJson.access_token : '';
  const refreshToken = typeof tokenJson.refresh_token === 'string' ? tokenJson.refresh_token : undefined;
  const expiresIn = typeof tokenJson.expires_in === 'number' ? tokenJson.expires_in : 3600;

  if (!accessToken) {
    throw new Error(t('oauthNoAccessToken'));
  }

  const userInfo = await fetchGoogleUserInfo(accessToken);
  if (!userInfo) {
    throw new Error(t('oauthUserInfoFailed', 'request'));
  }

  const email = userInfo.email || '';
  const name = userInfo.name || email.split('@')[0];
  if (!email) {
    throw new Error(t('oauthNoEmail'));
  }

  const now = Date.now();
  const expiresAt = new Date(now + expiresIn * 1000).toISOString();

  return {
    email,
    accessToken,
    refreshToken,
    expiresAt,
    name,
    idToken: typeof tokenJson.id_token === 'string' ? tokenJson.id_token : undefined,
    verifiedAtHash: computeTokenFingerprint(accessToken),
    verifiedAt: now,
    importMeta: {
      source: 'oauth',
      importedAt: new Date(now).toISOString(),
    },
  };
}

async function findAvailablePort(): Promise<number> {
  for (let i = 0; i < CALLBACK_PORT_RANGE; i++) {
    const port = CALLBACK_PORT_START + i;
    const available = await new Promise<boolean>((resolve) => {
      const server = http.createServer();
      server.once('error', () => resolve(false));
      server.once('listening', () => {
        server.close();
        resolve(true);
      });
      server.listen(port, '127.0.0.1');
    });
    if (available) return port;
  }
  throw new Error(t('oauthNoPort'));
}

/** 创建可控制的 OAuth 会话：同时监听本地 loopback 回调并支持手动粘贴回调 URL 提交 */
export async function createOAuthSession(options: OAuthSessionOptions = {}): Promise<OAuthSession> {
  const port = await findAvailablePort();
  const redirectUri = `http://127.0.0.1:${port}/callback`;
  const state = randomState();
  const authUrl = `${OAUTH_AUTH_URL}?` + new URLSearchParams({
    client_id: OAUTH_CLIENT_ID,
    redirect_uri: redirectUri,
    response_type: 'code',
    scope: OAUTH_SCOPES.join(' '),
    state,
    access_type: 'offline',
    prompt: 'consent',
  }).toString();
  const timeoutMs = typeof options.timeoutMs === 'number' && options.timeoutMs > 0
    ? options.timeoutMs
    : OAUTH_TIMEOUT_MS;

  let server: http.Server | null = null;
  let timer: NodeJS.Timeout | null = null;
  let settled = false;
  let inFlightExchange: Promise<StoredAccount> | null = null;
  let resolvePromise!: (acc: StoredAccount) => void;
  let rejectPromise!: (err: unknown) => void;

  const promise = new Promise<StoredAccount>((resolve, reject) => {
    resolvePromise = resolve;
    rejectPromise = reject;
  });

  const cleanup = () => {
    if (timer) clearTimeout(timer);
    timer = null;
    try {
      server?.close();
      (server as (http.Server & { closeAllConnections?: () => void }) | null)?.closeAllConnections?.();
    } catch (err) {
      logWarn('oauth.server.close', err instanceof Error ? err.message : String(err));
    }
    server = null;
  };

  const finishOk = (acc: StoredAccount) => {
    if (settled) return;
    settled = true;
    cleanup();
    resolvePromise(acc);
  };

  const finishErr = (err: unknown) => {
    if (settled) return;
    settled = true;
    cleanup();
    rejectPromise(err);
  };

  const runExchange = async (code: string): Promise<StoredAccount> => {
    if (inFlightExchange) return inFlightExchange;
    const task = exchangeCodeForAccount(code, redirectUri);
    inFlightExchange = task;
    try {
      return await task;
    } finally {
      if (inFlightExchange === task) inFlightExchange = null;
    }
  };

  await new Promise<void>((resolveListen, rejectListen) => {
    server = http.createServer(async (req, res) => {
      const url = new URL(req.url || '/', `http://127.0.0.1:${port}`);
      if (url.pathname !== '/callback') {
        res.writeHead(404);
        res.end('Not Found');
        return;
      }

      const gotState = url.searchParams.get('state') || '';
      const code = url.searchParams.get('code') || '';
      const error = url.searchParams.get('error') || '';

      // 杂波请求或错误 state：只回 400 并继续监听，不中止正在等待真实回调的会话
      if (gotState !== state) {
        res.writeHead(400, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(failHtml(t('oauthStateMismatch')));
        return;
      }

      if (error) {
        res.writeHead(400, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(failHtml(error));
        finishErr(new Error(t('errOauthError', error)));
        return;
      }

      if (!code) {
        res.writeHead(400, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(failHtml(t('errOauthNoCode')));
        finishErr(new Error(t('errOauthCallbackNoCode')));
        return;
      }

      try {
        const account = await runExchange(code);
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(successHtml());
        finishOk(account);
      } catch (err) {
        res.writeHead(500, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(failHtml(err instanceof Error ? err.message : String(err)));
        finishErr(err);
      }
    });

    const onStartupError = (err: Error) => {
      cleanup();
      rejectListen(err);
    };
    server.once('error', onStartupError);
    server.listen(port, '127.0.0.1', () => {
      server?.off('error', onStartupError);
      server?.on('error', (err) => finishErr(err));
      timer = setTimeout(() => {
        finishErr(new Error(t('oauthTimeout')));
      }, timeoutMs);
      resolveListen();
    });
  });

  const session: OAuthSession = {
    port,
    redirectUri,
    state,
    authUrl,
    promise,
    async openInBrowser(): Promise<void> {
      await vscode.env.openExternal(vscode.Uri.parse(authUrl));
    },
    async submitCallbackUrl(rawInput: string): Promise<StoredAccount> {
      if (settled) {
        throw new Error(t('oauthSessionMissing'));
      }
      const parsed = parseOAuthCallbackInput(rawInput);
      if (!parsed.ok) {
        if (parsed.reason === 'empty') throw new Error(t('oauthCallbackEmpty'));
        if (parsed.reason === 'auth_url_not_callback') throw new Error(t('oauthCallbackWrongUrl'));
        if (parsed.reason === 'oauth_error') throw new Error(t('errOauthError', parsed.oauthError || ''));
        if (parsed.reason === 'missing_code') throw new Error(t('errOauthCallbackNoCode'));
        throw new Error(t('oauthCallbackInvalid'));
      }
      if (parsed.state && parsed.state !== state) {
        throw new Error(t('oauthStateMismatch'));
      }
      const account = await runExchange(parsed.code!);
      finishOk(account);
      return account;
    },
    cancel(): void {
      finishErr(new OAuthCancelledError());
    },
  };

  if (options.openBrowser !== false) {
    await session.openInBrowser();
  }

  return session;
}

// ── 单实例会话管理（防止新开会话遗留旧端口监听） ──
let activeSession: OAuthSession | null = null;

export function getActiveOAuthSession(): OAuthSession | null {
  return activeSession;
}

export async function startManagedOAuthSession(options: OAuthSessionOptions = {}): Promise<OAuthSession> {
  if (activeSession) {
    const prev = activeSession;
    activeSession = null;
    prev.cancel();
  }
  const session = await createOAuthSession(options);
  activeSession = session;
  session.promise.then(
    () => { if (activeSession === session) activeSession = null; },
    () => { if (activeSession === session) activeSession = null; },
  );
  return session;
}

export async function copyActiveOAuthUrl(): Promise<boolean> {
  if (!activeSession) return false;
  await vscode.env.clipboard.writeText(activeSession.authUrl);
  return true;
}

export async function openActiveOAuthBrowser(): Promise<boolean> {
  if (!activeSession) return false;
  await activeSession.openInBrowser();
  return true;
}

export async function submitActiveOAuthCallback(rawInput: string): Promise<StoredAccount> {
  if (!activeSession) {
    throw new Error(t('oauthSessionMissing'));
  }
  return activeSession.submitCallbackUrl(rawInput);
}

export function cancelActiveOAuthSession(): void {
  if (!activeSession) return;
  const prev = activeSession;
  activeSession = null;
  prev.cancel();
}

export async function runOAuthUiFlow(opts: {
  openBrowser: boolean;
  copyUrl: boolean;
  post: (msg: Record<string, unknown>) => void;
  notify: (status: 'success' | 'error', msg: string) => void;
  onAccount: (account: StoredAccount) => Promise<void>;
}): Promise<void> {
  let session: OAuthSession;
  try {
    session = await startManagedOAuthSession({ openBrowser: opts.openBrowser });
  } catch (err) {
    opts.notify('error', t('loginFailed', err instanceof Error ? err.message : String(err)));
    opts.post({ type: 'oauthSession', active: false });
    return;
  }
  if (opts.copyUrl) {
    await vscode.env.clipboard.writeText(session.authUrl);
    opts.notify('success', t('oauthUrlCopiedToast'));
  }
  opts.post({
    type: 'oauthSession',
    active: true,
    authUrl: session.authUrl,
    copied: opts.copyUrl,
    mode: opts.openBrowser ? 'browser' : 'link',
  });
  try {
    const account = await session.promise;
    await opts.onAccount(account);
  } catch (err) {
    if (!isOAuthCancelledError(err)) {
      opts.notify('error', t('loginFailed', err instanceof Error ? err.message : String(err)));
    }
  } finally {
    if (!getActiveOAuthSession() || getActiveOAuthSession() === session) {
      opts.post({ type: 'oauthSession', active: false });
    }
  }
}

export async function startOAuth(): Promise<StoredAccount> {
  const session = await createOAuthSession({ openBrowser: true });
  return session.promise;
}
