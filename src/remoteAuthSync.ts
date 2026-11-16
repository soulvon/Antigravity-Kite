/**
 * Remote SSH 远端官方登录态同步（~/.gemini/jetski-standalone-oauth-token）
 *
 * 机制（已在真实 Remote SSH 环境中通过 strace / 反汇编 / 隔离实测证实）：
 * - Kite 为 extensionKind: ["ui"]，始终运行在本地 UI 扩展宿主；
 * - 官方 google.google-antigravity 运行在远端 Remote Extension Host，其拉起的远端
 *   `agy --hub` 检测到 SSH 会话后（composite_token_storage.go），不再读取本地凭据库或 Linux keyring，
 *   而是读取远端的 `~/.gemini/jetski-standalone-oauth-token`（与本地 gemini:antigravity 同构的明文 JSON）。
 *
 * 通道选择：
 * - 通过 VS Code 已建连的 `vscode.workspace.fs`（scheme='vscode-remote'）定位远端 $HOME 并读写文件，
 *   无需额外派生 ssh 进程，兼容密码登录 / 跳板机 / 2FA / 自定义 SSH 配置，绝不触碰受 resolvers 提案限制的 API。
 */
import * as fs from 'fs';
import * as http from 'http';
import * as https from 'https';
import * as path from 'path';
import * as vscode from 'vscode';
import { IdeCredential } from './winCredential';
import { logInfo, logWarn } from './logger';

export const STANDALONE_TOKEN_DIR = '.gemini';
export const STANDALONE_TOKEN_FILE = 'jetski-standalone-oauth-token';
export const PENDING_REMOTE_NOTICE_KEY = 'kite.remoteSyncPendingNotice';
export const REMOTE_SYNC_COOLDOWN_KEY = 'kite.remoteSyncLastTrigger';

const SUPPORTED_REMOTE_NAMES = new Set(['ssh-remote']);
const SAFE_POSIX_USER_RE = /^[a-zA-Z0-9._-]+$/;
const LOG_SLICE_BYTES = 16 * 1024;
const TOKEN_FRESH_MARGIN_MS = 60 * 1000;
const HUB_LOGOUT_TIMEOUT_MS = 2500;
const HUB_DAEMON_FILE_RE = /^hub_\d+\.json$/;

export type RemoteTokenPreviousState = 'missing' | 'empty' | 'corrupt' | 'same-account' | 'mismatch';

export interface RemoteFsLike {
  readFile(uri: vscode.Uri): Thenable<Uint8Array>;
  writeFile(uri: vscode.Uri, content: Uint8Array): Thenable<void>;
  createDirectory(uri: vscode.Uri): Thenable<void>;
  stat(uri: vscode.Uri): Thenable<{ type: number }>;
  readDirectory?(uri: vscode.Uri): Thenable<[string, number][]>;
}

export interface RemoteHubDaemonInfo {
  httpPort: number;
  csrfToken: string;
  pid?: number;
  fileName: string;
}

export type PostJsonFn = (
  url: string,
  headers: Record<string, string>,
  body: string,
  timeoutMs: number
) => Promise<number>;

export interface ResolveAuthorityInputs {
  workspaceFolders?: readonly { uri?: { scheme?: string; authority?: string; path?: string } }[];
  workspaceFile?: { scheme?: string; authority?: string; path?: string };
  activeEditorUri?: { scheme?: string; authority?: string; path?: string };
  tabGroupsAll?: readonly { tabs?: readonly { input?: unknown }[] }[];
  logUriFsPath?: string;
}

export interface RemoteHomeResult {
  ok: boolean;
  homeDir?: string;
  user?: string;
  source?: 'proc-environ' | 'etc-passwd' | 'posix-user-dir';
  error?: string;
}

export interface RemoteSyncResult {
  ok: boolean;
  wrote: boolean;
  skipped?: boolean;
  reason?: string;
  previousState?: RemoteTokenPreviousState;
  targetPath?: string;
  error?: string;
}

