import * as vscode from 'vscode';
import * as https from 'https';
import * as http from 'http';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { t } from './i18n';
import { logInfo } from './logger';
import { notifyUi, askUi } from './uiChannel';

interface GitHubRelease {
  tag_name: string;
  name: string;
  body: string;
  html_url: string;
  assets: Array<{
    name: string;
    browser_download_url: string;
    size: number;
  }>;
}

// 硬编码仓库信息（公开仓库，无需 token）
const REPO_OWNER = 'soulvon';
const REPO_NAME = 'antigravity-kite';

interface UpdateConfig {
  autoCheck: boolean;
  autoInstall: boolean;
}

/**
 * 获取更新配置
 */
function getUpdateConfig(): UpdateConfig {
  const config = vscode.workspace.getConfiguration('antigravityKite.update');
  return {
    autoCheck: config.get('autoCheck', true),
    autoInstall: config.get('autoInstall', true),
  };
}

/**
 * 获取当前扩展版本
 */
function getCurrentVersion(): string {
  const packageJson = JSON.parse(fs.readFileSync(path.join(__dirname, '../package.json'), 'utf8'));
  return packageJson.version;
}

/**
 * 请求 GitHub API
 */
function fetchGitHubApi(url: string, token: string): Promise<any> {
  return new Promise((resolve, reject) => {
    const protocol = url.startsWith('https') ? https : http;
    const headers: Record<string, string> = {
      'User-Agent': 'antigravity-kite-updater',
    };
    if (token) {
      headers['Authorization'] = `token ${token}`;
    }

    const req = protocol.get(url, { headers }, (res) => {
      let data = '';
      res.on('data', (chunk) => data += chunk);
      res.on('end', () => {
        if (res.statusCode === 200) {
          try {
            resolve(JSON.parse(data));
          } catch (e) {
            reject(new Error('JSON parse failed'));
          }
        } else if (res.statusCode === 404) {
          reject(new Error('Repository or release not found'));
        } else if (res.statusCode === 401) {
          reject(new Error('Invalid GitHub token or insufficient permissions'));
        } else {
          reject(new Error(`GitHub API error: ${res.statusCode}`));
        }
      });
    });

    req.on('error', reject);
    req.setTimeout(10000, () => {
      req.destroy();
      reject(new Error('Request timeout'));
    });
  });
}

/**
 * 下载文件到临时目录（支持重定向）
 */
function downloadFile(url: string, token: string, destPath: string, maxRedirects: number = 5): Promise<void> {
  return new Promise((resolve, reject) => {
    if (maxRedirects <= 0) {
      reject(new Error('Too many redirects'));
      return;
    }

    const protocol = url.startsWith('https') ? https : http;
    const headers: Record<string, string> = {
      'User-Agent': 'antigravity-kite-updater',
    };
    if (token) {
      headers['Authorization'] = `token ${token}`;
    }

    const req = protocol.get(url, { headers }, (res) => {
      // 处理重定向
      if (res.statusCode && [301, 302, 303, 307, 308].includes(res.statusCode) && res.headers.location) {
        res.resume(); // 消费响应体
        downloadFile(res.headers.location, token, destPath, maxRedirects - 1).then(resolve, reject);
        return;
      }

      if (res.statusCode !== 200) {
        reject(new Error(`Download failed: ${res.statusCode}`));
        return;
      }

      const file = fs.createWriteStream(destPath);
      res.pipe(file);

      file.on('finish', () => {
        file.close();
        resolve();
      });

      file.on('error', (err) => {
        fs.unlink(destPath, () => {});
        reject(err);
      });
    });

    req.on('error', reject);
    req.setTimeout(60000, () => {
      req.destroy();
      reject(new Error('Download timeout'));
    });
  });
}

/**
 * 比较版本号 (返回 >0 如果 a>b, <0 如果 a<b, =0 如果相等)
 */
