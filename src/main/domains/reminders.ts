// 一次性提醒与信箱（R08、R15、TD §8.2～8.3、§11）。
// scheduled_actions 是提醒的唯一真相；inbox_items 是到期后可回看的卡片；
// 弹出气泡（shown_at）与入箱分开记录。

import { z } from 'zod';
import { CommandErrorCodes } from '../../shared/contracts/command';
import {
  MISSED_POPUP_WINDOW_MS,
  REMINDER_CONTENT_MAX,
  SNOOZE_OPTIONS_MINUTES,
  type BubbleItem,
  type InboxItemDto,
  type ReminderDto,
  type ReminderStatus,
} from '../../shared/contracts/reminders';
import { CommandError, defineCommand, requireRevision } from '../application/commands';
import { defineQuery } from '../application/queries';
import type { JobHandler } from '../application/scheduler';
import type { Database } from '../storage/database';
import { findTask } from './tasks';

interface ActionRow {
  id: string;
  content: string;
  due_at: number;
  time_zone: string;
  target_type: string | null;
  target_id: string | null;
  status: ReminderStatus;
  cancel_reason: string | null;
  revision: number;
  created_at: number;
  updated_at: number;
}

interface InboxRow {
  id: string;
  source_id: string;
  source_revision: number;
  status: InboxItemDto['status'];
  due_at: number | null;
  created_at: number;
  read_at: number | null;
}

const ACTION_COLUMNS =
  'id, content, due_at, time_zone, target_type, target_id, status, cancel_reason, revision, created_at, updated_at';

function findReminder(db: Database, id: string): ActionRow | undefined {
  return db.get<ActionRow>(`SELECT ${ACTION_COLUMNS} FROM scheduled_actions WHERE id = ? AND kind = 'reminder'`, id);
}

