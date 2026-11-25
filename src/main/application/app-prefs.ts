// 应用级偏好：安静模式、安静时是否用系统通知、开机启动提示是否已关闭。
// 存在 app_settings；不依赖 Electron。

import { z } from 'zod';
import type { AppSettings } from '../storage/app-settings';

const PrefsSchema = z.object({
  quietMode: z.boolean().catch(false),
  /** 安静、隐藏或全屏时，提醒是否另发系统通知（R08.AC-8；默认关闭，D-13 暂定） */
  notifyWhenQuiet: z.boolean().catch(false),
  /** 首次创建提醒时的开机启动提示，用户选了“不再提示”（R01.AC-5） */
  startupPromptDismissed: z.boolean().catch(false),
});

export type AppPrefsValue = z.output<typeof PrefsSchema>;

const DEFAULTS: AppPrefsValue = { quietMode: false, notifyWhenQuiet: false, startupPromptDismissed: false };
const KEY = 'app.prefs';

export class AppPrefs {
  private current: AppPrefsValue;
  private readonly listeners = new Set<(next: AppPrefsValue, previous: AppPrefsValue) => void>();

  constructor(private readonly settings: AppSettings) {
    this.current = { ...DEFAULTS, ...(settings.get(KEY, PrefsSchema) ?? {}) };
  }

  get value(): AppPrefsValue {
    return this.current;
  }

  update(patch: Partial<AppPrefsValue>): void {
    const previous = this.current;
    const next = { ...previous, ...PrefsSchema.partial().parse(patch) };
    if (JSON.stringify(next) === JSON.stringify(previous)) return;
    this.current = next;
    this.settings.set(KEY, next);
    for (const listener of this.listeners) listener(next, previous);
  }

  onChange(listener: (next: AppPrefsValue, previous: AppPrefsValue) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
}
