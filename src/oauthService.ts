/**
 * Google OAuth 登录流程服务
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
const OAUTH_TIMEOUT_MS = 5 * 60 * 1000;

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

export async function startOAuth(): Promise<StoredAccount> {
  const port = await findAvailablePort();
  const redirectUri = `http://127.0.0.1:${port}/callback`;
  const state = randomState();

  return new Promise((resolve, reject) => {
    let server: http.Server | null = null;
    let timer: NodeJS.Timeout | null = null;
    let settled = false;

    const cleanup = () => {
      if (timer) clearTimeout(timer);
      timer = null;
      try {
        server?.close();
      } catch (err) {
        logWarn('oauth.server.close', err instanceof Error ? err.message : String(err));
      }
    };

    const finishOk = (acc: StoredAccount) => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(acc);
    };

    const finishErr = (err: unknown) => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(err);
    };

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
        // 交换 token
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

        // 获取用户信息
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

        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(successHtml());

        finishOk({
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
        });
      } catch (err) {
        res.writeHead(500, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(failHtml(err instanceof Error ? err.message : String(err)));
        finishErr(err);
      }
    });

    server.listen(port, '127.0.0.1', async () => {
      const authUrl = `${OAUTH_AUTH_URL}?` + new URLSearchParams({
        client_id: OAUTH_CLIENT_ID,
        redirect_uri: redirectUri,
        response_type: 'code',
        scope: OAUTH_SCOPES.join(' '),
        state,
        access_type: 'offline',
        prompt: 'consent',
      }).toString();

      timer = setTimeout(() => {
        finishErr(new Error(t('oauthTimeout')));
      }, OAUTH_TIMEOUT_MS);

      await vscode.env.openExternal(vscode.Uri.parse(authUrl));
    });

    server.on('error', (err) => {
      finishErr(err);
    });
  });
}
