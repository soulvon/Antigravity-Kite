/**
 * 扩展自动更新检查与新版发布说明展示
 */
import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { t } from './i18n';
import { logInfo, logWarn } from './logger';
import { notifyUi, askUi } from './uiChannel';
import { downloadToFile, httpRequest } from './httpClient';

interface GitHubReleaseAsset {
  name: string;
  browser_download_url: string;
  size: number;
}

interface GitHubRelease {
  tag_name: string;
  name: string;
  body: string;
  html_url: string;
  assets: GitHubReleaseAsset[];
}

// 公开仓库信息（无需 token）
const REPO_OWNER = 'soulvon';
const REPO_NAME = 'antigravity-kite';

interface UpdateConfig {
  autoCheck: boolean;
  autoInstall: boolean;
}

type LatestUpdateCheck =
  | { status: 'upToDate'; currentVersion: string }
  | { status: 'noVsix'; currentVersion: string; latestVersion: string }
  | {
    status: 'available';
    currentVersion: string;
    latestVersion: string;
    release: GitHubRelease;
    vsixAsset: GitHubReleaseAsset;
  };

function getUpdateConfig(): UpdateConfig {
  const config = vscode.workspace.getConfiguration('antigravityKite.update');
  return {
    autoCheck: config.get('autoCheck', true),
    autoInstall: config.get('autoInstall', true),
  };
}

function getCurrentVersion(): string {
  const packageJson = JSON.parse(fs.readFileSync(path.join(__dirname, '../package.json'), 'utf8')) as { version?: string };
  return packageJson.version || '0.0.0';
}

function buildApiHeaders(token: string): Record<string, string> {
  const headers: Record<string, string> = {
    'User-Agent': 'antigravity-kite-updater',
  };
  if (token) {
    headers['Authorization'] = `token ${token}`;
  }
  return headers;
}

async function fetchGitHubApi<T>(url: string, token: string): Promise<T> {
  const res = await httpRequest(url, {
    method: 'GET',
    headers: buildApiHeaders(token),
    timeoutMs: 10_000,
  });

  if (res.status === 200) {
    try {
      return JSON.parse(res.body) as T;
    } catch {
      throw new Error('JSON parse failed');
    }
  }
  if (res.status === 404) {
    throw new Error('Repository or release not found');
  }
  if (res.status === 401) {
    throw new Error('Invalid GitHub token or insufficient permissions');
  }
  throw new Error(`GitHub API error: ${res.status}`);
}

/**
 * 比较版本号 (返回 >0 如果 a>b, <0 如果 a<b, =0 如果相等)
 */
