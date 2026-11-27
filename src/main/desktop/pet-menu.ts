// 宠物相关菜单项：右键菜单和托盘菜单共用，保证宠物窗口的功能都能从托盘完成（R21.AC-4）。

import type { MenuItemConstructorOptions } from 'electron';
import type { NestView } from '../../shared/contracts/nest-ipc';
import { PET_SIZE_LABELS, PET_SIZES } from '../../shared/contracts/pet-settings';
import type { AppPrefs } from '../application/app-prefs';
import type { PetHost } from './pet-host';
import type { PetSettingsService } from './pet-settings';

export function petSettingsMenuItems(settings: PetSettingsService): MenuItemConstructorOptions[] {
  const current = settings.value;
  return [
    {
      label: '尺寸',
      submenu: PET_SIZES.map((size) => ({
        label: PET_SIZE_LABELS[size],
        type: 'radio' as const,
        checked: current.size === size,
        click: () => settings.update({ size }),
      })),
    },
    {
      label: '降低动态效果',
      type: 'checkbox',
      checked: current.reducedMotion,
      click: () => settings.update({ reducedMotion: !settings.value.reducedMotion }),
    },
    {
      label: '全屏时保持显示',
      type: 'checkbox',
      checked: current.keepVisibleInFullscreen,
      click: () => settings.update({ keepVisibleInFullscreen: !settings.value.keepVisibleInFullscreen }),
    },
  ];
}

/** 菜单里打开其他窗口的入口，由组合根提供 */
export interface PetMenuActions {
  openNest(view?: NestView): void;
  openChat(): void;
  /** 专注（R09）：进行中时返回 true */
  focusActive(): boolean;
  startFocus(minutes: number): void;
  endFocus(): void;
}

/** 专注入口：托盘和右键菜单共用 */
export function focusMenuItem(actions: PetMenuActions): MenuItemConstructorOptions {
  return actions.focusActive()
    ? { label: '结束专注', click: () => actions.endFocus() }
    : { label: '开始专注 25 分钟', click: () => actions.startFocus(25) };
}

/** 安静模式（R01.AC-2、R08.AC-8）：提醒只进信箱，不弹气泡 */
export function quietModeMenuItem(prefs: AppPrefs): MenuItemConstructorOptions {
  return {
    label: '安静模式',
    type: 'checkbox',
    checked: prefs.value.quietMode,
    click: () => prefs.update({ quietMode: !prefs.value.quietMode }),
  };
}

/** 在宠物上右键弹出的菜单（R02.AC-5） */
export function petContextMenu(
  host: PetHost,
  settings: PetSettingsService,
  prefs: AppPrefs,
  actions: PetMenuActions,
): MenuItemConstructorOptions[] {
  return [
    { label: '对话', click: () => actions.openChat() },
    { label: '打开小窝', click: () => actions.openNest() },
    { label: '信箱', click: () => actions.openNest('inbox') },
    { label: '新建提醒', click: () => actions.openNest('reminders') },
    focusMenuItem(actions),
    { type: 'separator' },
    quietModeMenuItem(prefs),
    { label: '隐藏宠物', click: () => host.hide() },
    { label: '找回宠物', click: () => host.recall() },
    { type: 'separator' },
    ...petSettingsMenuItems(settings),
  ];
}
