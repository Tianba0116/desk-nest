// 事项与记忆的数据约定（R11、R12）。只放类型和常量。

export type TopicStatus = 'active' | 'done' | 'archived';

/** 记录来自哪次对话或哪次表单操作（R11.AC-4） */
export interface SourceDto {
  type: 'conversation' | 'ui';
  /** 来源消息的原文（截断）；消息已删除时为 null */
  messageText: string | null;
  at: number;
}

export interface TopicDto {
  id: string;
  title: string;
  status: TopicStatus;
  progressNote: string;
  progressUpdatedAt: number | null;
  completedAt: number | null;
  forgottenAt: number | null;
  source: SourceDto;
  revision: number;
  createdAt: number;
  updatedAt: number;
}

export interface TopicDetailDto extends TopicDto {
  tasks: Array<{ id: string; title: string; status: 'open' | 'done' }>;
  /** 尚未到期的跟进 */
  followUps: Array<{ id: string; content: string; dueAt: number; revision: number; stopPolicy: StopPolicy }>;
}

export interface MemoryDto {
  id: string;
  content: string;
  expiresAt: number | null;
  /** 已过期：不再用于对话，但仍可以查看 */
  expired: boolean;
  forgottenAt: number | null;
  source: SourceDto;
  revision: number;
  createdAt: number;
  updatedAt: number;
}

/** on_target_closed：事项或待办完成、删除、归档后自动取消；none：完成后复盘，不取消（R12.AC-5） */
export type StopPolicy = 'on_target_closed' | 'none';

export const TOPIC_TITLE_MAX = 100;
export const TOPIC_PROGRESS_MAX = 1000;
export const MEMORY_CONTENT_MAX = 300;
export const FOLLOW_UP_PURPOSE_MAX = 200;

export const TOPIC_STATUS_LABELS: Record<TopicStatus, string> = { active: '进行中', done: '已完成', archived: '已归档' };
