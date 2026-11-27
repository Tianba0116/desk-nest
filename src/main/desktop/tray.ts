import { app, Menu, Tray } from 'electron';
import type { AppPrefs } from '../application/app-prefs';
import type { PetHost } from './pet-host';
import { focusMenuItem, petSettingsMenuItems, quietModeMenuItem, type PetMenuActions } from './pet-menu';
import type { PetSettingsService } from './pet-settings';
import type { StartupSetting } from './startup';
import { createTrayIcon } from './tray-icon';

export interface TrayDeps {
  host: PetHost;
  settings: PetSettingsService;
  prefs: AppPrefs;
  startup: StartupSetting;
  actions: PetMenuActions;
  /** 托盘“退出”：由组合根决定是否需要先确认（R01.AC-4） */
  quit: () => void;
}

/** 托盘菜单至少包含：显示/隐藏宠物、打开小窝、安静模式、真正退出（R01.AC-2） */
export function createPetTray({ host, settings, prefs, startup, actions, quit }: TrayDeps): Tray {
  const tray = new Tray(createTrayIcon());
  tray.setToolTip('桌面宠物');

  const refreshMenu = (): void => {
    tray.setContextMenu(
      Menu.buildFromTemplate([
        { label: '对话', click: () => actions.openChat() },
        { label: '打开小窝', click: () => actions.openNest() },
        { label: '信箱', click: () => actions.openNest('inbox') },
        focusMenuItem(actions),
        { label: '沙漏（专注）', click: () => actions.openNest('focus') },
        { label: '模型设置', click: () => actions.openNest('settings') },
        { type: 'separator' },
        { label: host.visible ? '隐藏宠物' : '显示宠物', click: () => host.toggle() },
        { label: '找回宠物', click: () => host.recall() },
        { type: 'separator' },
        quietModeMenuItem(prefs),
        {
          label: '安静时用系统通知提醒',
          type: 'checkbox',
          checked: prefs.value.notifyWhenQuiet,
          click: () => prefs.update({ notifyWhenQuiet: !prefs.value.notifyWhenQuiet }),
        },
        ...petSettingsMenuItems(settings),
        {
          label: startup.supported ? '开机启动' : '开机启动（仅安装后的版本可用）',
          type: 'checkbox',
          enabled: startup.supported,
          checked: startup.openAtLogin(),
          click: () => {
            startup.set(!startup.openAtLogin());
            refreshMenu();
          },
        },
        { type: 'separator' },
        { label: `版本 ${app.getVersion()}`, enabled: false },
        { label: '退出', click: quit },
      ]),
    );
  };

  refreshMenu();
  host.onVisibilityChange(refreshMenu);
  settings.onChange(refreshMenu);
  prefs.onChange(refreshMenu);
  startup.onChange(refreshMenu);
  tray.on('click', () => host.show());
  return tray;
}