function compareVersions(a: string, b: string): number {
  const splitVer = (v: string) => {
    const dashIdx = v.indexOf('-');
    return {
      core: dashIdx >= 0 ? v.slice(0, dashIdx) : v,
      pre: dashIdx >= 0 ? v.slice(dashIdx + 1) : '',
    };
  };
  const { core: coreA, pre: preA } = splitVer(a);
  const { core: coreB, pre: preB } = splitVer(b);

  const pa = coreA.split('.').map(s => parseInt(s, 10) || 0);
  const pb = coreB.split('.').map(s => parseInt(s, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const na = pa[i] || 0;
    const nb = pb[i] || 0;
    if (na !== nb) return na - nb;
  }

  if (preA === '' && preB === '') return 0;
  if (preA === '') return 1;
  if (preB === '') return -1;
  return preA < preB ? -1 : (preA > preB ? 1 : 0);
}

/**
 * 检查更新
 */
export async function checkForUpdates(silent: boolean = false): Promise<boolean> {
  const config = getUpdateConfig();
  const currentVersion = getCurrentVersion();

  try {
    const url = `https://api.github.com/repos/${REPO_OWNER}/${REPO_NAME}/releases/latest`;
    const release: GitHubRelease = await fetchGitHubApi(url, '');

    const latestVersion = release.tag_name.startsWith('v') ? release.tag_name.slice(1) : release.tag_name;

    if (compareVersions(latestVersion, currentVersion) <= 0) {
      if (!silent) {
        notifyUi('info', t('updUpToDate', currentVersion));
      }
      return false;
    }

    // 找到 vsix 资产
    const vsixAsset = release.assets.find(a => a.name.endsWith('.vsix'));
    if (!vsixAsset) {
      if (!silent) {
        notifyUi('warning', t('updNoVsix'));
      }
      return false;
    }

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
        await downloadAndInstall(vsixAsset.browser_download_url, '', latestVersion);
      } else {
        await downloadOnly(vsixAsset.browser_download_url, '', latestVersion);
      }
    }

    return true;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (msg.includes('not found')) {
      // 仓库尚未发布任何 Release：不算故障，静默视为无更新
      console.log('[antigravity-kite] GitHub 上还没有发布版本，跳过更新检查');
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
async function downloadAndInstall(downloadUrl: string, token: string, version: string): Promise<void> {
  const tempDir = os.tmpdir();
  const vsixPath = path.join(tempDir, `antigravity-kite-${version}.vsix`);

  await vscode.window.withProgress(
    {
      location: vscode.ProgressLocation.Notification,
      title: t('updDownloading'),
      cancellable: false,
    },
    async () => {
      await downloadFile(downloadUrl, token, vsixPath);
    }
  );

  await vscode.window.withProgress(
    {
      location: vscode.ProgressLocation.Notification,
      title: t('updInstalling'),
      cancellable: false,
    },
    async () => {
      await vscode.commands.executeCommand('workbench.extensions.installExtension', vscode.Uri.file(vsixPath));
    }
  );

  const reload = await askUi({
    title: t('updInstalling'),
    message: t('updReloadPrompt'),
    okText: t('updReloadNow'),
    cancelText: t('updLater'),
  });

  if (reload) {
    vscode.commands.executeCommand('workbench.action.reloadWindow');
  }

  // 清理临时文件
  fs.unlink(vsixPath, () => {});
}

/**
 * 仅下载
 */
async function downloadOnly(downloadUrl: string, token: string, version: string): Promise<void> {
  const tempDir = os.tmpdir();
  const vsixPath = path.join(tempDir, `antigravity-kite-${version}.vsix`);

  await vscode.window.withProgress(
    {
      location: vscode.ProgressLocation.Notification,
      title: t('updDownloadingPlain'),
      cancellable: false,
    },
    async () => {
      await downloadFile(downloadUrl, token, vsixPath);
    }
  );

  const open = await askUi({
    title: t('updDownloadedTitle'),
    message: t('updDownloadDone', vsixPath),
    okText: t('updOpenFolder'),
    cancelText: t('updLater'),
  });

  if (open) {
    vscode.env.openExternal(vscode.Uri.file(tempDir));
  }
}

/**
 * 启动时自动检查
 */
export async function autoCheckOnStartup(): Promise<void> {
  const config = getUpdateConfig();
  if (!config.autoCheck) {
    return;
  }

  // 延迟 30 秒后检查，避免影响启动性能
  setTimeout(async () => {
    try {
      const currentVersion = getCurrentVersion();
      const url = `https://api.github.com/repos/${REPO_OWNER}/${REPO_NAME}/releases/latest`;
      const release: GitHubRelease = await fetchGitHubApi(url, '');

      const latestVersion = release.tag_name.startsWith('v') ? release.tag_name.slice(1) : release.tag_name;

      if (compareVersions(latestVersion, currentVersion) <= 0) {
        return; // 已是最新
      }

      // 找到 vsix 资产
      const vsixAsset = release.assets.find(a => a.name.endsWith('.vsix'));
      if (!vsixAsset) {
        return;
      }

      if (config.autoInstall) {
        const confirm = await askUi({
          title: t('updFoundTitle', latestVersion),
          meta: `v${currentVersion} → v${latestVersion}`,
          message: t('updFoundAsk', latestVersion),
          okText: t('updInstallNow'),
          cancelText: t('updLater'),
        });

        if (confirm) {
          await downloadAndInstall(vsixAsset.browser_download_url, '', latestVersion);
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
      console.error('[antigravity-kite] Auto check update failed:', err);
    }
  }, 30000);
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
 * 新版本安装后的更新说明：走侧栏通用询问弹窗（不再弹 VS Code 原生模态）。
 * Release 说明拉不到时，主按钮换成带诊断参数的 GitHub 反馈链接。
 */
export async function showUpdateNotesOnStartup(context: vscode.ExtensionContext): Promise<void> {
  const currentVersion = getCurrentVersion();
  const lastVersion = context.globalState.get<string>('lastInstalledVersion');

  // 首次安装没有历史版本号：记下当前版本，不弹更新说明
  if (!lastVersion) {
    context.globalState.update('lastInstalledVersion', currentVersion);
    return;
  }

  if (lastVersion === currentVersion) {
    return;
  }

  context.globalState.update('lastInstalledVersion', currentVersion);

  // 延迟一两秒再弹，避免刚启动时抢焦点
  setTimeout(async () => {
    let releaseBody = '';
    let gitHubUrl = `https://github.com/${REPO_OWNER}/${REPO_NAME}/releases`;

    // 没有发布说明就不打扰：拿不到 Release（404/网络失败/正文为空）直接静默，
    // 只留日志，不弹空白说明框
    try {
      const releaseUrl = `https://api.github.com/repos/${REPO_OWNER}/${REPO_NAME}/releases/tags/v${currentVersion}`;
      const release: GitHubRelease = await fetchGitHubApi(releaseUrl, '');
      releaseBody = release.body ? releaseBodyToPlainText(release.body) : '';
      gitHubUrl = release.html_url || gitHubUrl;
    } catch (e) {
      logInfo('updateNotes.skip', {
        version: currentVersion,
        reason: 'release-unavailable: ' + (e instanceof Error ? e.message : String(e)),
      });
      return;
    }

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
    });
  }, 2000);
}
