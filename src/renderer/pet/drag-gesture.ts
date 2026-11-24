// 区分“触碰”和“拖动”：按下后移动超过阈值才算拖动（R02.AC-2）。
// 纯状态机，不依赖 DOM，便于单元测试。坐标使用屏幕 DIP（PointerEvent.screenX/Y）。

export const DRAG_THRESHOLD_DIP = 5;

type GestureState =
  | { phase: 'idle' }
  | { phase: 'pressed'; pointerId: number; startX: number; startY: number }
  | { phase: 'dragging'; pointerId: number };

export type GesturePhase = GestureState['phase'];

export class DragGesture {
  private state: GestureState = { phase: 'idle' };

  get phase(): GesturePhase {
    return this.state.phase;
  }

  down(pointerId: number, x: number, y: number): void {
    if (this.state.phase !== 'idle') return;
    this.state = { phase: 'pressed', pointerId, startX: x, startY: y };
  }

  /** 超过阈值时返回 'drag-start'，只返回一次 */
  move(pointerId: number, x: number, y: number): 'drag-start' | null {
    const s = this.state;
    if (s.phase !== 'pressed' || s.pointerId !== pointerId) return null;
    if (Math.hypot(x - s.startX, y - s.startY) <= DRAG_THRESHOLD_DIP) return null;
    this.state = { phase: 'dragging', pointerId };
    return 'drag-start';
  }

  up(pointerId: number): 'touch' | 'drag-end' | null {
    const s = this.state;
    if (s.phase === 'idle' || s.pointerId !== pointerId) return null;
    this.state = { phase: 'idle' };
    return s.phase === 'pressed' ? 'touch' : 'drag-end';
  }

  /** 指针被取消（失去捕获、系统打断）：按下未拖动时不算触碰 */
  cancel(): 'drag-end' | null {
    const wasDragging = this.state.phase === 'dragging';
    this.state = { phase: 'idle' };
    return wasDragging ? 'drag-end' : null;
  }

  /** 主进程已经结束了拖动，只需回到初始状态 */
  reset(): void {
    this.state = { phase: 'idle' };
  }
}