export function isSupportedRemoteSession(remoteName?: string): boolean {
  const name = typeof remoteName === 'string'
    ? remoteName.trim()
    : (typeof vscode.env?.remoteName === 'string' ? vscode.env.remoteName.trim() : '');
  return SUPPORTED_REMOTE_NAMES.has(name);
}

export function isRemoteAuthSyncEnabled(): boolean {
  try {
    return vscode.workspace.getConfiguration('antigravityKite').get<boolean>('remote.syncAuth', true) !== false;
  } catch {
    return true;
  }
}

function buildRemoteUri(authority: string, posixPath: string): vscode.Uri {
  return vscode.Uri.from({ scheme: 'vscode-remote', authority, path: posixPath });
}

function posixJoin(base: string, ...parts: string[]): string {
  const normalizedBase = base === '/' ? '' : base.replace(/\/+$/, '');
  const cleanParts = parts.map((p) => p.replace(/^\/+|\/+$/g, '')).filter(Boolean);
  return `${normalizedBase}/${cleanParts.join('/')}` || '/';
}

/** 从 ssh-remote+<hex|user@host> 提取可选远端用户名 */
export function parseSshAuthorityUser(authority: string): string | undefined {
  const plusIdx = authority.indexOf('+');
  if (plusIdx < 0) return undefined;
  const payload = authority.slice(plusIdx + 1).trim();
  if (!payload) return undefined;

  if (/^[0-9a-fA-F]+$/.test(payload) && payload.length % 2 === 0) {
    try {
      const decoded = JSON.parse(Buffer.from(payload, 'hex').toString('utf8')) as { user?: unknown };
      if (typeof decoded?.user === 'string' && SAFE_POSIX_USER_RE.test(decoded.user.trim())) {
        return decoded.user.trim();
      }
    } catch { /* 非 hex JSON */ }
  }

  const atIdx = payload.indexOf('@');
  if (atIdx > 0) {
    const candidate = payload.slice(0, atIdx).trim();
    if (SAFE_POSIX_USER_RE.test(candidate)) return candidate;
  }
  return undefined;
}

function readLogHeadAndTail(filePath: string): string {
  const st = fs.statSync(filePath);
  if (st.size <= LOG_SLICE_BYTES * 2) {
    return fs.readFileSync(filePath, 'utf8');
  }
  const fd = fs.openSync(filePath, 'r');
  try {
    const head = Buffer.alloc(LOG_SLICE_BYTES);
    const tail = Buffer.alloc(LOG_SLICE_BYTES);
    fs.readSync(fd, head, 0, LOG_SLICE_BYTES, 0);
    fs.readSync(fd, tail, 0, LOG_SLICE_BYTES, st.size - LOG_SLICE_BYTES);
    return head.toString('utf8') + '\n' + tail.toString('utf8');
  } finally {
    fs.closeSync(fd);
  }
}

function listCandidateRemoteLogs(logUriFsPath?: string): string[] {
  if (!logUriFsPath) return [];
  const exthostDir = path.dirname(logUriFsPath);
  if (!fs.existsSync(exthostDir)) return [];

  const logs: { file: string; mtimeMs: number; priority: number }[] = [];
  let entries: fs.Dirent[] = [];
  try { entries = fs.readdirSync(exthostDir, { withFileTypes: true }); } catch { return []; }

  for (const ent of entries) {
    if (!ent.isDirectory()) continue;
    const subDir = path.join(exthostDir, ent.name);
    const isSshDir = ent.name.includes('remote-openssh') || ent.name.includes('remote');
    const isOutputDir = ent.name.startsWith('output_logging_');
    if (!isSshDir && !isOutputDir) continue;

    let files: string[] = [];
    try { files = fs.readdirSync(subDir); } catch { continue; }
    for (const f of files) {
      if (!f.endsWith('.log')) continue;
      if (isOutputDir && !/remote/i.test(f)) continue;
      const fp = path.join(subDir, f);
      try {
        const st = fs.statSync(fp);
        if (st.size > 0) {
          logs.push({ file: fp, mtimeMs: st.mtimeMs, priority: isSshDir ? 0 : 1 });
        }
      } catch { /* ignore */ }
    }
  }

  logs.sort((a, b) => (a.priority - b.priority) || (b.mtimeMs - a.mtimeMs));
  return logs.map((l) => l.file);
}

