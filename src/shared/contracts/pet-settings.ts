// 宠物外观与桌面行为设置。只放常量和类型（会被沙箱 preload 和渲染层引用）。

export const PET_SIZES = ['small', 'medium', 'large'] as const;
export type PetSize = (typeof PET_SIZES)[number];

export const PET_SIZE_LABELS: Record<PetSize, string> = {
  small: '小',
  medium: '中',
  large: '大',
};

/** 角色按 160 DIP 设计，各档缩放比例（R04.AC-3） */
export const PET_SIZE_SCALE: Record<PetSize, number> = {
  small: 0.75,
  medium: 1,
  large: 1.3,
};

export const PET_BASE_SIZE = 160;

export interface PetSettings {
  size: PetSize;
  /** 应用内“降低动态效果”；与系统设置任一开启即生效（R04.AC-4） */
  reducedMotion: boolean;
  /** 外部应用全屏时仍显示宠物（R02.AC-8，默认关闭） */
  keepVisibleInFullscreen: boolean;
}

export const DEFAULT_PET_SETTINGS: PetSettings = {
  size: 'medium',
  reducedMotion: false,
  keepVisibleInFullscreen: false,
};

export function petWindowSize(size: PetSize): { width: number; height: number } {
  const side = Math.round(PET_BASE_SIZE * PET_SIZE_SCALE[size]);
  return { width: side, height: side };
}
