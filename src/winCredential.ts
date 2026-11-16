/**
 * Windows 凭据管理器读写（gemini:antigravity）
 *
 * 身份权威来源：IDE 主进程启动时从此条目读取 id_token_email 建立认证会话
 * （bundle 逆向 + 真机实验证实：写它 + 重启 = 身份/头像/名字/额度完整切换；
 *   写 state.vscdb 对界面身份无效）。
 *
 * 实现方式：优先走 winNativeHelper（一次 csc.exe 编译缓存为 KiteWinHelper_<hash>.exe，
 * 后续直调 Win32 CredReadW/CredWriteW，单次仅 ~100ms，零 PowerShell 启动）；
 * 无 csc.exe 的极简环境自动回退 PowerShell + Add-Type。
 * 本模块不 import vscode，供扩展与关-写-重启助手共用。
 */
import * as cp from 'child_process';
import { createHash } from 'crypto';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { getAppDataDir } from './platformPaths';
import { ensureWinNativeHelper, runWinCredRead, runWinCredWrite } from './winNativeHelper';
import { t } from './i18n';

export const IDE_CRED_TARGET = 'gemini:antigravity';

/**
 * 平台门控：凭据写入依赖 Windows Credential Manager（CredReadW/CredWriteW）。
 * macOS Keychain / Linux libsecret 的等价实现须先逆向对应平台 IDE 的凭据服务名，
 * 未实证前显式失败，严禁用跨平台壳伪装成功。
 */
function assertWindowsCredAvailable(): void {
  if (process.platform !== 'win32') {
    throw new Error(t('credWindowsOnly'));
  }
}

export interface IdeCredential {
  token: {
    access_token: string;
    token_type: string;
    refresh_token: string;
    expiry: string;
    expires_in?: number;
  };
  auth_method: string;
  id_token_email: string;
  writer_id: string;
}

/** P/Invoke C# 源码（单独常量：DLL 文件名要绑定它的 hash） */
const CS_SOURCE_LINES = [
  'using System;',
  'using System.Runtime.InteropServices;',
  'public static class KiteWinCred {',
  '  [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]',
  '  public struct CREDENTIAL {',
  '    public int Flags;',
  '    public int Type;',
  '    public string TargetName;',
  '    public string Comment;',
  '    public System.Runtime.InteropServices.ComTypes.FILETIME LastWritten;',
  '    public int CredentialBlobSize;',
  '    public IntPtr CredentialBlob;',
  '    public int Persist;',
  '    public int AttributeCount;',
  '    public IntPtr Attributes;',
  '    public string TargetAlias;',
  '    public string UserName;',
  '  }',
  '  [DllImport("Advapi32.dll", EntryPoint = "CredReadW", CharSet = CharSet.Unicode, SetLastError = true)]',
  '  public static extern bool CredReadW(string target, int type, int flags, out IntPtr credPtr);',
  '  [DllImport("Advapi32.dll", EntryPoint = "CredWriteW", CharSet = CharSet.Unicode, SetLastError = true)]',
  '  public static extern bool CredWriteW(ref CREDENTIAL cred, int flags);',
  '  [DllImport("Advapi32.dll")]',
  '  public static extern void CredFree(IntPtr cred);',
  '}',
];

/** DLL 文件名绑定 C# 源码 hash：源码一变文件名即变，杜绝加载旧结构 DLL 写坏凭据（2026-11-16 审视修正） */
export const WIN_CRED_DLL_NAME = `KiteWinCred_${createHash('sha1').update(CS_SOURCE_LINES.join('\n')).digest('hex').slice(0, 8)}.dll`;

