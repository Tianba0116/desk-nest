// app_settings：窗口位置、外观等本地设置（TD §5.2）。
// 这些是界面状态而非业务数据，直接写入，不经过命令收据。

import { existsSync, renameSync } from 'node:fs';
import type { z } from 'zod';
import type { Database } from './database';

export class AppSettings {
  constructor(
    private readonly db: Database,
    private readonly now: () => number = Date.now,
  ) {}

  get<S extends z.ZodType>(key: string, schema: S): z.output<S> | null {
    const row = this.db.get<{ value_json: string }>('SELECT value_json FROM app_settings WHERE key = ?', key);
    if (!row) return null;
    try {
      const parsed = schema.safeParse(JSON.parse(row.value_json));
      return parsed.success ? parsed.data : null;
    } catch {
      return null;
    }
  }

  has(key: string): boolean {
    return !!this.db.get('SELECT 1 FROM app_settings WHERE key = ?', key);
  }

  set(key: string, value: unknown): void {
    this.db.run(
      `INSERT INTO app_settings (key, value_json, schema_version, updated_at) VALUES (?, ?, 1, ?)
       ON CONFLICT (key) DO UPDATE SET value_json = excluded.value_json, updated_at = excluded.updated_at`,
      key,
      JSON.stringify(value),
      this.now(),
    );
  }

  delete(key: string): void {
    this.db.run('DELETE FROM app_settings WHERE key = ?', key);
  }
}

/**
 * M1/M2 把位置和外观存在 JSON 文件里。首次使用数据库时导入一次，
 * 然后把旧文件改名为 *.imported，避免以后误读。
 */
export function importLegacyJson<T>(
  settings: AppSettings,
  key: string,
  filePath: string,
  read: (filePath: string) => T | null,
): void {
  if (settings.has(key) || !existsSync(filePath)) return;
  const value = read(filePath);
  if (value !== null) settings.set(key, value);
  try {
    renameSync(filePath, `${filePath}.imported`);
  } catch (error) {
    console.warn(`[settings] rename legacy file failed: ${filePath}`, error);
  }
}