/** 从同窗口 exthost 日志中提取 authority 与可选用户名（专用于尚未打开任何文件夹的空 SSH 窗口） */
function extractFromRemoteLogs(logUriFsPath?: string): { authority?: string; user?: string } {
  const candidates = listCandidateRemoteLogs(logUriFsPath);
  let foundAuthority: string | undefined;
  let foundUser: string | undefined;

  for (const fp of candidates) {
    try {
      const content = readLogHeadAndTail(fp);
      if (!foundAuthority) {
        const authMatches = [...content.matchAll(/Resolving\s+(?:ssh\s+)?remote\s+authority\s+'([^']+)'/gi)];
        const lastAuth = authMatches.at(-1)?.[1]?.trim();
        if (lastAuth) foundAuthority = lastAuth;
      }
      if (!foundUser) {
        const userMatches = [...content.matchAll(/Connecting to\s+([a-zA-Z0-9._-]+)@/g)];
        const lastUser = userMatches.at(-1)?.[1]?.trim();
        if (lastUser && SAFE_POSIX_USER_RE.test(lastUser)) foundUser = lastUser;
      }
      if (foundAuthority && foundUser) break;
    } catch { /* 继续下一个日志 */ }
  }
  return { authority: foundAuthority, user: foundUser };
}

function collectTabUris(tabGroupsAll?: readonly { tabs?: readonly { input?: unknown }[] }[]): Array<{ scheme?: string; authority?: string }> {
  const out: Array<{ scheme?: string; authority?: string }> = [];
  if (!Array.isArray(tabGroupsAll)) return out;
  for (const group of tabGroupsAll) {
    for (const tab of group?.tabs || []) {
      const inp = tab?.input as { uri?: { scheme?: string; authority?: string }; modified?: { scheme?: string; authority?: string }; original?: { scheme?: string; authority?: string } } | undefined;
      if (inp?.uri) out.push(inp.uri);
      if (inp?.modified) out.push(inp.modified);
      if (inp?.original) out.push(inp.original);
    }
  }
  return out;
}

/**
 * 解析当前窗口的 vscode-remote authority（例如 ssh-remote+...）。
 * 不依赖受 resolvers 提案限制的属性读取，确保非提案扩展稳定运行。
 */
export async function resolveRemoteAuthority(inputs?: ResolveAuthorityInputs): Promise<string | undefined> {
  const folders = inputs?.workspaceFolders ?? vscode.workspace.workspaceFolders;
  const wsFile = inputs?.workspaceFile ?? vscode.workspace.workspaceFile;
  const editorUri = inputs?.activeEditorUri ?? vscode.window.activeTextEditor?.document?.uri;
  const tabGroupsAll = inputs?.tabGroupsAll ?? vscode.window.tabGroups?.all;

  const uris: Array<{ scheme?: string; authority?: string } | undefined> = [
    ...(folders || []).map((f) => f?.uri),
    wsFile,
    editorUri,
    ...collectTabUris(tabGroupsAll),
  ];

  for (const u of uris) {
    if (u?.scheme === 'vscode-remote' && typeof u.authority === 'string' && u.authority.trim()) {
      return u.authority.trim();
    }
  }

  const fromLog = extractFromRemoteLogs(inputs?.logUriFsPath);
  return fromLog.authority;
}

async function isRemoteDir(fsApi: Pick<RemoteFsLike, 'stat'>, authority: string, posixPath: string): Promise<boolean> {
  if (!posixPath.startsWith('/')) return false;
  try {
    const st = await fsApi.stat(buildRemoteUri(authority, posixPath));
    return (st.type & vscode.FileType.Directory) !== 0;
  } catch {
    return false;
  }
}