export function toReminderDto(db: Database, row: ActionRow): ReminderDto {
  let task: ReminderDto['task'] = null;
  if (row.target_type === 'task' && row.target_id) {
    const t = findTask(db, row.target_id);
    task = t ? { id: t.id, title: t.title, deleted: t.deleted_at !== null } : null;
  }
  return {
    id: row.id,
    content: row.content,
    dueAt: row.due_at,
    timeZone: row.time_zone,
    status: row.status,
    cancelReason: row.cancel_reason,
    task,
    revision: row.revision,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function mustLoad(db: Database, id: string): ReminderDto {
  const row = findReminder(db, id);
  if (!row) throw new CommandError(CommandErrorCodes.notFound);
  return toReminderDto(db, row);
}

/** 不静默创建立即到期的提醒（R08.AC-4） */
function requireFuture(dueAt: number, now: number): void {
  if (dueAt <= now) throw new CommandError(CommandErrorCodes.pastTime, '这个时间已经过去了，请选择以后的时间');
}

/** 旧版本的未读卡片失效：改期、推迟、取消后，旧卡片不再有可执行按钮（TD §8.3） */
function invalidateInbox(db: Database, reminderId: string, now: number): void {
  db.run(
    `UPDATE inbox_items SET status = 'invalidated', invalidated_at = ?
     WHERE source_type = 'reminder' AND source_id = ? AND status = 'unread'`,
    now,
    reminderId,
  );
}

const Id = z.string().min(1).max(100);
const DueAt = z.number().int().positive();
const TimeZone = z.string().min(1).max(64);

export const createReminder = defineCommand({
  name: 'reminders.create',
  input: z.object({
    content: z.string().trim().min(1, '提醒内容不能为空').max(REMINDER_CONTENT_MAX),
    dueAt: DueAt,
    timeZone: TimeZone,
    taskId: Id.nullable().default(null),
  }),
  invalidates: ['reminders'],
  execute({ db, now, newId }, input): ReminderDto {
    requireFuture(input.dueAt, now);
    if (input.taskId) {
      const task = findTask(db, input.taskId);
      if (!task || task.deleted_at !== null) throw new CommandError(CommandErrorCodes.notFound, '关联的待办不存在');
    }
    const id = newId();
    db.run(
      `INSERT INTO scheduled_actions (id, kind, content, due_at, time_zone, target_type, target_id, status,
         revision, created_at, updated_at)
       VALUES (?, 'reminder', ?, ?, ?, ?, ?, 'scheduled', 1, ?, ?)`,
      id,
      input.content,
      input.dueAt,
      input.timeZone,
      input.taskId ? 'task' : null,
      input.taskId,
      now,
      now,
    );
    return mustLoad(db, id);
  },
});

/** 改期：revision + 1，回到 scheduled；旧时间不会再提示（R08.AC-5） */
export const rescheduleReminder = defineCommand({
  name: 'reminders.reschedule',
  input: z.object({ id: Id, revision: z.number().int().positive(), dueAt: DueAt }),
  invalidates: ['reminders', 'inbox'],
  execute({ db, now }, input): ReminderDto {
    const row = findReminder(db, input.id);
    requireRevision(row, input.revision);
    if ((row as ActionRow).status === 'cancelled') throw new CommandError(CommandErrorCodes.invalidState, '提醒已取消');
    requireFuture(input.dueAt, now);
    db.run(
      `UPDATE scheduled_actions SET due_at = ?, status = 'scheduled', revision = revision + 1, updated_at = ?
       WHERE id = ?`,
      input.dueAt,
      now,
      input.id,
    );
    invalidateInbox(db, input.id, now);
    return mustLoad(db, input.id);
  },
});

/** 推迟（R08.AC-1）：从现在起若干分钟后再提醒 */
export const snoozeReminder = defineCommand({
  name: 'reminders.snooze',
  input: z.object({
    id: Id,
    minutes: z.number().int().refine((m) => (SNOOZE_OPTIONS_MINUTES as readonly number[]).includes(m)),
  }),
  invalidates: ['reminders', 'inbox'],
  execute({ db, now }, input): ReminderDto {
    const row = findReminder(db, input.id);
    if (!row) throw new CommandError(CommandErrorCodes.notFound);
    if (row.status === 'cancelled') throw new CommandError(CommandErrorCodes.invalidState, '提醒已取消');
    db.run(
      `UPDATE scheduled_actions SET due_at = ?, status = 'scheduled', revision = revision + 1, updated_at = ?
       WHERE id = ?`,
      now + input.minutes * 60_000,
      now,
      input.id,
    );
    invalidateInbox(db, input.id, now);
    return mustLoad(db, input.id);
  },
});

export const cancelReminder = defineCommand({
  name: 'reminders.cancel',
  input: z.object({ id: Id, revision: z.number().int().positive().optional() }),
  invalidates: ['reminders', 'inbox'],
  execute({ db, now }, input): ReminderDto {
    const row = findReminder(db, input.id);
    requireRevision(row, input.revision);
    if ((row as ActionRow).status === 'cancelled') return toReminderDto(db, row as ActionRow);
    cancelAction(db, input.id, 'user', now);
    return mustLoad(db, input.id);
  },
});

export const markInboxRead = defineCommand({
  name: 'inbox.markRead',
  input: z.object({ ids: z.array(Id).min(1).max(100) }),
  invalidates: ['inbox'],
  execute({ db, now }, input): { updated: number } {
    let updated = 0;
    for (const id of input.ids) {
      updated += db.run(`UPDATE inbox_items SET status = 'read', read_at = ? WHERE id = ? AND status = 'unread'`, now, id)
        .changes;
    }
    return { updated };
  },
});

export const markAllInboxRead = defineCommand({
  name: 'inbox.markAllRead',
  input: z.object({}).strict(),
  invalidates: ['inbox'],
  execute({ db, now }): { updated: number } {
    return { updated: db.run(`UPDATE inbox_items SET status = 'read', read_at = ? WHERE status = 'unread'`, now).changes };
  },
});

export const reminderCommands = [
  createReminder,
  rescheduleReminder,
  snoozeReminder,
  cancelReminder,
  markInboxRead,
  markAllInboxRead,
];

function cancelAction(db: Database, id: string, reason: string, now: number): void {
  db.run(
    `UPDATE scheduled_actions SET status = 'cancelled', cancel_reason = ?, revision = revision + 1, updated_at = ?
     WHERE id = ?`,
    reason,
    now,
    id,
  );
  invalidateInbox(db, id, now);
}

/** 删除待办时在同一事务里取消关联的未到期提醒，不留悬空提醒（R07.AC-4） */
export function cancelRemindersForTask(db: Database, taskId: string, now: number): number {
  const rows = db.all<{ id: string }>(
    `SELECT id FROM scheduled_actions WHERE target_type = 'task' AND target_id = ? AND status = 'scheduled'`,
    taskId,
  );
  for (const row of rows) cancelAction(db, row.id, 'target_deleted', now);
  return rows.length;
}

// ---------- 调度（Scheduler 调用，不经过 UI） ----------

export function nextDueAt(db: Database): number | null {
  return (
    db.get<{ due_at: number }>(
      `SELECT due_at FROM scheduled_actions WHERE status = 'scheduled' ORDER BY due_at LIMIT 1`,
    )?.due_at ?? null
  );
}

export function countUpcoming(db: Database, now: number): number {
  return (
    db.get<{ n: number }>(`SELECT COUNT(*) AS n FROM scheduled_actions WHERE status = 'scheduled' AND due_at > ?`, now)
      ?.n ?? 0
  );
}

/**
 * 把已到期的提醒放入信箱（TD §8.3）。每条在短事务内重新读取最新版本和状态；
 * 唯一键 (source, revision) 防止同一次到期重复入箱。返回新建的信箱项数量。
 */
export function materializeDue(db: Database, now: number, newId: () => string, batch = 50): number {
  const due = db.all<{ id: string }>(
    `SELECT id FROM scheduled_actions WHERE status = 'scheduled' AND due_at <= ? ORDER BY due_at LIMIT ?`,
    now,
    batch,
  );
  let created = 0;
  for (const { id } of due) {
    db.transaction(() => {
      const row = db.get<ActionRow>(`SELECT ${ACTION_COLUMNS} FROM scheduled_actions WHERE id = ?`, id);
      if (!row || row.status !== 'scheduled' || row.due_at > now) return;
      const inserted = db.run(
        `INSERT OR IGNORE INTO inbox_items (id, source_type, source_id, source_revision, category, status, due_at, created_at)
         VALUES (?, 'reminder', ?, ?, 'reminder', 'unread', ?, ?)`,
        newId(),
        row.id,
        row.revision,
        row.due_at,
        now,
      );
      created += inserted.changes;
      db.run(`UPDATE scheduled_actions SET status = 'materialized', updated_at = ? WHERE id = ? AND revision = ?`, now, row.id, row.revision);
    });
  }
  return created;
}

/**
 * 需要弹出的信箱项：未读、未弹出、未跳过。超过 24 小时的旧提醒只进信箱（R08.AC-6），
 * 在这里标记为跳过。返回的项按到期时间排序。
 */
export function takePopupCandidates(db: Database, now: number): BubbleItem[] {
  db.run(
    `UPDATE inbox_items SET popup_skipped_at = ?
     WHERE status = 'unread' AND shown_at IS NULL AND popup_skipped_at IS NULL AND due_at < ?`,
    now,
    now - MISSED_POPUP_WINDOW_MS,
  );
  return db
    .all<{ id: string; source_id: string; content: string; due_at: number }>(
      `SELECT i.id, i.source_id, a.content, i.due_at FROM inbox_items i
       JOIN scheduled_actions a ON a.id = i.source_id AND a.revision = i.source_revision
       WHERE i.status = 'unread' AND i.shown_at IS NULL AND i.popup_skipped_at IS NULL
       ORDER BY i.due_at LIMIT 20`,
    )
    .map((r) => ({ inboxId: r.id, reminderId: r.source_id, content: r.content, dueAt: r.due_at }));
}

/** 安静模式等不能弹出时：只进信箱，以后也不再补弹（R08.AC-8） */
export function skipPopups(db: Database, inboxIds: string[], now: number): void {
  for (const id of inboxIds) {
    db.run(`UPDATE inbox_items SET popup_skipped_at = ? WHERE id = ? AND shown_at IS NULL`, now, id);
  }
}

/** 界面确认已显示后记录（TD §11：IPC 发送成功不等于用户看见） */
export function markShown(db: Database, inboxIds: string[], now: number): void {
  for (const id of inboxIds) {
    db.run(`UPDATE inbox_items SET shown_at = ? WHERE id = ? AND shown_at IS NULL`, now, id);
  }
}

export function unreadCount(db: Database): number {
  return db.get<{ n: number }>(`SELECT COUNT(*) AS n FROM inbox_items WHERE status = 'unread'`)?.n ?? 0;
}

/** 气泡里的项是否仍然有效（展示前再核验，TD §11） */
export function stillUnread(db: Database, inboxIds: string[]): string[] {
  return inboxIds.filter(
    (id) => !!db.get(`SELECT 1 FROM inbox_items WHERE id = ? AND status = 'unread'`, id),
  );
}

// ---------- 查询 ----------

export const reminderQueries = [
  defineQuery({
    name: 'reminders.list',
    input: z.object({}).strict(),
    run: ({ db, now }): { upcoming: ReminderDto[]; history: ReminderDto[] } => {
      const upcoming = db
        .all<ActionRow>(
          `SELECT ${ACTION_COLUMNS} FROM scheduled_actions WHERE kind = 'reminder' AND status = 'scheduled'
           ORDER BY due_at LIMIT 200`,
        )
        .map((row) => toReminderDto(db, row));
      const history = db
        .all<ActionRow>(
          `SELECT ${ACTION_COLUMNS} FROM scheduled_actions WHERE kind = 'reminder' AND status != 'scheduled'
             AND updated_at >= ? ORDER BY updated_at DESC LIMIT 100`,
          now - 30 * 24 * 60 * 60 * 1000,
        )
        .map((row) => toReminderDto(db, row));
      return { upcoming, history };
    },
  }),
  defineQuery({
    name: 'inbox.list',
    input: z.object({}).strict(),
    run: ({ db }): InboxItemDto[] =>
      db
        .all<InboxRow>(
          `SELECT id, source_id, source_revision, status, due_at, created_at, read_at FROM inbox_items
           WHERE category = 'reminder' ORDER BY created_at DESC LIMIT 200`,
        )
        .map((row) => {
          const action = findReminder(db, row.source_id);
          return {
            id: row.id,
            category: 'reminder' as const,
            status: row.status,
            dueAt: row.due_at,
            createdAt: row.created_at,
            readAt: row.read_at,
            reminder: action ? toReminderDto(db, action) : null,
            stale: !action || action.revision !== row.source_revision,
          };
        }),
  }),
  defineQuery({ name: 'inbox.unreadCount', input: z.object({}).strict(), run: ({ db }) => unreadCount(db) }),
];

/** 定时任务扩展点：提醒到期入箱 */
export function reminderJob(newId: () => string): JobHandler {
  return {
    kind: 'reminder',
    nextDue: (db) => nextDueAt(db),
    run: (db, now) => materializeDue(db, now, newId),
  };
}
