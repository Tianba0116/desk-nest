// 小本子（笔记、待办、搜索、回收站）的数据约定。只放类型和常量。

export interface NoteDto {
  id: string;
  title: string;
  body: string;
  revision: number;
  createdAt: number;
  updatedAt: number;
  deletedAt: number | null;
}

export type TaskStatus = 'open' | 'done';

export interface TaskDto {
  id: string;
  title: string;
  status: TaskStatus;
  /** 可选的截止时间（UTC 毫秒）；只用于展示，不会触发提醒 */
  dueAt: number | null;
  progressNote: string;
  progressUpdatedAt: number | null;
  completedAt: number | null;
  revision: number;
  createdAt: number;
  updatedAt: number;
  deletedAt: number | null;
}

export type SearchHit = { type: 'note'; item: NoteDto } | { type: 'task'; item: TaskDto };

export type RecycledItem = { type: 'note'; item: NoteDto } | { type: 'task'; item: TaskDto };

/** 删除后可在界面上撤销的时间（R06.AC-2） */
export const UNDO_WINDOW_MS = 10_000;
/** 回收站保留天数（R06.AC-2） */
export const RECYCLE_RETENTION_DAYS = 7;
export const RECYCLE_RETENTION_MS = RECYCLE_RETENTION_DAYS * 24 * 60 * 60 * 1000;

export const NOTE_TITLE_MAX = 200;
export const NOTE_BODY_MAX = 20_000;
export const TASK_TITLE_MAX = 200;
export const TASK_PROGRESS_MAX = 2_000;
