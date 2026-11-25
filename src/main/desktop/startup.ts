// 开机启动（R01.AC-5）：默认关闭，由用户选择。开发版的 electron.exe 不能作为启动项，只有打包版支持。

import { app } from 'electron';

export interface StartupSetting {
  readonly supported: boolean;
  openAtLogin(): boolean;
  set(value: boolean): void;
  onChange(listener: () => void): () => void;
}

export function createStartupSetting(): StartupSetting {
  const listeners = new Set<() => void>();
  const supported = app.isPackaged && process.platform === 'win32';
  return {
    supported,
    openAtLogin: () => supported && app.getLoginItemSettings().openAtLogin,
    set(value) {
      if (!supported) return;
      app.setLoginItemSettings({ openAtLogin: value });
      for (const listener of listeners) listener();
    },
    onChange(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}
