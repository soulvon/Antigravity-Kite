/**
 * 语言自适应：默认跟随 IDE 语言（vscode.env.language），可在设置中手动指定。
 * 覆盖范围：门控/切号等会打扰用户的提示文案；声明按钮中英文均已在守卫里匹配。
 */
import * as vscode from 'vscode';

export type Lang = 'zh' | 'en';

export function getLang(): Lang {
  const cfg = vscode.workspace.getConfiguration('antigravityKite').get<string>('locale', 'auto');
  if (cfg === 'zh-CN') return 'zh';
  if (cfg === 'en') return 'en';
  return (vscode.env.language || '').toLowerCase().startsWith('zh') ? 'zh' : 'en';
}

/** [zh, en] */
const S: Record<string, [string, string]> = {
  // CDP 门控
  gateModalTitle: [
    '切换账号时自动确认安全声明，需要以调试端口启动 IDE（将修改快捷方式并重启一次，仅此一次）。',
    'To auto-confirm the security notice when switching accounts, the IDE must run with a debug port (shortcuts will be patched and the IDE restarted once).',
  ],
  gateEnable: ['开启（推荐）', 'Enable (recommended)'],
  gateLater: ['暂不', 'Not now'],
  gateRelaunching: [
    '正在以调试端口重启 IDE，之后切号不再弹窗…',
    'Restarting the IDE with the debug port; switching will no longer show the notice…',
  ],
  gateNoExe: ['未定位到 IDE 可执行文件', 'Could not locate the IDE executable'],
  gateNoPid: ['未定位到 IDE 主进程 PID', 'Could not locate the IDE main process PID'],
  gateEnableFailed: ['开启失败：', 'Failed to enable: '],
  gateDeclineInfo: [
    '已暂不开启：每次切换会弹一次安全声明（手动点击即可）。可在设置「自动确认安全声明」中开启。',
    'Auto-confirm is off: the security notice will appear on each switch (click manually). Enable "Auto-confirm security notice" in settings to turn it on.',
  ],
  gateManualToast: [
    '切换账号将弹一次安全声明（需手动点击）。可在设置「自动确认安全声明」中开启自动确认。',
    'A security notice will appear on each switch (click manually). Enable "Auto-confirm security notice" in settings for automatic confirmation.',
  ],
  // 切号 toast
  switchCredFail: ['凭据写入失败：', 'Failed to write credential: '],
  switchAgyPtrFail: ['agy 指针写入失败：', 'Failed to write agy pointer: '],
  switchGeminiFail: ['gemini 文件同步失败：', 'Failed to sync gemini files: '],
  switchMenuAlignLater: [
    '账号菜单显示待下次重启对齐（不影响使用）',
    'The account menu display will align after the next restart (does not affect usage)',
  ],
  switchDone: [
    '秒切完成：agent/额度已切至 ',
    'Quick switch done: agent/quota switched to ',
  ],
  switchCancelled: ['切号已取消：', 'Switch cancelled: '],
  switchGeminiSyncFail: [
    '切号已取消：同步本地凭据文件失败（',
    'Switch cancelled: failed to sync local credential files (',
  ],
};

/** 取文案；{0}{1} 为占位符 */
export function t(key: string, ...args: (string | number)[]): string {
  const e = S[key];
  if (!e) return key;
  const lang = getLang();
  let s = lang === 'zh' ? e[0] : e[1];
  args.forEach((a, i) => {
    s = s.split('{' + i + '}').join(String(a));
  });
  return s;
}
