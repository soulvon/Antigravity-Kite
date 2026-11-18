/**
 * 安全 HTTP 客户端与文件下载原语（零 vscode 依赖）
 *
 * 特点：
 * - 统一使用 Buffer.concat(chunks).toString('utf8') 收包，避免多字节 UTF-8 截断乱码
 * - 支持相对 Location 重定向；跳转前清除当前 timer 并 res.resume() 排水
 * - 默认阻止 https: 降级重定向至 http:，跨 origin 重定向自动剥离 Authorization 头
 * - downloadToFile 先流写入临时文件、校验 expectedSize，再原子 rename 到目标路径
 */
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as http from 'http';
import * as https from 'https';
import * as path from 'path';
import { renameWithRetrySync } from './atomicFile';

export interface HttpRequestOptions {
  method?: 'GET' | 'POST';
  headers?: Record<string, string>;
  body?: string | Buffer;
  timeoutMs?: number;
  maxRedirects?: number;
  allowHttpRedirect?: boolean;
}

export interface HttpResponse {
  status: number;
  headers: http.IncomingHttpHeaders;
  body: string;
}

const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);
const DEFAULT_REQUEST_TIMEOUT_MS = 15_000;
const DEFAULT_DOWNLOAD_TIMEOUT_MS = 60_000;
const DEFAULT_MAX_REDIRECTS = 5;

function stripAuthorizationHeader(headers: Record<string, string>): Record<string, string> {
  const next: Record<string, string> = {};
  for (const [k, v] of Object.entries(headers)) {
    if (k.toLowerCase() === 'authorization') continue;
    next[k] = v;
  }
  return next;
}

function stripBodyHeaders(headers: Record<string, string>): Record<string, string> {
  const next: Record<string, string> = {};
  for (const [k, v] of Object.entries(headers)) {
    const low = k.toLowerCase();
    if (low === 'content-length' || low === 'content-type') continue;
    next[k] = v;
  }
  return next;
}

function hasHeader(headers: Record<string, string>, name: string): boolean {
  const target = name.toLowerCase();
  return Object.keys(headers).some((k) => k.toLowerCase() === target);
}

function resolveRedirectTarget(
  currentUrl: URL,
  location: string,
  allowHttpRedirect: boolean,
): URL {
  const nextUrl = new URL(location, currentUrl);
  if (nextUrl.protocol !== 'http:' && nextUrl.protocol !== 'https:') {
    throw new Error(`Unsupported redirect protocol: ${nextUrl.protocol}`);
  }
  if (currentUrl.protocol === 'https:' && nextUrl.protocol === 'http:' && !allowHttpRedirect) {
    throw new Error(`Blocked insecure HTTPS -> HTTP redirect to ${nextUrl.origin}`);
  }
  return nextUrl;
}

function safeUnlink(filePath: string): void {
  try {
    if (fs.existsSync(filePath)) {
      fs.unlinkSync(filePath);
    }
  } catch (err) {
    const code = (err as NodeJS.ErrnoException)?.code;
    if (code !== 'ENOENT') {
      console.warn(`[httpClient] Failed to remove temp file ${filePath}:`, err instanceof Error ? err.message : String(err));
    }
  }
}

