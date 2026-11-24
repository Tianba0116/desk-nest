import { join } from 'node:path';
import { app, type Tray } from 'electron';
import { PetHost } from './desktop/pet-host';
import { PlacementStore } from './desktop/placement-store';
import { createPetTray } from './desktop/tray';

const APP_USER_MODEL_ID = 'dev.desktoppet.app';

// 单实例：再次启动时唤出已有实例（R01.AC-1）
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  let host: PetHost | null = null;
  // 保持引用，避免托盘图标被回收
  let tray: Tray | null = null;

  app.setAppUserModelId(APP_USER_MODEL_ID);

  app.on('second-instance', () => host?.summon());

  // 常驻托盘：窗口隐藏或关闭都不退出，只有托盘“退出”才结束进程（R01.AC-3）
  app.on('window-all-closed', () => {});

  app.on('before-quit', () => host?.dispose());

  void app.whenReady().then(() => {
    const store = new PlacementStore(join(app.getPath('userData'), 'pet-placement.json'));
    host = new PetHost(store);
    host.start();
    tray = createPetTray(host, () => app.quit());
  });

  app.on('will-quit', () => {
    tray?.destroy();
    tray = null;
  });
}