function parseNullSeparatedEnv(buf: Uint8Array): Record<string, string> {
  const env: Record<string, string> = {};
  const entries = Buffer.from(buf).toString('utf8').split('\0');
  for (const entry of entries) {
    const eq = entry.indexOf('=');
    if (eq > 0) {
      env[entry.slice(0, eq)] = entry.slice(eq + 1);
    }
  }
  return env;
}

/**
 * 在远端文件系统上真实解析并校验当前登录用户主目录（绝不盲猜 /root）。
 * 通路顺序：1) /proc/self/environ HOME -> 2) 已知用户名 + /etc/passwd -> 3) macOS /Users/<user>。
 */
export async function resolveRemoteHomeDir(
  authority: string,
  fsApi: Pick<RemoteFsLike, 'readFile' | 'stat'> = vscode.workspace.fs,
  opts?: { logUriFsPath?: string }
): Promise<RemoteHomeResult> {
  let envUser: string | undefined;

  try {
    const rawEnv = await fsApi.readFile(buildRemoteUri(authority, '/proc/self/environ'));
    const envMap = parseNullSeparatedEnv(rawEnv);
    const home = envMap.HOME?.trim();
    const u = (envMap.USER || envMap.LOGNAME || '').trim();
    if (u && SAFE_POSIX_USER_RE.test(u)) envUser = u;
    if (home && home.startsWith('/') && await isRemoteDir(fsApi, authority, home)) {
      return { ok: true, homeDir: home, user: envUser, source: 'proc-environ' };
    }
  } catch { /* 非 Linux 或权限受限，进入下一通路 */ }

  const candidateUser = envUser
    || parseSshAuthorityUser(authority)
    || extractFromRemoteLogs(opts?.logUriFsPath).user;

  if (candidateUser && SAFE_POSIX_USER_RE.test(candidateUser)) {
    try {
      const passwdBytes = await fsApi.readFile(buildRemoteUri(authority, '/etc/passwd'));
      const lines = Buffer.from(passwdBytes).toString('utf8').split(/\r?\n/);
      for (const line of lines) {
        if (!line || line.startsWith('#')) continue;
        const parts = line.split(':');
        if (parts[0] === candidateUser && parts.length >= 6) {
          const home = parts[5].trim();
          if (home.startsWith('/') && await isRemoteDir(fsApi, authority, home)) {
            return { ok: true, homeDir: home, user: candidateUser, source: 'etc-passwd' };
          }
        }
      }
    } catch { /* macOS 无普通用户条目或 /etc/passwd 不可读 */ }

    const macAndLinuxFallbacks = candidateUser === 'root'
      ? ['/var/root', '/Users/root']
      : [`/Users/${candidateUser}`, `/home/${candidateUser}`];
    for (const candidateHome of macAndLinuxFallbacks) {
      if (await isRemoteDir(fsApi, authority, candidateHome)) {
        return { ok: true, homeDir: candidateHome, user: candidateUser, source: 'posix-user-dir' };
      }
    }
  }

  return { ok: false, error: '无法解析并验证远端用户主目录' };
}

function isFileNotFoundErr(e: unknown): boolean {
  const err = e as { code?: string; name?: string; message?: string } | undefined;
  const code = String(err?.code || err?.name || '');
  const msg = String(err?.message || '');
  return code === 'FileNotFound' || code === 'ENOENT' || /\b(?:FileNotFound|ENOENT)\b/i.test(msg);
}

function defaultPostJson(
  url: string,
  headers: Record<string, string>,
  body: string,
  timeoutMs: number
): Promise<number> {
  return new Promise((resolve, reject) => {
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch (e) {
      reject(e);
      return;
    }
    const client = parsed.protocol === 'https:' ? https : http;
    const payload = Buffer.from(body, 'utf8');
    let settled = false;
    const done = (err: Error | null, status?: number) => {
      if (settled) return;
      settled = true;
      if (err) reject(err);
      else resolve(status || 0);
    };
    const req = client.request(
      parsed,
      {
        method: 'POST',
        headers: {
          ...headers,
          'Content-Length': String(payload.length),
        },
        timeout: timeoutMs,
      },
      (res) => {
        res.resume();
        res.on('end', () => done(null, res.statusCode || 0));
      }
    );
    req.on('timeout', () => {
      req.destroy(new Error(`HTTP POST timeout after ${timeoutMs}ms`));
    });
    req.on('error', (err) => done(err));
    req.write(payload);
    req.end();
  });
}