const PS_TEMPLATE = [
  "$ErrorActionPreference = 'Stop'",
  "$ProgressPreference = 'SilentlyContinue'",
  "$DllDir = '<DLLDIR>'",
  "if (-not (Test-Path $DllDir)) { New-Item -ItemType Directory -Path $DllDir -Force | Out-Null }",
  "$Dll = Join-Path $DllDir '<DLLNAME>'",
  "$Mode = '<MODE>'",
  "$Target = '<TARGET>'",
  "$User = '<USER>'",
  "$BlobBase64 = '<BLOB>'",
  "$src = @'",
  ...CS_SOURCE_LINES,
  "'@",
  // 首次切号用 csc 预编译到共享 DLL，后续切号 Add-Type -Path 直接加载，
  // 省掉每次 PowerShell 进程内重编译 C#（真机实测 hot.cred 中位 4.5s，编译占大头）。
  'if (Test-Path $Dll) {',
  '  try { Add-Type -Path $Dll | Out-Null } catch { Add-Type -TypeDefinition $src | Out-Null }',
  '} else {',
  '  Add-Type -TypeDefinition $src | Out-Null',
  '  try {',
  '    $csc = Join-Path $env:WINDIR "Microsoft.NET\\Framework64\\v4.0.30319\\csc.exe"',
  '    if (Test-Path $csc) {',
  '      $srcFile = [System.IO.Path]::ChangeExtension($Dll, ".cs")',
  '      Set-Content -Path $srcFile -Value $src -Encoding UTF8',
  '      & $csc /nologo /target:library /out:$Dll $srcFile | Out-Null',
  '      Remove-Item -Force $srcFile -ErrorAction SilentlyContinue',
  '    }',
  '  } catch {}',
  '}',
  'function Read-KiteCred([string]$target) {',
  '  $ptr = [IntPtr]::Zero',
  '  if (-not [KiteWinCred]::CredReadW($target, 1, 0, [ref]$ptr)) { throw ("CredReadW failed err=" + [Runtime.InteropServices.Marshal]::GetLastWin32Error()) }',
  '  try {',
  '    $cred = [Runtime.InteropServices.Marshal]::PtrToStructure($ptr, [type][KiteWinCred+CREDENTIAL])',
  '    $bytes = New-Object byte[] $cred.CredentialBlobSize',
  '    [Runtime.InteropServices.Marshal]::Copy($cred.CredentialBlob, $bytes, 0, $cred.CredentialBlobSize)',
  '    return @{ user = $cred.UserName; blob = [Convert]::ToBase64String($bytes) }',
  '  } finally { [KiteWinCred]::CredFree($ptr) }',
  '}',
  'function Write-KiteCred([string]$target, [string]$user, [byte[]]$bytes) {',
  '  $ptr = [Runtime.InteropServices.Marshal]::AllocHGlobal([Math]::Max(1, $bytes.Length))',
  '  try {',
  '    [Runtime.InteropServices.Marshal]::Copy($bytes, 0, $ptr, $bytes.Length)',
  '    $cred = New-Object KiteWinCred+CREDENTIAL',
  '    $cred.Flags = 0',
  '    $cred.Type = 1',
  '    $cred.TargetName = $target',
  '    $cred.CredentialBlobSize = $bytes.Length',
  '    $cred.CredentialBlob = $ptr',
  '    $cred.Persist = 2',
  '    $cred.UserName = $user',
  '    if (-not [KiteWinCred]::CredWriteW([ref]$cred, 0)) { throw ("CredWriteW failed err=" + [Runtime.InteropServices.Marshal]::GetLastWin32Error()) }',
  '  } finally { [Runtime.InteropServices.Marshal]::FreeHGlobal($ptr) }',
  '}',
  "if ($Mode -eq 'Read') {",
  '  $r = Read-KiteCred $Target',
  '  [Console]::Out.Write((ConvertTo-Json @{ ok = $true; user = $r.user; blobBase64 = $r.blob } -Compress))',
  "} elseif ($Mode -eq 'Write') {",
  '  $bytes = [Convert]::FromBase64String($BlobBase64)',
  '  Write-KiteCred $Target $User $bytes',
  '  [Console]::Out.Write((ConvertTo-Json @{ ok = $true } -Compress))',
  "} elseif ($Mode -eq 'Swap') {",
  '  # 读旧 + 写新一次完成：省掉一次 powershell 启动与 Add-Type 编译（切号链路最大固定开销）',
  '  $oldB64 = ""',
  '  $oldUser = $User',
  '  $oldJson = ""',
  '  try {',
  '    $r = Read-KiteCred $Target',
  '    $oldB64 = $r.blob',
  '    $oldUser = $r.user',
  '    $oldJson = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($oldB64))',
  '  } catch { }',
  '  $newText = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($BlobBase64))',
  '  if ($oldJson -ne "") {',
  '    try {',
  '      $oldObj = $oldJson | ConvertFrom-Json',
  '      $newObj = $newText | ConvertFrom-Json',
  '      if ($oldObj.writer_id) { $newObj.writer_id = $oldObj.writer_id }',
  '      if ($oldObj.auth_method) { $newObj.auth_method = $oldObj.auth_method }',
  '      $newText = $newObj | ConvertTo-Json -Depth 8 -Compress',
  '    } catch { }',
  '  }',
  '  $newBytes = [Text.Encoding]::UTF8.GetBytes($newText)',
  '  Write-KiteCred $Target $oldUser $newBytes',
  '  [Console]::Out.Write((ConvertTo-Json @{ ok = $true; oldBlobBase64 = $oldB64; oldUser = $oldUser } -Compress))',
  "} elseif ($Mode -eq 'Delete') {",
  '  $ptr = [IntPtr]::Zero',
  '  if ([KiteWinCred]::CredReadW($Target, 1, 0, [ref]$ptr)) {',
  '    [KiteWinCred]::CredFree($ptr)',
  "    $del = @'",
  'using System; using System.Runtime.InteropServices;',
  'public static class KiteCredDel {',
  '  [DllImport("Advapi32.dll", EntryPoint = "CredDeleteW", CharSet = CharSet.Unicode, SetLastError = true)]',
  '  public static extern bool CredDeleteW(string target, int type, int flags);',
  '}',
  "'@",
  '    Add-Type -TypeDefinition $del | Out-Null',
  '    [KiteCredDel]::CredDeleteW($Target, 1, 0) | Out-Null',
  '  }',
  '  [Console]::Out.Write((ConvertTo-Json @{ ok = $true } -Compress))',
  '} else {',
  '  throw "unknown mode"',
  '}',
].join('\n');

