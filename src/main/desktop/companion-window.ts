// 小窝窗口（TD §12.1 CompanionWindow）：普通可聚焦窗口，按需创建；关闭只隐藏，不退出（R01.AC-3）。
// 渲染层只能通过命名的命令和查询访问数据（TD §13.3），不能直接访问数据库或文件。

import { join } from 'node:path';
import { app, BrowserWindow, ipcMain, screen, type IpcMainInvokeEvent } from 'electron';
import { z } from 'zod';
import type { DataTopic } from '../../shared/contracts/command';
import {
  NestIpc,
  type ModelRequest,
  type ModelResponse,
  type NestView,
  type StartupState,
  type SystemRequest,
} from '../../shared/contracts/nest-ipc';
import type { CommandService } from '../application/commands';
import { QueryError, type QueryService } from '../application/queries';
import { hardenWebContents } from './web-contents';

const CommandArgs = z.tuple([z.string().max(100), z.unknown(), z.string().max(100)]);
const QueryArgs = z.tuple([z.string().max(100), z.unknown()]);
const SystemRequestSchema: z.ZodType<SystemRequest> = z.discriminatedUnion('action', [
  z.object({ action: z.literal('getStartup') }),
  z.object({ action: z.literal('setOpenAtLogin'), value: z.boolean() }),
  z.object({ action: z.literal('dismissStartupPrompt') }),
]);

/** 小窝可以请求的系统操作，由组合根实现 */
export type SystemActions = (request: SystemRequest) => StartupState;
export type ModelActions = (request: ModelRequest) => Promise<ModelResponse>;

const ModelInputSchema = z.object({
  presetId: z.string().max(50),
  adapterId: z.string().max(50),
  baseUrl: z.string().max(500),
  model: z.string().max(200),
  apiKey: z.string().max(500).optional(),
  consent: z.boolean(),
});
const ModelRequestSchema: z.ZodType<ModelRequest> = z.discriminatedUnion('action', [
  z.object({ action: z.literal('get') }),
  z.object({ action: z.literal('save'), input: ModelInputSchema }),
  z.object({ action: z.literal('test'), input: ModelInputSchema }),
  z.object({ action: z.literal('setStrategy'), strategy: z.enum(['two_phase', 'stream_retract']) }),
]);

const DEFAULT_SIZE = { width: 820, height: 600 };

export class CompanionHost {
  private win: BrowserWindow | null = null;
  private quitting = false;
  private pendingView: NestView | null = null;
  /** 首帧绘制前调用 show() 在 Windows 上可能无效，等 ready-to-show 再显示 */
  private ready = false;
  private showWhenReady = false;
  private readonly disposers: Array<() => void> = [];

  constructor(
    private readonly commands: CommandService,
    private readonly queries: QueryService,
    private readonly system: SystemActions,
    private readonly model: ModelActions,
  ) {}

  start(): void {
    const onBeforeQuit = (): void => {
      this.quitting = true;
    };
    app.on('before-quit', onBeforeQuit);
    this.disposers.push(() => app.removeListener('before-quit', onBeforeQuit));

    this.handle(NestIpc.command, (_event, ...args) => {
      const [name, input, operationId] = CommandArgs.parse(args);
      // 来源由主进程决定，不信任渲染层自报
      return this.commands.run(name, input, { operationId, origin: 'ui' });
    });
    this.handle(NestIpc.query, (_event, ...args) => {
      const [name, input] = QueryArgs.parse(args);
      try {
        return this.queries.run(name, input);
      } catch (error) {
        if (error instanceof QueryError) throw new Error(`${error.code}: ${error.message}`);
        console.error(`[query] ${name} failed:`, error);
        throw new Error('INTERNAL');
      }
    });

    this.handle(NestIpc.system, (_event, request) => this.system(SystemRequestSchema.parse(request)));
    this.handle(NestIpc.model, (_event, request) => this.model(ModelRequestSchema.parse(request)));

    this.disposers.push(this.commands.onCommitted((topics) => this.broadcast(topics)));
  }

  /** 打开小窝并切到指定页面 */
  open(view?: NestView): void {
    const win = this.ensureWindow();
    if (view) {
      if (win.webContents.isLoading()) this.pendingView = view;
      else win.webContents.send(NestIpc.navigate, view);
    }
    if (!this.ready) {
      this.showWhenReady = true;
      return;
    }
    if (win.isMinimized()) win.restore();
    win.show();
    win.focus();
  }

  /** 数据变化后通知小窝重新查询（例如其他入口修改了数据） */
  broadcast(topics: readonly DataTopic[]): void {
    if (this.win && !this.win.isDestroyed()) this.win.webContents.send(NestIpc.changed, topics);
  }

  dispose(): void {
    for (const dispose of this.disposers.splice(0)) dispose();
  }

  private ensureWindow(): BrowserWindow {
    if (this.win && !this.win.isDestroyed()) return this.win;
    const area = screen.getDisplayNearestPoint(screen.getCursorScreenPoint()).workArea;
    const win = new BrowserWindow({
      ...DEFAULT_SIZE,
      x: Math.round(area.x + (area.width - DEFAULT_SIZE.width) / 2),
      y: Math.round(area.y + (area.height - DEFAULT_SIZE.height) / 2),
      minWidth: 560,
      minHeight: 420,
      show: false,
      title: '小窝',
      backgroundColor: '#fbf7f2',
      autoHideMenuBar: true,
      webPreferences: {
        preload: join(__dirname, '../preload/companion.js'),
        sandbox: true,
        contextIsolation: true,
        nodeIntegration: false,
        spellcheck: false,
      },
    });
    win.setMenu(null);
    this.ready = false;
    win.once('ready-to-show', () => {
      this.ready = true;
      if (this.showWhenReady) {
        this.showWhenReady = false;
        win.show();
        win.focus();
      }
    });
    hardenWebContents(win.webContents);

    // 关闭只隐藏；托盘“退出”才结束进程
    win.on('close', (event) => {
      if (this.quitting) return;
      event.preventDefault();
      win.hide();
    });
    win.webContents.on('did-finish-load', () => {
      if (this.pendingView) win.webContents.send(NestIpc.navigate, this.pendingView);
      this.pendingView = null;
    });
    win.webContents.on('render-process-gone', () => {
      if (!win.isDestroyed()) void loadPage(win);
    });
    if (process.env['PET_DEVTOOLS'] === '1') win.webContents.openDevTools({ mode: 'detach' });

    void loadPage(win);
    this.win = win;
    return win;
  }

  /** 只接受来自小窝窗口自身的调用 */
  private handle(channel: string, handler: (event: IpcMainInvokeEvent, ...args: unknown[]) => unknown): void {
    ipcMain.handle(channel, (event, ...args) => {
      if (!this.win || this.win.isDestroyed() || event.sender !== this.win.webContents) {
        throw new Error('NOT_ALLOWED');
      }
      return handler(event, ...args);
    });
    this.disposers.push(() => ipcMain.removeHandler(channel));
  }
}

function loadPage(win: BrowserWindow): Promise<void> {
  const devServer = process.env['ELECTRON_RENDERER_URL'];
  return devServer ? win.loadURL(`${devServer}/home.html`) : win.loadFile(join(__dirname, '../renderer/home.html'));
}
