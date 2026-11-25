// 待办（R07）。完成状态只由用户的明确操作改变（R07.AC-2）：本模块之外的流程
// （提醒到期、专注结束、关闭气泡）都不能调用 tasks.setStatus。

import { z } from 'zod';
import { CommandErrorCodes } from '../../shared/contracts/command';
import {
  RECYCLE_RETENTION_MS,
  TASK_PROGRESS_MAX,
  TASK_TITLE_MAX,
  type TaskDto,
  type TaskStatus,
} from '../../shared/contracts/notebook';
import { CommandError, defineCommand, requireRevision } from '../application/commands';
import type { Database } from '../storage/database';
import { cancelRemindersForTask } from './reminders';
import { likeConditions, normalizeForSearch, searchTerms } from './text-search';

interface TaskRow {
  id: string;
  title: string;
  status: TaskStatus;
  due_at: number | null;
  progress_note: string;
  progress_updated_at: number | null;
  completed_at: number | null;
  revision: number;
  deleted_at: number | null;
  created_at: number;
  updated_at: number;
}

const COLUMNS =
  'id, title, status, due_at, progress_note, progress_updated_at, completed_at, revision, deleted_at, created_at, updated_at';

export function toTaskDto(row: TaskRow): TaskDto {
  return {
    id: row.id,
    title: row.title,
    status: row.status,
    dueAt: row.due_at,
    progressNote: row.progress_note,
    progressUpdatedAt: row.progress_updated_at,
    completedAt: row.completed_at,
    revision: row.revision,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    deletedAt: row.deleted_at,
  };
}

export function findTask(db: Database, id: string): TaskRow | undefined {
  return db.get<TaskRow>(`SELECT ${COLUMNS} FROM tasks WHERE id = ?`, id);
}

function mustLoad(db: Database, id: string): TaskDto {
  const row = findTask(db, id);
  if (!row) throw new CommandError(CommandErrorCodes.notFound);
  return toTaskDto(row);
}

function searchText(title: string, progress: string): string {
  return normalizeForSearch(`${title}\n${progress}`);
}

const Id = z.string().min(1).max(100);
const Title = z.string().trim().min(1, '标题不能为空').max(TASK_TITLE_MAX);
const DueAt = z.number().int().nonnegative().nullable();
const Revision = z.number().int().positive();

export const createTask = defineCommand({
  name: 'tasks.create',
  input: z.object({ title: Title, dueAt: DueAt.default(null) }),
  invalidates: ['tasks'],
  execute({ db, now, newId }, input): TaskDto {
    const id = newId();
    db.run(
      `INSERT INTO tasks (id, title, status, due_at, search_text, revision, created_at, updated_at)
       VALUES (?, ?, 'open', ?, ?, 1, ?, ?)`,
      id,
      input.title,
      input.dueAt,
      searchText(input.title, ''),
      now,
      now,
    );
    return mustLoad(db, id);
  },
});

export const updateTask = defineCommand({
  name: 'tasks.update',
  input: z.object({ id: Id, revision: Revision, title: Title, dueAt: DueAt }),
  invalidates: ['tasks'],
  execute({ db, now }, input): TaskDto {
    const row = findTask(db, input.id);
    requireRevision(row, input.revision);
    db.run(
      `UPDATE tasks SET title = ?, due_at = ?, search_text = ?, revision = revision + 1, updated_at = ? WHERE id = ?`,
      input.title,
      input.dueAt,
      searchText(input.title, (row as TaskRow).progress_note),
      now,
      input.id,
    );
    return mustLoad(db, input.id);
  },
});

export const setTaskStatus = defineCommand({
  name: 'tasks.setStatus',
  input: z.object({ id: Id, revision: Revision.optional(), status: z.enum(['open', 'done']) }),
  invalidates: ['tasks'],
  execute({ db, now }, input): TaskDto {
    const row = findTask(db, input.id);
    requireRevision(row, input.revision);
    if ((row as TaskRow).status === input.status) return toTaskDto(row as TaskRow);
    db.run(
      `UPDATE tasks SET status = ?, completed_at = ?, revision = revision + 1, updated_at = ? WHERE id = ?`,
      input.status,
      input.status === 'done' ? now : null,
      now,
      input.id,
    );
    return mustLoad(db, input.id);
  },
});

