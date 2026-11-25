import { describe, expect, it } from 'vitest';
import {
  centerOnPrimary,
  keepVisible,
  resizeAnchored,
  resolvePlacement,
  snapToEdges,
  toSavedPlacement,
  type DisplayArea,
} from '../../src/main/desktop/placement';

const SIZE = { width: 160, height: 160 };

// 主屏 1920×1080，任务栏在底部 40；副屏 2560×1440（150% 缩放下的 DIP）位于右侧
const primary: DisplayArea = {
  id: 1,
  primary: true,
  bounds: { x: 0, y: 0, width: 1920, height: 1080 },
  workArea: { x: 0, y: 0, width: 1920, height: 1040 },
};
const secondary: DisplayArea = {
  id: 2,
  primary: false,
  bounds: { x: 1920, y: 0, width: 1707, height: 960 },
  workArea: { x: 1920, y: 0, width: 1707, height: 960 },
};
const both = [primary, secondary];

describe('resolvePlacement', () => {
  it('首次启动放在主屏可用区右下角', () => {
    expect(resolvePlacement(null, both, SIZE)).toEqual({ x: 1920 - 160 - 24, y: 1040 - 160 - 24 });
  });

  it('保存后再恢复得到同一位置', () => {
    const bounds = { x: 2300, y: 400, ...SIZE };
    const saved = toSavedPlacement(bounds, both);
    expect(saved?.displayId).toBe(2);
    expect(resolvePlacement(saved, both, SIZE)).toEqual({ x: 2300, y: 400 });
  });

  it('显示器 id 变了但边界相同，仍回到那块屏幕', () => {
    const saved = toSavedPlacement({ x: 2300, y: 400, ...SIZE }, both)!;
    const renumbered = [primary, { ...secondary, id: 99 }];
    expect(resolvePlacement(saved, renumbered, SIZE)).toEqual({ x: 2300, y: 400 });
  });

  it('原显示器不存在时按相对位置放到主屏', () => {
    const saved = toSavedPlacement({ x: 1920 + 1707 - 160, y: 0, ...SIZE }, both)!;
    expect(saved.relX).toBe(1);
    expect(resolvePlacement(saved, [primary], SIZE)).toEqual({ x: 1920 - 160, y: 0 });
  });

  it('分辨率变小后位置仍在可用区内', () => {
    const saved = toSavedPlacement({ x: 1760, y: 880, ...SIZE }, [primary])!;
    const small: DisplayArea = {
      ...primary,
      bounds: { x: 0, y: 0, width: 1280, height: 720 },
      workArea: { x: 0, y: 0, width: 1280, height: 680 },
    };
    expect(resolvePlacement(saved, [small], SIZE)).toEqual({ x: 1280 - 160, y: 680 - 160 });
  });

  it('相对比例越界时被截断', () => {
    const saved = { displayId: 1, displayBounds: primary.bounds, relX: 5, relY: -3 };
    expect(resolvePlacement(saved, [primary], SIZE)).toEqual({ x: 1920 - 160, y: 0 });
  });

  it('没有任何显示器时退回原点', () => {
    expect(resolvePlacement(null, [], SIZE)).toEqual({ x: 0, y: 0 });
  });
});

describe('keepVisible', () => {
  it('已在可用区内时不移动', () => {
    expect(keepVisible({ x: 500, y: 300, ...SIZE }, both)).toEqual({ x: 500, y: 300 });
  });

  it('拖进任务栏时被推回可用区', () => {
    expect(keepVisible({ x: 500, y: 1000, ...SIZE }, both)).toEqual({ x: 500, y: 1040 - 160 });
  });

  it('拖出屏幕外时移入最近的显示器', () => {
    expect(keepVisible({ x: 3700, y: -100, ...SIZE }, both)).toEqual({ x: 1920 + 1707 - 160, y: 0 });
    expect(keepVisible({ x: -500, y: 500, ...SIZE }, both)).toEqual({ x: 0, y: 500 });
  });

  it('跨在两块屏幕之间时归到中心所在的屏幕', () => {
    expect(keepVisible({ x: 1900, y: 100, ...SIZE }, both)).toEqual({ x: 1920, y: 100 });
    expect(keepVisible({ x: 1820, y: 100, ...SIZE }, both)).toEqual({ x: 1920 - 160, y: 100 });
  });
});

describe('centerOnPrimary', () => {
  it('找回宠物时放在主屏中央', () => {
    expect(centerOnPrimary(both, SIZE)).toEqual({ x: 880, y: 440 });
  });

  it('没有标记主屏时用第一块', () => {
    expect(centerOnPrimary([secondary], SIZE)).toEqual({ x: 1920 + Math.round((1707 - 160) / 2), y: 400 });
  });
});

describe('snapToEdges', () => {
  const T = 24;

  it('离边缘较远时不贴边', () => {
    expect(snapToEdges({ x: 500, y: 300, ...SIZE }, both, T)).toEqual({ x: 500, y: 300 });
  });

  it('靠近左边和底部时贴边', () => {
    expect(snapToEdges({ x: 20, y: 1040 - 160 - 10, ...SIZE }, both, T)).toEqual({ x: 0, y: 1040 - 160 });
  });

  it('靠近右边和顶部时贴边', () => {
    expect(snapToEdges({ x: 1920 - 160 - 24, y: 24, ...SIZE }, both, T)).toEqual({ x: 1920 - 160, y: 0 });
  });

  it('拖出可用区时先移回再贴边', () => {
    expect(snapToEdges({ x: 600, y: 1100, ...SIZE }, both, T)).toEqual({ x: 600, y: 1040 - 160 });
  });

  it('副屏使用自己的工作区', () => {
    expect(snapToEdges({ x: 1930, y: 400, ...SIZE }, both, T)).toEqual({ x: 1920, y: 400 });
  });
});

describe('resizeAnchored', () => {
  it('保持底部中点不变', () => {
    expect(resizeAnchored({ x: 500, y: 300, ...SIZE }, { width: 208, height: 208 }, both)).toEqual({ x: 476, y: 252 });
    expect(resizeAnchored({ x: 500, y: 300, ...SIZE }, { width: 120, height: 120 }, both)).toEqual({ x: 520, y: 340 });
  });

  it('放大后超出可用区时移回', () => {
    expect(resizeAnchored({ x: 1920 - 160, y: 0, ...SIZE }, { width: 208, height: 208 }, both)).toEqual({
      x: 1920 - 208,
      y: 0,
    });
  });
});
