// 桌面系统信号扩展点（TD §12.4、§14.1）。
// 平台实现只负责读取原始信号；“算不算全屏”的判定是下面的纯函数，便于测试。

/** 未知要显式表示，不能默认为 false（TD §10.3） */
export type Tristate = boolean | 'unknown';

export interface DesktopContextProvider {
  readonly id: string;
  /**
   * 前台窗口是否在宠物所在的显示器上全屏。
   * @param petWindowHandle 宠物窗口的原生句柄（BrowserWindow.getNativeWindowHandle()）
   */
  queryFullscreen(petWindowHandle: Buffer): Tristate;
}

export interface Rect32 {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

/** 平台层读到的前台窗口信息（物理像素） */
export interface ForegroundSnapshot {
  className: string;
  /** 属于本应用进程（例如对话窗口） */
  ownProcess: boolean;
  windowRect: Rect32;
  maximized: boolean;
  /** 前台窗口所在显示器的完整区域 */
  monitorRect: Rect32;
  /** 前台窗口与宠物在同一个显示器上 */
  sameMonitorAsPet: boolean;
}

/** Windows SHQueryUserNotificationState 的取值 */
export const NotificationState = {
  notPresent: 1,
  busy: 2,
  d3dFullscreen: 3,
  presentationMode: 4,
  acceptsNotifications: 5,
  quietTime: 6,
  app: 7,
} as const;

/** 桌面、任务栏等外壳窗口：铺满屏幕但不是“全屏应用” */
const SHELL_CLASSES = new Set(['Progman', 'WorkerW', 'Shell_TrayWnd', 'Shell_SecondaryTrayWnd']);

/**
 * 判定规则（保守）：
 * - 独占全屏（D3D）或演示模式：视为全屏；
 * - 前台窗口不是外壳、不是最大化，且窗口矩形覆盖整个显示器：视为全屏（无边框全屏、浏览器/播放器全屏）；
 * - 只在与宠物同一显示器时返回 true，其他显示器上的全屏不影响宠物。
 */
export function evaluateFullscreen(foreground: ForegroundSnapshot | null, notificationState: number | null): Tristate {
  if (!foreground) {
    return notificationState === NotificationState.d3dFullscreen ? 'unknown' : false;
  }
  if (foreground.ownProcess || SHELL_CLASSES.has(foreground.className)) return false;
  if (!foreground.sameMonitorAsPet) return false;

  if (
    notificationState === NotificationState.d3dFullscreen ||
    notificationState === NotificationState.presentationMode
  ) {
    return true;
  }
  if (foreground.maximized) return false;
  return covers(foreground.windowRect, foreground.monitorRect);
}

function covers(window: Rect32, monitor: Rect32): boolean {
  return (
    window.left <= monitor.left &&
    window.top <= monitor.top &&
    window.right >= monitor.right &&
    window.bottom >= monitor.bottom
  );
}

/** 没有可用实现的平台：一律 unknown（保持显示，不提升置顶层级） */
export const unknownDesktopContext: DesktopContextProvider = {
  id: 'unknown',
  queryFullscreen: () => 'unknown',
};
