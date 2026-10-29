import * as vscode from 'vscode';
import * as https from 'https';
import * as http from 'http';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

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
        vscode.window.showInformationMessage(`当前已是最新版本 v${currentVersion}`);
      }
      return false;
    }

    // 找到 vsix 资产
    const vsixAsset = release.assets.find(a => a.name.endsWith('.vsix'));
    if (!vsixAsset) {
      if (!silent) {
        vscode.window.showWarningMessage('发布中未找到 .vsix 文件');
      }
      return false;
    }

    const message = `发现新版本 v${latestVersion} (当前: v${currentVersion})\n${release.body || ''}`;
    const actions = config.autoInstall
      ? ['立即更新', '稍后']
      : ['下载', '打开发布页', '稍后'];

    const choice = await vscode.window.showInformationMessage(
      message,
      ...actions
    );

    if (choice === '立即更新') {
      await downloadAndInstall(vsixAsset.browser_download_url, '', latestVersion);
    } else if (choice === '下载') {
      await downloadOnly(vsixAsset.browser_download_url, '', latestVersion);
    } else if (choice === '打开发布页') {
      vscode.env.openExternal(vscode.Uri.parse(release.html_url));
    }

    return true;
  } catch (err) {
    if (!silent) {
      vscode.window.showErrorMessage(`检查更新失败: ${err instanceof Error ? err.message : String(err)}`);
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
      title: '正在下载更新...',
      cancellable: false,
    },
    async () => {
      await downloadFile(downloadUrl, token, vsixPath);
    }
  );

  await vscode.window.withProgress(
    {
      location: vscode.ProgressLocation.Notification,
      title: '正在安装更新...',
      cancellable: false,
    },
    async () => {
      await vscode.commands.executeCommand('workbench.extensions.installExtension', vscode.Uri.file(vsixPath));
    }
  );

  const reload = await vscode.window.showInformationMessage(
    '更新安装完成，需要重新加载窗口才能生效',
    '立即重载'
  );

  if (reload === '立即重载') {
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
      title: '正在下载...',
      cancellable: false,
    },
    async () => {
      await downloadFile(downloadUrl, token, vsixPath);
    }
  );

  const open = await vscode.window.showInformationMessage(
    `下载完成: ${vsixPath}`,
    '打开文件夹'
  );

  if (open === '打开文件夹') {
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
        const confirm = await vscode.window.showInformationMessage(
          `发现新版本 v${latestVersion}，是否立即更新？`,
          '立即更新',
          '稍后'
        );

        if (confirm === '立即更新') {
          await downloadAndInstall(vsixAsset.browser_download_url, '', latestVersion);
        }
      } else {
        vscode.window.showInformationMessage(
          `发现新版本 v${latestVersion}，请在命令面板执行 "检查更新"`,
          '打开命令面板'
        ).then(choice => {
          if (choice === '打开命令面板') {
            vscode.commands.executeCommand('workbench.action.showCommands', 'antigravityKite.checkForUpdates');
          }
        });
      }
    } catch (err) {
      console.error('[antigravity-kite] Auto check update failed:', err);
    }
  }, 30000);
}

/**
 * 弹出新版本安装后的提示模态框
 * 如果获取到的 Release Body 信息不全（或获取失败），提供一个跳转到 GitHub 反馈/完善的按钮，把相关诊断信息带上去。
 */
export async function showUpdateNotesOnStartup(context: vscode.ExtensionContext): Promise<void> {
  const currentVersion = getCurrentVersion();
  const lastVersion = context.globalState.get<string>('lastInstalledVersion');

  // 如果上次版本号不存在，通常为首次安装，我们保存版本号但不弹窗（或者也可以弹窗，不过习惯上首次安装显示欢迎而非更新日志）。
  // 为了确保首次安装也能有个好印象，我们可以根据 lastVersion 的状态来处理。
  if (!lastVersion) {
    context.globalState.update('lastInstalledVersion', currentVersion);
    return;
  }

  // 如果版本号没有变化，直接返回
  if (lastVersion === currentVersion) {
    return;
  }

  // 记录新版本
  context.globalState.update('lastInstalledVersion', currentVersion);

  // 延迟一两秒再弹窗，避免刚启动时弹窗太多影响体验
  setTimeout(async () => {
    let releaseBody = '';
    let isInfoIncomplete = false;
    let gitHubUrl = `https://github.com/${REPO_OWNER}/${REPO_NAME}/releases`;

    try {
      // 尝试获取当前版本的 GitHub Release 详情
      const releaseUrl = `https://api.github.com/repos/${REPO_OWNER}/${REPO_NAME}/releases/tags/v${currentVersion}`;
      const release: GitHubRelease = await fetchGitHubApi(releaseUrl, '');
      releaseBody = release.body ? release.body.trim() : '';
      gitHubUrl = release.html_url || gitHubUrl;
      
      // 如果获取到的 body 为空或者太短，说明信息不全
      if (!releaseBody || releaseBody.length < 10) {
        isInfoIncomplete = true;
      }
    } catch (e) {
      // 获取失败，属于信息不全（网络不通或者 GitHub Release 还没建）
      isInfoIncomplete = true;
    }

    const detailText = isInfoIncomplete
      ? `检测到您已成功升级至新版本 v${currentVersion}（从 v${lastVersion}）。\n由于当前版本的更新日志信息尚不完整或未能从 GitHub 加载成功，您可以点击下方按钮前往 GitHub 查看或反馈信息！`
      : `核心更新内容：\n\n${releaseBody}`;

    const modalTitle = `Antigravity Kite 已更新至 v${currentVersion}`;

    const actions = isInfoIncomplete
      ? ['前往 GitHub 反馈/完善信息', '知道了']
      : ['查看 GitHub 发布页', '知道了'];

    const choice = await vscode.window.showInformationMessage(
      modalTitle,
      { modal: true, detail: detailText },
      ...actions
    );

    if (choice === '前往 GitHub 反馈/完善信息') {
      // 生成带参数的 GitHub Issue 链接，将版本等诊断信息上传到 GitHub
      const bodyParams = encodeURIComponent(`### 升级反馈 (v${lastVersion} -> v${currentVersion})\n\n- **OS**: ${os.type()} ${os.release()}\n- **IDE**: ${vscode.env.appName} ${vscode.version}\n- **问题描述**: 在更新到 v${currentVersion} 后遇到以下问题/或更新日志未显示。`);
      const feedbackUrl = `https://github.com/${REPO_OWNER}/${REPO_NAME}/issues/new?title=${encodeURIComponent(`[更新反馈] v${currentVersion} 升级异常或信息缺失`)}&body=${bodyParams}`;
      vscode.env.openExternal(vscode.Uri.parse(feedbackUrl));
    } else if (choice === '查看 GitHub 发布页') {
      vscode.env.openExternal(vscode.Uri.parse(gitHubUrl));
    }
  }, 2000);
}
