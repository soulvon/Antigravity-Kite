#!/usr/bin/env node
/**
 * Remote SSH / WSL / 远程开发宿主兼容回归门控（Issue #1）
 *
 * 覆盖：
 *   S1  package.json 声明 extensionKind: ["ui"]（强制本地 UI 扩展宿主执行，避免跑到远端 Linux server）
 *   S2a isIdeMainProcessCmd 拒绝 shell 壳与远程 server（sh -c / bash / .antigravity-server / --start-server）
 *   S2b isIdeMainProcessCmd 放行本地真实桌面主进程（含 --remote ssh-remote+... 本地窗口）
 *   S3  ideRuntime.ts 的 listIdeProcesses 统一应用 isIdeMainProcessCmd，且 detectExeUnix 兼容 appRoot 与 antigravity 二进制
 *   S4  multiWindowManager.ts 仅在 uri.scheme === 'file' 时透传工作区目录
 *   S5  Remote SSH 窗口安全跳过本地 killAgyEngine + i18n 提示
 *   S6  localReader.resolveLocalStateDbPath 优先当前 userDataDir 并兼容 getAppDataDir / Antigravity 目录
 *   S7  ideRuntime.formatUnixProcCmdline 保留 Linux /proc cmdline 空格边界，detectExeUnix 覆盖桌面版文件名
 *   S8  cdpGate.patchShortcuts 精确匹配 IDE exe，relaunchWithPort 先优雅关闭等待退出再强杀兜底
 *   S9  declarationSuppressor.getAliveCdpPorts 探测当前 effective userDataDir 的 DevToolsActivePort
 *   S10 winCredential PS 回退失败必返回非空 error，extension switchCredFail 不出现空后缀
 *   S11 package.json 声明 untrustedWorkspaces.supported 与 antigravityKite.remote.syncAuth (application scope)
 *   S12 remoteAuthSync.resolveRemoteAuthority 覆盖 workspaceFolders/tabGroups 与空窗口 Remote-SSH 日志（零 proposed API）
 *   S13 remoteAuthSync.resolveRemoteHomeDir 按 /proc/self/environ -> /etc/passwd 真实解析，失败不盲猜 /root
 *   S14 remoteAuthSync.syncCredentialToRemoteIdempotent 幂等跳过、账号变化覆盖、失败透明暴露
 *   S15 extension.ts 与 i18n 接入启动自动同步与切号远端同步
 */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import http from 'node:http';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const require2 = createRequire(import.meta.url);

const stubDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kite-ssh-stub-'));
fs.mkdirSync(path.join(stubDir, 'vscode'), { recursive: true });
fs.writeFileSync(path.join(stubDir, 'vscode', 'package.json'), JSON.stringify({ name: 'vscode', main: 'index.js' }));
fs.writeFileSync(
  path.join(stubDir, 'vscode', 'index.js'),
  `const envState = { remoteName: undefined, appRoot: '', asExternalUri: async (u) => u };
  const cfgOverrides = Object.create(null);
  const Uri = {
    from: (parts) => ({ scheme: parts.scheme || '', authority: parts.authority || '', path: parts.path || '', fsPath: parts.path || '' }),
    parse: (raw) => {
      const m = /^([^:]+):\\/\\/([^/]*)(\\/.*)$/.exec(String(raw || ''));
      return m ? { scheme: m[1], authority: m[2], path: m[3], fsPath: m[3] } : { scheme: 'file', authority: '', path: String(raw || ''), fsPath: String(raw || '') };
    },
  };
  const FileType = { Unknown: 0, File: 1, Directory: 2, SymbolicLink: 64 };
  const c = new Proxy(function () {}, {
    get: (_t, p) => {
      if (p === 'then') return undefined;
      if (p === Symbol.toPrimitive || p === 'toString' || p === 'valueOf') return () => '';
      if (p === 'env') return envState;
      if (p === 'Uri') return Uri;
      if (p === 'FileType') return FileType;
      if (p === '__cfgOverrides') return cfgOverrides;
      if (p === 'getConfiguration') {
        return () => ({
          get: (k, def) => (Object.prototype.hasOwnProperty.call(cfgOverrides, k) ? cfgOverrides[k] : def),
        });
      }
      return c;
    },
    apply: () => c,
    construct: () => c,
  });
  module.exports = c;`
);
process.env.NODE_PATH = [stubDir, process.env.NODE_PATH].filter(Boolean).join(path.delimiter);
require2('module')._initPaths();

let pass = 0;
let fail = 0;
function gate(name, ok, detail = '') {
  if (ok) {
    pass++;
    console.log(`  PASS  ${name}${detail ? ' | ' + detail : ''}`);
  } else {
    fail++;
    console.log(`  FAIL  ${name}${detail ? ' <- ' + detail : ''}`);
  }
}

