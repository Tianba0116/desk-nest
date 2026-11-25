// 宠物窗口的生命周期：显示/隐藏、拖动、穿透切换、位置保存与恢复、显示器变化、
// 尺寸与外观设置、外部全屏时的自动隐藏。

import {
  ipcMain,
  Menu,
  powerMonitor,
  screen,
  type BrowserWindow,
  type IpcMainEvent,
  type MenuItemConstructorOptions,
  type Rectangle,
} from 'electron';
import { z } from 'zod';
import { PetIpc, type PetEvent } from '../../shared/contracts/pet-ipc';
import { petWindowSize, type PetSettings } from '../../shared/contracts/pet-settings';
import { PetDragController, type DragEndReason } from './pet-drag';
import type { PetSettingsService } from './pet-settings';
import { createPetWindow } from './pet-window';
import {
  centerOnPrimary,
  keepVisible,
  resizeAnchored,
  resolvePlacement,
  snapToEdges,
  toSavedPlacement,
  type DisplayArea,
  type Size,
} from './placement';
import type { PlacementPersistence } from './placement-store';

const InteractiveSchema = z.boolean();

/** 松手时离工作区边缘多近就贴边（R02.AC-4） */
export const EDGE_SNAP_DIP = 24;

export class PetHost {
  private win: BrowserWindow | null = null;
  private drag: PetDragController | null = null;
  private interactive = false;
  private size: Size;
  /** 用户希望宠物显示（托盘、右键菜单的显示/隐藏） */
  private userVisible = true;
  /** 系统原因（外部全屏）要求暂时隐藏；不改变 userVisible（TD §12.4） */
  private suppressed = false;
  /** 全屏期间用户手动要求显示：本次全屏结束前不再自动隐藏 */
  private suppressionOverridden = false;
  private contextMenu: (() => MenuItemConstructorOptions[]) | null = null;
  private touchHandler: (() => void) | null = null;
  private unread = 0;
  private readonly visibilityListeners = new Set<() => void>();
  private readonly moveListeners = new Set<() => void>();
  private readonly disposers: Array<() => void> = [];

  constructor(
    private readonly store: PlacementPersistence,
    private readonly settings: PetSettingsService,
  ) {
    this.size = petWindowSize(settings.value.size);
  }

  start(): void {
    const position = resolvePlacement(this.store.load(), currentDisplays(), this.size);
    const win = createPetWindow({ ...position, ...this.size });
    this.win = win;
    this.drag = new PetDragController(win, () => this.size, (reason) => this.onDragEnded(reason));

    win.on('show', () => this.notifyVisibility());
    win.on('hide', () => {
      this.drag?.end('system');
      this.setInteractive(false);
      this.notifyVisibility();
    });

    this.listenIpc(PetIpc.ready, () => {
      this.sendAppearance();
      this.send({ type: 'inbox', unread: this.unread });
    });
    this.listenIpc(PetIpc.dragStart, () => this.drag?.start());
    this.listenIpc(PetIpc.dragEnd, () => this.drag?.end('pointer'));
    this.listenIpc(PetIpc.setInteractive, (_event, value: unknown) => {
      const parsed = InteractiveSchema.safeParse(value);
      if (parsed.success) this.setInteractive(parsed.data);
    });
    this.listenIpc(PetIpc.openMenu, () => this.popupContextMenu());
    this.listenIpc(PetIpc.touched, () => this.touchHandler?.());

    // 锁屏、睡眠时结束拖动，不会停在“被拎起”状态（R02.AC-3）
    this.listen(powerMonitor, 'lock-screen', () => this.drag?.end('system'));
    this.listen(powerMonitor, 'suspend', () => this.drag?.end('system'));

    // 显示器拔出、分辨率或任务栏变化后，把宠物移回可见区域（R03.AC-2）
    for (const name of ['display-added', 'display-removed', 'display-metrics-changed'] as const) {
      this.listen(screen, name, () => this.ensureVisible());
    }

    this.disposers.push(this.settings.onChange((next, previous) => this.applySettings(next, previous)));
  }

  get visible(): boolean {
    return this.alive(this.win) && this.win.isVisible();
  }

  /** 单击宠物时做什么由组合根决定（M5 起：打开或收起对话） */
  onTouched(handler: () => void): void {
    this.touchHandler = handler;
  }

  /** 右键菜单的内容由组合根提供，宿主只负责弹出 */
  setContextMenu(build: () => MenuItemConstructorOptions[]): void {
    this.contextMenu = build;
  }

  show(): void {
    this.userVisible = true;
    if (this.suppressed) this.suppressionOverridden = true;
    this.applyVisibility();
  }

  hide(): void {
    this.userVisible = false;
    this.suppressionOverridden = false;
    this.applyVisibility();
  }

  toggle(): void {
    if (this.visible) this.hide();
    else this.show();
  }

  /** 外部全屏等系统原因的临时隐藏；用户的显示/隐藏选择保持不变 */
  setSuppressed(suppressed: boolean): void {
    if (suppressed === this.suppressed) return;
    this.suppressed = suppressed;
    if (!suppressed) this.suppressionOverridden = false;
    this.applyVisibility();
  }

  /** 宠物可见时的窗口位置，供气泡定位 */
  bounds(): Rectangle | null {
    return this.visible && this.win ? this.win.getBounds() : null;
  }

  /** 信箱未读数（宠物显示未读标记） */
  setUnread(count: number): void {
    if (count === this.unread) return;
    this.unread = count;
    this.send({ type: 'inbox', unread: count });
  }

  /** 宠物位置变化（拖动结束、尺寸变化、找回、显示器变化） */
  onMoved(listener: () => void): () => void {
    this.moveListeners.add(listener);
    return () => this.moveListeners.delete(listener);
  }