function formatMappedBaseUrl(extUri: unknown, fallback: string): string {
  const u = extUri as { scheme?: string; authority?: string; path?: string; toString?: () => string } | undefined;
  if (!u) return fallback;
  if (typeof u.toString === 'function' && u.toString !== Object.prototype.toString) {
    const str = String(u.toString()).trim();
    if (/^https?:\/\//i.test(str)) {
      return str.replace(/\/+$/, '');
    }
  }
  if (typeof u.scheme === 'string' && typeof u.authority === 'string' && u.authority.trim()) {
    if (/^https?$/i.test(u.scheme.trim())) {
      const p = typeof u.path === 'string' && u.path !== '/' ? u.path : '';
      return `${u.scheme.trim()}://${u.authority.trim()}${p}`.replace(/\/+$/, '');
    }
  }
  return fallback;
}

/**
 * 发现远端正在运行的 `agy --hub` 守护实例信息（~/.gemini/antigravity/daemon/hub_<port>.json）。
 */
export async function discoverRemoteHubDaemons(
  remoteHome: string,
  authority: string,
  fsApi: RemoteFsLike = vscode.workspace.fs
): Promise<RemoteHubDaemonInfo[]> {
  if (typeof fsApi.readDirectory !== 'function') return [];
  const daemonDirPath = posixJoin(remoteHome, STANDALONE_TOKEN_DIR, 'antigravity', 'daemon');
  let entries: [string, number][];
  try {
    entries = await fsApi.readDirectory(buildRemoteUri(authority, daemonDirPath));
  } catch {
    return [];
  }

  const out: RemoteHubDaemonInfo[] = [];
  for (const [fileName] of entries) {
    if (!HUB_DAEMON_FILE_RE.test(fileName)) continue;
    const filePath = posixJoin(daemonDirPath, fileName);
    try {
      const raw = await fsApi.readFile(buildRemoteUri(authority, filePath));
      const parsed = JSON.parse(Buffer.from(raw).toString('utf8')) as {
        httpPort?: unknown;
        csrfToken?: unknown;
        pid?: unknown;
      };
      const httpPort = typeof parsed?.httpPort === 'number' ? parsed.httpPort : Number(parsed?.httpPort);
      const csrfToken = typeof parsed?.csrfToken === 'string' ? parsed.csrfToken.trim() : '';
      if (!Number.isInteger(httpPort) || httpPort <= 0 || httpPort > 65535 || !csrfToken) {
        continue;
      }

      const pidNum = typeof parsed?.pid === 'number' ? parsed.pid : Number(parsed?.pid);
      const pid = Number.isInteger(pidNum) && pidNum > 0 ? pidNum : undefined;
      if (pid !== undefined) {
        try {
          const cmdRaw = await fsApi.readFile(buildRemoteUri(authority, `/proc/${pid}/cmdline`));
          const cmdline = Buffer.from(cmdRaw).toString('utf8').replace(/\0/g, ' ').trim();
          if (cmdline && !cmdline.toLowerCase().includes('agy')) {
            continue;
          }
        } catch { /* 非 Linux 无 /proc，或进程不可读时不误跳过 */ }
      }

      out.push({ httpPort, csrfToken, pid, fileName });
    } catch { /* 跳过损坏或并发删除的 discovery 文件 */ }
  }
  return out;
}

/**
 * 在覆盖远端 jetski-standalone-oauth-token 前通知运行中的 `agy --hub` 清空旧会话缓存。
 * 实测证实 AuthLogout 耗时仅 ~20ms 且不撤销 Google refresh_token，全程不重启扩展宿主、不断 SSH。
 */