try {
  console.log('=== Remote SSH / 远程宿主兼容门控 ===\n');

  const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
  gate(
    'S1 package.json 声明 extensionKind 包含 ui',
    Array.isArray(pkg.extensionKind) && pkg.extensionKind.length === 1 && pkg.extensionKind[0] === 'ui',
    JSON.stringify(pkg.extensionKind)
  );

  let rtMod = null;
  try { rtMod = require2(path.join(root, 'out', 'ideRuntime.js')); } catch {}
  const fn = rtMod && rtMod.isIdeMainProcessCmd;

  const badCmds = [
    ['sh -c wrapper', 'sh -c "export VSCODE_AGENT_FOLDER=/root/.antigravity-server && /root/.antigravity-server/bin/abc/bin/antigravity-ide-server"'],
    ['sh antigravity-ide-server (live layout)', 'sh /root/.antigravity-ide-server/bin/2.6.0-deadbeef/bin/antigravity-ide-server --start-server --host=127.0.0.1 --port=0 --enable-remote-auto-shutdown'],
    ['bash wrapper', '/bin/bash -lc \'/root/.antigravity-server/bin/abc/server.sh --start-server\''],
    ['remote node server-main', '/root/.antigravity-ide-server/bin/9e3a5da5/node /root/.antigravity-ide-server/bin/9e3a5da5/out/server-main.js --start-server --host=127.0.0.1'],
    ['antigravity-ide-server', '/root/.antigravity-server/bin/9e3a5da5/bin/antigravity-ide-server --port=43210 --start-server'],
    ['antigravity-reh', '/opt/antigravity-reh-linux-x64/bin/antigravity-server --port=9000'],
    ['Antigravity IDE-reh', '/home/user/.antigravity-ide-server/bin/2.6.0/Antigravity IDE-reh --port=9000'],
  ];
  for (const [label, cmd] of badCmds) {
    const res = typeof fn === 'function' ? fn(cmd) : null;
    gate(`S2a 拒绝非桌面主进程 (${label})`, res === false, `got=${String(res)}`);
  }

  const goodCmds = [
    ['win32 normal', '"C:\\Users\\demo\\AppData\\Local\\Programs\\Antigravity IDE\\Antigravity IDE.exe" --remote-debugging-port=9333'],
    ['win32 with remote ssh arg', '"C:\\Program Files\\Antigravity IDE\\Antigravity IDE.exe" --remote ssh-remote+demo /root/work'],
    ['win32 with folder-uri ssh-remote', '"C:\\Users\\demo\\AppData\\Local\\Programs\\Antigravity IDE\\Antigravity IDE.exe" --folder-uri vscode-remote://ssh-remote+deadbeef/tmp'],
    ['macOS desktop', '/Applications/Antigravity IDE.app/Contents/MacOS/Electron --remote-debugging-port=9333'],
    ['linux desktop with remote arg', '/usr/share/antigravity-ide/antigravity-ide --remote ssh-remote+box /srv/app'],
    ['linux alt binary', '/usr/share/antigravity/antigravity --user-data-dir=/home/demo/.config/Antigravity'],
  ];
  for (const [label, cmd] of goodCmds) {
    const res = typeof fn === 'function' ? fn(cmd) : null;
    gate(`S2b 放行本地真实桌面主进程 (${label})`, res === true, `got=${String(res)}`);
  }

  const rtSrc = fs.readFileSync(path.join(root, 'src', 'ideRuntime.ts'), 'utf8');
  const listFnStart = rtSrc.indexOf('async function listIdeProcesses()');
  const listFnEnd = rtSrc.indexOf('function processMatchesCurrentWindow', listFnStart);
  const listFnBody = listFnStart >= 0 && listFnEnd > listFnStart ? rtSrc.slice(listFnStart, listFnEnd) : '';
  gate(
    'S3a listIdeProcesses 统一调用 isIdeMainProcessCmd 过滤',
    (listFnBody.match(/isIdeMainProcessCmd\(/g) || []).length >= 3,
    'POSIX 与 Windows (wmic/PowerShell) 三分支需全部过滤'
  );
  const unixExeBody = rtSrc.match(/async function detectExeUnix\(\)[\s\S]*?\n\}/)?.[0] || '';
  gate(
    'S3b detectExeUnix 支持 vscode.env.appRoot 推导且兼容 antigravity',
    unixExeBody.includes('appRoot') && unixExeBody.includes('/usr/bin/antigravity'),
    '需覆盖 appRoot 与 antigravity 二进制名'
  );
  const isProcBody = rtSrc.match(/function isIdeMainProcess\(p: ProcSnapshot\)[\s\S]*?\n\}/)?.[0] || '';
  gate(
    'S3c isIdeMainProcess 统一委托 isIdeMainProcessCmd',
    isProcBody.includes('isIdeMainProcessCmd('),
    '避免快照路径重复维护弱过滤条件'
  );

  const mwExists = fs.existsSync(path.join(root, 'src', 'multiWindowManager.ts'));
  gate(
    'S4 multiWindowManager.ts 已下线清理（无多开路径参数污染风险）',
    !mwExists,
    mwExists ? '仍残留 src/multiWindowManager.ts' : ''
  );

  // S5 Remote SSH 切号时跳过本地 killAgyEngine（防误杀其他本地窗口 agy.exe 或报无引擎假错）
  const killStart = rtSrc.indexOf('export async function killAgyEngine');
  const killBody = killStart >= 0 ? rtSrc.slice(killStart, killStart + 900) : '';
  const hasRemoteGuard = killBody.includes('remoteName') && killBody.includes('remoteSkipped');
  gate('S5a killAgyEngine 具备 remoteName 远程跳过守卫', hasRemoteGuard, '防在 Remote SSH 窗口误杀其他本地窗口 agy.exe');
  if (hasRemoteGuard && typeof rtMod?.killAgyEngine === 'function') {
    const vscodeStub = require2('vscode');
    vscodeStub.env.remoteName = 'ssh-remote';
    const r = await rtMod.killAgyEngine();
    vscodeStub.env.remoteName = undefined;
    gate(
      'S5b remoteName=ssh-remote 时安全跳过且不报错',
      r?.remoteSkipped === true && r?.killed === 0 && !r?.error && r?.agyWasRunning === false,
      JSON.stringify(r)
    );
  } else {
    gate('S5b remoteName=ssh-remote 时安全跳过且不报错', false, '缺少守卫，跳过实调以防误杀本地 agy');
  }

  const extSrc = fs.readFileSync(path.join(root, 'src', 'extension.ts'), 'utf8');
  const switchSrc = fs.readFileSync(path.join(root, 'src', 'switchOrchestrator.ts'), 'utf8');
  const sidebarSrc = fs.readFileSync(path.join(root, 'src', 'sidebarProvider.ts'), 'utf8');
  const i18nMod = require2(path.join(root, 'out', 'i18n.js'));
  const dict = i18nMod?.__dictForCheck?.() || {};
  const remotePair = dict.agyReloadRemoteNote;
  const hasI18n = Array.isArray(remotePair)
    && remotePair.length === 2
    && remotePair.every((s) => typeof s === 'string' && s.includes('{0}'));
  gate(
    'S5c switchOrchestrator.ts 与 i18n 诚实提示远程窗口已跳过本地 agy 重载',
    switchSrc.includes('agyReload.remoteSkipped') && switchSrc.includes('agyReloadRemoteNote') && hasI18n,
    `hasI18n=${hasI18n}`
  );

  // S6 localReader 复用当前 userDataDir 与 getAppDataDir / resolveIdeStateDbPaths
  let lrMod = null;
  try { lrMod = require2(path.join(root, 'out', 'localReader.js')); } catch {}
  if (typeof lrMod?.resolveLocalStateDbPath === 'function' && typeof rtMod?.setEffectiveCurrentUserDataDir === 'function') {
    const tmpCustomUda = path.join(stubDir, 'custom-uda');
    const customDb = path.join(tmpCustomUda, 'User', 'globalStorage', 'state.vscdb');
    fs.mkdirSync(path.dirname(customDb), { recursive: true });
    fs.writeFileSync(customDb, '');

    const tmpFakeBase = path.join(stubDir, 'fake-appdata');
    const altDb = path.join(tmpFakeBase, 'Antigravity', 'User', 'globalStorage', 'state.vscdb');
    fs.mkdirSync(path.dirname(altDb), { recursive: true });
    fs.writeFileSync(altDb, '');

    const prevAppData = process.env.APPDATA;
    const prevXdg = process.env.XDG_CONFIG_HOME;
    try {
      rtMod.setEffectiveCurrentUserDataDir(tmpCustomUda);
      const gotCustom = lrMod.resolveLocalStateDbPath();
      gate(
        'S6a resolveLocalStateDbPath 优先当前 effective userDataDir',
        path.resolve(gotCustom) === path.resolve(customDb),
        `got=${gotCustom}`
      );

      rtMod.setEffectiveCurrentUserDataDir('');
      if (process.platform === 'win32') process.env.APPDATA = tmpFakeBase;
      else process.env.XDG_CONFIG_HOME = tmpFakeBase;
      const gotAlt = lrMod.resolveLocalStateDbPath();
      gate(
        'S6b resolveLocalStateDbPath 兼容 getAppDataDir 与 Antigravity 目录',
        process.platform === 'darwin' ? typeof gotAlt === 'string' : path.resolve(gotAlt) === path.resolve(altDb),
        `got=${gotAlt}`
      );
    } finally {
      rtMod.setEffectiveCurrentUserDataDir('');
      if (prevAppData === undefined) delete process.env.APPDATA;
      else process.env.APPDATA = prevAppData;
      if (prevXdg === undefined) delete process.env.XDG_CONFIG_HOME;
      else process.env.XDG_CONFIG_HOME = prevXdg;
    }
  } else {
    gate('S6a resolveLocalStateDbPath 优先当前 effective userDataDir', false, 'localReader.resolveLocalStateDbPath 未导出');
    gate('S6b resolveLocalStateDbPath 兼容 getAppDataDir 与 Antigravity 目录', false, 'localReader.resolveLocalStateDbPath 未导出');
  }

  // S7 ideRuntime.formatUnixProcCmdline 保留 Linux /proc cmdline 含空格与引号的 token 边界 + detectExeUnix
  if (typeof rtMod?.formatUnixProcCmdline === 'function' && typeof rtMod?.tokenizeCommandLine === 'function') {
    const rawBuf = Buffer.from(
      '/opt/Antigravity IDE/antigravity-ide\0--user-data-dir=/tmp/My Workspace\0--folder-uri=vscode-remote://ssh-remote+box/my dir\0--tag=it\'s-ok\0',
      'utf8'
    );
    const formatted = rtMod.formatUnixProcCmdline(rawBuf);
    const tokens = rtMod.tokenizeCommandLine(formatted);
    gate(
      'S7a formatUnixProcCmdline 保留含空格与单引号参数边界并可被 tokenizeCommandLine 精确还原',
      tokens[0] === '/opt/Antigravity IDE/antigravity-ide'
        && rtMod.isIdeMainProcessCmd(formatted) === true
        && rtMod.parseUserDataDir(formatted) === '/tmp/My Workspace'
        && tokens.includes("--folder-uri=vscode-remote://ssh-remote+box/my dir")
        && tokens.includes("--tag=it's-ok"),
      `tokens=${JSON.stringify(tokens)}`
    );
  } else {
    gate('S7a formatUnixProcCmdline 保留含空格与单引号参数边界并可被 tokenizeCommandLine 精确还原', false, 'formatUnixProcCmdline/tokenizeCommandLine 未导出');
  }
  const linuxAppRootMatch = unixExeBody.match(/\} else \{([\s\S]*?)\n  \}/)?.[1] || '';
  gate(
    'S7b detectExeUnix Linux appRoot 兼容 Antigravity IDE / Antigravity 文件名',
    linuxAppRootMatch.includes("'Antigravity IDE'") && linuxAppRootMatch.includes("'Antigravity'"),
    linuxAppRootMatch.trim().replace(/\s+/g, ' ')
  );

  // S8 cdpGate 快捷方式目标精确匹配与优雅关闭重拉起
  let cdpMod = null;
  try { cdpMod = require2(path.join(root, 'out', 'cdpGate.js')); } catch {}
  const cdpSrc = fs.readFileSync(path.join(root, 'src', 'cdpGate.ts'), 'utf8');
  if (typeof cdpMod?.isIdeShortcutTarget === 'function') {
    const ok1 = cdpMod.isIdeShortcutTarget('C:\\Users\\admin\\AppData\\Local\\Programs\\Antigravity IDE\\Antigravity IDE.exe') === true;
    const ok2 = cdpMod.isIdeShortcutTarget('C:\\Program Files\\Antigravity\\Antigravity.exe') === true;
    const no1 = cdpMod.isIdeShortcutTarget('C:\\Users\\admin\\AppData\\Local\\Antigravity Tools\\antigravity-tools.exe') === false;
    const no2 = cdpMod.isIdeShortcutTarget('D:\\Tools\\antigravity-helper.exe') === false;
    const strictPs = !cdpSrc.includes("$s.TargetPath -match 'antigravity'");
    gate(
      'S8a patchShortcuts 仅匹配真实 Antigravity IDE 可执行文件并排除 antigravity-tools.exe',
      ok1 && ok2 && no1 && no2 && strictPs,
      `ok1=${ok1}, ok2=${ok2}, no1=${no1}, no2=${no2}, strictPs=${strictPs}`
    );
  } else {
    gate('S8a patchShortcuts 仅匹配真实 Antigravity IDE 可执行文件并排除 antigravity-tools.exe', false, 'isIdeShortcutTarget 未导出');
  }
  if (typeof cdpMod?.buildRelaunchScript === 'function') {
    const scriptText = cdpMod.buildRelaunchScript(
      { exePath: 'C:\\Antigravity IDE\\Antigravity IDE.exe', args: ['--folder-uri', 'vscode-remote://ssh-remote+box/root'], pid: 999 },
      9444
    );
    let syntaxOk = false;
    try { new Function('require', 'process', scriptText); syntaxOk = true; } catch {}
    const hasGracefulWin = /taskkill[^;\n]*"\/PID",\s*String\(pid\)\]/.test(scriptText)
      && /"\/T",\s*"\/F"/.test(scriptText);
    const hasGracefulPosix = /process\.kill\(pid,\s*"SIGTERM"\)/.test(scriptText)
      && /process\.kill\(pid,\s*"SIGKILL"\)/.test(scriptText);
    const deadlineWait = Number(scriptText.match(/Date\.now\(\)\s*\+\s*(\d+)/)?.[1] || 0);
    gate(
      'S8b buildRelaunchScript 先发送优雅关闭并轮询等待退出后再强杀兜底',
      syntaxOk && hasGracefulWin && hasGracefulPosix && deadlineWait >= 4000,
      `syntaxOk=${syntaxOk}, gracefulWin=${hasGracefulWin}, gracefulPosix=${hasGracefulPosix}, deadlineWait=${deadlineWait}`
    );
  } else {
    gate('S8b buildRelaunchScript 先发送优雅关闭并轮询等待退出后再强杀兜底', false, 'buildRelaunchScript 未导出');
  }

  // S9 declarationSuppressor 优先探测 effective userDataDir 的 DevToolsActivePort
  let declMod = null;
  try { declMod = require2(path.join(root, 'out', 'declarationSuppressor.js')); } catch {}
  if (typeof declMod?.readDevToolsActivePortFromDir === 'function' && typeof rtMod?.setEffectiveCurrentUserDataDir === 'function') {
    const vscodeStub = require2('vscode');
    const mockSrv = http.createServer((req, res) => {
      if (req.url === '/json/version') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ Browser: 'Antigravity IDE/2.6.0' }));
        return;
      }
      res.writeHead(404);
      res.end();
    });
    await new Promise((resolve) => mockSrv.listen(0, '127.0.0.1', resolve));
    const mockPort = mockSrv.address().port;
    const tmpUda = path.join(stubDir, 'cdp-uda');
    fs.mkdirSync(tmpUda, { recursive: true });
    fs.writeFileSync(path.join(tmpUda, 'DevToolsActivePort'), `${mockPort}\n/devtools/browser/test\n`);
    const prevAppData = process.env.APPDATA;
    const prevXdg = process.env.XDG_CONFIG_HOME;
    process.env.APPDATA = path.join(stubDir, 'empty-appdata');
    process.env.XDG_CONFIG_HOME = path.join(stubDir, 'empty-appdata');
    vscodeStub.__cfgOverrides.cdpPort = 0;
    try {
      const readPort = declMod.readDevToolsActivePortFromDir(tmpUda);
      rtMod.setEffectiveCurrentUserDataDir(tmpUda);
      const alivePorts = await declMod.getAliveCdpPorts();
      gate(
        'S9 declarationSuppressor 优先发现自定义 userDataDir 下的 DevToolsActivePort',
        readPort === mockPort && Array.isArray(alivePorts) && alivePorts[0] === mockPort,
        `mockPort=${mockPort}, readPort=${readPort}, alive=${JSON.stringify(alivePorts)}`
      );
    } finally {
      rtMod.setEffectiveCurrentUserDataDir('');
      delete vscodeStub.__cfgOverrides.cdpPort;
      if (prevAppData === undefined) delete process.env.APPDATA;
      else process.env.APPDATA = prevAppData;
      if (prevXdg === undefined) delete process.env.XDG_CONFIG_HOME;
      else process.env.XDG_CONFIG_HOME = prevXdg;
      await new Promise((resolve) => mockSrv.close(resolve));
    }
  } else {
    gate('S9 declarationSuppressor 优先发现自定义 userDataDir 下的 DevToolsActivePort', false, 'readDevToolsActivePortFromDir 未导出');
  }

  // S10 winCredential PS 回退错误信息保底 + extension switchCredFail 不出现空后缀
  let credMod = null;
  try { credMod = require2(path.join(root, 'out', 'winCredential.js')); } catch {}
  const credSrc = fs.readFileSync(path.join(root, 'src', 'winCredential.ts'), 'utf8');
  if (typeof credMod?.normalizePsCredResponse === 'function') {
    const rFail = credMod.normalizePsCredResponse('Write', '{"ok":false}');
    const rEmptyErr = credMod.normalizePsCredResponse('Swap', '{"ok":false,"error":"   "}');
    const rMissingBlob = credMod.normalizePsCredResponse('Read', '{"ok":true}');
    const rBadJson = credMod.normalizePsCredResponse('Swap', 'not-json');
    const rOk = credMod.normalizePsCredResponse('Read', '{"ok":true,"user":"antigravity","blobBase64":"e30="}');
    const callCount = (credSrc.match(/normalizePsCredResponse\(/g) || []).length;
    const allSafe = rFail?.ok === false && Boolean(rFail.error)
      && rEmptyErr?.ok === false && Boolean(rEmptyErr.error)
      && rMissingBlob?.ok === false && Boolean(rMissingBlob.error)
      && rBadJson?.ok === false && Boolean(rBadJson.error)
      && rOk?.ok === true
      && callCount >= 4;
    gate(
      'S10a winCredential PS 回退失败统一返回非空错误信息',
      allSafe,
      `calls=${callCount}, rFail=${JSON.stringify(rFail)}, rMissing=${JSON.stringify(rMissingBlob)}`
    );
  } else {
    gate('S10a winCredential PS 回退失败统一返回非空错误信息', false, 'normalizePsCredResponse 未导出');
  }
  gate(
    'S10b switchOrchestrator.ts switchCredFail 不再使用空串兜底',
    !switchSrc.includes("t('switchCredFail', cw.error || '')")
      && /t\('switchCredFail',\s*cw\.error\s*\|\|\s*t\('ui\.unknown'\)\)/.test(switchSrc),
    '需改为 cw.error || t(\'ui.unknown\')'
  );

  // S11 package.json untrustedWorkspaces 与 remote.syncAuth 配置
  const syncAuthCfg = pkg.contributes?.configuration?.properties?.['antigravityKite.remote.syncAuth'];
  gate(
    'S11a package.json 声明 capabilities.untrustedWorkspaces.supported = true',
    pkg.capabilities?.untrustedWorkspaces?.supported === true,
    JSON.stringify(pkg.capabilities)
  );
  gate(
    'S11b package.json 配置 antigravityKite.remote.syncAuth（默认 true，application 级防工作区篡改）',
    syncAuthCfg?.type === 'boolean' && syncAuthCfg?.default === true && syncAuthCfg?.scope === 'application',
    JSON.stringify(syncAuthCfg)
  );

  // S12-S14 remoteAuthSync 模块单测
  let remoteMod = null;
  try { remoteMod = require2(path.join(root, 'out', 'remoteAuthSync.js')); } catch {}
  gate('S12a 导出 remoteAuthSync 模块及核心函数',
    typeof remoteMod?.resolveRemoteAuthority === 'function'
      && typeof remoteMod?.resolveRemoteHomeDir === 'function'
      && typeof remoteMod?.syncCredentialToRemote === 'function',
    `exports=${remoteMod ? Object.keys(remoteMod).join(',') : 'missing'}`
  );

  const remoteSrcPath = path.join(root, 'src', 'remoteAuthSync.ts');
  const remoteSrc = fs.existsSync(remoteSrcPath) ? fs.readFileSync(remoteSrcPath, 'utf8') : '';
  const remoteCodeLines = remoteSrc
    .split(/\r?\n/)
    .filter((l) => !/^\s*(?:\/\*|\*|\/\/)/.test(l))
    .join('\n');
  gate(
    'S12b remoteAuthSync 源码不调用受 resolvers 提案限制的 env.remoteAuthority 属性',
    remoteCodeLines.length > 0 && !/\.env\??\.remoteAuthority/.test(remoteCodeLines),
    '必须绕开 resolvers 提案限制'
  );

  if (remoteMod && typeof remoteMod.resolveRemoteAuthority === 'function') {
    const authFromWs = await remoteMod.resolveRemoteAuthority({
      workspaceFolders: [{ uri: { scheme: 'vscode-remote', authority: 'ssh-remote+ws123', path: '/srv/app' } }],
    });
    const fakeExthost = path.join(stubDir, 'win-logs', 'window9', 'exthost');
    const kiteLogDir = path.join(fakeExthost, 'soulvon.antigravity-kite');
    const sshLogDir = path.join(fakeExthost, 'google.antigravity-remote-openssh');
    fs.mkdirSync(kiteLogDir, { recursive: true });
    fs.mkdirSync(sshLogDir, { recursive: true });
    fs.writeFileSync(
      path.join(sshLogDir, 'Remote - SSH (Antigravity IDE).log'),
      "2026-11-16 12:49:59 [info] Resolving ssh remote authority 'ssh-remote+log456' (attempt #1)\nConnecting to alice@10.0.0.2...\n"
    );
    const authFromLog = await remoteMod.resolveRemoteAuthority({
      workspaceFolders: [],
      logUriFsPath: kiteLogDir,
    });
    gate(
      'S12c resolveRemoteAuthority 覆盖 workspaceFolders 与空窗口日志目录提取',
      authFromWs === 'ssh-remote+ws123' && authFromLog === 'ssh-remote+log456',
      `ws=${authFromWs}, log=${authFromLog}`
    );
  } else {
    gate('S12c resolveRemoteAuthority 覆盖 workspaceFolders 与空窗口日志目录提取', false, '模块未就绪');
  }

  if (remoteMod && typeof remoteMod.resolveRemoteHomeDir === 'function') {
    const makeMockFs = (files, dirs) => ({
      readFile: async (uri) => {
        if (!(uri.path in files)) throw new Error('ENOENT: ' + uri.path);
        return Buffer.from(files[uri.path], 'utf8');
      },
      stat: async (uri) => {
        if (dirs.has(uri.path)) return { type: 2 };
        if (uri.path in files) return { type: 1 };
        throw new Error('ENOENT: ' + uri.path);
      },
    });
    const rLinux = await remoteMod.resolveRemoteHomeDir(
      'ssh-remote+abc',
      makeMockFs({ '/proc/self/environ': 'PATH=/usr/bin\0HOME=/home/alice\0USER=alice\0' }, new Set(['/home/alice']))
    );
    const hexAuth = 'ssh-remote+' + Buffer.from(JSON.stringify({ hostName: '1.2.3.4', user: 'deploy' }), 'utf8').toString('hex');
    const rPasswd = await remoteMod.resolveRemoteHomeDir(
      hexAuth,
      makeMockFs({ '/etc/passwd': 'root:x:0:0:root:/root:/bin/bash\ndeploy:x:1001:1001::/data/deploy:/bin/bash\n' }, new Set(['/data/deploy']))
    );
    const rUnknown = await remoteMod.resolveRemoteHomeDir(
      'ssh-remote+missing',
      makeMockFs({}, new Set(['/root']))
    );
    gate(
      'S13 resolveRemoteHomeDir 支持 /proc/self/environ、/etc/passwd 回退，未知时不盲猜 /root',
      rLinux?.ok === true && rLinux.homeDir === '/home/alice'
        && rPasswd?.ok === true && rPasswd.homeDir === '/data/deploy'
        && rUnknown?.ok === false && !rUnknown.homeDir,
      `linux=${JSON.stringify(rLinux)}, passwd=${JSON.stringify(rPasswd)}, unknown=${JSON.stringify(rUnknown)}`
    );
  } else {
    gate('S13 resolveRemoteHomeDir 支持 /proc/self/environ、/etc/passwd 回退，未知时不盲猜 /root', false, '模块未就绪');
  }

  if (remoteMod && typeof remoteMod.syncCredentialToRemote === 'function') {
    const store = new Map();
    const dirs = new Set(['/home/dev']);
    let writeCount = 0;
    const mockFs = {
      readFile: async (u) => {
        if (!store.has(u.path)) throw Object.assign(new Error('FileNotFound'), { code: 'FileNotFound' });
        return Buffer.from(store.get(u.path), 'utf8');
      },
      writeFile: async (u, content) => {
        writeCount++;
        store.set(u.path, Buffer.from(content).toString('utf8'));
      },
      createDirectory: async (u) => { dirs.add(u.path); },
      stat: async (u) => {
        if (dirs.has(u.path)) return { type: 2 };
        if (store.has(u.path)) return { type: 1 };
        throw new Error('ENOENT');
      },
    };
    const credA = {
      token: { access_token: 'ya29.test_A', token_type: 'Bearer', refresh_token: '1//rt_A', expiry: new Date(Date.now() + 3600_000).toISOString(), expires_in: 3599 },
      auth_method: 'consumer',
      id_token_email: 'a@example.com',
      writer_id: 'w-local',
    };
    const r1 = await remoteMod.syncCredentialToRemote('/home/dev', 'ssh-remote+h1', credA, { fsApi: mockFs, forceOverwrite: false });
    const writtenJson = JSON.parse(store.get('/home/dev/.gemini/jetski-standalone-oauth-token') || '{}');
    const r2 = await remoteMod.syncCredentialToRemote('/home/dev', 'ssh-remote+h1', credA, { fsApi: mockFs, forceOverwrite: false });
    const r3 = await remoteMod.syncCredentialToRemote('/home/dev', 'ssh-remote+h1', credA, { fsApi: mockFs, forceOverwrite: true });

    const credB = { ...credA, id_token_email: 'b@example.com', token: { ...credA.token, access_token: 'ya29.test_B', refresh_token: '1//rt_B' } };
    const r4 = await remoteMod.syncCredentialToRemote('/home/dev', 'ssh-remote+h1', credB, { fsApi: mockFs, forceOverwrite: false });
    const failFs = {
      ...mockFs,
      writeFile: async () => { throw new Error('EACCES: permission denied'); },
    };
    const rErr = await remoteMod.syncCredentialToRemote('/home/dev', 'ssh-remote+h1', credB, { fsApi: failFs, forceOverwrite: true });

    // 显式切号时必须先对 hub_<port>.json 发现的实例调 AuthLogout（会删除旧 token 文件），再写入新 token 文件
    const hubStore = new Map([
      ['/home/dev/.gemini/jetski-standalone-oauth-token', JSON.stringify(credA)],
      ['/home/dev/.gemini/antigravity/daemon/hub_45907.json', JSON.stringify({ pid: 123, httpPort: 45907, csrfToken: 'csrf-test' })],
      ['/home/dev/.gemini/antigravity/daemon/hub_49999.json', JSON.stringify({ pid: 499, httpPort: 49999, csrfToken: 'csrf-stale' })],
      ['/proc/123/cmdline', '/root/.gemini/bin/agy\0--hub\0'],
      ['/proc/499/cmdline', '/usr/bin/python3\0server.py\0'],
    ]);
    const opOrder = [];
    const logoutCalls = [];
    const hubMockFs = {
      readFile: async (u) => {
        if (!hubStore.has(u.path)) throw Object.assign(new Error('FileNotFound'), { code: 'FileNotFound' });
        return Buffer.from(hubStore.get(u.path), 'utf8');
      },
      writeFile: async (u, content) => {
        opOrder.push('write');
        hubStore.set(u.path, Buffer.from(content).toString('utf8'));
      },
      createDirectory: async (u) => { dirs.add(u.path); },
      stat: async (u) => {
        if (dirs.has(u.path) || u.path === '/home/dev/.gemini/antigravity/daemon') return { type: 2 };
        if (hubStore.has(u.path)) return { type: 1 };
        throw new Error('ENOENT');
      },
      readDirectory: async (u) => {
        if (u.path === '/home/dev/.gemini/antigravity/daemon') {
          return [['hub_45907.json', 1], ['hub_49999.json', 1], ['other.txt', 1]];
        }
        throw Object.assign(new Error('FileNotFound'), { code: 'FileNotFound' });
      },
    };
    const rSwitchLogout = await remoteMod.syncCredentialToRemote('/home/dev', 'ssh-remote+h1', credB, {
      fsApi: hubMockFs,
      forceOverwrite: true,
      postJson: async (url, headers, body, timeoutMs) => {
        opOrder.push('logout');
        logoutCalls.push({ url, csrf: headers['x-codeium-csrf-token'], body, timeoutMs });
        // 模拟 agy AuthLogout 真实副作用：删掉磁盘上旧 jetski-standalone-oauth-token
        hubStore.delete('/home/dev/.gemini/jetski-standalone-oauth-token');
        return 200;
      },
    });
    const finalAfterLogout = JSON.parse(hubStore.get('/home/dev/.gemini/jetski-standalone-oauth-token') || '{}');
    const logoutOrderOk = typeof remoteMod.logoutRemoteHubSessions === 'function'
      && rSwitchLogout?.ok === true && rSwitchLogout.wrote === true
      && logoutCalls.length === 1
      && logoutCalls[0].url === 'http://127.0.0.1:45907/exa.language_server_pb.LanguageServerService/AuthLogout'
      && logoutCalls[0].csrf === 'csrf-test'
      && logoutCalls[0].body === '{}'
      && opOrder.join(',') === 'logout,write'
      && finalAfterLogout?.id_token_email === 'b@example.com';

    gate(
      'S14 syncCredentialToRemote 写入 schema、幂等跳过、异号覆盖、AuthLogout->write 顺序及失败暴露',
      r1?.ok === true && r1.wrote === true && r1.previousState === 'missing'
        && writtenJson?.id_token_email === 'a@example.com' && writtenJson?.token?.refresh_token === '1//rt_A'
        && r2?.ok === true && r2.wrote === false && r2.skipped === true
        && r3?.ok === true && r3.wrote === true
        && r4?.ok === true && r4.wrote === true && r4.previousState === 'mismatch'
        && writeCount === 3
        && rErr?.ok === false && Boolean(rErr.error)
        && logoutOrderOk,
      JSON.stringify({ r1, r2, r3, r4, writeCount, rErr, logoutOrderOk, opOrder, logoutCallsCount: logoutCalls.length })
    );
  } else {
    gate('S14 syncCredentialToRemote 写入 schema、幂等跳过、异号覆盖、AuthLogout->write 顺序及失败暴露', false, '模块未就绪');
  }

  // S15 switchOrchestrator / extension / sidebarProvider 与 remoteAuthSync 集成及 i18n 文案检查
  const hasExtWiring = switchSrc.includes('syncCredentialForRemoteSession')
    && extSrc.includes('syncStartupAuthToRemote')
    && switchSrc.includes('applyRemoteAuthRefresh')
    && !remoteSrc.includes('PENDING_REMOTE_NOTICE_KEY')
    && sidebarSrc.includes('syncRemoteAuth');
  const hasRefreshCmds = remoteSrc.includes('antigravity.reconnect')
    && !remoteSrc.includes('workbench.action.restartExtensionHost')
    && remoteSrc.includes('AuthLogout')
    && /hub_/.test(remoteSrc);
  const remoteDictOk = ['remoteSyncDone', 'remoteSyncFail', 'remoteSyncStartupDone', 'remoteSyncAligned', 'remoteSyncNoAuthority', 'ui.syncRemoteAuthRow']
    .every((k) => Array.isArray(dict[k]) && dict[k].length === 2 && Boolean(dict[k][0]) && Boolean(dict[k][1]));
  gate(
    'S15 扩展接入远端登录态同步、无重启热刷新与完整双语文案',
    hasExtWiring && hasRefreshCmds && remoteDictOk,
    `hasExtWiring=${hasExtWiring}, hasRefreshCmds=${hasRefreshCmds}, remoteDictOk=${remoteDictOk}`
  );

  console.log(`\n结果: ${pass} 通过 / ${fail} 失败`);
  process.exit(fail > 0 ? 1 : 0);
} finally {
  fs.rmSync(stubDir, { recursive: true, force: true });
}
