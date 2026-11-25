// 宠物窗口位置的纯计算：保存、恢复、保持在可见区域内。
// 坐标统一为 DIP（R03、TD §12.3）。不依赖 Electron，便于单元测试。

export interface Point {
  x: number;
  y: number;
}

export interface Size {
  width: number;
  height: number;
}

export interface Rect extends Point, Size {}

export interface DisplayArea {
  id: number;
  bounds: Rect;
  /** 去掉任务栏后的可用区域 */
  workArea: Rect;
  primary: boolean;
}

/** 保存的位置：所在显示器 + 窗口左上角在可用区内的相对比例（0～1） */
export interface SavedPlacement {
  displayId: number;
  /** 显示器 id 变化时，按边界再匹配一次 */
  displayBounds: Rect;
  relX: number;
  relY: number;
}

/** 首次启动时距离主屏可用区右下角的边距 */
const DEFAULT_MARGIN = 24;

export function toSavedPlacement(windowBounds: Rect, displays: DisplayArea[]): SavedPlacement | null {
  const display = nearestDisplay(centerOf(windowBounds), displays);
  if (!display) return null;
  const area = display.workArea;
  return {
    displayId: display.id,
    displayBounds: { ...display.bounds },
    relX: ratio(windowBounds.x - area.x, area.width - windowBounds.width),
    relY: ratio(windowBounds.y - area.y, area.height - windowBounds.height),
  };
}

export function resolvePlacement(saved: SavedPlacement | null, displays: DisplayArea[], size: Size): Point {
  if (!saved) return defaultPosition(displays, size);

  const display =
    displays.find((d) => d.id === saved.displayId) ??
    displays.find((d) => sameRect(d.bounds, saved.displayBounds)) ??
    primaryDisplay(displays);
  if (!display) return { x: 0, y: 0 };

  const area = display.workArea;
  const position = {
    x: area.x + clamp01(saved.relX) * Math.max(0, area.width - size.width),
    y: area.y + clamp01(saved.relY) * Math.max(0, area.height - size.height),
  };
  return clampInto(position, size, area);
}

/** 把窗口整体移入离它最近的显示器可用区；已经在内部时位置不变 */
export function keepVisible(windowBounds: Rect, displays: DisplayArea[]): Point {
  const display = nearestDisplay(centerOf(windowBounds), displays);
  if (!display) return { x: windowBounds.x, y: windowBounds.y };
  return clampInto(windowBounds, windowBounds, display.workArea);
}

/** 松手时离工作区边缘不超过 threshold 的一侧贴边（R02.AC-4），结果整体在可用区内 */
export function snapToEdges(windowBounds: Rect, displays: DisplayArea[], threshold: number): Point {
  const display = nearestDisplay(centerOf(windowBounds), displays);
  if (!display) return { x: windowBounds.x, y: windowBounds.y };
  const area = display.workArea;
  const right = area.x + area.width - windowBounds.width;
  const bottom = area.y + area.height - windowBounds.height;
  let { x, y } = clampInto(windowBounds, windowBounds, area);
  if (x - area.x <= threshold) x = area.x;
  else if (right - x <= threshold) x = right;
  if (y - area.y <= threshold) y = area.y;
  else if (bottom - y <= threshold) y = bottom;
  return clampInto({ x, y }, windowBounds, area);
}

/** 改变窗口尺寸时保持底部中点不动（角色“站”在原地），再移入可见区域 */
export function resizeAnchored(windowBounds: Rect, size: Size, displays: DisplayArea[]): Point {
  const next = {
    x: Math.round(windowBounds.x + windowBounds.width / 2 - size.width / 2),
    y: Math.round(windowBounds.y + windowBounds.height - size.height),
    ...size,
  };
  return keepVisible(next, displays);
}

export function centerOnPrimary(displays: DisplayArea[], size: Size): Point {
  const display = primaryDisplay(displays);
  if (!display) return { x: 0, y: 0 };
  const area = display.workArea;
  return clampInto(
    { x: area.x + (area.width - size.width) / 2, y: area.y + (area.height - size.height) / 2 },
    size,
    area,
  );
}

function defaultPosition(displays: DisplayArea[], size: Size): Point {
  const display = primaryDisplay(displays);
  if (!display) return { x: 0, y: 0 };
  const area = display.workArea;
  return clampInto(
    {
      x: area.x + area.width - size.width - DEFAULT_MARGIN,
      y: area.y + area.height - size.height - DEFAULT_MARGIN,
    },
    size,
    area,
  );
}

function primaryDisplay(displays: DisplayArea[]): DisplayArea | undefined {
  return displays.find((d) => d.primary) ?? displays[0];
}

function nearestDisplay(point: Point, displays: DisplayArea[]): DisplayArea | undefined {
  let best: DisplayArea | undefined;
  let bestDistance = Infinity;
  for (const display of displays) {
    const distance = distanceToRect(point, display.workArea);
    if (distance < bestDistance) {
      best = display;
      bestDistance = distance;
    }
  }
  return best;
}

function clampInto(position: Point, size: Size, area: Rect): Point {
  return {
    x: Math.round(clamp(position.x, area.x, area.x + area.width - size.width)),
    y: Math.round(clamp(position.y, area.y, area.y + area.height - size.height)),
  };
}

function centerOf(rect: Rect): Point {
  return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 };
}

function distanceToRect(point: Point, rect: Rect): number {
  const dx = Math.max(rect.x - point.x, 0, point.x - (rect.x + rect.width));
  const dy = Math.max(rect.y - point.y, 0, point.y - (rect.y + rect.height));
  return Math.hypot(dx, dy);
}

function sameRect(a: Rect, b: Rect): boolean {
  return a.x === b.x && a.y === b.y && a.width === b.width && a.height === b.height;
}

/** 可用区比窗口还小时，max < min，此时贴住左上角 */
function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(value, max));
}

function clamp01(value: number): number {
  return clamp(value, 0, 1);
}

function ratio(offset: number, span: number): number {
  return span > 0 ? clamp01(offset / span) : 0;
}