function runPs(script: string, timeoutMs = 45000): Promise<string> {
  return new Promise((resolve, reject) => {
    const encoded = Buffer.from(script, 'utf16le').toString('base64');
    const child = cp.spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', encoded], {
      windowsHide: true,
    });
    let stdout = '';
    let stderr = '';
    let settled = false;
    const timer = setTimeout(() => {
      if (!settled) { settled = true; try { child.kill(); } catch { /* 已退出 */ } reject(new Error('powershell timeout')); }
    }, timeoutMs);
    child.stdout.on('data', (d) => { stdout += String(d); });
    child.stderr.on('data', (d) => { stderr += String(d); });
    child.on('error', (e) => { if (!settled) { settled = true; clearTimeout(timer); reject(e); } });
    child.on('exit', (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (code !== 0) reject(new Error('powershell exit ' + code + ': ' + stderr.slice(-400)));
      else resolve(stdout);
    });
  });
}

export interface PsCredJsonResponse {
  ok?: boolean;
  error?: string;
  user?: string;
  blobBase64?: string;
  oldBlobBase64?: string;
  oldUser?: string;
}

/** 统一校验并规整 PowerShell 凭据回退响应：任何非 ok / 缺字段都必须返回非空 error，严禁静默吞错或返回 undefined */
export function normalizePsCredResponse(
  action: 'Read' | 'Write' | 'Swap',
  rawOut: string
): { ok: true; json: PsCredJsonResponse } | { ok: false; error: string } {
  let json: PsCredJsonResponse;
  try {
    json = JSON.parse((rawOut || '').trim()) as PsCredJsonResponse;
  } catch (e) {
    return {
      ok: false,
      error: `PowerShell ${action} invalid JSON: ${e instanceof Error ? e.message : String(e)}`,
    };
  }
  if (!json || typeof json !== 'object' || json.ok !== true) {
    const errMsg = typeof json?.error === 'string' && json.error.trim()
      ? json.error.trim()
      : `PowerShell ${action} failed (ok=${String(json?.ok)})`;
    return { ok: false, error: errMsg };
  }
  if (action === 'Read' && (typeof json.blobBase64 !== 'string' || !json.blobBase64)) {
    return { ok: false, error: 'PowerShell Read returned empty credential blob' };
  }
  return { ok: true, json };
}

