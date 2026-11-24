import { join } from 'node:path';
import { BrowserWindow, type WebContents } from 'electron';
import type { Point, Size } from './placement';

/** 窗口只比角色略大，不使用覆盖整屏的透明窗口（R02.AC-7） */
export const PET_WINDOW_SIZE: Size = { width: 160, height: 160 };

export function createPetWindow(position: Point): BrowserWindow {
  const win = new BrowserWindow({
    ...PET_WINDOW_SIZE,
    ...position,
    show: false,
    frame: false,
    transparent: true,
    backgroundColor: '#00000000',
    hasShadow: false,
    resizable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    // 平时不获取键盘焦点，点击宠物也不会把焦点从用户正在用的窗口抢走（R02.AC-6）
    focusable: false,
    alwaysOnTop: true,
    title: '桌面宠物',
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      spellcheck: false,
    },
  });

  // 外部全屏时的叠放策略在 M2 处理（R02.AC-8、D-04）；M1 使用普通置顶层级
  win.setAlwaysOnTop(true, 'floating');
  // 默认穿透；指针进入角色轮廓时由渲染层请求关闭穿透（TD §12.2）
  win.setIgnoreMouseEvents(true, { forward: true });

  hardenWebContents(win.webContents);
  win.webContents.on('render-process-gone', () => {
    if (!win.isDestroyed()) void loadPetPage(win);
  });
  win.once('ready-to-show', () => win.showInactive());

  if (process.env['PET_DEVTOOLS'] === '1') {
    win.webContents.openDevTools({ mode: 'detach' });
  }

  void loadPetPage(win);
  return win;
}

function loadPetPage(win: BrowserWindow): Promise<void> {
  const devServer = process.env['ELECTRON_RENDERER_URL'];
  return devServer
    ? win.loadURL(`${devServer}/pet.html`)
    : win.loadFile(join(__dirname, '../renderer/pet.html'));
}

/** 只加载本地受控页面：禁止跳转和新开窗口（TD §13.3） */
function hardenWebContents(contents: WebContents): void {
  contents.on('will-navigate', (event) => event.preventDefault());
  contents.setWindowOpenHandler(() => ({ action: 'deny' }));
}
