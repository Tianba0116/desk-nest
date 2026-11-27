// 一次性提醒与信箱（R08、R15、TD §8.2～8.3、§11）。
// scheduled_actions 是提醒的唯一真相；inbox_items 是到期后可回看的卡片；
// 弹出气泡（shown_at）与入箱分开记录。

import { z } from 'zod';
import { CommandErrorCodes } from '../../shared/contracts/command';
import { FOLLOW_UP_PURPOSE_MAX } from '../../shared/contracts/memory';
import { formatTime } from '../../shared/format-time';
import {
  MISSED_POPUP_WINDOW_MS,
  REMINDER_CONTENT_MAX,
  SNOOZE_OPTIONS_MINUTES,
  type BubbleItem,
  type InboxItemDto,
  type ReminderDto,
  type ReminderStatus,
} from '../../shared/contracts/reminders';
import {
  CommandError,
  defineCommand,
  requireExplicit,
  requireRevision,
  sourceMessageId,
  sourceTypeOf,
  type ToolPrepareContext,
  type ToolPrepareResult,
} from '../application/commands';
import { detectRecurrence, formatInZone, resolveTime, TimeSpec } from '../application/time-resolver';
import { defineQuery } from '../application/queries';
import type { JobHandler } from '../application/scheduler';
import type { Database } from '../storage/database';
import { findTask } from './tasks';
import { findTopic } from './topics';

interface ActionRow {
  id: string;
  kind: 'reminder' | 'follow_up';
  content: string;
  due_at: number;
  time_zone: string;
  target_type: string | null;
  target_id: string | null;
  status: ReminderStatus;
  cancel_reason: string | null;
  stop_policy: 'on_target_closed' | 'none';
  revision: number;
  created_at: number;
  updated_at: number;
}

interface InboxRow {
  id: string;
  category: InboxItemDto['category'];
  source_id: string;
  source_revision: number;
  status: InboxItemDto['status'];
  due_at: number | null;
  created_at: number;
  read_at: number | null;
}

const ACTION_COLUMNS =
  'id, kind, content, due_at, time_zone, target_type, target_id, status, cancel_reason, stop_policy, revision, created_at, updated_at';

/** 提醒和约定跟进都是计划（TD §8.2）：改期、推迟、取消共用 */
function findReminder(db: Database, id: string): ActionRow | undefined {
  return db.get<ActionRow>(`SELECT ${ACTION_COLUMNS} FROM scheduled_actions WHERE id = ?`, id);
}

