// 对话窗口（TD §12.1 CompanionWindow 的紧凑对话视图，独立窗口实现）。
// 单击宠物打开或收起（R02.AC-2）；只在用户打开时获得焦点（R02.AC-6）。

import { join } from 'node:path';
import { app, BrowserWindow, ipcMain, net, screen, type IpcMainEvent, type IpcMainInvokeEvent, type Rectangle } from 'electron';
import { z } from 'zod';
import {
  CHAT_MESSAGE_MAX,
  ChatIpc,
  type ChatActionRequest,
  type ChatEvent,
  type ChatHistory,
  type ChatStatus,
  type NestTarget,
} from '../../shared/contracts/chat';
import type { CommandResult } from '../../shared/contracts/command';
import type { CommandService } from '../application/commands';
import type { Database } from '../storage/database';
import { actionCards, confirmDraft, dismissDraft, undoAction } from '../conversation/actions';
import { chatHistory } from '../conversation/conversation-store';
import type { FetchLike } from '../conversation/model-adapter';
import type { ModelSettings } from '../conversation/model-settings';
import { ConversationRunner } from '../conversation/runner';
import type { Clock } from '../application/clock';
import { hardenWebContents } from './web-contents';

const SIZE = { width: 380, height: 540 };
const SendArgs = z.tuple([z.string().max(CHAT_MESSAGE_MAX + 100), z.string().min(8).max(100)]);
const RetryArgs = z.tuple([z.string().max(100), z.string().min(8).max(100)]);
const Id = z.string().min(1).max(100);
const ActionArgs = z.tuple([
  z.discriminatedUnion('action', [
    z.object({ action: z.literal('confirmDraft'), draftId: Id }),
    z.object({ action: z.literal('dismissDraft'), draftId: Id }),
    z.object({ action: z.literal('rescheduleReminder'), id: Id, revision: z.number().int().positive(), dueAt: z.number().int().positive() }),
    z.object({ action: z.literal('cancelReminder'), id: Id, revision: z.number().int().positive() }),
    z.object({ action: z.literal('undo'), operationId: Id }),
    z.object({ action: z.literal('deleteMessage'), messageId: Id }),
  ]),
  z.string().min(8).max(100),
]);
const NestTargetArg = z.enum(['notes', 'reminders', 'settings', 'topics']);

/** Electron 的 net.fetch 走 Chromium 网络栈，跟随系统代理设置 */
const electronFetch: FetchLike = (url, init) => net.fetch(url, init);

export interface ChatHooks {
  /** 宠物位置；对话窗口放在它旁边 */
  anchor(): Rectangle | null;
  openSettings(): void;
  openNest(target: NestTarget): void;
}

export class ChatHost {
  private win: BrowserWindow | null = null;
  private ready = false;
  private showWhenReady = false;
  private quitting = false;
  private readonly runner: ConversationRunner;
  private readonly disposers: Array<() => void> = [];

  constructor(
    private readonly db: Database,
    private readonly clock: Clock,
    private readonly commands: CommandService,
    private readonly models: ModelSettings,
    private readonly hooks: ChatHooks,
  ) {
    this.runner = new ConversationRunner(
      db,
      clock,
      {
        onLive: (turn) => this.emit({ type: 'live', turn }),
        onEnded: (turnId, errorCode) => {
          this.emit({ type: 'ended', turnId, errorCode });
          this.notifyChanged();
        },
        onToolsRejected: () => {
          const built = this.models.createAdapter(electronFetch);
          if (built) this.models.markToolsRejected(built.configKey);
        },
        // 纠正打断了回复：按新上下文重试同一条用户消息（TD §9.4）
        onSuperseded: (userMessageId) => {
          void Promise.resolve().then(() => this.retry(userMessageId, `supersede-${crypto.randomUUID()}`));
        },
      },
      undefined,
      undefined,
      commands,
    );
  }

