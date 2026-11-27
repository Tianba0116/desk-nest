// 气泡窗口（宠物旁的到期提醒）与主进程之间的 IPC 约定。只放常量和类型。

import type { CommandResult } from './command';
import type { BubbleItem } from './reminders';

export const BubbleIpc = {
  /** 主进程 → 渲染层：要显示的项（BubbleItem[]） */
  items: 'bubble:items',
  /** 渲染层 → 主进程：这些项已经实际渲染（string[] inboxId） */
  shown: 'bubble:shown',
  /** 渲染层 → 主进程：内容高度变化（number，DIP） */
  resize: 'bubble:resize',
  /** 渲染层 → 主进程：关闭气泡（不改变已读状态） */
  close: 'bubble:close',
  /** 渲染层 → 主进程：打开小窝的信箱 */
  openInbox: 'bubble:open-inbox',
  /** 渲染层 → 主进程：(inboxId) 跟进“去聊聊” */
  openFollowUp: 'bubble:open-follow-up',
  /** 渲染层 → 主进程（invoke）：执行允许的命令 (name, input, operationId) */
  command: 'bubble:command',
} as const;

/** 气泡里允许执行的命令 */
export const BUBBLE_COMMANDS = ['inbox.markRead', 'reminders.snooze'] as const;

export interface BubbleBridge {
  onItems(listener: (items: BubbleItem[]) => void): () => void;
  shown(inboxIds: string[]): void;
  resize(height: number): void;
  close(): void;
  openInbox(): void;
  openFollowUp(inboxId: string): void;
  command<T = unknown>(name: (typeof BUBBLE_COMMANDS)[number], input: unknown, operationId: string): Promise<CommandResult<T>>;
}
