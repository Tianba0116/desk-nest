// 专注（R09、TD §8.4）。focus_sessions 是计时的唯一真相，按墙上时钟计时：
// 睡眠、锁屏、应用退出期间继续计时；暂停时不计时。到期由调度器结算一次并入信箱。
// 专注结束不会自动完成待办（R09.AC-2）：由用户在卡片上选择。

import { z } from 'zod';
import { CommandErrorCodes } from '../../shared/contracts/command';
import { FOCUS_LATE_MS, FOCUS_MAX_MINUTES, type FocusDto, type FocusStatus } from '../../shared/contracts/focus';
import { CommandError, defineCommand } from '../application/commands';
import { defineQuery } from '../application/queries';
import type { JobHandler } from '../application/scheduler';
import type { Database } from '../storage/database';
import { findTask } from './tasks';

interface FocusRow {
  id: string;
  task_id: string | null;
  status: FocusStatus;
  planned_ms: number;
  run_ms: number;
  segment_started_at: number | null;
  due_at: number | null;
  remaining_ms: number | null;
  pause_reason: string | null;
  away_ms: number;
  counted_ms: number | null;
  settled_late: number;
  started_at: number;
  ended_at: number | null;
  revision: number;
}

const COLUMNS =
  'id, task_id, status, planned_ms, run_ms, segment_started_at, due_at, remaining_ms, pause_reason, away_ms, counted_ms, settled_late, started_at, ended_at, revision';

function findSession(db: Database, id: string): FocusRow | undefined {
  return db.get<FocusRow>(`SELECT ${COLUMNS} FROM focus_sessions WHERE id = ?`, id);
}

export function activeSession(db: Database): FocusRow | undefined {
  return db.get<FocusRow>(`SELECT ${COLUMNS} FROM focus_sessions WHERE active_slot = 1`);
}

export function toFocusDto(db: Database, row: FocusRow): FocusDto {
  const task = row.task_id ? findTask(db, row.task_id) : undefined;
  return {
    id: row.id,
    status: row.status,
    plannedMs: row.planned_ms,
    dueAt: row.status === 'running' ? row.due_at : null,
    remainingMs: row.status === 'paused' ? row.remaining_ms : null,
    pauseReason: row.pause_reason,
    countedMs: row.counted_ms,
    awayMs: row.away_ms,
    settledLate: row.settled_late === 1,
    task: row.task_id
      ? { id: row.task_id, title: task?.title ?? '（已删除的待办）', status: task?.status ?? 'open', deleted: !task || task.deleted_at !== null }
      : null,
    startedAt: row.started_at,
    endedAt: row.ended_at,
    revision: row.revision,
  };
}

export function focusDtoById(db: Database, id: string): FocusDto | null {
  const row = findSession(db, id);
  return row ? toFocusDto(db, row) : null;
}

function mustLoad(db: Database, id: string): FocusDto {
  const row = findSession(db, id);
  if (!row) throw new CommandError(CommandErrorCodes.notFound);
  return toFocusDto(db, row);
}

/** 到目前为止实际专注的时长（以计划时长为上限） */
function elapsedMs(row: FocusRow, now: number): number {
  const running = row.status === 'running' && row.segment_started_at !== null ? Math.max(0, Math.min(now, row.due_at ?? now) - row.segment_started_at) : 0;
  return Math.min(row.planned_ms, Math.max(0, row.run_ms + running));
}

const Id = z.string().min(1).max(100);

export const startFocus = defineCommand({
  name: 'focus.start',
  input: z.object({
    plannedMinutes: z.number().int().min(1).max(FOCUS_MAX_MINUTES),
    taskId: Id.nullable().default(null),
  }),
  invalidates: ['focus'],
  execute({ db, now, newId }, input): FocusDto {
    if (activeSession(db)) throw new CommandError(CommandErrorCodes.invalidState, '已经有一个进行中的专注');
    if (input.taskId) {
      const task = findTask(db, input.taskId);
      if (!task || task.deleted_at !== null) throw new CommandError(CommandErrorCodes.notFound, '关联的待办不存在');
    }
    const id = newId();
    const planned = input.plannedMinutes * 60_000;
    db.run(
      `INSERT INTO focus_sessions (id, task_id, status, active_slot, planned_ms, run_ms, segment_started_at, due_at, started_at,
         revision, created_at, updated_at)
       VALUES (?, ?, 'running', 1, ?, 0, ?, ?, ?, 1, ?, ?)`,
      id,
      input.taskId,
      planned,
      now,
      now + planned,
      now,
      now,
      now,
    );
    return mustLoad(db, id);
  },
});

