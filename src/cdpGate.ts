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
import * as instanceMgr from './instanceManager';

export type GateResult = 'ready' | 'manual' | 'relaunching';

function cdpPort(): number {
  return vscode.workspace.getConfiguration('antigravityKite').get<number>('cdpPort', 9333);
}

function autoConfirmEnabled(): boolean {
  return vscode.workspace.getConfiguration('antigravityKite').get<boolean>('autoConfirmDeclaration', true);
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
    "    if ($s.TargetPath -and $s.TargetPath -match 'antigravity') {",
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

/** 轻量重启：延迟关闭 IDE → 以原参数 + 调试端口重新拉起（独立进程执行，不写任何身份状态） */
function relaunchWithPort(launch: { exePath: string; args: string[]; pid: number }, port: number): void {
  const script = [
    'const cp = require("child_process");',
    `const pid = ${launch.pid};`,
    `const exe = ${JSON.stringify(launch.exePath)};`,
    `const args = ${JSON.stringify([...launch.args, '--remote-debugging-port=' + port])};`,
    'setTimeout(() => {',
    '  try { cp.execSync("taskkill /PID " + pid + " /T /F", { stdio: "ignore" }); } catch (e) {}',
    '  setTimeout(() => {',
    '    const c = cp.spawn(exe, args, { detached: true, stdio: "ignore", windowsHide: false });',
    '    c.once("spawn", () => process.exit(0));',
    '    c.once("error", () => process.exit(1));',
    '    c.unref();',
    '  }, 1500);',
    '}, 1200);',
  ].join('\n');
  const child = cp.spawn(process.execPath, ['-e', script], {
    detached: true,
    stdio: 'ignore',
    windowsHide: true,
  });
  child.unref();
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
      void vscode.window.showInformationMessage(
        '切换账号将弹一次安全声明（需手动点击）。可在设置「自动确认安全声明」中开启自动确认。',
      );
    }
    logInfo('cdpGate.manual', { asked: true });
    return 'manual';
  }

  await context.globalState.update('cdpGate.asked', true);
  logInfo('cdpGate.firstAsk', {});

  const pick = await vscode.window.showWarningMessage(
    '切换账号时自动确认安全声明，需要以调试端口启动 IDE（将修改快捷方式并重启一次，仅此一次）。',
    { modal: true },
    '开启（推荐）',
    '暂不',
  );

  if (pick === '开启（推荐）') {
    const p = cdpPort();
    const patched = await patchShortcuts(p);
    logInfo('cdpGate.shortcuts', { patched: patched.patched, details: patched.details.slice(0, 3) });
    if (patched.patched === 0) {
      logWarn('cdpGate.shortcuts.none', {});
    }
    try {
      const launch = await instanceMgr.getCurrentInstanceLaunchInfo();
      const exePath = launch.exePath || (await instanceMgr.detectExePath());
      if (!exePath) throw new Error('未定位到 IDE 可执行文件');
      if (!launch.pid) throw new Error('未定位到 IDE 主进程 PID');
      void vscode.window.showInformationMessage('正在以调试端口重启 IDE，之后切号不再弹窗…');
      relaunchWithPort({ exePath, args: launch.args, pid: launch.pid }, p);
      return 'relaunching';
    } catch (e) {
      logWarn('cdpGate.relaunch.fail', e);
      void vscode.window.showErrorMessage('开启失败：' + (e instanceof Error ? e.message : String(e)));
      return 'manual';
    }
  }

  // 拒绝：永久安静，本次切号照常
  void vscode.window.showInformationMessage(
    '已暂不开启：每次切换会弹一次安全声明（手动点击即可）。可在设置「自动确认安全声明」中开启。',
  );
  return 'manual';
}
