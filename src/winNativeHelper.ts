/**
 * Windows 原生轻量 Helper 编译缓存与调用器（零 powershell.exe 启动开销）
 *
 * 将 Win32 P/Invoke（CredReadW / CredWriteW / CredDeleteW / CreateToolhelp32Snapshot /
 * TerminateProcess）编译为单个带源码哈希缓存的轻量 .NET Framework 控制台工具
 * （%APPDATA%\.antigravity-kite\bin\KiteWinHelper_<hash>.exe）。
 *
 * 相比每次冷启 powershell.exe（实测 2.6s~5.2s），预编译后的原生 .exe
 * 单次执行仅 ~100ms，无第三方原生模块、不膨胀 VSIX 包体、零 vscode 依赖。
 */
import * as cp from 'child_process';
import { createHash } from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import { getAppDataDir } from './platformPaths';
import { logWarn } from './logger';

const HELPER_CS_LINES = [
  'using System;',
  'using System.Collections.Generic;',
  'using System.Runtime.InteropServices;',
  'using System.Text;',
  'public static class KiteWinHelper {',
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
  '  [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]',
  '  public struct PROCESSENTRY32W {',
  '    public uint dwSize;',
  '    public uint cntUsage;',
  '    public uint th32ProcessID;',
  '    public IntPtr th32DefaultHeapID;',
  '    public uint th32ModuleID;',
  '    public uint cntThreads;',
  '    public uint th32ParentProcessID;',
  '    public int pcPriClassBase;',
  '    public uint dwFlags;',
  '    [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 260)]',
  '    public string szExeFile;',
  '  }',
  '  [DllImport("Advapi32.dll", EntryPoint = "CredReadW", CharSet = CharSet.Unicode, SetLastError = true)]',
  '  static extern bool CredReadW(string target, int type, int flags, out IntPtr credPtr);',
  '  [DllImport("Advapi32.dll", EntryPoint = "CredWriteW", CharSet = CharSet.Unicode, SetLastError = true)]',
  '  static extern bool CredWriteW(ref CREDENTIAL cred, int flags);',
  '  [DllImport("Advapi32.dll", EntryPoint = "CredDeleteW", CharSet = CharSet.Unicode, SetLastError = true)]',
  '  static extern bool CredDeleteW(string target, int type, int flags);',
  '  [DllImport("Advapi32.dll")]',
  '  static extern void CredFree(IntPtr cred);',
  '  [DllImport("Kernel32.dll", SetLastError = true)]',
  '  static extern IntPtr CreateToolhelp32Snapshot(uint dwFlags, uint th32ProcessID);',
  '  [DllImport("Kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]',
  '  static extern bool Process32FirstW(IntPtr hSnapshot, ref PROCESSENTRY32W lppe);',
  '  [DllImport("Kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]',
  '  static extern bool Process32NextW(IntPtr hSnapshot, ref PROCESSENTRY32W lppe);',
  '  [DllImport("Kernel32.dll", SetLastError = true)]',
  '  static extern IntPtr OpenProcess(uint dwDesiredAccess, bool bInheritHandle, uint dwProcessId);',
  '  [DllImport("Kernel32.dll", SetLastError = true)]',
  '  static extern bool TerminateProcess(IntPtr hProcess, uint uExitCode);',
  '  [DllImport("Kernel32.dll", SetLastError = true)]',
  '  static extern bool CloseHandle(IntPtr hObject);',
  '  static readonly IntPtr INVALID_HANDLE_VALUE = new IntPtr(-1);',
  '  static string JsonStr(string s) {',
  '    if (s == null) return "null";',
  '    var sb = new StringBuilder(s.Length + 8);',
  '    sb.Append(\'"\');',
  '    foreach (char c in s) {',
  '      if (c == \'"\') sb.Append("\\\\\\"");',
  '      else if (c == \'\\\\\') sb.Append("\\\\\\\\");',
  '      else if (c == \'\\b\') sb.Append("\\\\b");',
  '      else if (c == \'\\f\') sb.Append("\\\\f");',
  '      else if (c == \'\\n\') sb.Append("\\\\n");',
  '      else if (c == \'\\r\') sb.Append("\\\\r");',
  '      else if (c == \'\\t\') sb.Append("\\\\t");',
  '      else if (c < 32) sb.AppendFormat("\\\\u{0:x4}", (int)c);',
  '      else sb.Append(c);',
  '    }',
  '    sb.Append(\'"\');',
  '    return sb.ToString();',
  '  }',
  '  static List<PROCESSENTRY32W> SnapshotProcesses() {',
  '    var list = new List<PROCESSENTRY32W>(512);',
  '    IntPtr snap = CreateToolhelp32Snapshot(2, 0);',
  '    if (snap == IntPtr.Zero || snap == INVALID_HANDLE_VALUE) return list;',
  '    try {',
  '      var pe = new PROCESSENTRY32W();',
  '      pe.dwSize = (uint)Marshal.SizeOf(typeof(PROCESSENTRY32W));',
  '      if (Process32FirstW(snap, ref pe)) {',
  '        do { list.Add(pe); } while (Process32NextW(snap, ref pe));',
  '      }',
  '    } finally { CloseHandle(snap); }',
  '    return list;',
  '  }',
  '  static void LocateAgy(List<PROCESSENTRY32W> all, uint selfPid, out uint rootPid, out List<uint> treeAgy, out List<uint> allAgy) {',
  '    var byPid = new Dictionary<uint, PROCESSENTRY32W>(all.Count);',
  '    var children = new Dictionary<uint, List<uint>>(all.Count);',
  '    allAgy = new List<uint>();',
  '    foreach (var p in all) {',
  '      byPid[p.th32ProcessID] = p;',
  '      List<uint> ch;',
  '      if (!children.TryGetValue(p.th32ParentProcessID, out ch)) { ch = new List<uint>(); children[p.th32ParentProcessID] = ch; }',
  '      ch.Add(p.th32ProcessID);',
  '      if (p.szExeFile != null && p.szExeFile.Equals("agy.exe", StringComparison.OrdinalIgnoreCase)) {',
  '        allAgy.Add(p.th32ProcessID);',
  '      }',
  '    }',
  '    rootPid = 0;',
  '    if (selfPid > 0 && byPid.ContainsKey(selfPid)) {',
  '      uint cur = selfPid;',
  '      string selfExe = byPid[selfPid].szExeFile ?? "";',
  '      var seen = new HashSet<uint>();',
  '      while (byPid.ContainsKey(cur) && seen.Add(cur)) {',
  '        uint ppid = byPid[cur].th32ParentProcessID;',
  '        PROCESSENTRY32W parent;',
  '        if (!byPid.TryGetValue(ppid, out parent)) break;',
  '        string pExe = parent.szExeFile ?? "";',
  '        bool sameFamily = (!string.IsNullOrEmpty(selfExe) && pExe.Equals(selfExe, StringComparison.OrdinalIgnoreCase))',
  '          || pExe.StartsWith("Antigravity", StringComparison.OrdinalIgnoreCase);',
  '        if (!sameFamily) break;',
  '        cur = ppid;',
  '      }',
  '      rootPid = cur;',
  '    }',
  '    treeAgy = new List<uint>();',
  '    if (rootPid > 0) {',
  '      var desc = new HashSet<uint>();',
  '      var q = new Queue<uint>();',
  '      q.Enqueue(rootPid);',
  '      while (q.Count > 0) {',
  '        uint pid = q.Dequeue();',
  '        List<uint> ch;',
  '        if (!children.TryGetValue(pid, out ch)) continue;',
  '        foreach (uint c in ch) if (desc.Add(c)) q.Enqueue(c);',
  '      }',
  '      foreach (uint a in allAgy) if (desc.Contains(a)) treeAgy.Add(a);',
  '    }',
  '  }',
  '  static bool KillProcessSubtree(List<PROCESSENTRY32W> all, uint targetPid) {',
  '    var children = new Dictionary<uint, List<uint>>();',
  '    foreach (var p in all) {',
  '      List<uint> ch;',
  '      if (!children.TryGetValue(p.th32ParentProcessID, out ch)) { ch = new List<uint>(); children[p.th32ParentProcessID] = ch; }',
  '      ch.Add(p.th32ProcessID);',
  '    }',
  '    var toKill = new List<uint>();',
  '    var seen = new HashSet<uint>();',
  '    var q = new Queue<uint>();',
  '    if (seen.Add(targetPid)) q.Enqueue(targetPid);',
  '    while (q.Count > 0) {',
  '      uint cur = q.Dequeue();',
  '      toKill.Add(cur);',
  '      List<uint> ch;',
  '      if (children.TryGetValue(cur, out ch)) foreach (uint c in ch) if (seen.Add(c)) q.Enqueue(c);',
  '    }',
  '    bool targetKilled = false;',
  '    for (int i = toKill.Count - 1; i >= 0; i--) {',
  '      uint pid = toKill[i];',
  '      IntPtr h = OpenProcess(0x0001, false, pid);',
  '      if (h != IntPtr.Zero) {',
  '        bool ok = TerminateProcess(h, 1);',
  '        CloseHandle(h);',
  '        if (pid == targetPid && ok) targetKilled = true;',
  '      }',
  '    }',
  '    return targetKilled;',
  '  }',
  '  public static int Main(string[] args) {',
  '    Console.OutputEncoding = new UTF8Encoding(false);',
  '    Console.InputEncoding = new UTF8Encoding(false);',
  '    if (args.Length < 1) { Console.WriteLine("{\\"ok\\":false,\\"error\\":\\"missing cmd\\"}"); return 1; }',
  '    string cmd = args[0];',
  '    if (cmd == "cred-read" && args.Length >= 2) {',
  '      IntPtr ptr = IntPtr.Zero;',
  '      if (!CredReadW(args[1], 1, 0, out ptr)) {',
  '        int err = Marshal.GetLastWin32Error();',
  '        Console.WriteLine("{\\"ok\\":false,\\"code\\":" + err + ",\\"error\\":" + JsonStr("CredReadW failed err=" + err) + "}");',
  '        return 0;',
  '      }',
  '      try {',
  '        var cred = (CREDENTIAL)Marshal.PtrToStructure(ptr, typeof(CREDENTIAL));',
  '        byte[] bytes = new byte[cred.CredentialBlobSize];',
  '        if (cred.CredentialBlobSize > 0) Marshal.Copy(cred.CredentialBlob, bytes, 0, cred.CredentialBlobSize);',
  '        Console.WriteLine("{\\"ok\\":true,\\"user\\":" + JsonStr(cred.UserName ?? "") + ",\\"blobBase64\\":" + JsonStr(Convert.ToBase64String(bytes)) + "}");',
  '      } finally { CredFree(ptr); }',
  '      return 0;',
  '    }',
  '    if (cmd == "cred-write" && args.Length >= 3) {',
  '      string b64 = (Console.In.ReadToEnd() ?? "").Trim();',
  '      byte[] bytes = Convert.FromBase64String(b64);',
  '      IntPtr ptr = Marshal.AllocHGlobal(Math.Max(1, bytes.Length));',
  '      try {',
  '        if (bytes.Length > 0) Marshal.Copy(bytes, 0, ptr, bytes.Length);',
  '        var cred = new CREDENTIAL {',
  '          Flags = 0, Type = 1, TargetName = args[1],',
  '          CredentialBlobSize = bytes.Length, CredentialBlob = ptr,',
  '          Persist = 2, UserName = args[2]',
  '        };',
  '        if (!CredWriteW(ref cred, 0)) {',
  '          int err = Marshal.GetLastWin32Error();',
  '          Console.WriteLine("{\\"ok\\":false,\\"code\\":" + err + ",\\"error\\":" + JsonStr("CredWriteW failed err=" + err) + "}");',
  '          return 0;',
  '        }',
  '        Console.WriteLine("{\\"ok\\":true}");',
  '      } finally { Marshal.FreeHGlobal(ptr); }',
  '      return 0;',
  '    }',
  '    if (cmd == "cred-delete" && args.Length >= 2) {',
  '      IntPtr ptr = IntPtr.Zero;',
  '      if (CredReadW(args[1], 1, 0, out ptr)) { CredFree(ptr); CredDeleteW(args[1], 1, 0); }',
  '      Console.WriteLine("{\\"ok\\":true}");',
  '      return 0;',
  '    }',
  '    if (cmd == "agy-locate") {',
  '      uint selfPid = args.Length >= 2 ? uint.Parse(args[1]) : 0;',
  '      var all = SnapshotProcesses();',
  '      if (all.Count == 0) { Console.WriteLine("{\\"ok\\":false,\\"error\\":\\"CreateToolhelp32Snapshot empty\\"}"); return 0; }',
  '      uint rootPid; List<uint> treeAgy; List<uint> allAgy;',
  '      LocateAgy(all, selfPid, out rootPid, out treeAgy, out allAgy);',
  '      Console.WriteLine("{\\"ok\\":true,\\"rootPid\\":" + rootPid + ",\\"treeAgy\\":[" + string.Join(",", treeAgy) + "],\\"allAgy\\":[" + string.Join(",", allAgy) + "]}");',
  '      return 0;',
  '    }',
  '    if (cmd == "agy-reload") {',
  '      uint selfPid = args.Length >= 2 ? uint.Parse(args[1]) : 0;',
  '      var all = SnapshotProcesses();',
  '      if (all.Count == 0) { Console.WriteLine("{\\"ok\\":false,\\"error\\":\\"CreateToolhelp32Snapshot empty\\"}"); return 0; }',
  '      uint rootPid; List<uint> treeAgy; List<uint> allAgy;',
  '      LocateAgy(all, selfPid, out rootPid, out treeAgy, out allAgy);',
  '      var targets = treeAgy.Count > 0 ? treeAgy : (allAgy.Count == 1 ? allAgy : new List<uint>());',
  '      bool needsDisambiguate = treeAgy.Count == 0 && allAgy.Count >= 2;',
  '      var killed = new List<uint>();',
  '      var failed = new List<uint>();',
  '      foreach (uint p in targets) { if (KillProcessSubtree(all, p)) killed.Add(p); else failed.Add(p); }',
  '      Console.WriteLine("{\\"ok\\":true,\\"rootPid\\":" + rootPid + ",\\"treeAgy\\":[" + string.Join(",", treeAgy) + "],\\"allAgy\\":[" + string.Join(",", allAgy) + "],\\"killed\\":[" + string.Join(",", killed) + "],\\"failed\\":[" + string.Join(",", failed) + "],\\"needsDisambiguate\\":" + (needsDisambiguate ? "true" : "false") + "}");',
  '      return 0;',
  '    }',
  '    if (cmd == "kill-pids" && args.Length >= 2) {',
  '      var all = SnapshotProcesses();',
  '      var killed = new List<uint>();',
  '      var failed = new List<uint>();',
  '      foreach (string part in args[1].Split(new[] {\',\'}, StringSplitOptions.RemoveEmptyEntries)) {',
  '        uint p; if (uint.TryParse(part.Trim(), out p) && p > 0) {',
  '          if (KillProcessSubtree(all, p)) killed.Add(p); else failed.Add(p);',
  '        }',
  '      }',
  '      Console.WriteLine("{\\"ok\\":true,\\"killed\\":[" + string.Join(",", killed) + "],\\"failed\\":[" + string.Join(",", failed) + "]}");',
  '      return 0;',
  '    }',
  '    Console.WriteLine("{\\"ok\\":false,\\"error\\":\\"unknown cmd\\"}");',
  '    return 1;',
  '  }',
  '}',
];

