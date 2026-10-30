import * as vscode from 'vscode';
import * as http from 'http';
import * as https from 'https';
import { StoredAccount } from './types';

// Antigravity OAuth 配置
const CLIENT_ID = '1071006060591-tmhssin2h21lcre235vtolojh4g403ep.apps.googleusercontent.com';
const CLIENT_SECRET = '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';
const SCOPES = [
  'openid',
  'https://www.googleapis.com/auth/cloud-platform',
  'https://www.googleapis.com/auth/userinfo.email',
  'https://www.googleapis.com/auth/userinfo.profile',
];
const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const AUTH_URL = 'https://accounts.google.com/o/oauth2/auth';
const USERINFO_URL = 'https://www.googleapis.com/oauth2/v2/userinfo';

const CALLBACK_PORT_START = 11451;
const CALLBACK_PORT_RANGE = 100;
const OAUTH_TIMEOUT_MS = 5 * 60 * 1000;

function randomState(): string {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  let result = '';
  for (let i = 0; i < 32; i++) {
    result += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return result;
}

function httpsPost(url: string, data: string, headers: Record<string, string> = {}): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const urlObj = new URL(url);
    const options: https.RequestOptions = {
      hostname: urlObj.hostname,
      port: 443,
      path: urlObj.pathname + urlObj.search,
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'Content-Length': Buffer.byteLength(data),
        ...headers
      }
    };
    const req = https.request(options, (res) => {
      let body = '';
      res.on('data', chunk => body += chunk);
      res.on('end', () => resolve({ status: res.statusCode || 0, body }));
    });
    req.on('error', reject);
    req.write(data);
    req.end();
  });
}

function httpsGet(url: string, headers: Record<string, string> = {}): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const urlObj = new URL(url);
    const options: https.RequestOptions = {
      hostname: urlObj.hostname,
      port: 443,
      path: urlObj.pathname + urlObj.search,
      method: 'GET',
      headers
    };
    const req = https.request(options, (res) => {
      let body = '';
      res.on('data', chunk => body += chunk);
      res.on('end', () => resolve({ status: res.statusCode || 0, body }));
    });
    req.on('error', reject);
    req.end();
  });
}

function successHtml(): string {
  return `<!DOCTYPE html><html><head><meta charset="utf-8"><title>授权成功</title>
<style>body{font-family:-apple-system,sans-serif;display:flex;align-items:center;justify-content:center;height:100vh;margin:0;background:#1a1a2e;color:#eee}.box{max-width:400px;padding:24px;border-radius:12px;background:#16213e;text-align:center}h1{color:#4ade80;margin:0 0 10px;font-size:24px}p{margin:0;opacity:.85}</style></head>
<body><div class="box"><h1>授权成功</h1><p>可以关闭此页面，返回 Antigravity Kite。</p></div></body></html>`;
}

function failHtml(message: string): string {
  return `<!DOCTYPE html><html><head><meta charset="utf-8"><title>授权失败</title>
<style>body{font-family:-apple-system,sans-serif;display:flex;align-items:center;justify-content:center;height:100vh;margin:0;background:#1a1a2e;color:#eee}.box{max-width:400px;padding:24px;border-radius:12px;background:#16213e;text-align:center}h1{color:#ef4444;margin:0 0 10px;font-size:24px}p{margin:0;opacity:.85}</style></head>
<body><div class="box"><h1>授权失败</h1><p>${message}</p></div></body></html>`;
}

async function findAvailablePort(): Promise<number> {
  for (let i = 0; i < CALLBACK_PORT_RANGE; i++) {
    const port = CALLBACK_PORT_START + i;
    const available = await new Promise<boolean>(resolve => {
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
  throw new Error('无法找到可用端口');
}

export async function startOAuth(): Promise<StoredAccount> {
  const port = await findAvailablePort();
  const redirectUri = `http://127.0.0.1:${port}/callback`;
  const state = randomState();

  return new Promise((resolve, reject) => {
    let server: http.Server | null = null;
    let timer: NodeJS.Timeout | null = null;

    const cleanup = () => {
      if (timer) clearTimeout(timer);
      try { server?.close(); } catch {}
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

      if (gotState !== state) {
        res.writeHead(400, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(failHtml('state 校验失败'));
        cleanup();
        reject(new Error('OAuth state 校验失败'));
        return;
      }

      if (error) {
        res.writeHead(400, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(failHtml(error));
        cleanup();
        reject(new Error(`OAuth 错误: ${error}`));
        return;
      }

      if (!code) {
        res.writeHead(400, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(failHtml('缺少授权码'));
        cleanup();
        reject(new Error('OAuth 回调缺少 code'));
        return;
      }

      try {
        // 交换 token
        const tokenData = new URLSearchParams({
          code,
          client_id: CLIENT_ID,
          client_secret: CLIENT_SECRET,
          redirect_uri: redirectUri,
          grant_type: 'authorization_code'
        }).toString();

        const tokenRes = await httpsPost(TOKEN_URL, tokenData);
        if (tokenRes.status !== 200) {
          throw new Error(`Token 交换失败: HTTP ${tokenRes.status}`);
        }

        const tokenJson = JSON.parse(tokenRes.body);
        const accessToken = tokenJson.access_token;
        const refreshToken = tokenJson.refresh_token;
        const expiresIn = tokenJson.expires_in || 3600;

        if (!accessToken) {
          throw new Error('Token 响应缺少 access_token');
        }

        // 获取用户信息
        const userRes = await httpsGet(USERINFO_URL, {
          Authorization: `Bearer ${accessToken}`
        });

        if (userRes.status !== 200) {
          throw new Error(`获取用户信息失败: HTTP ${userRes.status}`);
        }

        const userJson = JSON.parse(userRes.body);
        const email = userJson.email || '';
        const name = userJson.name || email.split('@')[0];

        if (!email) {
          throw new Error('用户信息缺少 email');
        }

        const expiresAt = new Date(Date.now() + expiresIn * 1000).toISOString();

        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(successHtml());
        cleanup();

        resolve({
          email,
          accessToken,
          refreshToken,
          expiresAt,
          name,
          idToken: typeof tokenJson.id_token === 'string' ? tokenJson.id_token : undefined,
          importMeta: {
            source: 'oauth',
            importedAt: new Date().toISOString()
          }
        });

      } catch (err) {
        res.writeHead(500, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(failHtml(err instanceof Error ? err.message : String(err)));
        cleanup();
        reject(err);
      }
    });

    server.listen(port, '127.0.0.1', async () => {
      const authUrl = `${AUTH_URL}?` + new URLSearchParams({
        client_id: CLIENT_ID,
        redirect_uri: redirectUri,
        response_type: 'code',
        scope: SCOPES.join(' '),
        state,
        access_type: 'offline',
        prompt: 'consent'
      }).toString();

      timer = setTimeout(() => {
        cleanup();
        reject(new Error('OAuth 授权超时'));
      }, OAUTH_TIMEOUT_MS);

      await vscode.env.openExternal(vscode.Uri.parse(authUrl));
    });

    server.on('error', (err) => {
      cleanup();
      reject(err);
    });
  });
}
