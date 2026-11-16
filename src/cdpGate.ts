/**
 * CDP 门控：首次切号时探测调试端口，未开启则一次性引导（改快捷方式持久化 + 带端口重启）。
 *
 * 交互原则（克制）：
 * - 门控通过 → 静默放行，弹窗由自动确认器处理
 * - 未通过且从未询问过 → 模态提示一次；同意 → 持久化快捷方式 + 重启；拒绝 → 永不再问
 * - 拒绝/关闭设置 → 切号照常执行，弹窗手点一次（toast 说明一次）
 */
import * as vscode from 'vscode';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as cp from 'child_process';
import { logInfo, logWarn } from './logger';
import { probeCdpPort } from './declarationSuppressor';
import { t } from './i18n';
import { notifyUi, askUi } from './uiChannel';
import * as ideRuntime from './ideRuntime';

export type GateResult = 'ready' | 'manual' | 'relaunching';

function cdpPort(): number {
  return vscode.workspace.getConfiguration('antigravityKite').get<number>('cdpPort', 9333);
}

function autoConfirmEnabled(): boolean {
  return vscode.workspace.getConfiguration('antigravityKite').get<boolean>('autoConfirmDeclaration', true);
}

const IDE_SHORTCUT_EXE_RE = /(?:^|[\\/])antigravity(?:\s+ide)?\.exe$/i;

/** 校验快捷方式 TargetPath 是否指向 Antigravity IDE 主程序（排除 antigravity-tools 等第三方程序） */
export function isIdeShortcutTarget(targetPath: string): boolean {
  return IDE_SHORTCUT_EXE_RE.test(String(targetPath || '').trim());
}

/** 给桌面 / 开始菜单 / 任务栏中指向 Antigravity IDE 的快捷方式追加调试端口参数（WScript.Shell COM） */
async function patchShortcuts(port: number): Promise<{ patched: number; details: string[] }> {
  const ps = [
    "$ErrorActionPreference = 'SilentlyContinue'",
    "$flag = '--remote-debugging-port=" + port + "'",
    "$dirs = @(",
    "  [Environment]::GetFolderPath('Desktop'),",
    "  [Environment]::GetFolderPath('CommonDesktopDirectory'),",
    "  [Environment]::GetFolderPath('StartMenu') + '\\Programs',",
    "  [Environment]::GetFolderPath('CommonStartMenu') + '\\Programs',",
    "  \"$env:APPDATA\\Microsoft\\Internet Explorer\\Quick Launch\\User Pinned\\TaskBar\"",
    ")",
    "$ws = New-Object -ComObject WScript.Shell",
    "$patched = 0; $details = @()",
    "$lnks = foreach ($d in $dirs) { if (Test-Path $d) { Get-ChildItem -Path $d -Filter *.lnk -Recurse -Force } }",
    "foreach ($lnk in $lnks) {",
    "  try {",
    "    $s = $ws.CreateShortcut($lnk.FullName)",
    "    if ($s.TargetPath -and ($s.TargetPath.Trim() -match '(^|[\\\\/])antigravity(\\s+ide)?\\.exe$')) {",
    "      if ($s.Arguments -notmatch 'remote-debugging-port') {",
    "        $s.Arguments = ($s.Arguments + ' ' + $flag).Trim()",
    "        $s.Save()",
    "        $patched++; $details += $lnk.FullName",
    "      }",
    "    }",
    "  } catch {}",
    "}",
    "Write-Output ($patched.ToString() + '|' + ($details -join ';'))",
  ].join('\n');

  const tmp = path.join(os.tmpdir(), 'kite-patch-lnk.ps1');
  fs.writeFileSync(tmp, ps, 'utf8');
  return new Promise((resolve) => {
    cp.exec(
      `powershell -NoProfile -ExecutionPolicy Bypass -File "${tmp}"`,
      { timeout: 25000 },
      (err, stdout) => {
        try { fs.unlinkSync(tmp); } catch { /* 忽略 */ }
        if (err) { resolve({ patched: 0, details: [String(err).slice(0, 120)] }); return; }
        const m = String(stdout).trim().match(/^(\d+)\|(.*)$/s);
        resolve({ patched: m ? Number(m[1]) : 0, details: m && m[2] ? m[2].split(';').filter(Boolean) : [] });
      },
    );
  });
}

