import { app, Menu, Tray } from 'electron';
import type { PetHost } from './pet-host';
import { createTrayIcon } from './tray-icon';

export function createPetTray(host: PetHost, quit: () => void): Tray {
  const tray = new Tray(createTrayIcon());
  tray.setToolTip('桌面宠物');

  const refreshMenu = (): void => {
    tray.setContextMenu(
      Menu.buildFromTemplate([
        { label: host.visible ? '隐藏宠物' : '显示宠物', click: () => host.toggle() },
        { label: '找回宠物', click: () => host.recall() },
        { type: 'separator' },
        { label: `版本 ${app.getVersion()}`, enabled: false },
        { label: '退出', click: quit },
      ]),
    );
  };

  refreshMenu();
  host.onVisibilityChange(refreshMenu);
  tray.on('click', () => host.show());
  return tray;
}
