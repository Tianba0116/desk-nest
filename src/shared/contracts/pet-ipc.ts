// 宠物窗口与主进程之间的 IPC 约定。
// 本文件会被沙箱化的 preload 引用，只能放常量和类型，不要引入第三方依赖。

export const PetIpc = {
  /** 渲染层 → 主进程：页面已就绪，请推送当前外观 */
  ready: 'pet:ready',
  /** 渲染层 → 主进程：按下后移动超过阈值，开始拖动 */
  dragStart: 'pet:drag-start',
  /** 渲染层 → 主进程：松开或指针被取消，结束拖动 */
  dragEnd: 'pet:drag-end',
  /** 渲染层 → 主进程：指针是否位于角色的交互轮廓内（boolean） */
  setInteractive: 'pet:set-interactive',
  /** 渲染层 → 主进程：在角色上右键，弹出菜单（R02.AC-5） */
  openMenu: 'pet:open-menu',
  /** 渲染层 → 主进程：单击（触碰）宠物，打开或收起对话（R02.AC-2） */
  touched: 'pet:touched',
  /** 主进程 → 渲染层：PetEvent */
  event: 'pet:event',
} as const;

export type PetEvent =
  /** 主进程因锁屏、睡眠、窗口隐藏等原因结束了拖动 */
  | { type: 'drag-cancelled' }
  /** 宠物被找回，或用户再次启动了应用 */
  | { type: 'summoned' }
  /** 外观设置：应用内“降低动态效果” */
  | { type: 'appearance'; reducedMotion: boolean }
  /** 信箱未读数：大于 0 时宠物显示未读标记 */
  | { type: 'inbox'; unread: number };

/** preload 暴露给宠物窗口的接口（window.petBridge） */
export interface PetBridge {
  ready(): void;
  dragStart(): void;
  dragEnd(): void;
  setInteractive(interactive: boolean): void;
  openMenu(): void;
  touched(): void;
  /** 返回取消订阅函数 */
  onEvent(listener: (event: PetEvent) => void): () => void;
}
