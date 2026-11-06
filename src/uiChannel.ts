/**
 * 统一 UI 通道：宿主侧提示与询问一律走侧栏 webview，不再弹 VS Code 原生对话框。
 *
 * 调用方（updater / statusBar / cdpGate / extension）只依赖本模块的 notifyUi / askUi，
 * 不直接持有 SidebarProvider，避免各处重复拼接 postMessage。
 * 没有注册展示器时（理论上不会发生）只记日志，绝不回退到 vscode.window.showXxxMessage——
 * 原生弹窗与侧栏视觉割裂，是用户明确要求去掉的。
 */

export type UiStatus = 'success' | 'error' | 'warning' | 'info';

export interface UiAskOptions {
  title: string;
  /** 次级说明行（如版本跨度 v1.0.10 → v1.1.0），可选 */
  meta?: string;
  message: string;
  okText?: string;
  cancelText?: string;
  /** 主按钮同时打开外部链接（GitHub Release / 反馈 Issue） */
  linkUrl?: string;
}

export interface UiPresenter {
  notify(status: UiStatus, message: string): void;
  /** 返回 true = 用户点了主按钮；false = 取消/关闭/侧栏不可用 */
  ask(options: UiAskOptions): Promise<boolean>;
  /** 用户点主按钮时打开的外部链接（由展示器自行处理跳转） */
}

let presenter: UiPresenter | undefined;

export function registerUiPresenter(p: UiPresenter): void {
  presenter = p;
}

/** 单条提示：走侧栏 toast（成功/失败/警告同款，可堆叠） */
export function notifyUi(status: UiStatus, message: string): void {
  if (!presenter) {
    console.warn('[Kite-UI] 展示器未注册，提示未显示:', message);
    return;
  }
  presenter.notify(status, message);
}

/** 需要用户确认的询问：走侧栏模态框 */
export async function askUi(options: UiAskOptions): Promise<boolean> {
  if (!presenter) {
    console.warn('[Kite-UI] 展示器未注册，询问未显示:', options.title);
    return false;
  }
  return presenter.ask(options);
}
