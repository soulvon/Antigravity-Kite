/**
 * 跨平台数据目录解析（单一真源）
 *
 * 零依赖：严禁 import vscode —— 本模块同时被扩展宿主与
 * switchRestartHelper（IDE 之外 ELECTRON_RUN_AS_NODE 进程）加载。
 * 规则与 VS Code 系惯例对齐：
 *   win32  → %APPDATA% / %LOCALAPPDATA%
 *   darwin → ~/Library/Application Support
 *   linux  → $XDG_CONFIG_HOME~/.config / $XDG_DATA_HOME~/.local/share
 */
import * as os from 'os';
import * as path from 'path';

export function getAppDataDir(): string {
  if (process.platform === 'win32') {
    return process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming');
  }
  if (process.platform === 'darwin') {
    return path.join(os.homedir(), 'Library', 'Application Support');
  }
  return process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config');
}

export function getLocalAppDataDir(): string {
  if (process.platform === 'win32') {
    return process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local');
  }
  if (process.platform === 'darwin') {
    return path.join(os.homedir(), 'Library', 'Application Support');
  }
  return process.env.XDG_DATA_HOME || path.join(os.homedir(), '.local', 'share');
}