export function toReminderDto(db: Database, row: ActionRow): ReminderDto {
  let task: ReminderDto['task'] = null;
  if (row.target_type === 'task' && row.target_id) {
    const t = findTask(db, row.target_id);
    task = t ? { id: t.id, title: t.title, deleted: t.deleted_at !== null } : null;
  }
  let topic: ReminderDto['topic'] = null;
  if (row.target_type === 'topic' && row.target_id) {
    const t = findTopic(db, row.target_id);
    topic = { id: row.target_id, title: t?.title ?? '（已删除的事项）', gone: !t || t.forgotten_at !== null };
  }
  return {
    id: row.id,
    kind: row.kind,
    content: row.content,
    dueAt: row.due_at,
    timeZone: row.time_zone,
    status: row.status,
    cancelReason: row.cancel_reason,
    task,
    topic,
    stopPolicy: row.stop_policy,
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

/** 模型看到的参数：时间只填语义结构，由本地换算（TD §8.1） */
const ReminderToolArgs = z.object({
  content: z.string().trim().max(REMINDER_CONTENT_MAX).describe('要提醒的事，用用户的原话，例如“改简历”；用户没说就留空'),
  when: TimeSpec.describe('用户说的时间，只填语义字段，不要自己算日期'),
  onceOnly: z.boolean().nullish().describe('用户说了重复表达、并同意只设置下一次时填 true'),
});

function prepareReminder(raw: unknown, ctx: ToolPrepareContext): ToolPrepareResult {
  const args = raw as z.output<typeof ReminderToolArgs>;
  const partial = { ...args };
  if (!args.content) {
    return { kind: 'needs_input', missing: ['content'], question: '要提醒你做什么呢？', partial };
  }
  return prepareTimed(args.when, args.onceOnly ?? false, ctx, partial, `几点提醒你“${args.content}”呢？`, (dueAt) => ({
    content: args.content,
    dueAt,
    timeZone: ctx.timeZone,
    taskId: null,
  }));
}

/**
 * 带时间的工具共用：本地换算时间，处理缺时刻、时间已过、重复表达（TD §8.1）。
 * 模型漏填重复表达时，本地规则仍然拦住（R08.AC-7）。
 */
export function prepareTimed(
  rawWhen: z.output<typeof TimeSpec>,
  onceOnly: boolean,
  ctx: ToolPrepareContext,
  partialArgs: Record<string, unknown>,
  askTime: string,
  input: (dueAt: number) => unknown,
): ToolPrepareResult {
  const recurrence = onceOnly ? null : (rawWhen.recurrence ?? detectRecurrence(ctx.userText));
  const when = { ...rawWhen, recurrence };
  const partial = { ...partialArgs, when };
  const flags = onceOnly ? { onceOnly: true } : {};
  const resolution = resolveTime(when, ctx.baseTime, ctx.timeZone);
  if (resolution.ok) return { kind: 'ready', input: input(resolution.dueAt), flags };
  switch (resolution.reason) {
    case 'MISSING_TIME':
      return { kind: 'needs_input', missing: ['time'], question: askTime, partial };
    case 'INVALID_DATE':
      return { kind: 'needs_input', missing: ['date'], question: '这个日期好像不存在，是哪一天呢？', partial };
    case 'PAST_TIME': {
      const past = formatInZone(resolution.dueAt, ctx.timeZone);
      if (resolution.suggestion === null) {
        return { kind: 'needs_input', missing: ['confirm_past'], question: `${past} 已经过去了，换个以后的时间吧？`, partial };
      }
      const next = formatInZone(resolution.suggestion, ctx.timeZone);
      return {
        kind: 'needs_input',
        missing: ['confirm_past'],
        question: `${past} 已经过去了，要改成 ${next} 吗？`,
        partial,
        suggestion: { input: input(resolution.suggestion), label: `改成 ${next}`, flags },
      };
    }
    case 'UNSUPPORTED_RECURRENCE': {
      const ask = '我现在还不会设置重复提醒。';
      if (resolution.next === null) {
        return { kind: 'needs_input', missing: ['confirm_once', 'time'], question: `${ask}要不要只设置下一次？几点呢？`, partial };
      }
      const next = formatInZone(resolution.next, ctx.timeZone);
      return {
        kind: 'needs_input',
        missing: ['confirm_once'],
        question: `${ask}要不要只设置下一次（${next}）？`,
        partial,
        suggestion: { input: input(resolution.next), label: `只设置下一次（${next}）`, flags: { onceOnly: true } },
      };
    }
  }
}

const createReminderInput = z.object({
  content: z.string().trim().min(1, '提醒内容不能为空').max(REMINDER_CONTENT_MAX),
  dueAt: DueAt,
  timeZone: TimeZone,
  taskId: Id.nullable().default(null),
});

export const createReminder = defineCommand({
  name: 'reminders.create',
  input: createReminderInput,
  invalidates: ['reminders'],
  tool: {
    description:
      '为用户创建一条一次性提醒。只有用户明确要求“提醒我……”时调用；闲聊里提到的计划不要调用。时间只填 when 的语义字段，系统会换算并在缺信息时向用户确认。',
    parameters: ReminderToolArgs,
    prepare: prepareReminder,
    summarize(result, flags, timeZone) {
      const r = result as ReminderDto;
      return `已创建提醒“${r.content}”：${formatInZone(r.dueAt, timeZone)}${flags.onceOnly ? '（仅一次）' : ''}`;
    },
    card(db, result) {
      const row = findReminder(db, (result as ReminderDto).id);
      return { reminder: row ? toReminderDto(db, row) : null };
    },
  },
  execute({ db, now, newId, meta }, input): ReminderDto {
    requireFuture(input.dueAt, now);
    if (input.taskId) {
      const task = findTask(db, input.taskId);
      if (!task || task.deleted_at !== null) throw new CommandError(CommandErrorCodes.notFound, '关联的待办不存在');
    }
    const id = newId();
    db.run(
      `INSERT INTO scheduled_actions (id, kind, content, due_at, time_zone, target_type, target_id, status,
         revision, source_type, source_message_id, created_at, updated_at)
       VALUES (?, 'reminder', ?, ?, ?, ?, ?, 'scheduled', 1, ?, ?, ?, ?)`,
      id,
      input.content,
      input.dueAt,
      input.timeZone,
      input.taskId ? 'task' : null,
      input.taskId,
      sourceTypeOf(meta),
      sourceMessageId(db, meta),
      now,
      now,
    );
    return mustLoad(db, id);
  },
});

// ---------- 约定跟进（R12） ----------

const FollowUpToolArgs = z.object({
  purpose: z.string().trim().max(FOLLOW_UP_PURPOSE_MAX).describe('到时候要问什么，用用户的原话，例如“面试准备得怎么样”'),
  topicId: z.string().max(100).nullish().describe('要跟进的事项 id，必须来自系统提示里列出的事项；没有对应事项就留空'),
  taskId: z.string().max(100).nullish().describe('要跟进的待办 id；一般留空'),
  when: TimeSpec.describe('约好的时间，只填语义字段'),
  reviewAfterDone: z.boolean().nullish().describe('用户说“做完以后也来问问我/复盘”时填 true：对象完成后跟进不会自动取消'),
  onceOnly: z.boolean().nullish().describe('用户说了重复表达、并同意只设置下一次时填 true'),
});

/** 明确约定跟进的说法（R12.AC-1）：模型不能仅凭一段笔记或分享自行安排 */
const EXPLICIT_FOLLOW_UP = /问问|问我|问一下|问一问|来问|跟进|关心一下|看看我|催催?我|检查一下我|找我聊/;

const createFollowUpInput = z.object({
  purpose: z.string().trim().min(1, '跟进的目的不能为空').max(FOLLOW_UP_PURPOSE_MAX),
  dueAt: DueAt,
  timeZone: TimeZone,
  topicId: Id.nullable().default(null),
  taskId: Id.nullable().default(null),
  stopPolicy: z.enum(['on_target_closed', 'none']).default('on_target_closed'),
});

export const createFollowUp = defineCommand({
  name: 'followUps.create',
  input: createFollowUpInput,
  invalidates: ['reminders', 'topics', 'tasks'],
  tool: {
    description:
      '和用户约定：到了某个时间来问问用户某件事的进展。只有用户明确说“…的时候问问我…”“周五来跟进一下”时调用。能对应到系统提示里列出的事项时填 topicId。',
    parameters: FollowUpToolArgs,
    risk: 'undoable',
    prepare(raw, ctx) {
      const args = raw as z.output<typeof FollowUpToolArgs>;
      const partial: Record<string, unknown> = { ...args };
      if (!args.purpose) return { kind: 'needs_input', missing: ['purpose'], question: '到时候想让我问你什么呢？', partial };
      const topicId = args.topicId || null;
      let taskId = topicId ? null : args.taskId || null;
      if (topicId) {
        const topic = findTopic(ctx.db, topicId);
        if (!topic || topic.forgotten_at !== null) {
          return {
            kind: 'needs_input',
            missing: ['target'],
            question: '是哪件事呢？我没找到对应的事项。',
            partial: { ...partial, topicId: null },
          };
        }
      }
      if (taskId) {
        const task = findTask(ctx.db, taskId);
        if (!task || task.deleted_at !== null) taskId = null;
      }
      const timed = prepareTimed(args.when, args.onceOnly ?? false, ctx, partial, '几点来问你呢？', (dueAt) => ({
        purpose: args.purpose,
        dueAt,
        timeZone: ctx.timeZone,
        topicId,
        taskId,
        stopPolicy: args.reviewAfterDone ? 'none' : 'on_target_closed',
      }));
      if (timed.kind !== 'ready') return timed;
      return requireExplicit(ctx, EXPLICIT_FOLLOW_UP, timed, {
        question: '要我到时候来问问你吗？',
        label: '好，到时候来问我',
        partial,
      });
    },
    summarize(result, flags, timeZone) {
      const r = result as ReminderDto;
      const target = r.topic ? `（事项“${r.topic.title}”）` : r.task ? `（待办“${r.task.title}”）` : '';
      return `已约好 ${formatInZone(r.dueAt, timeZone)} 来问“${r.content}”${target}${flags.onceOnly ? '（仅一次）' : ''}`;
    },
    card(db, result) {
      const row = findReminder(db, (result as ReminderDto).id);
      return { reminder: row ? toReminderDto(db, row) : null };
    },
  },
  execute({ db, now, newId, meta }, input): ReminderDto {
    requireFuture(input.dueAt, now);
    if (input.topicId) {
      const topic = findTopic(db, input.topicId);
      if (!topic || topic.forgotten_at !== null) throw new CommandError(CommandErrorCodes.notFound, '关联的事项不存在');
    }
    if (input.taskId) {
      const task = findTask(db, input.taskId);
      if (!task || task.deleted_at !== null) throw new CommandError(CommandErrorCodes.notFound, '关联的待办不存在');
    }
    const id = newId();
    db.run(
      `INSERT INTO scheduled_actions (id, kind, content, due_at, time_zone, target_type, target_id, status, stop_policy,
         revision, source_type, source_message_id, created_at, updated_at)
       VALUES (?, 'follow_up', ?, ?, ?, ?, ?, 'scheduled', ?, 1, ?, ?, ?, ?)`,
      id,
      input.purpose,
      input.dueAt,
      input.timeZone,
      input.topicId ? 'topic' : input.taskId ? 'task' : null,
      input.topicId ?? input.taskId,
      input.stopPolicy,
      sourceTypeOf(meta),
      sourceMessageId(db, meta),
      now,
      now,
    );
    return mustLoad(db, id);
  },
});

/**
 * 跟进到期时的问题：读取对象的最新状态（R12.AC-4），不用安排时的旧摘要。
 * 本地模板生成，不依赖模型（断网时也能准时发问）。
 */
export function followUpQuestion(db: Database, actionId: string): string {
  const row = findReminder(db, actionId);
  if (!row) return '';
  const purpose = row.content.replace(/[？?。！!～~]+$/, '');
  let context = '';
  if (row.target_type === 'topic' && row.target_id) {
    const topic = findTopic(db, row.target_id);
    if (topic && topic.forgotten_at === null) {
      const progress = topic.progress_note ? `，上次你说“${topic.progress_note.slice(0, 60)}”` : '';
      const done = topic.status === 'done' ? '（这件事已经完成了）' : '';
      context = `关于“${topic.title}”${done}${progress}。`;
    }
  } else if (row.target_type === 'task' && row.target_id) {
    const task = findTask(db, row.target_id);
    if (task && task.deleted_at === null) {
      const progress = task.progress_note ? `，上次的进展是“${task.progress_note.slice(0, 60)}”` : '';
      context = `关于待办“${task.title}”${task.status === 'done' ? '（已完成）' : ''}${progress}。`;
    }
  }
  return `约好来问问你啦～${context}${purpose}？`;
}

const CLOSE_REASON_TEXT: Record<string, string> = {
  done: '已经完成',
  archived: '已经归档',
  deleted: '已经删除',
  forgotten: '已经忘记',
};

/**
 * 关联的事项或待办完成、删除、归档、忘记时，在同一事务里取消尚未到期的跟进，
 * 并在信箱留下“已自动取消”的说明（R12.AC-5、TD §8.2）。“完成后复盘”的跟进只在删除和忘记时取消。
 */
export function closeFollowUpsForTarget(
  db: Database,
  targetType: 'topic' | 'task',
  targetId: string,
  reason: 'done' | 'archived' | 'deleted' | 'forgotten',
  now: number,
  newId: () => string,
): number {
  const rows = db.all<ActionRow>(
    `SELECT ${ACTION_COLUMNS} FROM scheduled_actions
     WHERE kind = 'follow_up' AND target_type = ? AND target_id = ? AND status = 'scheduled'
       AND (stop_policy = 'on_target_closed' OR ? IN ('deleted', 'forgotten'))`,
    targetType,
    targetId,
    reason,
  );
  for (const row of rows) {
    cancelAction(db, row.id, `target_${reason}`, now);
    db.run(
      `INSERT OR IGNORE INTO inbox_items (id, source_type, source_id, source_revision, category, status, due_at, created_at,
         popup_skipped_at)
       VALUES (?, 'follow_up', ?, ?, 'auto_cancelled', 'unread', ?, ?, ?)`,
      newId(),
      row.id,
      row.revision + 1,
      row.due_at,
      now,
      now,
    );
  }
  return rows.length;
}

export function autoCancelText(db: Database, actionId: string): string {
  const row = findReminder(db, actionId);
  if (!row) return '一条约定跟进已自动取消';
  const reason = CLOSE_REASON_TEXT[(row.cancel_reason ?? '').replace(/^target_/, '')] ?? '已经结束';
  const target =
    row.target_type === 'topic'
      ? `事项“${findTopic(db, row.target_id ?? '')?.title ?? '（已删除）'}”`
      : `待办“${findTask(db, row.target_id ?? '')?.title ?? '（已删除）'}”`;
  return `${target}${reason}，原定 ${formatTime(row.due_at)} 的跟进“${row.content}”已自动取消。`;
}

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
  createFollowUp,
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
      // 兜底：对象已经结束但还没被取消的跟进，到期时再检查一次（TD §8.2）
      if (row.kind === 'follow_up') {
        const closed = targetClosedReason(db, row);
        if (closed && (row.stop_policy === 'on_target_closed' || closed === 'deleted' || closed === 'forgotten')) {
          closeFollowUpsForTarget(db, row.target_type as 'topic' | 'task', row.target_id as string, closed, now, newId);
          return;
        }
      }
      const category = row.kind === 'follow_up' ? 'follow_up' : 'reminder';
      const inserted = db.run(
        `INSERT OR IGNORE INTO inbox_items (id, source_type, source_id, source_revision, category, status, due_at, created_at)
         VALUES (?, ?, ?, ?, ?, 'unread', ?, ?)`,
        newId(),
        row.kind,
        row.id,
        row.revision,
        category,
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
    .all<BubbleRow>(
      `SELECT i.id, i.source_id, a.kind, a.content, i.due_at FROM inbox_items i
       JOIN scheduled_actions a ON a.id = i.source_id AND a.revision = i.source_revision
       WHERE i.status = 'unread' AND i.shown_at IS NULL AND i.popup_skipped_at IS NULL
         AND i.category IN ('reminder', 'follow_up')
       ORDER BY i.due_at LIMIT 20`,
    )
    .map((r) => toBubbleItem(db, r));
}

export interface BubbleRow {
  id: string;
  source_id: string;
  kind: 'reminder' | 'follow_up';
  content: string;
  due_at: number;
}

/** 气泡里的一项：跟进显示按最新状态生成的问题 */
export function toBubbleItem(db: Database, r: BubbleRow): BubbleItem {
  const content = r.kind === 'follow_up' ? followUpQuestion(db, r.source_id) : r.content;
  return { inboxId: r.id, kind: r.kind, reminderId: r.source_id, content, dueAt: r.due_at };
}

/** 跟进对象已经结束的原因；没结束或没有对象时为 null */
function targetClosedReason(db: Database, row: ActionRow): 'done' | 'archived' | 'deleted' | 'forgotten' | null {
  if (row.target_type === 'topic' && row.target_id) {
    const topic = findTopic(db, row.target_id);
    if (!topic) return 'deleted';
    if (topic.forgotten_at !== null) return 'forgotten';
    if (topic.status === 'done') return 'done';
    if (topic.status === 'archived') return 'archived';
  }
  if (row.target_type === 'task' && row.target_id) {
    const task = findTask(db, row.target_id);
    if (!task || task.deleted_at !== null) return 'deleted';
    if (task.status === 'done') return 'done';
  }
  return null;
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
          `SELECT ${ACTION_COLUMNS} FROM scheduled_actions WHERE status = 'scheduled'
           ORDER BY due_at LIMIT 200`,
        )
        .map((row) => toReminderDto(db, row));
      const history = db
        .all<ActionRow>(
          `SELECT ${ACTION_COLUMNS} FROM scheduled_actions WHERE status != 'scheduled'
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
          `SELECT id, category, source_id, source_revision, status, due_at, created_at, read_at FROM inbox_items
           ORDER BY created_at DESC LIMIT 200`,
        )
        .map((row) => {
          const action = findReminder(db, row.source_id);
          const text =
            row.category === 'follow_up'
              ? followUpQuestion(db, row.source_id)
              : row.category === 'auto_cancelled'
                ? autoCancelText(db, row.source_id)
                : undefined;
          return {
            id: row.id,
            category: row.category,
            ...(text ? { text } : {}),
            status: row.status,
            dueAt: row.due_at,
            createdAt: row.created_at,
            readAt: row.read_at,
            reminder: action ? toReminderDto(db, action) : null,
            stale: row.category === 'auto_cancelled' ? false : !action || action.revision !== row.source_revision,
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