export const WIN_HELPER_EXE_NAME = `KiteWinHelper_${createHash('sha1').update(HELPER_CS_LINES.join('\n')).digest('hex').slice(0, 8)}.exe`;

let _compilePromise: Promise<string | null> | null = null;

function resolveCscPath(): string | null {
  const winDir = process.env.WINDIR || 'C:\\Windows';
  const candidates = [
    path.join(winDir, 'Microsoft.NET', 'Framework64', 'v4.0.30319', 'csc.exe'),
    path.join(winDir, 'Microsoft.NET', 'Framework', 'v4.0.30319', 'csc.exe'),
  ];
  return candidates.find((p) => fs.existsSync(p)) || null;
}

export function getWinHelperExePath(): string {
  return path.join(getAppDataDir(), '.antigravity-kite', 'bin', WIN_HELPER_EXE_NAME);
}

/** 确保缓存的原生 Helper .exe 就绪（首次编译约 0.5s，后续直接命中缓存零编译；单飞防并发竞争） */
export async function ensureWinNativeHelper(): Promise<string | null> {
  if (process.platform !== 'win32') return null;
  const targetExe = getWinHelperExePath();
  try {
    if (fs.existsSync(targetExe) && fs.statSync(targetExe).size > 0) {
      return targetExe;
    }
  } catch { /* 继续走编译路径 */ }

  if (_compilePromise) return _compilePromise;

  _compilePromise = (async () => {
    const csc = resolveCscPath();
    if (!csc) {
      logWarn('winHelper.noCsc', { reason: 'csc.exe 未找到' });
      return null;
    }
    const binDir = path.dirname(targetExe);
    fs.mkdirSync(binDir, { recursive: true });
    const nonce = `${process.pid}.${Date.now()}.${Math.random().toString(16).slice(2, 8)}`;
    const tmpCs = path.join(binDir, `KiteWinHelper.${nonce}.cs`);
    const tmpExe = path.join(binDir, `KiteWinHelper.${nonce}.exe`);
    try {
      fs.writeFileSync(tmpCs, HELPER_CS_LINES.join('\r\n'), 'utf8');
      await new Promise<void>((resolve, reject) => {
        cp.execFile(
          csc,
          ['/nologo', '/optimize+', '/target:exe', `/out:${tmpExe}`, tmpCs],
          { windowsHide: true, timeout: 25000 },
          (err, stdout, stderr) => {
            if (err) reject(new Error(`csc exit: ${err.message} ${stderr || stdout}`));
            else resolve();
          },
        );
      });
      if (!fs.existsSync(tmpExe) || fs.statSync(tmpExe).size === 0) {
        return null;
      }
      // 原子落盘；多窗口并发编译同一版本时若目标已就绪则直接复用
      try {
        fs.renameSync(tmpExe, targetExe);
      } catch (e) {
        if (!fs.existsSync(targetExe)) throw e;
      }
      return targetExe;
    } catch (e) {
      logWarn('winHelper.compileFail', { message: e instanceof Error ? e.message : String(e) });
      return fs.existsSync(targetExe) ? targetExe : null;
    } finally {
      try { if (fs.existsSync(tmpCs)) fs.unlinkSync(tmpCs); } catch { /* 清理临时源码 */ }
      try { if (fs.existsSync(tmpExe)) fs.unlinkSync(tmpExe); } catch { /* 清理未重命名的临时产物 */ }
    }
  })().finally(() => {
    _compilePromise = null;
  });

  return _compilePromise;
}