/** 记录进展（R07.AC-1）：保存最新进展，不改变完成状态 */
export const recordTaskProgress = defineCommand({
  name: 'tasks.recordProgress',
  input: z.object({ id: Id, revision: Revision.optional(), note: z.string().trim().max(TASK_PROGRESS_MAX) }),
  invalidates: ['tasks'],
  execute({ db, now }, input): TaskDto {
    const row = findTask(db, input.id);
    requireRevision(row, input.revision);
    db.run(
      `UPDATE tasks SET progress_note = ?, progress_updated_at = ?, search_text = ?, revision = revision + 1,
         updated_at = ? WHERE id = ?`,
      input.note,
      input.note ? now : null,
      searchText((row as TaskRow).title, input.note),
      now,
      input.id,
    );
    return mustLoad(db, input.id);
  },
});

export const deleteTask = defineCommand({
  name: 'tasks.delete',
  input: z.object({ id: Id, revision: Revision.optional() }),
  invalidates: ['tasks', 'reminders', 'inbox'],
  execute({ db, now }, input): TaskDto {
    requireRevision(findTask(db, input.id), input.revision);
    db.run('UPDATE tasks SET deleted_at = ?, revision = revision + 1, updated_at = ? WHERE id = ?', now, now, input.id);
    // 同一事务取消关联的提醒，不留下仍会触发的悬空提醒（R07.AC-4）
    cancelRemindersForTask(db, input.id, now);
    return mustLoad(db, input.id);
  },
});

export const restoreTask = defineCommand({
  name: 'tasks.restore',
  input: z.object({ id: Id }),
  invalidates: ['tasks'],
  execute({ db, now }, input): TaskDto {
    const row = findTask(db, input.id);
    if (!row) throw new CommandError(CommandErrorCodes.notFound);
    if (row.deleted_at === null) return toTaskDto(row);
    if (now - row.deleted_at > RECYCLE_RETENTION_MS) throw new CommandError(CommandErrorCodes.expired);
    db.run('UPDATE tasks SET deleted_at = NULL, revision = revision + 1, updated_at = ? WHERE id = ?', now, input.id);
    return mustLoad(db, input.id);
  },
});

export const purgeTask = defineCommand({
  name: 'tasks.purge',
  input: z.object({ id: Id }),
  invalidates: ['tasks'],
  execute({ db }, input): { id: string } {
    const row = findTask(db, input.id);
    if (!row) throw new CommandError(CommandErrorCodes.notFound);
    if (row.deleted_at === null) throw new CommandError(CommandErrorCodes.invalidState, '只能彻底删除回收站中的待办');
    db.run('DELETE FROM tasks WHERE id = ?', input.id);
    return { id: input.id };
  },
});

export const taskCommands = [
  createTask,
  updateTask,
  setTaskStatus,
  recordTaskProgress,
  deleteTask,
  restoreTask,
  purgeTask,
];

// ---------- 查询 ----------

/** 未完成在前（按创建时间），已完成在后（按完成时间倒序） */
export function listTasks(db: Database, limit = 500): TaskDto[] {
  return db
    .all<TaskRow>(
      `SELECT ${COLUMNS} FROM tasks WHERE deleted_at IS NULL
       ORDER BY status = 'done', CASE WHEN status = 'done' THEN -completed_at ELSE created_at END LIMIT ?`,
      limit,
    )
    .map(toTaskDto);
}

export function searchTasks(db: Database, query: string, limit = 100): TaskDto[] {
  const terms = searchTerms(query);
  if (terms.length === 0) return [];
  const where = likeConditions('search_text', terms);
  return db
    .all<TaskRow>(
      `SELECT ${COLUMNS} FROM tasks WHERE deleted_at IS NULL AND ${where.sql} ORDER BY updated_at DESC LIMIT ?`,
      ...where.params,
      limit,
    )
    .map(toTaskDto);
}

export function listDeletedTasks(db: Database, now: number): TaskDto[] {
  return db
    .all<TaskRow>(
      `SELECT ${COLUMNS} FROM tasks WHERE deleted_at IS NOT NULL AND deleted_at >= ? ORDER BY deleted_at DESC`,
      now - RECYCLE_RETENTION_MS,
    )
    .map(toTaskDto);
}

export function purgeExpiredTasks(db: Database, now: number): number {
  return db.run('DELETE FROM tasks WHERE deleted_at IS NOT NULL AND deleted_at < ?', now - RECYCLE_RETENTION_MS)
    .changes;
}
