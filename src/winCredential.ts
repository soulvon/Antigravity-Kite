/**
 * Windows 凭据管理器读写（gemini:antigravity）
 *
 * 身份权威来源：IDE 主进程启动时从此条目读取 id_token_email 建立认证会话
 * （bundle 逆向 + 真机实验证实：写它 + 重启 = 身份/头像/名字/额度完整切换；
 *   写 state.vscdb 对界面身份无效）。
 *
 * 实现方式：生成 PowerShell 脚本（Add-Type P/Invoke CredReadW/CredWriteW），
 * 以 -EncodedCommand 执行，避免引号转义问题。
 * 本模块不 import vscode，供扩展与关-写-重启助手共用。
 */
import * as cp from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

export const IDE_CRED_TARGET = 'gemini:antigravity';

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

const PS_TEMPLATE = [
  "$ErrorActionPreference = 'Stop'",
  "$Mode = '<MODE>'",
  "$Target = '<TARGET>'",
  "$User = '<USER>'",
  "$BlobBase64 = '<BLOB>'",
  "$src = @'",
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
  "'@",
  'Add-Type -TypeDefinition $src | Out-Null',
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
      if (code !== 0) reject(new Error('powershell exit ' + code + ': ' + stderr.slice(0, 300)));
      else resolve(stdout);
    });
  });
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
    const script = PS_TEMPLATE
      .replace('<MODE>', 'Read')
      .replace('<TARGET>', (targetOverride || IDE_CRED_TARGET).replace(/'/g, "''"))
      .replace('<USER>', '')
      .replace('<BLOB>', '');
    const out = await runPs(script);
    const json = JSON.parse(out.trim());
    const parsed = JSON.parse(Buffer.from(json.blobBase64, 'base64').toString('utf8')) as IdeCredential;
    return { ok: true, user: json.user, blobBase64: json.blobBase64, parsed };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

/** 写入 IDE 凭据（blobBase64 为 UTF-8 JSON 字节的 base64；targetOverride 仅供自测） */
export async function writeIdeCredentialBlob(blobBase64: string, user: string, targetOverride?: string): Promise<{ ok: boolean; error?: string }> {
  try {
    const script = PS_TEMPLATE
      .replace('<MODE>', 'Write')
      .replace('<TARGET>', (targetOverride || IDE_CRED_TARGET).replace(/'/g, "''"))
      .replace('<USER>', user.replace(/'/g, "''"))
      .replace('<BLOB>', blobBase64);
    const out = await runPs(script);
    JSON.parse(out.trim());
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

/** 删除凭据（仅自测清理用） */
export async function deleteIdeCredentialByTarget(target: string): Promise<{ ok: boolean; error?: string }> {
  try {
    const script = PS_TEMPLATE
      .replace('<MODE>', 'Delete')
      .replace('<TARGET>', target.replace(/'/g, "''"))
      .replace('<USER>', '')
      .replace('<BLOB>', '');
    await runPs(script);
    return { ok: true };
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