export async function logoutRemoteHubSessions(
  remoteHome: string,
  authority: string,
  opts?: { fsApi?: RemoteFsLike; postJson?: PostJsonFn }
): Promise<{ attempted: number; succeeded: number }> {
  const fsApi = opts?.fsApi ?? vscode.workspace.fs;
  const postJson = opts?.postJson ?? defaultPostJson;
  const daemons = await discoverRemoteHubDaemons(remoteHome, authority, fsApi);
  let attempted = 0;
  let succeeded = 0;

  for (const d of daemons) {
    attempted++;
    const rawBase = `http://127.0.0.1:${d.httpPort}`;
    let mappedBase = rawBase;
    try {
      if (typeof vscode.env?.asExternalUri === 'function') {
        const extUri = await vscode.env.asExternalUri(vscode.Uri.parse(rawBase));
        mappedBase = formatMappedBaseUrl(extUri, rawBase);
      }
    } catch { /* 映射失败回退原始环回端口 */ }

    const rpcPath = '/exa.language_server_pb.LanguageServerService/AuthLogout';
    const headers = {
      'Content-Type': 'application/json',
      'x-codeium-csrf-token': d.csrfToken,
    };

    try {
      const status = await postJson(`${mappedBase}${rpcPath}`, headers, '{}', HUB_LOGOUT_TIMEOUT_MS);
      logInfo('remote.sync.hub-logout', { httpPort: d.httpPort, status });
      if (status >= 200 && status < 300) succeeded++;
    } catch (firstErr) {
      if (mappedBase !== rawBase) {
        try {
          const status = await postJson(`${rawBase}${rpcPath}`, headers, '{}', HUB_LOGOUT_TIMEOUT_MS);
          logInfo('remote.sync.hub-logout', { httpPort: d.httpPort, status, fallback: true });
          if (status >= 200 && status < 300) succeeded++;
          continue;
        } catch (fallbackErr) {
          logWarn('remote.sync.hub-logout-fail', {
            httpPort: d.httpPort,
            error: fallbackErr instanceof Error ? fallbackErr.message : String(fallbackErr),
          });
          continue;
        }
      }
      logWarn('remote.sync.hub-logout-fail', {
        httpPort: d.httpPort,
        error: firstErr instanceof Error ? firstErr.message : String(firstErr),
      });
    }
  }

  return { attempted, succeeded };
}

/**
 * 将本地已对齐的 IdeCredential 同步至远端 `~/.gemini/jetski-standalone-oauth-token`。
 * - forceOverwrite=false（启动自动同步）：若远端已是同一账号且 RT 一致、AT 未过期，则幂等跳过；
 * - forceOverwrite=true（用户主动切号）：先调 AuthLogout 清空运行中 hub 内存，再强制覆写最新 token；
 * - 任意读写失败均返回 { ok: false, error }，严禁静默吞错或伪造成功。
 */
