// 提醒与信箱的数据约定（R08、R15）。只放类型和常量。

export type ReminderStatus = 'scheduled' | 'materialized' | 'cancelled';

export interface ReminderDto {
  id: string;
  /** reminder：提醒；follow_up：约定跟进（R12），content 是跟进的目的 */
  kind: 'reminder' | 'follow_up';
  content: string;
  dueAt: number;
  timeZone: string;
  status: ReminderStatus;
  /** 取消原因：user（用户取消）、target_deleted（关联待办被删除） */
  cancelReason: string | null;
  task: { id: string; title: string; deleted: boolean } | null;
  /** 跟进关联的事项（R12.AC-2） */
  topic: { id: string; title: string; gone: boolean } | null;
  /** on_target_closed：对象完成后自动取消；none：完成后复盘 */
  stopPolicy: 'on_target_closed' | 'none';
  revision: number;
  createdAt: number;
  updatedAt: number;
}

export type InboxStatus = 'unread' | 'read' | 'dismissed' | 'invalidated';

export interface InboxItemDto {
  id: string;
  /** reminder 提醒到期；follow_up 跟进到期；auto_cancelled 跟进因对象完成或删除而自动取消（R12.AC-5） */
  category: 'reminder' | 'follow_up' | 'auto_cancelled';
  status: InboxStatus;
  /** 这张卡片对应的到期时间（入箱时的版本） */
  dueAt: number | null;
  createdAt: number;
  readAt: number | null;
  /** 提醒的当前状态：卡片按实体当前状态渲染，不用旧副本（TD §11） */
  reminder: ReminderDto | null;
  /** 提醒在入箱之后被改期、推迟或取消：只显示状态，不保留操作按钮（R15.AC-4） */
  stale: boolean;
  /** 跟进：按对象的最新状态生成的问题（R12.AC-4）；自动取消：说明原因 */
  text?: string;
}

/** 气泡中的一项 */
export interface BubbleItem {
  inboxId: string;
  kind: 'reminder' | 'follow_up';
  reminderId: string;
  content: string;
  dueAt: number;
}

export const REMINDER_CONTENT_MAX = 200;
/** 应用未运行期间错过的提醒：24 小时内的汇总提示一次，更早的只进入信箱（R08.AC-6） */
export const MISSED_POPUP_WINDOW_MS = 24 * 60 * 60 * 1000;
export const SNOOZE_OPTIONS_MINUTES = [10, 30, 60] as const;
