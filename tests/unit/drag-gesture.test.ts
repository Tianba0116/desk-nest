import { describe, expect, it } from 'vitest';
import { DRAG_THRESHOLD_DIP, DragGesture } from '../../src/renderer/pet/drag-gesture';

describe('DragGesture', () => {
  it('移动不超过阈值时松开算触碰', () => {
    const g = new DragGesture();
    g.down(1, 100, 100);
    expect(g.move(1, 100 + DRAG_THRESHOLD_DIP, 100)).toBeNull();
    expect(g.phase).toBe('pressed');
    expect(g.up(1)).toBe('touch');
    expect(g.phase).toBe('idle');
  });

  it('超过阈值才开始拖动，且只通知一次', () => {
    const g = new DragGesture();
    g.down(1, 100, 100);
    expect(g.move(1, 104, 104)).toBe('drag-start'); // 斜向距离 ≈5.66
    expect(g.move(1, 200, 200)).toBeNull();
    expect(g.phase).toBe('dragging');
    expect(g.up(1)).toBe('drag-end');
  });

  it('忽略其他指针', () => {
    const g = new DragGesture();
    g.down(1, 0, 0);
    g.down(2, 0, 0);
    expect(g.move(2, 50, 50)).toBeNull();
    expect(g.up(2)).toBeNull();
    expect(g.phase).toBe('pressed');
  });

  it('未按下时移动和松开没有效果', () => {
    const g = new DragGesture();
    expect(g.move(1, 50, 50)).toBeNull();
    expect(g.up(1)).toBeNull();
  });

  it('取消：拖动中返回 drag-end，仅按下时不算触碰', () => {
    const dragging = new DragGesture();
    dragging.down(1, 0, 0);
    dragging.move(1, 20, 0);
    expect(dragging.cancel()).toBe('drag-end');
    expect(dragging.phase).toBe('idle');

    const pressed = new DragGesture();
    pressed.down(1, 0, 0);
    expect(pressed.cancel()).toBeNull();
    expect(pressed.phase).toBe('idle');
  });

  it('主进程结束拖动后 reset，之后的松开不再触发', () => {
    const g = new DragGesture();
    g.down(1, 0, 0);
    g.move(1, 20, 0);
    g.reset();
    expect(g.up(1)).toBeNull();
  });
});
