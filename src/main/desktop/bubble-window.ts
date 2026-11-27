// 宠物旁的提醒气泡（TD §12.1 惰性创建的 BubbleWindow）：不抢焦点、不在任务栏显示。
// 关闭气泡只是收起，不改变信箱的已读状态（R15.AC-3）。

import { join } from 'node:path';
import { BrowserWindow, ipcMain, screen, type IpcMainEvent, type Rectangle } from 'electron';
import { z } from 'zod';
import { BUBBLE_COMMANDS, BubbleIpc } from '../../shared/contracts/bubble-ipc';
import type { BubbleItem } from '../../shared/contracts/reminders';
import type { CommandService } from '../application/commands';
import type { BubbleChannel } from '../application/presenter';
import { hardenWebContents } from './web-contents';

const WIDTH = 300;
const MIN_HEIGHT = 96;
const MAX_HEIGHT = 420;
const GAP = 4;

const CommandArgs = z.tuple([z.enum(BUBBLE_COMMANDS), z.unknown(), z.string().max(100)]);
const IdsSchema = z.array(z.string().max(100)).max(50);

export interface BubbleHooks {
  /** 宠物窗口当前位置；宠物不可见时返回 null */
  anchor(): Rectangle | null;
  onShown(inboxIds: string[]): void;
  openInbox(): void;
  openFollowUp(inboxId: string): void;
}

export class BubbleHost implements BubbleChannel {
  private win: BrowserWindow | null = null;
  private ready = false;
  private items: BubbleItem[] = [];
  private height = 160;
  private readonly disposers: Array<() => void> = [];

  constructor(
    private readonly commands: CommandService,
    private readonly hooks: BubbleHooks,
  ) {}

  get visibleIds(): readonly string[] {
    return this.win && !this.win.isDestroyed() && this.win.isVisible() ? this.items.map((i) => i.inboxId) : [];
  }

  start(): void {
    this.on(BubbleIpc.shown, (_event, value) => {
      const ids = IdsSchema.safeParse(value);
      if (ids.success) this.hooks.onShown(ids.data);
    });
    this.on(BubbleIpc.resize, (_event, value) => {
      const height = z.number().finite().safeParse(value);
      if (!height.success) return;
      this.height = Math.round(Math.min(MAX_HEIGHT, Math.max(MIN_HEIGHT, height.data)));
      this.reposition();
    });
    this.on(BubbleIpc.close, () => this.hide());
    this.on(BubbleIpc.openInbox, () => {
      this.hide();
      this.hooks.openInbox();
    });
    this.on(BubbleIpc.openFollowUp, (_event, inboxId) => {
      if (typeof inboxId !== 'string' || inboxId.length > 100) return;
      this.hide();
      this.hooks.openFollowUp(inboxId);
    });
    const handler = (event: Electron.IpcMainInvokeEvent, ...args: unknown[]): unknown => {
      if (!this.isSender(event.sender)) throw new Error('NOT_ALLOWED');
      const [name, input, operationId] = CommandArgs.parse(args);
      return this.commands.run(name, input, { operationId, origin: 'ui' });
    };
    ipcMain.handle(BubbleIpc.command, handler);
    this.disposers.push(() => ipcMain.removeHandler(BubbleIpc.command));
  }

  show(items: BubbleItem[]): void {
    this.items = items;
    if (items.length === 0) {
      this.hide();
      return;
    }
    const win = this.ensureWindow();
    if (!this.ready) return; // ready-to-show 后再发送和显示
    win.webContents.send(BubbleIpc.items, items);
    this.reposition();
    if (!win.isVisible()) win.showInactive();
  }

  hide(): void {
    if (this.win && !this.win.isDestroyed()) this.win.hide();
  }

  /** 宠物移动后跟随 */
  reposition(): void {
    if (!this.win || this.win.isDestroyed()) return;
    const anchor = this.hooks.anchor();
    if (!anchor) {
      this.hide();
      return;
    }
    this.win.setBounds(placeBubble(anchor, { width: WIDTH, height: this.height }));
  }

  dispose(): void {
    for (const dispose of this.disposers.splice(0)) dispose();
    if (this.win && !this.win.isDestroyed()) this.win.destroy();
  }

  private ensureWindow(): BrowserWindow {
    if (this.win && !this.win.isDestroyed()) return this.win;
    this.ready = false;
    const win = new BrowserWindow({
      width: WIDTH,
      height: this.height,
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
      // 不抢用户正在用的窗口的焦点（R02.AC-6）；按钮仍可点击
      focusable: false,
      alwaysOnTop: true,
      title: '提醒',
      webPreferences: {
        preload: join(__dirname, '../preload/bubble.js'),
        sandbox: true,
        contextIsolation: true,
        nodeIntegration: false,
        spellcheck: false,
      },
    });
    win.setAlwaysOnTop(true, 'floating');
    hardenWebContents(win.webContents);
    win.once('ready-to-show', () => {
      this.ready = true;
      this.show(this.items);
    });
    const devServer = process.env['ELECTRON_RENDERER_URL'];
    void (devServer ? win.loadURL(`${devServer}/bubble.html`) : win.loadFile(join(__dirname, '../renderer/bubble.html')));
    this.win = win;
    return win;
  }

  private isSender(sender: Electron.WebContents): boolean {
    return !!this.win && !this.win.isDestroyed() && sender === this.win.webContents;
  }

  private on(channel: string, handler: (event: IpcMainEvent, ...args: unknown[]) => void): void {
    const wrapped = (event: IpcMainEvent, ...args: unknown[]): void => {
      if (this.isSender(event.sender)) handler(event, ...args);
    };
    ipcMain.on(channel, wrapped);
    this.disposers.push(() => ipcMain.removeListener(channel, wrapped));
  }
}

/** 优先放在宠物上方，水平居中；上方放不下时放到下方；整体留在工作区内 */
export function placeBubble(anchor: Rectangle, size: { width: number; height: number }): Rectangle {
  const area = screen.getDisplayMatching(anchor).workArea;
  let x = Math.round(anchor.x + anchor.width / 2 - size.width / 2);
  let y = anchor.y - size.height - GAP + Math.round(anchor.height * 0.2);
  if (y < area.y) y = anchor.y + anchor.height + GAP;
  x = Math.max(area.x, Math.min(x, area.x + area.width - size.width));
  y = Math.max(area.y, Math.min(y, area.y + area.height - size.height));
  return { x, y, ...size };
}