/** 从启动参数中移除已有 --remote-debugging-port（支持 =val 与空格双参数形式），再追加目标端口 */
export function sanitizeCdpLaunchArgs(args: string[], port: number): string[] {
  const cleaned: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--remote-debugging-port') {
      i += 1;
      continue;
    }
    if (/^--remote-debugging-port=/i.test(a)) continue;
    cleaned.push(a);
  }
  cleaned.push(`--remote-debugging-port=${port}`);
  return cleaned;
}

/** 构建独立重拉起脚本：先发送优雅退出信号并等待落盘，超时后再强杀兜底，避免丢失未保存窗口状态 */
export function buildRelaunchScript(launch: { exePath: string; args: string[]; pid: number }, port: number): string {
  const cleanArgs = sanitizeCdpLaunchArgs(launch.args, port);
  const logFile = path.join(os.tmpdir(), 'kite-cdp-relaunch.log');
  return [
    'const cp = require("child_process");',
    'const fs = require("fs");',
    `const pid = ${launch.pid};`,
    `const exe = ${JSON.stringify(launch.exePath)};`,
    `const args = ${JSON.stringify(cleanArgs)};`,
    `const logFile = ${JSON.stringify(logFile)};`,
    'const logErr = (tag, err) => { try { fs.appendFileSync(logFile, new Date().toISOString() + " " + tag + ": " + String(err && err.stack || err) + "\\n"); } catch {} };',
    'const cleanEnv = Object.assign({}, process.env);',
    'for (const k of ["ELECTRON_RUN_AS_NODE","ELECTRON_NO_ATTACH_CONSOLE","VSCODE_IPC_HOOK","VSCODE_IPC_HOOK_CLI","VSCODE_PID","VSCODE_CWD","VSCODE_HANDLES_UNCAUGHT_ERRORS"]) { delete cleanEnv[k]; }',
    'const isAlive = (p) => {',
    '  try { process.kill(p, 0); return true; }',
    '  catch (e) { return !!(e && e.code === "EPERM"); }',
    '};',
    'const launchApp = () => {',
    '  try {',
    '    const c = cp.spawn(exe, args, { detached: true, stdio: "ignore", windowsHide: false, env: cleanEnv });',
    '    c.once("spawn", () => process.exit(0));',
    '    c.once("error", (err) => { logErr("spawn", err); process.exit(1); });',
    '    c.unref();',
    '  } catch (err) { logErr("spawnSync", err); process.exit(1); }',
    '};',
    'const forceKillAndLaunch = () => {',
    '  if (process.platform === "win32") {',
    '    try { cp.execFileSync("taskkill", ["/PID", String(pid), "/T", "/F"], { stdio: "ignore", windowsHide: true, timeout: 4000 }); } catch (err) { logErr("taskkillForce", err); }',
    '    setTimeout(launchApp, 800);',
    '  } else {',
    '    try { process.kill(pid, "SIGKILL"); } catch (err) { logErr("sigkill", err); }',
    '    setTimeout(launchApp, 600);',
    '  }',
    '};',
    'setTimeout(() => {',
    '  if (process.platform === "win32") {',
    '    try { cp.execFileSync("taskkill", ["/PID", String(pid)], { stdio: "ignore", windowsHide: true, timeout: 2500 }); } catch (err) { logErr("taskkillGraceful", err); }',
    '  } else {',
    '    try { process.kill(pid, "SIGTERM"); } catch (err) { logErr("sigterm", err); }',
    '  }',
    '  const deadline = Date.now() + 6000;',
    '  const waitExit = () => {',
    '    if (!isAlive(pid)) { setTimeout(launchApp, 600); return; }',
    '    if (Date.now() >= deadline) { forceKillAndLaunch(); return; }',
    '    setTimeout(waitExit, 250);',
    '  };',
    '  setTimeout(waitExit, 250);',
    '}, 1200);',
  ].join('\n');
}

