// 拖动由主进程驱动：渲染层只报告“开始/结束”，位置由主进程读取系统光标计算，
// 光标移出窗口或跨显示器时仍然跟手（TD §12.3）。

import { screen, type BrowserWindow } from 'electron';
import type { Point, Size } from './placement';

export type DragEndReason =
  /** 渲染层报告松开或指针取消 */
  | 'pointer'
  /** 锁屏、睡眠、窗口隐藏等由主进程终止 */
  | 'system';

/** 约 60 Hz；Windows 定时器精度约 15.6 ms */
const FOLLOW_INTERVAL_MS = 16;

export class PetDragController {
  private timer: NodeJS.Timeout | null = null;
  private grabOffset: Point = { x: 0, y: 0 };
  private lastPosition: Point | null = null;

  constructor(
    private readonly win: BrowserWindow,
    /** 固定窗口尺寸：跨不同缩放比例的显示器移动时，只用 setPosition 会让窗口尺寸漂移 */
    private readonly size: () => Size,
    private readonly onEnd: (reason: DragEndReason) => void,
  ) {}

  get active(): boolean {
    return this.timer !== null;
  }

  start(): void {
    if (this.active || this.win.isDestroyed()) return;
    const cursor = screen.getCursorScreenPoint();
    const [x = 0, y = 0] = this.win.getPosition();
    this.grabOffset = { x: cursor.x - x, y: cursor.y - y };
    this.lastPosition = { x, y };
    this.timer = setInterval(() => this.follow(), FOLLOW_INTERVAL_MS);
  }

  end(reason: DragEndReason): void {
    if (!this.timer) return;
    clearInterval(this.timer);
    this.timer = null;
    this.lastPosition = null;
    this.onEnd(reason);
  }

  private follow(): void {
    if (this.win.isDestroyed()) {
      this.end('system');
      return;
    }
    const cursor = screen.getCursorScreenPoint();
    const next = { x: Math.round(cursor.x - this.grabOffset.x), y: Math.round(cursor.y - this.grabOffset.y) };
    if (this.lastPosition && next.x === this.lastPosition.x && next.y === this.lastPosition.y) return;
    this.lastPosition = next;
    this.win.setBounds({ ...next, ...this.size() });
  }
}