  nativeHandle(): Buffer | null {
    return this.alive(this.win) ? this.win.getNativeWindowHandle() : null;
  }

  /** 再次启动应用时：显示宠物并打个招呼 */
  summon(): void {
    this.show();
    this.send({ type: 'summoned' });
  }

  /** 托盘“找回宠物”：移到主屏中心（R03.AC-4） */
  recall(): void {
    if (!this.alive(this.win)) return;
    this.drag?.end('system');
    const position = centerOnPrimary(currentDisplays(), this.size);
    this.win.setBounds({ ...position, ...this.size });
    this.savePlacement();
    this.notifyMoved();
    this.summon();
  }

  onVisibilityChange(listener: () => void): () => void {
    this.visibilityListeners.add(listener);
    return () => this.visibilityListeners.delete(listener);
  }

  dispose(): void {
    this.drag?.end('system');
    for (const dispose of this.disposers.splice(0)) dispose();
    this.visibilityListeners.clear();
    this.moveListeners.clear();
  }

  private applyVisibility(): void {
    if (!this.alive(this.win)) return;
    const shouldShow = this.userVisible && (!this.suppressed || this.suppressionOverridden);
    if (shouldShow && !this.win.isVisible()) this.win.showInactive();
    else if (!shouldShow && this.win.isVisible()) this.win.hide();
  }

  private applySettings(next: PetSettings, previous: PetSettings): void {
    if (next.size !== previous.size) this.resize(petWindowSize(next.size));
    if (next.reducedMotion !== previous.reducedMotion) this.sendAppearance();
  }

  /** 尺寸变化：底部中点不动，留在可见区域，保存新位置（R04.AC-3） */
  private resize(size: Size): void {
    this.size = size;
    if (!this.alive(this.win)) return;
    this.drag?.end('system');
    const position = resizeAnchored(this.win.getBounds(), size, currentDisplays());
    this.win.setBounds({ ...position, ...size });
    this.savePlacement();
    this.notifyMoved();
  }

  private onDragEnded(reason: DragEndReason): void {
    if (!this.alive(this.win)) return;
    // 允许拖到任何位置，但松手后整体留在某个显示器的可用区内；靠近边缘时贴边
    const bounds = { ...this.win.getBounds(), ...this.size };
    const position =
      reason === 'pointer' ? snapToEdges(bounds, currentDisplays(), EDGE_SNAP_DIP) : keepVisible(bounds, currentDisplays());
    this.win.setBounds({ ...position, ...this.size });
    this.savePlacement();
    this.notifyMoved();
    if (reason === 'system') this.send({ type: 'drag-cancelled' });
  }

  /** 显示器变化引起的移动不保存：原显示器接回后，下次启动仍回到用户放的位置 */
  private ensureVisible(): void {
    if (!this.alive(this.win) || this.drag?.active) return;
    const bounds = this.win.getBounds();
    const position = keepVisible(bounds, currentDisplays());
    if (position.x !== bounds.x || position.y !== bounds.y) {
      this.win.setBounds({ ...position, ...this.size });
      this.notifyMoved();
    }
  }

  private popupContextMenu(): void {
    if (!this.alive(this.win) || !this.contextMenu || this.drag?.active) return;
    const win = this.win;
    Menu.buildFromTemplate(this.contextMenu()).popup({
      window: win,
      // 菜单关闭后指针可能已离开角色，恢复穿透，由渲染层在下一次移动时重新判断
      callback: () => this.setInteractive(false),
    });
  }

  private savePlacement(): void {
    if (!this.alive(this.win)) return;
    const placement = toSavedPlacement(this.win.getBounds(), currentDisplays());
    if (placement) this.store.save(placement);
  }

  private setInteractive(interactive: boolean): void {
    if (!this.alive(this.win)) return;
    // 拖动过程中始终接收鼠标，避免松手事件被穿透到下层窗口
    const next = interactive || !!this.drag?.active;
    if (next === this.interactive) return;
    this.interactive = next;
    if (next) this.win.setIgnoreMouseEvents(false);
    else this.win.setIgnoreMouseEvents(true, { forward: true });
  }

  private sendAppearance(): void {
    this.send({ type: 'appearance', reducedMotion: this.settings.value.reducedMotion });
  }

  private send(event: PetEvent): void {
    if (this.alive(this.win)) this.win.webContents.send(PetIpc.event, event);
  }

  private notifyVisibility(): void {
    for (const listener of this.visibilityListeners) listener();
  }

  private notifyMoved(): void {
    for (const listener of this.moveListeners) listener();
  }

  /** 只接受来自宠物窗口自身的消息 */
  private listenIpc(channel: string, handler: (event: IpcMainEvent, ...args: unknown[]) => void): void {
    const wrapped = (event: IpcMainEvent, ...args: unknown[]): void => {
      if (!this.alive(this.win) || event.sender !== this.win.webContents) return;
      handler(event, ...args);
    };
    ipcMain.on(channel, wrapped);
    this.disposers.push(() => ipcMain.removeListener(channel, wrapped));
  }

  private listen<E extends string>(
    emitter: { on(event: E, listener: () => void): unknown; removeListener(event: E, listener: () => void): unknown },
    event: E,
    listener: () => void,
  ): void {
    emitter.on(event, listener);
    this.disposers.push(() => emitter.removeListener(event, listener));
  }

  private alive(win: BrowserWindow | null): win is BrowserWindow {
    return !!win && !win.isDestroyed();
  }
}

function currentDisplays(): DisplayArea[] {
  const primaryId = screen.getPrimaryDisplay().id;
  return screen.getAllDisplays().map((display) => ({
    id: display.id,
    bounds: display.bounds,
    workArea: display.workArea,
    primary: display.id === primaryId,
  }));
}
