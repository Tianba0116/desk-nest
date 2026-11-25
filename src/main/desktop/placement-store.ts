// 宠物位置的持久化。M1 还没有数据库（M3 引入 SQLite），先存一个小 JSON 文件。

import { z } from 'zod';
import type { AppSettings } from '../storage/app-settings';
import { readJsonFile, writeJsonFile } from '../storage/json-file';
import type { SavedPlacement } from './placement';

const RectSchema = z.object({
  x: z.number().finite(),
  y: z.number().finite(),
  width: z.number().finite(),
  height: z.number().finite(),
});

export const SavedPlacementSchema = z.object({
  displayId: z.number().finite(),
  displayBounds: RectSchema,
  relX: z.number().min(0).max(1),
  relY: z.number().min(0).max(1),
});

const PlacementFileSchema = z.object({
  version: z.literal(1),
  placement: SavedPlacementSchema,
});

export interface PlacementPersistence {
  load(): SavedPlacement | null;
  save(placement: SavedPlacement): void;
}

export class PlacementStore implements PlacementPersistence {
  constructor(private readonly filePath: string) {}

  /** 文件不存在或内容无效时返回 null，调用方使用默认位置 */
  load(): SavedPlacement | null {
    return readJsonFile(this.filePath, PlacementFileSchema)?.placement ?? null;
  }

  /** 位置保存失败不影响使用，下次启动回到默认位置 */
  save(placement: SavedPlacement): void {
    writeJsonFile(this.filePath, { version: 1, placement });
  }
}

/** M3 起位置存在 app_settings 的 pet.placement 键 */
export class SettingsPlacementStore implements PlacementPersistence {
  static readonly key = 'pet.placement';

  constructor(private readonly settings: AppSettings) {}

  load(): SavedPlacement | null {
    return this.settings.get(SettingsPlacementStore.key, SavedPlacementSchema);
  }

  save(placement: SavedPlacement): void {
    try {
      this.settings.set(SettingsPlacementStore.key, placement);
    } catch (error) {
      console.warn('[placement] save failed:', error);
    }
  }
}
