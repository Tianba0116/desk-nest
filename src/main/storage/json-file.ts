// M3 引入 SQLite 之前的小型配置文件读写。
// 写入采用“临时文件 + 重命名”，强制关闭时不会留下半个文件。

import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import type { z } from 'zod';

/** 文件不存在、不是 JSON 或不符合 schema 时返回 null，调用方使用默认值 */
export function readJsonFile<S extends z.ZodType>(filePath: string, schema: S): z.output<S> | null {
  let raw: string;
  try {
    raw = readFileSync(filePath, 'utf8');
  } catch {
    return null;
  }
  try {
    const parsed = schema.safeParse(JSON.parse(raw));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

/** 失败时只打印警告：这些文件只保存位置和外观，丢失后回到默认值 */
export function writeJsonFile(filePath: string, value: unknown): boolean {
  const tempPath = `${filePath}.tmp`;
  try {
    mkdirSync(dirname(filePath), { recursive: true });
    writeFileSync(tempPath, JSON.stringify(value, null, 2), 'utf8');
    renameSync(tempPath, filePath);
    return true;
  } catch (error) {
    console.warn(`[json-file] save failed: ${filePath}`, error);
    return false;
  }
}
