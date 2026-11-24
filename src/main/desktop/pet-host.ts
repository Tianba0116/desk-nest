// 宠物窗口的生命周期：显示/隐藏、拖动、穿透切换、位置保存与恢复、显示器变化。

import { ipcMain, powerMonitor, screen, type BrowserWindow, type IpcMainEvent } from 'electron';
import { z } from 'zod';
import { PetIpc, type PetEvent } from '../../shared/contracts/pet-ipc';
import { PetDragController, type DragEndReason } from './pet-drag';
import { createPetWindow, PET_WINDOW_SIZE } from './pet-window';
import {
  centerOnPrimary,
  keepVisible,
  resolvePlacement,
  toSavedPlacement,
  type DisplayArea,
} from './placement';
import type { PlacementStore } from './placement-store';

const InteractiveSchema = z.boolean();

export class PetHost {
  private win: BrowserWindow | null = null;
  private drag: PetDragController | null = null;
  private interactive = false;
  private readonly visibilityListeners = new Set<() => void>();
  private readonly disposers: Array<() => void> = [];

  constructor(private readonly store: PlacementStore) {}

  start(): void {
    const position = resolvePlacement(this.store.load(), currentDisplays(), PET_WINDOW_SIZE);
    const win = createPetWindow(position);
    this.win = win;
    this.drag = new PetDragController(win, PET_WINDOW_SIZE, (reason) => this.onDragEnded(reason));

    win.on('show', () => this.notifyVisibility());
    win.on('hide', () => {
      this.drag?.end('system');
      this.setInteractive(false);
      this.notifyVisibility();
    });

    this.listenIpc(PetIpc.dragStart, () => this.drag?.start());
    this.listenIpc(PetIpc.dragEnd, () => this.drag?.end('pointer'));
    this.listenIpc(PetIpc.setInteractive, (_event, value: unknown) => {
      const parsed = InteractiveSchema.safeParse(value);
      if (parsed.success) this.setInteractive(parsed.data);
    });

    // 锁屏、睡眠时结束拖动，不会停在“被拎起”状态（R02.AC-3）
    this.listen(powerMonitor, 'lock-screen', () => this.drag?.end('system'));
    this.listen(powerMonitor, 'suspend', () => this.drag?.end('system'));

    // 显示器拔出、分辨率或任务栏变化后，把宠物移回可见区域（R03.AC-2）
    for (const name of ['display-added', 'display-removed', 'display-metrics-changed'] as const) {
      this.listen(screen, name, () => this.ensureVisible());
    }
  }

  get visible(): boolean {
    return !!this.win && !this.win.isDestroyed() && this.win.isVisible();
  }

  show(): void {
    if (!this.alive(this.win)) return;
    if (!this.win.isVisible()) this.win.showInactive();
  }

  hide(): void {
    if (this.alive(this.win)) this.win.hide();
  }

  toggle(): void {
    if (this.visible) this.hide();
    else this.show();
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
    const position = centerOnPrimary(currentDisplays(), PET_WINDOW_SIZE);
    this.win.setBounds({ ...position, ...PET_WINDOW_SIZE });
    this.savePlacement();
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
  }

  private onDragEnded(reason: DragEndReason): void {
    if (!this.alive(this.win)) return;
    // 允许拖到任何位置，但松手后整体留在某个显示器的可用区内，避免“丢失”宠物
    const position = keepVisible(this.win.getBounds(), currentDisplays());
    this.win.setBounds({ ...position, ...PET_WINDOW_SIZE });
    this.savePlacement();
    if (reason === 'system') this.send({ type: 'drag-cancelled' });
  }

  /** 显示器变化引起的移动不保存：原显示器接回后，下次启动仍回到用户放的位置 */
  private ensureVisible(): void {
    if (!this.alive(this.win) || this.drag?.active) return;
    const bounds = this.win.getBounds();
    const position = keepVisible(bounds, currentDisplays());
    if (position.x !== bounds.x || position.y !== bounds.y) {
      this.win.setBounds({ ...position, ...PET_WINDOW_SIZE });
    }
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

  private send(event: PetEvent): void {
    if (this.alive(this.win)) this.win.webContents.send(PetIpc.event, event);
  }

  private notifyVisibility(): void {
    for (const listener of this.visibilityListeners) listener();
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