function liveSession(db: Database, id: string): FocusRow {
  const row = findSession(db, id);
  if (!row) throw new CommandError(CommandErrorCodes.notFound);
  if (row.status !== 'running' && row.status !== 'paused') throw new CommandError(CommandErrorCodes.invalidState, '这次专注已经结束了');
  return row;
}

/** 暂停：记下已专注的时长和剩余时间，暂停期间不计时 */
function pauseRow(db: Database, row: FocusRow, now: number, reason: string | null): void {
  const run = elapsedMs(row, now);
  const remaining = Math.max(0, (row.due_at ?? now) - now);
  db.run(
    `UPDATE focus_sessions SET status = 'paused', run_ms = ?, remaining_ms = ?, due_at = NULL, segment_started_at = NULL,
       pause_reason = ?, revision = revision + 1, updated_at = ? WHERE id = ?`,
    run,
    remaining,
    reason,
    now,
    row.id,
  );
}

export const pauseFocus = defineCommand({
  name: 'focus.pause',
  input: z.object({ id: Id }),
  invalidates: ['focus'],
  execute({ db, now }, input): FocusDto {
    const row = liveSession(db, input.id);
    if (row.status === 'running') pauseRow(db, row, now, null);
    return mustLoad(db, input.id);
  },
});

/** 继续；时间被调整后暂停的，用户可以确认或修改剩余时间（R09.AC-7） */
export const resumeFocus = defineCommand({
  name: 'focus.resume',
  input: z.object({ id: Id, remainingMinutes: z.number().int().min(1).max(FOCUS_MAX_MINUTES).optional() }),
  invalidates: ['focus'],
  execute({ db, now }, input): FocusDto {
    const row = liveSession(db, input.id);
    if (row.status === 'running') return toFocusDto(db, row);
    const remaining = input.remainingMinutes !== undefined ? input.remainingMinutes * 60_000 : (row.remaining_ms ?? 0);
    // 修改剩余时间后，计划时长 = 已专注 + 剩余，统计仍以计划时长为上限
    const planned = input.remainingMinutes !== undefined ? row.run_ms + remaining : row.planned_ms;
    db.run(
      `UPDATE focus_sessions SET status = 'running', planned_ms = ?, due_at = ?, segment_started_at = ?, remaining_ms = NULL,
         pause_reason = NULL, revision = revision + 1, updated_at = ? WHERE id = ?`,
      planned,
      now + remaining,
      now,
      now,
      input.id,
    );
    return mustLoad(db, input.id);
  },
});

function endRow(db: Database, row: FocusRow, status: 'finished' | 'cancelled', now: number): void {
  db.run(
    `UPDATE focus_sessions SET status = ?, active_slot = NULL, counted_ms = ?, due_at = NULL, segment_started_at = NULL,
       remaining_ms = NULL, ended_at = ?, revision = revision + 1, updated_at = ? WHERE id = ?`,
    status,
    status === 'finished' ? elapsedMs(row, now) : null,
    now,
    now,
    row.id,
  );
}

export const finishFocus = defineCommand({
  name: 'focus.finish',
  input: z.object({ id: Id }),
  invalidates: ['focus'],
  execute({ db, now }, input): FocusDto {
    endRow(db, liveSession(db, input.id), 'finished', now);
    return mustLoad(db, input.id);
  },
});

export const cancelFocus = defineCommand({
  name: 'focus.cancel',
  input: z.object({ id: Id }),
  invalidates: ['focus'],
  execute({ db, now }, input): FocusDto {
    endRow(db, liveSession(db, input.id), 'cancelled', now);
    return mustLoad(db, input.id);
  },
});

export const focusCommands = [startFocus, pauseFocus, resumeFocus, finishFocus, cancelFocus];

// ---------- 调度与系统事件（不经过 UI） ----------

/**
 * 到期结算（R09.AC-3、AC-4、AC-6）：每个会话在短事务里只结算一次。
 * 到期后超过 FOCUS_LATE_MS 才结算的，记为“已到期”（期间电脑处于睡眠、锁屏或应用未运行）。
 */
