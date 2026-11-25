import { describe, expect, it } from 'vitest';
import {
  evaluateFullscreen,
  NotificationState,
  type ForegroundSnapshot,
  type Tristate,
} from '../../src/main/desktop/context/desktop-context';
import { FullscreenGuard } from '../../src/main/desktop/fullscreen-guard';

const monitor = { left: 0, top: 0, right: 2560, bottom: 1440 };

function fg(patch: Partial<ForegroundSnapshot> = {}): ForegroundSnapshot {
  return {
    className: 'Chrome_WidgetWin_1',
    ownProcess: false,
    windowRect: { left: 100, top: 100, right: 1200, bottom: 900 },
    maximized: false,
    monitorRect: monitor,
    sameMonitorAsPet: true,
    ...patch,
  };
}

const ACCEPTS = NotificationState.acceptsNotifications;

describe('evaluateFullscreen', () => {
  it('普通窗口不是全屏', () => {
    expect(evaluateFullscreen(fg(), ACCEPTS)).toBe(false);
  });

  it('无边框窗口覆盖整个显示器时是全屏', () => {
    expect(evaluateFullscreen(fg({ windowRect: monitor }), NotificationState.busy)).toBe(true);
  });

  it('最大化窗口不算全屏（即使边框超出屏幕）', () => {
    const rect = { left: -8, top: -8, right: 2568, bottom: 1448 };
    expect(evaluateFullscreen(fg({ windowRect: rect, maximized: true }), ACCEPTS)).toBe(false);
  });

  it('桌面和任务栏不算全屏', () => {
    for (const className of ['Progman', 'WorkerW', 'Shell_TrayWnd']) {
      expect(evaluateFullscreen(fg({ className, windowRect: monitor }), ACCEPTS)).toBe(false);
    }
  });

  it('本应用自己的窗口不算外部全屏', () => {
    expect(evaluateFullscreen(fg({ ownProcess: true, windowRect: monitor }), ACCEPTS)).toBe(false);
  });

  it('全屏发生在其他显示器时不影响宠物', () => {
    expect(evaluateFullscreen(fg({ windowRect: monitor, sameMonitorAsPet: false }), ACCEPTS)).toBe(false);
  });

  it('独占全屏和演示模式视为全屏', () => {
    expect(evaluateFullscreen(fg(), NotificationState.d3dFullscreen)).toBe(true);
    expect(evaluateFullscreen(fg(), NotificationState.presentationMode)).toBe(true);
  });

  it('读不到前台窗口：独占全屏时为 unknown，否则为 false', () => {
    expect(evaluateFullscreen(null, NotificationState.d3dFullscreen)).toBe('unknown');
    expect(evaluateFullscreen(null, ACCEPTS)).toBe(false);
  });
});

describe('FullscreenGuard', () => {
  function setup(results: Tristate[], enabled = true) {
    const suppressed: boolean[] = [];
    let i = 0;
    const guard = new FullscreenGuard(
      { id: 'fake', queryFullscreen: () => results[Math.min(i++, results.length - 1)] ?? 'unknown' },
      { nativeHandle: () => Buffer.alloc(8), setSuppressed: (value) => suppressed.push(value) },
      () => enabled,
    );
    return { guard, suppressed };
  }

  it('全屏时隐藏，退出后恢复', () => {
    const { guard, suppressed } = setup([true, false]);
    guard.check();
    guard.check();
    expect(suppressed).toEqual([true, false]);
  });

  it('结果未知时保持显示', () => {
    const { guard, suppressed } = setup(['unknown']);
    guard.check();
    expect(suppressed).toEqual([false]);
    expect(guard.state).toBe('unknown');
  });

  it('用户选择“全屏时保持显示”时不隐藏', () => {
    const { guard, suppressed } = setup([true], false);
    guard.check();
    expect(suppressed).toEqual([false]);
  });

  it('停止时撤销隐藏', () => {
    const { guard, suppressed } = setup([true]);
    guard.check();
    guard.stop();
    expect(suppressed).toEqual([true, false]);
  });
});