export async function syncCredentialToRemote(
  remoteHome: string,
  authority: string,
  credential: IdeCredential,
  opts?: { fsApi?: RemoteFsLike; forceOverwrite?: boolean; postJson?: PostJsonFn }
): Promise<RemoteSyncResult> {
  const fsApi = opts?.fsApi ?? vscode.workspace.fs;
  const forceOverwrite = opts?.forceOverwrite === true;
  const dirPath = posixJoin(remoteHome, STANDALONE_TOKEN_DIR);
  const filePath = posixJoin(dirPath, STANDALONE_TOKEN_FILE);
  const dirUri = buildRemoteUri(authority, dirPath);
  const fileUri = buildRemoteUri(authority, filePath);

  let previousState: RemoteTokenPreviousState = 'missing';
  let existingParsed: Partial<IdeCredential> | undefined;

  try {
    const raw = await fsApi.readFile(fileUri);
    const text = Buffer.from(raw).toString('utf8').trim();
    if (!text) {
      previousState = 'empty';
    } else {
      try {
        existingParsed = JSON.parse(text) as Partial<IdeCredential>;
        const existingEmail = typeof existingParsed?.id_token_email === 'string'
          ? existingParsed.id_token_email.trim()
          : '';
        if (!existingEmail) {
          previousState = 'empty';
        } else if (existingEmail.toLowerCase() === credential.id_token_email.trim().toLowerCase()) {
          previousState = 'same-account';
        } else {
          previousState = 'mismatch';
        }
      } catch {
        previousState = 'corrupt';
      }
    }
  } catch (e) {
    if (!isFileNotFoundErr(e)) {
      logWarn('remote.sync.read-existing-warn', { targetPath: filePath, error: e instanceof Error ? e.message : String(e) });
    }
    previousState = 'missing';
  }

  if (!forceOverwrite && previousState === 'same-account' && existingParsed?.token) {
    const existingRt = existingParsed.token.refresh_token || '';
    const existingAt = existingParsed.token.access_token || '';
    const existingExpMs = Date.parse(existingParsed.token.expiry || '');
    const sameRt = !credential.token.refresh_token || existingRt === credential.token.refresh_token;
    const tokenAlive = Boolean(existingAt) && (
      existingAt === credential.token.access_token
      || (Number.isFinite(existingExpMs) && existingExpMs > Date.now() + TOKEN_FRESH_MARGIN_MS)
    );
    if (sameRt && tokenAlive) {
      return {
        ok: true,
        wrote: false,
        skipped: true,
        reason: 'already-synced',
        previousState,
        targetPath: filePath,
      };
    }
  }

  const payload: IdeCredential = {
    token: { ...credential.token },
    auth_method: credential.auth_method || existingParsed?.auth_method || 'consumer',
    id_token_email: credential.id_token_email,
    writer_id: credential.writer_id || existingParsed?.writer_id || '',
  };

  if (forceOverwrite || previousState === 'mismatch' || previousState === 'same-account') {
    try {
      await logoutRemoteHubSessions(remoteHome, authority, { fsApi, postJson: opts?.postJson });
    } catch (e) {
      logWarn('remote.sync.hub-logout-unexpected', e instanceof Error ? e.message : String(e));
    }
  }

  try {
    try {
      await fsApi.createDirectory(dirUri);
    } catch (dirErr) {
      if (!(await isRemoteDir(fsApi, authority, dirPath))) {
        throw dirErr;
      }
    }
    await fsApi.writeFile(fileUri, Buffer.from(JSON.stringify(payload), 'utf8'));
    logInfo('remote.sync.write', {
      email: credential.id_token_email,
      previousState,
      targetPath: filePath,
      forceOverwrite,
    });
    return {
      ok: true,
      wrote: true,
      skipped: false,
      previousState,
      targetPath: filePath,
    };
  } catch (e) {
    const error = e instanceof Error ? e.message : String(e);
    logWarn('remote.sync.write-fail', { targetPath: filePath, error });
    return { ok: false, wrote: false, previousState, targetPath: filePath, error };
  }
}

/** 轻量触发远端 Antigravity Webview 刷新以加载新登录态（零扩展宿主重启，不断 SSH） */
export async function applyRemoteAuthRefresh(
  _context: vscode.ExtensionContext,
  opts: { previousState?: RemoteTokenPreviousState; email: string; authority: string; isExplicitSwitch: boolean }
): Promise<{ refreshed: boolean; mode: 'reconnect'; error?: string }> {
  try {
    await vscode.commands.executeCommand('antigravity.reconnect');
    logInfo('remote.sync.refresh', {
      mode: 'reconnect',
      email: opts.email,
      isExplicitSwitch: opts.isExplicitSwitch,
      previousState: opts.previousState,
    });
    return { refreshed: true, mode: 'reconnect' };
  } catch (e) {
    const error = e instanceof Error ? e.message : String(e);
    logWarn('remote.sync.reconnect-fail', { error });
    return { refreshed: false, mode: 'reconnect', error };
  }
}
