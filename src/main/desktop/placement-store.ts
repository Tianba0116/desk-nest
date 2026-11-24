// 宠物位置的持久化。M1 还没有数据库（M3 引入 SQLite），先存一个小 JSON 文件。
// 写入采用“临时文件 + 重命名”，强制关闭时不会留下半个文件。

import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { z } from 'zod';
import type { SavedPlacement } from './placement';

const RectSchema = z.object({
  x: z.number().finite(),
  y: z.number().finite(),
  width: z.number().finite(),
  height: z.number().finite(),
});

const PlacementFileSchema = z.object({
  version: z.literal(1),
  placement: z.object({
    displayId: z.number().finite(),
    displayBounds: RectSchema,
    relX: z.number().min(0).max(1),
    relY: z.number().min(0).max(1),
  }),
});

export class PlacementStore {
  constructor(private readonly filePath: string) {}

  /** 文件不存在或内容无效时返回 null，调用方使用默认位置 */
  load(): SavedPlacement | null {
    let raw: string;
    try {
      raw = readFileSync(this.filePath, 'utf8');
    } catch {
      return null;
    }
    try {
      const parsed = PlacementFileSchema.safeParse(JSON.parse(raw));
      return parsed.success ? parsed.data.placement : null;
    } catch {
      return null;
    }
  }

  save(placement: SavedPlacement): void {
    const tempPath = `${this.filePath}.tmp`;
    try {
      mkdirSync(dirname(this.filePath), { recursive: true });
      writeFileSync(tempPath, JSON.stringify({ version: 1, placement }, null, 2), 'utf8');
      renameSync(tempPath, this.filePath);
    } catch (error) {
      // 位置保存失败不影响使用，下次启动回到默认位置
      console.warn('[placement] save failed:', error);
    }
  }
}