  start(): void {
    const onBeforeQuit = (): void => {
      this.quitting = true;
    };
    app.on('before-quit', onBeforeQuit);
    this.disposers.push(() => app.removeListener('before-quit', onBeforeQuit));
    this.handle(ChatIpc.history, (): ChatHistory => this.history());
    this.handle(ChatIpc.action, (_event, ...args) => {
      const [request, operationId] = ActionArgs.parse(args);
      return this.action(request, operationId);
    });
    this.on(ChatIpc.openNest, (_event, ...args) => this.hooks.openNest(NestTargetArg.parse(args[0])));
    // 别处（小窝、气泡）改了提醒或笔记：卡片按当前状态重新渲染
    this.disposers.push(
      this.commands.onCommitted((topics) => {
        // 小窝里纠正或忘记了内容：正在生成的回复作废并重来
        if (topics.includes('context')) this.runner.supersede();
        if (topics.some((t) => t !== 'conversation')) this.notifyChanged();
      }),
    );
    this.handle(ChatIpc.status, (): ChatStatus => this.status());
    this.handle(ChatIpc.send, (_event, ...args) => {
      const [text, operationId] = SendArgs.parse(args);
      return this.send(text, operationId);
    });
    this.handle(ChatIpc.retry, (_event, ...args) => {
      const [userMessageId, operationId] = RetryArgs.parse(args);
      return this.retry(userMessageId, operationId);
    });
    this.on(ChatIpc.stop, () => this.runner.stop());
    this.on(ChatIpc.openSettings, () => this.hooks.openSettings());
    this.on(ChatIpc.hide, () => this.hide());
    this.disposers.push(this.models.onChange(() => this.notifyChanged()));
  }

  /** 跟进到期后“去聊聊”：宠物把问题说出来，然后打开对话（R12） */
  openFollowUp(inboxId: string): void {
    const result = this.commands.run('chat.openFollowUp', { inboxId }, { operationId: `followup-open-${inboxId}`, origin: 'ui' });
    if (!result.ok) console.warn('[chat] open follow-up failed:', result.errorCode);
    this.notifyChanged();
    this.open();
  }

  /** 单击宠物：打开或收起 */
  toggle(): void {
    if (this.win && !this.win.isDestroyed() && this.win.isVisible() && this.win.isFocused()) this.hide();
    else this.open();
  }

  open(): void {
    const win = this.ensureWindow();
    this.place(win);
    if (!this.ready) {
      this.showWhenReady = true;
      return;
    }
    this.reveal(win);
  }

  hide(): void {
    if (this.win && !this.win.isDestroyed()) this.win.hide();
  }

  dispose(): void {
    this.runner.stop();
    for (const dispose of this.disposers.splice(0)) dispose();
  }

  private history(): ChatHistory {
    const messages = chatHistory(this.db);
    const turnIds = [...new Set(messages.flatMap((m) => (m.turnId ? [m.turnId] : [])))];
    const live = this.runner.liveTurn;
    if (live && !turnIds.includes(live.turnId)) turnIds.push(live.turnId);
    return { messages, live, cards: actionCards(this.db, this.commands, turnIds, this.clock.now()) };
  }

  private status(): ChatStatus {
    const built = this.models.createAdapter(electronFetch);
    return {
      configured: !!built,
      modelLabel: built?.label ?? null,
      toolCalls: !!built && built.adapter.capabilities.toolCalls && !this.models.isToolsRejected(built.configKey),
    };
  }

  private runOptions(configKey: string): { strategy: ReturnType<ModelSettings['strategy']>; tools: boolean } {
    return { strategy: this.models.strategy(), tools: !this.models.isToolsRejected(configKey) };
  }

  /** 卡片按钮：全部走统一命令入口，来源是 UI */
  private action(request: ChatActionRequest, operationId: string): CommandResult {
    const now = this.clock.now();
    let result: CommandResult;
    switch (request.action) {
      case 'confirmDraft':
        result = confirmDraft(this.db, this.commands, request.draftId, now);
        break;
      case 'dismissDraft':
        result = dismissDraft(this.db, request.draftId, now)
          ? { ok: true, operationId, result: null, replayed: false }
          : { ok: false, operationId, errorCode: 'INVALID_STATE' };
        break;
      case 'rescheduleReminder':
        result = this.commands.run('reminders.reschedule', { id: request.id, revision: request.revision, dueAt: request.dueAt }, { operationId, origin: 'ui' });
        break;
      case 'cancelReminder':
        result = this.commands.run('reminders.cancel', { id: request.id, revision: request.revision }, { operationId, origin: 'ui' });
        break;
      case 'undo':
        result = undoAction(this.db, this.commands, request.operationId, now);
        break;
      case 'deleteMessage':
        result = this.commands.run('chat.deleteMessage', { messageId: request.messageId }, { operationId, origin: 'ui' });
        break;
    }
    this.notifyChanged();
    return result;
  }

  private send(text: string, operationId: string): CommandResult {
    const built = this.models.createAdapter(electronFetch);
    // 未配置模型：不保存、不发送，输入保留在输入框（R18.AC-4）
    if (!built) return { ok: false, operationId, errorCode: 'INVALID_STATE', detail: 'NOT_CONFIGURED' };
    const result = this.commands.run<{ userMessageId: string; turnId: string }>(
      'chat.send',
      { text, model: built.label },
      { operationId, origin: 'ui' },
    );
    if (result.ok) {
      this.notifyChanged();
      if (!result.replayed) void this.runner.run(result.result.turnId, built.adapter, this.runOptions(built.configKey));
    }
    return result;
  }

