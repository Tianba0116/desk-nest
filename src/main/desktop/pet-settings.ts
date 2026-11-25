// 宠物设置：内存中的当前值 + 持久化 + 变更通知。
// M2 存 JSON 文件；M3 起改为 SQLite app_settings，只替换 PetSettingsPersistence。

import { z } from 'zod';
import { DEFAULT_PET_SETTINGS, PET_SIZES, type PetSettings } from '../../shared/contracts/pet-settings';
import type { AppSettings } from '../storage/app-settings';
import { readJsonFile, writeJsonFile } from '../storage/json-file';

export const PetSettingsSchema = z.object({
  size: z.enum(PET_SIZES).catch(DEFAULT_PET_SETTINGS.size),
  reducedMotion: z.boolean().catch(DEFAULT_PET_SETTINGS.reducedMotion),
  keepVisibleInFullscreen: z.boolean().catch(DEFAULT_PET_SETTINGS.keepVisibleInFullscreen),
});

export const PetSettingsPatchSchema = z
  .object({
    size: z.enum(PET_SIZES),
    reducedMotion: z.boolean(),
    keepVisibleInFullscreen: z.boolean(),
  })
  .partial()
  .strict();

export interface PetSettingsPersistence {
  load(): PetSettings | null;
  save(settings: PetSettings): void;
}

const SettingsFileSchema = z.object({ version: z.literal(1), settings: PetSettingsSchema });

export class PetSettingsFile implements PetSettingsPersistence {
  constructor(private readonly filePath: string) {}

  load(): PetSettings | null {
    return readJsonFile(this.filePath, SettingsFileSchema)?.settings ?? null;
  }

  save(settings: PetSettings): void {
    writeJsonFile(this.filePath, { version: 1, settings });
  }
}

export class PetSettingsService {
  private current: PetSettings;
  private readonly listeners = new Set<(next: PetSettings, previous: PetSettings) => void>();

  constructor(private readonly persistence: PetSettingsPersistence) {
    this.current = { ...DEFAULT_PET_SETTINGS, ...(persistence.load() ?? {}) };
  }

  get value(): PetSettings {
    return this.current;
  }

  update(patch: Partial<PetSettings>): PetSettings {
    const parsed = PetSettingsPatchSchema.parse(patch);
    const previous = this.current;
    const next = { ...previous, ...parsed };
    if (sameSettings(previous, next)) return previous;
    this.current = next;
    this.persistence.save(next);
    for (const listener of this.listeners) listener(next, previous);
    return next;
  }

  onChange(listener: (next: PetSettings, previous: PetSettings) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
}

function sameSettings(a: PetSettings, b: PetSettings): boolean {
  return (
    a.size === b.size &&
    a.reducedMotion === b.reducedMotion &&
    a.keepVisibleInFullscreen === b.keepVisibleInFullscreen
  );
}

/** M3 起外观设置存在 app_settings 的 pet.settings 键 */
export class AppPetSettings implements PetSettingsPersistence {
  static readonly key = 'pet.settings';

  constructor(private readonly settings: AppSettings) {}

  load(): PetSettings | null {
    return this.settings.get(AppPetSettings.key, PetSettingsSchema);
  }

  save(settings: PetSettings): void {
    try {
      this.settings.set(AppPetSettings.key, settings);
    } catch (error) {
      console.warn('[pet-settings] save failed:', error);
    }
  }
}