export async function httpRequest(url: string, opts: HttpRequestOptions = {}): Promise<HttpResponse> {
  const method = opts.method ?? 'GET';
  const timeoutMs = opts.timeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
  const maxRedirects = opts.maxRedirects ?? DEFAULT_MAX_REDIRECTS;
  const allowHttpRedirect = opts.allowHttpRedirect ?? false;
  const baseHeaders: Record<string, string> = { ...(opts.headers ?? {}) };

  const execute = (
    targetUrl: URL,
    reqMethod: 'GET' | 'POST',
    reqHeaders: Record<string, string>,
    reqBody: string | Buffer | undefined,
    redirectsLeft: number,
  ): Promise<HttpResponse> => {
    return new Promise((resolve, reject) => {
      if (targetUrl.protocol !== 'http:' && targetUrl.protocol !== 'https:') {
        reject(new Error(`Unsupported protocol: ${targetUrl.protocol}`));
        return;
      }

      const headersToSend: Record<string, string> = { ...reqHeaders };
      let payloadBuf: Buffer | undefined;
      if (reqBody !== undefined && reqMethod === 'POST') {
        payloadBuf = Buffer.isBuffer(reqBody) ? reqBody : Buffer.from(reqBody, 'utf8');
        if (!hasHeader(headersToSend, 'content-length')) {
          headersToSend['Content-Length'] = String(payloadBuf.length);
        }
      }

      let settled = false;
      let timer: NodeJS.Timeout | null = null;
      const clearTimer = () => {
        if (timer) {
          clearTimeout(timer);
          timer = null;
        }
      };
      const finishOk = (val: HttpResponse) => {
        if (settled) return;
        settled = true;
        clearTimer();
        resolve(val);
      };
      const finishErr = (err: unknown) => {
        if (settled) return;
        settled = true;
        clearTimer();
        reject(err);
      };

      const onResponse = (res: http.IncomingMessage) => {
        const status = res.statusCode || 0;
        const location = res.headers.location;
        if (REDIRECT_STATUSES.has(status) && location) {
          clearTimer();
          res.resume();
          if (redirectsLeft <= 0) {
            finishErr(new Error('Too many redirects'));
            return;
          }
          let nextUrl: URL;
          try {
            nextUrl = resolveRedirectTarget(targetUrl, location, allowHttpRedirect);
          } catch (err) {
            finishErr(err);
            return;
          }
          let nextHeaders = nextUrl.origin !== targetUrl.origin
            ? stripAuthorizationHeader(reqHeaders)
            : { ...reqHeaders };
          const switchToGet = reqMethod === 'POST' && (status === 301 || status === 302 || status === 303);
          const nextMethod: 'GET' | 'POST' = switchToGet ? 'GET' : reqMethod;
          const nextBody = switchToGet ? undefined : reqBody;
          if (switchToGet) {
            nextHeaders = stripBodyHeaders(nextHeaders);
          }
          settled = true;
          execute(nextUrl, nextMethod, nextHeaders, nextBody, redirectsLeft - 1).then(resolve, reject);
          return;
        }

        const chunks: Buffer[] = [];
        res.on('data', (chunk: Buffer | string) => {
          chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
        });
        res.on('end', () => {
          finishOk({
            status,
            headers: res.headers,
            body: Buffer.concat(chunks).toString('utf8'),
          });
        });
        res.on('error', finishErr);
      };

      const req = targetUrl.protocol === 'https:'
        ? https.request(targetUrl, { method: reqMethod, headers: headersToSend }, onResponse)
        : http.request(targetUrl, { method: reqMethod, headers: headersToSend }, onResponse);

      timer = setTimeout(() => {
        const timeoutErr = new Error(`Request timeout after ${timeoutMs}ms`);
        req.destroy(timeoutErr);
        finishErr(timeoutErr);
      }, timeoutMs);

      req.on('error', finishErr);
      if (payloadBuf !== undefined) {
        req.write(payloadBuf);
      }
      req.end();
    });
  };

  return execute(new URL(url), method, baseHeaders, opts.body, maxRedirects);
}