function execWinHelper(args: string[], stdinText?: string, timeoutMs = 15000): Promise<string> {
  return new Promise(async (resolve, reject) => {
    const exe = await ensureWinNativeHelper();
    if (!exe) {
      reject(new Error('KiteWinHelper executable unavailable'));
      return;
    }
    const child = cp.spawn(exe, args, { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    let settled = false;
    const timer = setTimeout(() => {
      if (!settled) {
        settled = true;
        try { child.kill(); } catch { /* 已退出 */ }
        reject(new Error('KiteWinHelper timeout'));
      }
    }, timeoutMs);
    child.stdout.on('data', (d) => { stdout += String(d); });
    child.stderr.on('data', (d) => { stderr += String(d); });
    child.on('error', (e) => {
      if (!settled) { settled = true; clearTimeout(timer); reject(e); }
    });
    child.on('exit', (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (code !== 0) reject(new Error(`KiteWinHelper exit ${code}: ${stderr.slice(-300)} ${stdout.slice(-200)}`));
      else resolve(stdout.replace(/^\uFEFF/, '').trim());
    });
    if (stdinText !== undefined) {
      child.stdin.end(stdinText, 'utf8');
    } else {
      child.stdin.end();
    }
  });
}

export interface WinCredReadJson {
  ok: boolean;
  user?: string;
  blobBase64?: string;
  code?: number;
  error?: string;
}

export async function runWinCredRead(target: string): Promise<WinCredReadJson> {
  const out = await execWinHelper(['cred-read', target]);
  return JSON.parse(out) as WinCredReadJson;
}

export async function runWinCredWrite(target: string, user: string, blobBase64: string): Promise<{ ok: boolean; code?: number; error?: string }> {
  const out = await execWinHelper(['cred-write', target, user], blobBase64);
  return JSON.parse(out);
}

export async function runWinCredDelete(target: string): Promise<{ ok: boolean }> {
  const out = await execWinHelper(['cred-delete', target]);
  return JSON.parse(out);
}

export interface WinAgyLocateJson {
  ok: boolean;
  rootPid: number;
  treeAgy: number[];
  allAgy: number[];
}

export async function locateWinAgyNative(selfPid: number): Promise<WinAgyLocateJson | null> {
  try {
    const out = await execWinHelper(['agy-locate', String(selfPid)], undefined, 10000);
    const parsed = JSON.parse(out) as WinAgyLocateJson;
    return parsed && parsed.ok ? parsed : null;
  } catch (e) {
    logWarn('winHelper.agyLocate', { message: e instanceof Error ? e.message : String(e) });
    return null;
  }
}

export interface WinAgyReloadJson extends WinAgyLocateJson {
  killed: number[];
  failed: number[];
  needsDisambiguate: boolean;
}

export async function reloadWinAgyNative(selfPid: number): Promise<WinAgyReloadJson | null> {
  try {
    const out = await execWinHelper(['agy-reload', String(selfPid)], undefined, 10000);
    const parsed = JSON.parse(out) as WinAgyReloadJson;
    return parsed && parsed.ok ? parsed : null;
  } catch (e) {
    logWarn('winHelper.agyReload', { message: e instanceof Error ? e.message : String(e) });
    return null;
  }
}

export async function killWinPidsNative(pids: number[]): Promise<{ ok: boolean; killed: number[]; failed: number[] } | null> {
  if (pids.length === 0) return { ok: true, killed: [], failed: [] };
  try {
    const out = await execWinHelper(['kill-pids', pids.join(',')], undefined, 10000);
    return JSON.parse(out);
  } catch (e) {
    logWarn('winHelper.killPids', { message: e instanceof Error ? e.message : String(e) });
    return null;
  }
}