  private retry(userMessageId: string, operationId: string): CommandResult {
    const built = this.models.createAdapter(electronFetch);
    if (!built) return { ok: false, operationId, errorCode: 'INVALID_STATE', detail: 'NOT_CONFIGURED' };
    const result = this.commands.run<{ turnId: string }>(
      'chat.retry',
      { userMessageId, model: built.label },
      { operationId, origin: 'ui' },
    );
    if (result.ok) {
      this.notifyChanged();
      if (!result.replayed) void this.runner.run(result.result.turnId, built.adapter, this.runOptions(built.configKey));
    }
    return result;
  }

  private reveal(win: BrowserWindow): void {
    if (win.isMinimized()) win.restore();
    win.show();
    win.focus();
    win.webContents.send(ChatIpc.event, { type: 'focus-input' } satisfies ChatEvent);
  }

  /** 放在宠物旁边：优先左侧，放不下放右侧；整体留在工作区内 */
  private place(win: BrowserWindow): void {
    if (win.isVisible()) return;
    const anchor = this.hooks.anchor();
    const area = (anchor ? screen.getDisplayMatching(anchor) : screen.getPrimaryDisplay()).workArea;
    const { width, height } = SIZE;
    let x: number;
    let y: number;
    if (anchor) {
      x = anchor.x - width - 8 >= area.x ? anchor.x - width - 8 : anchor.x + anchor.width + 8;
      y = anchor.y + anchor.height - height;
    } else {
      x = area.x + area.width - width - 24;
      y = area.y + area.height - height - 24;
    }
    x = Math.max(area.x, Math.min(x, area.x + area.width - width));
    y = Math.max(area.y, Math.min(y, area.y + area.height - height));
    win.setBounds({ x: Math.round(x), y: Math.round(y), width, height });
  }

  private ensureWindow(): BrowserWindow {
    if (this.win && !this.win.isDestroyed()) return this.win;
    this.ready = false;
    const win = new BrowserWindow({
      ...SIZE,
      minWidth: 320,
      minHeight: 360,
      show: false,
      title: '和宠物聊天',
      backgroundColor: '#fbf7f2',
      autoHideMenuBar: true,
      maximizable: false,
      fullscreenable: false,
      webPreferences: {
        preload: join(__dirname, '../preload/chat.js'),
        sandbox: true,
        contextIsolation: true,
        nodeIntegration: false,
        spellcheck: false,
      },
    });
    win.setMenu(null);
    hardenWebContents(win.webContents);
    win.once('ready-to-show', () => {
      this.ready = true;
      if (this.showWhenReady) {
        this.showWhenReady = false;
        this.reveal(win);
      }
    });
    // 关闭只是收起，聊天记录保留；回复仍在后台完成
    win.on('close', (event) => {
      if (!this.quitting) {
        event.preventDefault();
        win.hide();
      }
    });
    const devServer = process.env['ELECTRON_RENDERER_URL'];
    void (devServer ? win.loadURL(`${devServer}/chat.html`) : win.loadFile(join(__dirname, '../renderer/chat.html')));
    this.win = win;
    return win;
  }

  private emit(event: ChatEvent): void {
    if (this.win && !this.win.isDestroyed()) this.win.webContents.send(ChatIpc.event, event);
  }

  private notifyChanged(): void {
    if (this.win && !this.win.isDestroyed()) this.win.webContents.send(ChatIpc.changed);
  }

  private isSender(sender: Electron.WebContents): boolean {
    return !!this.win && !this.win.isDestroyed() && sender === this.win.webContents;
  }

  private handle(channel: string, handler: (event: IpcMainInvokeEvent, ...args: unknown[]) => unknown): void {
    ipcMain.handle(channel, (event, ...args) => {
      if (!this.isSender(event.sender)) throw new Error('NOT_ALLOWED');
      return handler(event, ...args);
    });
    this.disposers.push(() => ipcMain.removeHandler(channel));
  }

  private on(channel: string, handler: (event: IpcMainEvent, ...args: unknown[]) => void): void {
    const wrapped = (event: IpcMainEvent, ...args: unknown[]): void => {
      if (!this.isSender(event.sender)) return;
      try {
        handler(event, ...args);
      } catch (error) {
        console.warn(`[chat] ${channel} rejected:`, error instanceof Error ? error.name : 'unknown');
      }
    };
    ipcMain.on(channel, wrapped);
    this.disposers.push(() => ipcMain.removeListener(channel, wrapped));
  }
}