/** 轻量重启：延迟优雅关闭 IDE → 以原参数 + 调试端口重新拉起（独立进程执行，跨平台 win32/POSIX，失败留痕日志） */
function relaunchWithPort(launch: { exePath: string; args: string[]; pid: number }, port: number): void {
  const script = buildRelaunchScript(launch, port);
  const child = cp.spawn(process.execPath, ['-e', script], {
    detached: true,
    stdio: 'ignore',
    windowsHide: true,
    // process.execPath 可能是 Electron，运行 -e 助手脚本时必须显式保留 ELECTRON_RUN_AS_NODE=1
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
  });
  child.once('error', (err) => logWarn('cdpGate.relaunchHelperError', err));
  child.unref();
}

/**
 * 打补丁 + 带调试端口重启 IDE（幂等，可在设置面板反复调用）。
 * 失败必须把原因抛回调用方：第一次失败若不暴露，用户后面没有任何补救入口。
 */
export async function enableCdp(context: vscode.ExtensionContext): Promise<{ ok: boolean; error?: string }> {
  const p = cdpPort();
  if (process.platform === 'win32') {
    const patched = await patchShortcuts(p);
    logInfo('cdpGate.shortcuts', { patched: patched.patched, details: patched.details.slice(0, 3) });
    if (patched.patched === 0) {
      logWarn('cdpGate.shortcuts.none', {});
    }
  } else {
    // POSIX 无 .lnk 快捷方式可 patch：本次 relaunch 直接带端口；用户日后手动启动需自行附加参数
    logWarn('cdpGate.shortcuts.unsupported', { platform: process.platform });
  }
  try {
    const launch = await ideRuntime.getCurrentLaunchInfo();
    const exePath = launch.exePath || (await ideRuntime.detectExePath());
    if (!exePath) throw new Error(t('gateNoExe'));
    // 关掉 IDE 之前必须先确认 exe 真的在：否则重启失败就等于把用户窗口关了打不开
    if (!fs.existsSync(exePath)) throw new Error(t('gateNoExe') + ' ' + exePath);
    if (!launch.pid) throw new Error(t('gateNoPid'));
    relaunchWithPort({ exePath, args: launch.args, pid: launch.pid }, p);
    await context.globalState.update('cdpGate.asked', true);
    await context.globalState.update('cdpGate.declineToastShown', true);
    return { ok: true };
  } catch (e) {
    logWarn('cdpGate.relaunch.fail', e);
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

/**
 * 门控：'ready'（CDP 可用）| 'manual'（无 CDP，弹窗手点，不再打扰）| 'relaunching'（正在重启 IDE，中止本次切号）
 */
export async function ensureCdpGate(context: vscode.ExtensionContext): Promise<GateResult> {
  if (!autoConfirmEnabled()) return 'manual';

  const port = await probeCdpPort();
  if (port) {
    logInfo('cdpGate.pass', { port });
    return 'ready';
  }

  // 未通过：只询问一次
  const asked = context.globalState.get<boolean>('cdpGate.asked', false);
  if (asked) {
    const toastShown = context.globalState.get<boolean>('cdpGate.declineToastShown', false);
    if (!toastShown) {
      await context.globalState.update('cdpGate.declineToastShown', true);
      notifyUi('info', t('gateManualToast'));
    }
    logInfo('cdpGate.manual', { asked: true });
    return 'manual';
  }

  await context.globalState.update('cdpGate.asked', true);
  logInfo('cdpGate.firstAsk', {});

  const pick = await askUi({
    title: t('gateModalHeading'),
    message: t('gateModalTitle'),
    okText: t('gateEnable'),
    cancelText: t('gateLater'),
  });

  if (pick) {
    notifyUi('info', t('gateRelaunching'));
    const r = await enableCdp(context);
    if (!r.ok) {
      notifyUi('error', t('gateEnableFailed') + (r.error || ''));
      return 'manual';
    }
    return 'relaunching';
  }

  // 拒绝：永久安静，本次切号照常
  notifyUi('info', t('gateDeclineInfo'));
  return 'manual';
}