export function compareVersions(a: string, b: string): number {
  const normalize = (v: string) => v.trim().replace(/^v/i, '');
  const splitVer = (v: string) => {
    const clean = normalize(v);
    const dashIdx = clean.indexOf('-');
    return {
      core: dashIdx >= 0 ? clean.slice(0, dashIdx) : clean,
      pre: dashIdx >= 0 ? clean.slice(dashIdx + 1) : '',
    };
  };
  const { core: coreA, pre: preA } = splitVer(a);
  const { core: coreB, pre: preB } = splitVer(b);

  const pa = coreA.split('.').map((s) => parseInt(s, 10) || 0);
  const pb = coreB.split('.').map((s) => parseInt(s, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const na = pa[i] || 0;
    const nb = pb[i] || 0;
    if (na !== nb) return na - nb;
  }

  if (preA === '' && preB === '') return 0;
  if (preA === '') return 1;
  if (preB === '') return -1;
  const partsA = preA.split('.');
  const partsB = preB.split('.');
  for (let i = 0; i < Math.max(partsA.length, partsB.length); i++) {
    if (i >= partsA.length) return -1;
    if (i >= partsB.length) return 1;
    const sa = partsA[i];
    const sb = partsB[i];
    if (sa === sb) continue;
    const numA = /^\d+$/.test(sa) ? Number(sa) : NaN;
    const numB = /^\d+$/.test(sb) ? Number(sb) : NaN;
    if (Number.isFinite(numA) && Number.isFinite(numB)) return numA - numB;
    if (Number.isFinite(numA)) return -1;
    if (Number.isFinite(numB)) return 1;
    return sa < sb ? -1 : 1;
  }
  return 0;
}

async function queryLatestUpdate(): Promise<LatestUpdateCheck> {
  const currentVersion = getCurrentVersion();
  const url = `https://api.github.com/repos/${REPO_OWNER}/${REPO_NAME}/releases/latest`;
  const release = await fetchGitHubApi<GitHubRelease>(url, '');
  const latestVersion = release.tag_name.startsWith('v') ? release.tag_name.slice(1) : release.tag_name;

  if (compareVersions(latestVersion, currentVersion) <= 0) {
    return { status: 'upToDate', currentVersion };
  }

  const vsixAsset = Array.isArray(release.assets) ? release.assets.find((a) => a.name.endsWith('.vsix')) : undefined;
  if (!vsixAsset) {
    return { status: 'noVsix', currentVersion, latestVersion };
  }

  return { status: 'available', currentVersion, latestVersion, release, vsixAsset };
}

async function downloadVsixWithProgress(
  downloadUrl: string,
  token: string,
  version: string,
  expectedSize: number | undefined,
  title: string,
): Promise<string> {
  const tempDir = os.tmpdir();
  const vsixPath = path.join(tempDir, `antigravity-kite-${version}.vsix`);

  await vscode.window.withProgress(
    {
      location: vscode.ProgressLocation.Notification,
      title,
      cancellable: false,
    },
    async () => {
      await downloadToFile(downloadUrl, vsixPath, {
        headers: buildApiHeaders(token),
        timeoutMs: 60_000,
        expectedSize: typeof expectedSize === 'number' && expectedSize > 0 ? expectedSize : undefined,
      });
    },
  );

  return vsixPath;
}

/**
 * 检查更新
 */
export async function checkForUpdates(silent = false): Promise<boolean> {
  const config = getUpdateConfig();

  try {
    const check = await queryLatestUpdate();
    if (check.status === 'upToDate') {
      if (!silent) {
        notifyUi('info', t('updUpToDate', check.currentVersion));
      }
      return false;
    }
    if (check.status === 'noVsix') {
      if (!silent) {
        notifyUi('warning', t('updNoVsix'));
      }
      return false;
    }

    const { currentVersion, latestVersion, release, vsixAsset } = check;
    const message = t('updFound', latestVersion, currentVersion, release.body || '');
    const accepted = await askUi({
      title: t('updFoundTitle', latestVersion),
      meta: `v${currentVersion} → v${latestVersion}`,
      message,
      okText: config.autoInstall ? t('updInstallNow') : t('updDownload'),
      cancelText: t('updLater'),
    });

    if (accepted) {
      if (config.autoInstall) {
        await downloadAndInstall(vsixAsset.browser_download_url, '', latestVersion, vsixAsset.size);
      } else {
        await downloadOnly(vsixAsset.browser_download_url, '', latestVersion, vsixAsset.size);
      }
    }

    return true;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (msg.includes('not found')) {
      // 仓库尚未发布任何 Release：不算故障，静默视为无更新
      logInfo('updater.noRelease', { reason: msg });
      return false;
    }
    if (!silent) {
      notifyUi('error', t('checkUpdateFailed', msg));
    }
    return false;
  }
}

/**
 * 下载并安装
 */
async function downloadAndInstall(
  downloadUrl: string,
  token: string,
  version: string,
  expectedSize?: number,
): Promise<void> {
  const vsixPath = await downloadVsixWithProgress(downloadUrl, token, version, expectedSize, t('updDownloading'));

  try {
    await vscode.window.withProgress(
      {
        location: vscode.ProgressLocation.Notification,
        title: t('updInstalling'),
        cancellable: false,
      },
      async () => {
        await vscode.commands.executeCommand('workbench.extensions.installExtension', vscode.Uri.file(vsixPath));
      },
    );

    const reload = await askUi({
      title: t('updInstalling'),
      message: t('updReloadPrompt'),
      okText: t('updReloadNow'),
      cancelText: t('updLater'),
    });

    if (reload) {
      void vscode.commands.executeCommand('workbench.action.reloadWindow');
    }
  } finally {
    fs.unlink(vsixPath, (err) => {
      if (err && err.code !== 'ENOENT') {
        logWarn('updater.cleanup', { path: vsixPath, error: err.message });
      }
    });
  }
}

/**
 * 仅下载
 */
async function downloadOnly(
  downloadUrl: string,
  token: string,
  version: string,
  expectedSize?: number,
): Promise<void> {
  const vsixPath = await downloadVsixWithProgress(downloadUrl, token, version, expectedSize, t('updDownloadingPlain'));

  const open = await askUi({
    title: t('updDownloadedTitle'),
    message: t('updDownloadDone', vsixPath),
    okText: t('updOpenFolder'),
    cancelText: t('updLater'),
  });

  if (open) {
    void vscode.env.openExternal(vscode.Uri.file(path.dirname(vsixPath)));
  }
}

async function runStartupUpdateCheck(): Promise<void> {
  const config = getUpdateConfig();
  if (!config.autoCheck) return;

  try {
    const check = await queryLatestUpdate();
    if (check.status !== 'available') return;

    const { currentVersion, latestVersion, vsixAsset } = check;
    if (config.autoInstall) {
      const confirm = await askUi({
        title: t('updFoundTitle', latestVersion),
        meta: `v${currentVersion} → v${latestVersion}`,
        message: t('updFoundAsk', latestVersion),
        okText: t('updInstallNow'),
        cancelText: t('updLater'),
      });
      if (confirm) {
        await downloadAndInstall(vsixAsset.browser_download_url, '', latestVersion, vsixAsset.size);
      }
    } else {
      void askUi({
        title: t('updFoundTitle', latestVersion),
        meta: `v${currentVersion} → v${latestVersion}`,
        message: t('updUseCommand', latestVersion),
        okText: t('updOpenPalette'),
        cancelText: t('updLater'),
      }).then((open) => {
        if (open) {
          void vscode.commands.executeCommand('workbench.action.showCommands', 'antigravityKite.checkForUpdates');
        }
      });
    }
  } catch (err) {
    logWarn('updater.autoCheck.fail', err instanceof Error ? err.message : String(err));
  }
}

/**
 * 启动时自动检查（返回可销毁的 Disposable 以清理延迟定时器）
 */
export function autoCheckOnStartup(): vscode.Disposable {
  const config = getUpdateConfig();
  if (!config.autoCheck) {
    return new vscode.Disposable(() => {});
  }

  let disposed = false;
  // 延迟 30 秒后检查，避免影响启动性能
  const timer = setTimeout(() => {
    if (disposed) return;
    void runStartupUpdateCheck();
  }, 30_000);

  return new vscode.Disposable(() => {
    disposed = true;
    clearTimeout(timer);
  });
}

/** GitHub Release body 是 Markdown，弹窗按纯文本渲染：剥掉标记，保留行结构 */
function releaseBodyToPlainText(md: string): string {
  return md
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/!\[[^\]]*\]\([^)]*\)/g, '')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/^#{1,6}\s*/gm, '')
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/^\s*[-*+]\s+/gm, '· ')
    .replace(/^\s*>\s?/gm, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/**
 * 新版本安装后的更新说明：走侧栏通用询问弹窗（不再弹 VS Code 原生模态），返回可销毁句柄以清理延迟定时器。
 */
export function showUpdateNotesOnStartup(context: vscode.ExtensionContext): vscode.Disposable {
  const currentVersion = getCurrentVersion();
  const lastVersion = context.globalState.get<string>('lastInstalledVersion');

  // 首次安装没有历史版本号：记下当前版本，不弹更新说明
  if (!lastVersion) {
    void context.globalState.update('lastInstalledVersion', currentVersion);
    return new vscode.Disposable(() => {});
  }

  if (compareVersions(currentVersion, lastVersion) <= 0) {
    if (lastVersion !== currentVersion) {
      void context.globalState.update('lastInstalledVersion', currentVersion);
    }
    return new vscode.Disposable(() => {});
  }

  void context.globalState.update('lastInstalledVersion', currentVersion);

  let disposed = false;
  // 延迟一两秒再弹，避免刚启动时抢焦点
  const timer = setTimeout(async () => {
    if (disposed) return;
    let releaseBody = '';
    let gitHubUrl = `https://github.com/${REPO_OWNER}/${REPO_NAME}/releases`;

    // 没有发布说明就不打扰：拿不到 Release（404/网络失败/正文为空）直接静默，只留日志
    try {
      const releaseUrl = `https://api.github.com/repos/${REPO_OWNER}/${REPO_NAME}/releases/tags/v${currentVersion}`;
      const release = await fetchGitHubApi<GitHubRelease>(releaseUrl, '');
      releaseBody = release.body ? releaseBodyToPlainText(release.body) : '';
      gitHubUrl = release.html_url || gitHubUrl;
    } catch (e) {
      logInfo('updateNotes.skip', {
        version: currentVersion,
        reason: 'release-unavailable: ' + (e instanceof Error ? e.message : String(e)),
      });
      return;
    }

    if (disposed) return;
    if (releaseBody.length < 10) {
      logInfo('updateNotes.skip', { version: currentVersion, reason: 'empty-body' });
      return;
    }

    void askUi({
      title: t('updUpdatedTitle', currentVersion),
      meta: `v${lastVersion} → v${currentVersion}`,
      message: t('updNotesBody', releaseBody),
      okText: t('updViewRelease'),
      cancelText: t('updKnown'),
      linkUrl: gitHubUrl,
      // 启动时不抢编辑器焦点：侧栏没开就排队，等用户打开侧栏再补发
      silent: true,
    });
  }, 2000);

  return new vscode.Disposable(() => {
    disposed = true;
    clearTimeout(timer);
  });
}
