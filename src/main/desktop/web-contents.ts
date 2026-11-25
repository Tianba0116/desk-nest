import type { WebContents } from 'electron';

/** 只加载本地受控页面：禁止跳转和新开窗口（TD §13.3） */
export function hardenWebContents(contents: WebContents): void {
  contents.on('will-navigate', (event) => event.preventDefault());
  contents.setWindowOpenHandler(() => ({ action: 'deny' }));
}