/** 凭据脚本渲染：统一注入 DLL 缓存目录与 DLL 名，避免三处调用各拼一遍漏掉占位符 */
function renderPs(mode: 'Read' | 'Write' | 'Swap', target: string, user: string, blob: string): string {
  const dllDir = path.join(getAppDataDir(), '.antigravity-kite', 'dll').replace(/'/g, "''");
  return PS_TEMPLATE
    .replace('<MODE>', mode)
    .replace('<TARGET>', target.replace(/'/g, "''"))
    .replace('<USER>', user.replace(/'/g, "''"))
    .replace('<BLOB>', blob)
    .replace('<DLLDIR>', dllDir)
    .replace('<DLLNAME>', WIN_CRED_DLL_NAME);
}

export interface IdeCredentialReadResult {
  ok: boolean;
  user?: string;
  blobBase64?: string;
  parsed?: IdeCredential;
  error?: string;
}

/** 读取 IDE 凭据（gemini:antigravity；targetOverride 仅供自测） */
export async function readIdeCredential(targetOverride?: string): Promise<IdeCredentialReadResult> {
  try {
    assertWindowsCredAvailable();
    const target = targetOverride || IDE_CRED_TARGET;
    const helper = await ensureWinNativeHelper();
    if (helper) {
      const res = await runWinCredRead(target);
      if (!res.ok || !res.blobBase64) {
        return { ok: false, error: res.error || 'CredReadW failed' };
      }
      const parsed = JSON.parse(Buffer.from(res.blobBase64, 'base64').toString('utf8')) as IdeCredential;
      return { ok: true, user: res.user, blobBase64: res.blobBase64, parsed };
    }
    const script = renderPs('Read', target, '', '');
    const out = await runPs(script);
    const res = normalizePsCredResponse('Read', out);
    if (!res.ok) return { ok: false, error: res.error };
    const parsed = JSON.parse(Buffer.from(res.json.blobBase64!, 'base64').toString('utf8')) as IdeCredential;
    return { ok: true, user: res.json.user, blobBase64: res.json.blobBase64, parsed };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

/** 写入 IDE 凭据（blobBase64 为 UTF-8 JSON 字节的 base64；targetOverride 仅供自测） */
export async function writeIdeCredentialBlob(blobBase64: string, user: string, targetOverride?: string): Promise<{ ok: boolean; error?: string }> {
  try {
    assertWindowsCredAvailable();
    const target = targetOverride || IDE_CRED_TARGET;
    const helper = await ensureWinNativeHelper();
    if (helper) {
      const res = await runWinCredWrite(target, user, blobBase64);
      return res.ok ? { ok: true } : { ok: false, error: res.error || 'CredWriteW failed' };
    }
    const script = renderPs('Write', target, user, blobBase64);
    const out = await runPs(script);
    const res = normalizePsCredResponse('Write', out);
    return res.ok ? { ok: true } : { ok: false, error: res.error };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

export interface IdeCredentialSwapResult {
  ok: boolean;
  error?: string;
  /** 被覆盖的旧凭据（内部或预读阶段读出，用于回滚备份） */
  previous?: IdeCredential;
  previousUser?: string;
}

/**
 * 合并旧凭据的 writer_id / auth_method 并写入新凭据。
 * 若外部已在并发阶段传入 preRead（Phase A 零增量读完），则无需再次读凭据，直接一次 native write（~100ms）落地。
 */
export async function swapIdeCredential(
  blobBase64: string,
  user: string,
  targetOverride?: string,
  preRead?: IdeCredentialReadResult,
): Promise<IdeCredentialSwapResult> {
  try {
    assertWindowsCredAvailable();
    const target = targetOverride || IDE_CRED_TARGET;
    const helper = await ensureWinNativeHelper();
    if (helper) {
      let prev = preRead;
      if (!prev) {
        try {
          const raw = await runWinCredRead(target);
          if (raw.ok && raw.blobBase64) {
            let parsed: IdeCredential | undefined;
            try {
              parsed = JSON.parse(Buffer.from(raw.blobBase64, 'base64').toString('utf8')) as IdeCredential;
            } catch { /* 非 JSON 旧 blob 仅跳过继承 */ }
            prev = { ok: true, user: raw.user, blobBase64: raw.blobBase64, parsed };
          } else {
            prev = { ok: false, error: raw.error };
          }
        } catch {
          prev = { ok: false };
        }
      }
      let finalBlobBase64 = blobBase64;
      let writeUser = user;
      if (prev.ok) {
        if (prev.user) writeUser = prev.user;
        if (prev.parsed) {
          try {
            const newObj = JSON.parse(Buffer.from(blobBase64, 'base64').toString('utf8')) as Record<string, unknown>;
            if (prev.parsed.writer_id) newObj.writer_id = prev.parsed.writer_id;
            if (prev.parsed.auth_method) newObj.auth_method = prev.parsed.auth_method;
            finalBlobBase64 = Buffer.from(JSON.stringify(newObj), 'utf8').toString('base64');
          } catch { /* 新 blob 解析异常时仍按原样写入 */ }
        }
      }
      const wRes = await runWinCredWrite(target, writeUser, finalBlobBase64);
      if (!wRes.ok) {
        return { ok: false, error: wRes.error || 'CredWriteW failed' };
      }
      return {
        ok: true,
        previous: prev.parsed,
        previousUser: prev.ok ? (prev.user || user) : user,
      };
    }
    const script = renderPs('Swap', target, user, blobBase64);
    const out = await runPs(script);
    const res = normalizePsCredResponse('Swap', out);
    let previous: IdeCredential | undefined;
    if (res.ok && res.json.oldBlobBase64) {
      try {
        previous = JSON.parse(Buffer.from(res.json.oldBlobBase64, 'base64').toString('utf8')) as IdeCredential;
      } catch { /* 旧 blob 非 JSON：只影响备份，不影响切换 */ }
    }
    if (!res.ok) {
      return { ok: false, error: res.error };
    }
    return { ok: true, previous, previousUser: res.json.oldUser };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

/** 与 IDE 现有格式一致的 expiry（本地时区 ISO，7 位小数秒） */
export function isoWithLocalOffset(ms: number): string {
  const d = new Date(ms);
  const off = -d.getTimezoneOffset();
  const sign = off >= 0 ? '+' : '-';
  const abs = Math.abs(off);
  const p = (n: number, l = 2) => String(n).padStart(l, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}.${p(d.getMilliseconds() * 1000, 7)}${sign}${p(Math.floor(abs / 60))}:${p(abs % 60)}`;
}

/** 构造与 IDE 现有格式完全一致的凭据 blob（UTF-8 JSON） */
export function buildIdeCredentialBlob(params: {
  email: string;
  accessToken: string;
  refreshToken: string;
  /** 毫秒时间戳；AT 过期也没关系，IDE 启动后用 RT 自刷新 */
  expiryMs: number;
  authMethod?: string;
  writerId?: string;
}): { blobBase64: string; parsed: IdeCredential } {
  const obj: IdeCredential = {
    token: {
      access_token: params.accessToken,
      token_type: 'Bearer',
      refresh_token: params.refreshToken,
      expiry: isoWithLocalOffset(params.expiryMs),
      expires_in: 3599,
    },
    auth_method: params.authMethod || 'consumer',
    id_token_email: params.email,
    writer_id: params.writerId || '',
  };
  return { blobBase64: Buffer.from(JSON.stringify(obj), 'utf8').toString('base64'), parsed: obj };
}

/** 同步 ~/.gemini 下的账号文件（google_accounts.json / oauth_creds.json），保留未知字段 */
export function syncGeminiAccountFiles(params: { email: string; accessToken: string; refreshToken: string; expiryMs: number }): { ok: boolean; error?: string } {
  try {
    const dir = path.join(os.homedir(), '.gemini');
    fs.mkdirSync(dir, { recursive: true });

    // google_accounts.json：active 指向目标号，原 active 挪入 old
    const gaFile = path.join(dir, 'google_accounts.json');
    let ga: { active?: string; old?: string[] } = { active: params.email, old: [] };
    try { ga = { ...ga, ...JSON.parse(fs.readFileSync(gaFile, 'utf8')) }; } catch { /* 不存在即用默认 */ }
    const prevActive = ga.active;
    ga.active = params.email;
    if (prevActive && prevActive !== params.email) {
      if (!Array.isArray(ga.old)) ga.old = [];
      if (!ga.old.includes(prevActive)) ga.old.push(prevActive);
    }
    fs.writeFileSync(gaFile, JSON.stringify(ga, null, 2), 'utf8');

    // oauth_creds.json：整体替换 token 相关字段，保留其它字段（如 cockpit 标记）
    const ocFile = path.join(dir, 'oauth_creds.json');
    let oc: Record<string, unknown> = {};
    try { oc = JSON.parse(fs.readFileSync(ocFile, 'utf8')); } catch { /* 不存在即新建 */ }
    oc.access_token = params.accessToken;
    oc.token_type = 'Bearer';
    oc.refresh_token = params.refreshToken;
    oc.expiry_date = params.expiryMs;
    oc.id_token_email = params.email;
    fs.writeFileSync(ocFile, JSON.stringify(oc, null, 2), 'utf8');

    return { ok: true };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}