export function settleDueFocus(db: Database, now: number, newId: () => string): number {
  const due = db.all<{ id: string }>(`SELECT id FROM focus_sessions WHERE status = 'running' AND due_at <= ?`, now);
  let created = 0;
  for (const { id } of due) {
    db.transaction(() => {
      const row = findSession(db, id);
      if (!row || row.status !== 'running' || (row.due_at ?? Infinity) > now) return;
      const late = now - (row.due_at as number) > FOCUS_LATE_MS;
      db.run(
        `UPDATE focus_sessions SET status = ?, active_slot = NULL, counted_ms = ?, settled_late = ?, ended_at = due_at,
           segment_started_at = NULL, revision = revision + 1, updated_at = ? WHERE id = ? AND status = 'running'`,
        late ? 'expired' : 'completed',
        elapsedMs(row, row.due_at as number),
        late ? 1 : 0,
        now,
        id,
      );
      created += db.run(
        `INSERT OR IGNORE INTO inbox_items (id, source_type, source_id, source_revision, category, status, due_at, created_at)
         VALUES (?, 'focus', ?, ?, 'focus', 'unread', ?, ?)`,
        newId(),
        id,
        row.revision + 1,
        row.due_at,
        now,
      ).changes;
    });
  }
  return created;
}

export function focusJob(newId: () => string): JobHandler {
  return {
    kind: 'focus',
    nextDue: (db) => db.get<{ due_at: number }>(`SELECT due_at FROM focus_sessions WHERE status = 'running' ORDER BY due_at LIMIT 1`)?.due_at ?? null,
    run: (db, now) => settleDueFocus(db, now, newId),
  };
}

/** 锁屏、睡眠的时长单独记录（D-07）；应用未运行期间无法得知，不计入 */
export function addAwayTime(db: Database, ms: number, now: number): void {
  if (ms <= 0) return;
  db.run(
    `UPDATE focus_sessions SET away_ms = away_ms + ?, updated_at = ? WHERE status = 'running'`,
    Math.round(ms),
    now,
  );
}

/** 检测到系统时间被大幅调整：暂停进行中的会话，等用户确认剩余时间（R09.AC-7） */
export function pauseForClockJump(db: Database, now: number, jumpMs: number, newId: () => string): boolean {
  return db.transaction(() => {
    const row = activeSession(db);
    if (!row || row.status !== 'running') return false;
    // 墙上时钟被调整了 jumpMs：按调整前的时间推算进度，剩余时间不出现负数，也不超过计划时长
    const expectedNow = now - jumpMs;
    const run = elapsedMs(row, expectedNow);
    const remaining = Math.max(60_000, Math.min(row.planned_ms - run, (row.due_at ?? expectedNow) - expectedNow));
    db.run(
      `UPDATE focus_sessions SET status = 'paused', run_ms = ?, remaining_ms = ?, due_at = NULL, segment_started_at = NULL,
         pause_reason = 'clock_jump', revision = revision + 1, updated_at = ? WHERE id = ?`,
      run,
      remaining,
      now,
      row.id,
    );
    db.run(
      `INSERT OR IGNORE INTO inbox_items (id, source_type, source_id, source_revision, category, status, due_at, created_at,
         popup_skipped_at)
       VALUES (?, 'focus', ?, ?, 'focus_paused', 'unread', NULL, ?, ?)`,
      newId(),
      row.id,
      row.revision + 1,
      now,
      now,
    );
    return true;
  });
}

export function isFocusRunning(db: Database): boolean {
  return !!db.get(`SELECT 1 FROM focus_sessions WHERE status = 'running'`);
}

export function focusNotice(db: Database, sessionId: string, category: string): string {
  const row = findSession(db, sessionId);
  if (!row) return '';
  const minutes = Math.round(row.planned_ms / 60_000);
  if (category === 'focus_paused') return '系统时间变化较大，专注已暂停。请到沙漏确认剩余时间后继续。';
  const late = row.settled_late === 1 ? '（期间电脑处于睡眠、锁屏或应用未运行）' : '';
  return `专注 ${minutes} 分钟结束啦${late}`;
}

export const focusQueries = [
  defineQuery({
    name: 'focus.state',
    input: z.object({}).strict(),
    run: ({ db }): { active: FocusDto | null; recent: FocusDto[] } => {
      const active = activeSession(db);
      return {
        active: active ? toFocusDto(db, active) : null,
        recent: db
          .all<FocusRow>(
            `SELECT ${COLUMNS} FROM focus_sessions WHERE active_slot IS NULL AND status != 'cancelled'
             ORDER BY ended_at DESC LIMIT 10`,
          )
          .map((row) => toFocusDto(db, row)),
      };
    },
  }),
];