export async function downloadToFile(
  url: string,
  destPath: string,
  opts: {
    headers?: Record<string, string>;
    timeoutMs?: number;
    maxRedirects?: number;
    expectedSize?: number;
    allowHttpRedirect?: boolean;
  } = {},
): Promise<{ bytes: number }> {
  const timeoutMs = opts.timeoutMs ?? DEFAULT_DOWNLOAD_TIMEOUT_MS;
  const maxRedirects = opts.maxRedirects ?? DEFAULT_MAX_REDIRECTS;
  const allowHttpRedirect = opts.allowHttpRedirect ?? false;
  const baseHeaders: Record<string, string> = { ...(opts.headers ?? {}) };

  const execute = (
    targetUrl: URL,
    reqHeaders: Record<string, string>,
    redirectsLeft: number,
  ): Promise<{ bytes: number }> => {
    return new Promise((resolve, reject) => {
      if (targetUrl.protocol !== 'http:' && targetUrl.protocol !== 'https:') {
        reject(new Error(`Unsupported protocol: ${targetUrl.protocol}`));
        return;
      }

      let settled = false;
      let timer: NodeJS.Timeout | null = null;
      let tmpPath: string | null = null;
      let fileStream: fs.WriteStream | null = null;

      const clearTimer = () => {
        if (timer) {
          clearTimeout(timer);
          timer = null;
        }
      };
      const finishOk = (bytes: number) => {
        if (settled) return;
        settled = true;
        clearTimer();
        resolve({ bytes });
      };
      const finishErr = (err: unknown) => {
        if (settled) return;
        settled = true;
        clearTimer();
        const pathToClean = tmpPath;
        tmpPath = null;
        if (fileStream) {
          const streamToClose = fileStream;
          fileStream = null;
          streamToClose.once('close', () => {
            if (pathToClean) safeUnlink(pathToClean);
          });
          streamToClose.destroy();
        } else if (pathToClean) {
          safeUnlink(pathToClean);
        }
        reject(err);
      };

      const onResponse = (res: http.IncomingMessage) => {
        const status = res.statusCode || 0;
        const location = res.headers.location;

        if (REDIRECT_STATUSES.has(status) && location) {
          clearTimer();
          res.resume();
          if (redirectsLeft <= 0) {
            finishErr(new Error('Too many redirects'));
            return;
          }
          let nextUrl: URL;
          try {
            nextUrl = resolveRedirectTarget(targetUrl, location, allowHttpRedirect);
          } catch (err) {
            finishErr(err);
            return;
          }
          const nextHeaders = nextUrl.origin !== targetUrl.origin
            ? stripAuthorizationHeader(reqHeaders)
            : { ...reqHeaders };
          settled = true;
          execute(nextUrl, nextHeaders, redirectsLeft - 1).then(resolve, reject);
          return;
        }

        if (status !== 200) {
          clearTimer();
          res.resume();
          finishErr(new Error(`Download failed: HTTP ${status}`));
          return;
        }

        try {
          fs.mkdirSync(path.dirname(destPath), { recursive: true });
        } catch (err) {
          res.resume();
          finishErr(err);
          return;
        }

        tmpPath = `${destPath}.tmp.${process.pid}.${Date.now()}.${crypto.randomBytes(4).toString('hex')}`;
        fileStream = fs.createWriteStream(tmpPath);
        let receivedBytes = 0;

        res.on('data', (chunk: Buffer | string) => {
          receivedBytes += Buffer.isBuffer(chunk) ? chunk.length : Buffer.byteLength(chunk);
        });
        res.on('error', finishErr);
        fileStream.on('error', finishErr);

        res.pipe(fileStream);

        fileStream.on('finish', () => {
          clearTimer();
          const streamRef = fileStream;
          fileStream = null;
          const finalize = () => {
            if (settled) return;
            if (!tmpPath) {
              finishErr(new Error('Download temp path missing'));
              return;
            }
            if (receivedBytes <= 0) {
              finishErr(new Error('Downloaded file is empty (0 bytes)'));
              return;
            }
            if (typeof opts.expectedSize === 'number' && opts.expectedSize > 0 && receivedBytes !== opts.expectedSize) {
              finishErr(new Error(`Downloaded size mismatch: expected ${opts.expectedSize}, got ${receivedBytes}`));
              return;
            }
            try {
              renameWithRetrySync(tmpPath, destPath);
              tmpPath = null;
              finishOk(receivedBytes);
            } catch (err) {
              finishErr(err);
            }
          };

          if (streamRef) {
            streamRef.close((closeErr) => {
              if (closeErr) finishErr(closeErr);
              else finalize();
            });
          } else {
            finalize();
          }
        });
      };

      const req = targetUrl.protocol === 'https:'
        ? https.get(targetUrl, { headers: reqHeaders }, onResponse)
        : http.get(targetUrl, { headers: reqHeaders }, onResponse);

      timer = setTimeout(() => {
        const timeoutErr = new Error(`Download timeout after ${timeoutMs}ms`);
        req.destroy(timeoutErr);
        finishErr(timeoutErr);
      }, timeoutMs);

      req.on('error', finishErr);
    });
  };

  return execute(new URL(url), baseHeaders, maxRedirects);
}
