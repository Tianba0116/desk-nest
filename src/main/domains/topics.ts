// 事项（R11）：持续一段时间的事，例如“准备产品经理面试”。当前进展直接读这里（TD §9.1）。
// 完成、归档、忘记、删除时，在同一事务里取消尚未到期的跟进（R12.AC-5）。
// 忘记：不再用于对话但保留，可以恢复；删除：彻底删除本机记录（R11.AC-7）。

import { z } from 'zod';
import { CommandErrorCodes } from '../../shared/contracts/command';
import {
  TOPIC_PROGRESS_MAX,
  TOPIC_STATUS_LABELS,
  TOPIC_TITLE_MAX,
  type SourceDto,
  type TopicDetailDto,
  type TopicDto,
  type TopicStatus,
} from '../../shared/contracts/memory';
import {
  CommandError,
  defineCommand,
  requireExplicit,
  requireRevision,
  sourceMessageId,
  sourceTypeOf,
} from '../application/commands';
import { bumpContext } from '../application/context-state';
import { defineQuery } from '../application/queries';
import type { Database } from '../storage/database';
import { closeFollowUpsForTarget } from './reminders';
import { normalizeForSearch } from './text-search';

export interface TopicRow {
  id: string;
  title: string;
  status: TopicStatus;
  progress_note: string;
  progress_updated_at: number | null;
  completed_at: number | null;
  source_type: 'conversation' | 'ui';
  source_message_id: string | null;
  forgotten_at: number | null;
  revision: number;
  created_at: number;
  updated_at: number;
}

const COLUMNS =
  'id, title, status, progress_note, progress_updated_at, completed_at, source_type, source_message_id, forgotten_at, revision, created_at, updated_at';

export function findTopic(db: Database, id: string): TopicRow | undefined {
  return db.get<TopicRow>(`SELECT ${COLUMNS} FROM topics WHERE id = ?`, id);
}

/** 来源（R11.AC-4）：哪次对话或哪次表单操作 */
export function sourceOf(db: Database, type: 'conversation' | 'ui', messageId: string | null, at: number): SourceDto {
  const message = messageId ? db.get<{ content: string }>('SELECT content FROM messages WHERE id = ?', messageId) : undefined;
  return { type, messageText: message ? message.content.slice(0, 120) : null, at };
}

export function toTopicDto(db: Database, row: TopicRow): TopicDto {
  return {
    id: row.id,
    title: row.title,
    status: row.status,
    progressNote: row.progress_note,
    progressUpdatedAt: row.progress_updated_at,
    completedAt: row.completed_at,
    forgottenAt: row.forgotten_at,
    source: sourceOf(db, row.source_type, row.source_message_id, row.created_at),
    revision: row.revision,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function mustLoad(db: Database, id: string): TopicDto {
  const row = findTopic(db, id);
  if (!row) throw new CommandError(CommandErrorCodes.notFound);
  return toTopicDto(db, row);
}

/** 可以被操作的事项：存在且没有被忘记 */
function liveTopic(db: Database, id: string, revision?: number): TopicRow {
  const row = findTopic(db, id);
  if (!row || row.forgotten_at !== null) throw new CommandError(CommandErrorCodes.notFound, '找不到这个事项');
  if (revision !== undefined && row.revision !== revision) {
    throw new CommandError(CommandErrorCodes.revisionConflict, '事项已在别处修改，请刷新后重试');
  }
  return row;
}

const Id = z.string().min(1).max(100);
const Title = z.string().trim().min(1, '事项名称不能为空').max(TOPIC_TITLE_MAX);
const Progress = z.string().trim().max(TOPIC_PROGRESS_MAX);
const Revision = z.number().int().positive();

/** 明确要求记住的说法（R11.AC-1）：一般分享不会自动创建事项 */
export const EXPLICIT_REMEMBER = /记住|记下|记一下|记着|记录一下|别忘|不要忘|帮我记|记得我/;
const EXPLICIT_PROGRESS = /记|进展|进度|更新/;
const EXPLICIT_DONE = /完成|搞定|结束|做完|弄完|告一段落|了结|不用再|已经.{0,6}(好|过)了|结果出来/;
const EXPLICIT_FORGET = /忘|别再提|不要再提|不用记|删掉|删除/;

export const createTopic = defineCommand({
  name: 'topics.create',
  input: z.object({ title: Title, progress: Progress.default('') }),
  invalidates: ['topics'],
  tool: {
    description:
      '记住用户正在忙的一件事（事项），例如“记住我在准备产品经理面试”。只有用户明确说“记住……”时调用；一般的分享、抱怨不要调用。已经列在系统提示里的事项不要重复创建。',
    parameters: z.object({
      title: z.string().trim().max(TOPIC_TITLE_MAX).describe('事项名称，简短，用用户的原话，例如“准备产品经理面试”'),
      progress: z.string().trim().max(TOPIC_PROGRESS_MAX).nullish().describe('用户同时说了进展才填'),
    }),
    risk: 'undoable',
    prepare(raw, ctx) {
      const args = raw as { title: string; progress?: string | null };
      if (!args.title) return { kind: 'needs_input', missing: ['title'], question: '要我记住哪件事呢？', partial: args };
      const input = { title: args.title, progress: args.progress ?? '' };
      return requireExplicit(ctx, EXPLICIT_REMEMBER, { input }, {
        question: `要我把“${args.title}”记成一件正在进行的事吗？`,
        label: '记住这件事',
        partial: args,
      });
    },
    summarize(result) {
      return `已记住事项“${(result as TopicDto).title}”`;
    },
    card(db, result) {
      const row = findTopic(db, (result as TopicDto).id);
      return { topic: row ? toTopicDto(db, row) : null };
    },
    undo(result) {
      return { command: 'topics.forget', input: { id: (result as TopicDto).id } };
    },
  },
  execute({ db, now, newId, meta }, input): TopicDto {
    const id = newId();
    db.run(
      `INSERT INTO topics (id, title, status, progress_note, progress_updated_at, search_text, source_type, source_message_id,
         revision, created_at, updated_at)
       VALUES (?, ?, 'active', ?, ?, ?, ?, ?, 1, ?, ?)`,
      id,
      input.title,
      input.progress,
      input.progress ? now : null,
      normalizeForSearch(`${input.title}\n${input.progress}`),
      sourceTypeOf(meta),
      sourceMessageId(db, meta),
      now,
      now,
    );
    return mustLoad(db, id);
  },
});

/** 修改名称是一次纠正：旧说法不再通过聊天历史出现（TD §9.4） */
export const updateTopic = defineCommand({
  name: 'topics.update',
  input: z.object({ id: Id, revision: Revision, title: Title }),
  invalidates: ['topics', 'context'],
  execute({ db, now }, input): TopicDto {
    const row = liveTopic(db, input.id, input.revision);
    if (row.title === input.title) return toTopicDto(db, row);
    db.run(
      `UPDATE topics SET title = ?, search_text = ?, revision = revision + 1, updated_at = ? WHERE id = ?`,
      input.title,
      normalizeForSearch(`${input.title}\n${row.progress_note}`),
      now,
      input.id,
    );
    bumpContext(db, now, 'topic_corrected', [row.source_message_id]);
    return mustLoad(db, input.id);
  },
});

export const recordTopicProgress = defineCommand({
  name: 'topics.recordProgress',
  input: z.object({ id: Id, revision: Revision.optional(), note: Progress }),
  invalidates: ['topics'],
  tool: {
    description: '记录某个事项的最新进展，例如“简历改好了，帮我记一下进展”。id 必须来自系统提示里列出的事项；对不上或有多个可能时先问用户。',
    parameters: z.object({
      id: z.string().max(100).describe('事项 id'),
      note: z.string().trim().min(1).max(TOPIC_PROGRESS_MAX).describe('最新进展，用用户的原话'),
    }),
    risk: 'undoable',
    prepare(raw, ctx) {
      const args = raw as { id: string; note: string };
      const topic = findTopic(ctx.db, args.id);
      if (!topic || topic.forgotten_at !== null) {
        return { kind: 'needs_input', missing: ['target'], question: '是哪件事的进展呢？', partial: args };
      }
      return requireExplicit(ctx, EXPLICIT_PROGRESS, { input: args }, {
        question: `要把“${args.note}”记成“${topic.title}”的最新进展吗？`,
        label: '记下进展',
        partial: args,
      });
    },
    summarize(result) {
      const t = result as TopicDto;
      return `已记下“${t.title}”的进展：${t.progressNote}`;
    },
    card(db, result) {
      const row = findTopic(db, (result as TopicDto).id);
      return { topic: row ? toTopicDto(db, row) : null };
    },
  },
  execute({ db, now }, input): TopicDto {
    const row = liveTopic(db, input.id, input.revision);
    db.run(
      `UPDATE topics SET progress_note = ?, progress_updated_at = ?, search_text = ?, revision = revision + 1,
         updated_at = ? WHERE id = ?`,
      input.note,
      input.note ? now : null,
      normalizeForSearch(`${row.title}
${input.note}`),
      now,
      input.id,
    );
    return mustLoad(db, input.id);
  },
});

export const setTopicStatus = defineCommand({
  name: 'topics.setStatus',
  input: z.object({ id: Id, revision: Revision.optional(), status: z.enum(['active', 'done', 'archived']) }),
  invalidates: ['topics', 'reminders', 'inbox'],
  tool: {
    description: '用户明确说某件事已经完成或结束时，把对应事项标为完成（status=done）。未到期的跟进会自动取消。id 必须来自系统提示里列出的事项。',
    parameters: z.object({ id: z.string().max(100).describe('事项 id'), status: z.enum(['done']).describe('只能填 done') }),
    risk: 'undoable',
    prepare(raw, ctx) {
      const args = raw as { id: string; status: 'done' };
      const topic = findTopic(ctx.db, args.id);
      if (!topic || topic.forgotten_at !== null) {
        return { kind: 'needs_input', missing: ['target'], question: '是哪件事完成了呢？', partial: args };
      }
      return requireExplicit(ctx, EXPLICIT_DONE, { input: args }, {
        question: `要把“${topic.title}”标为已完成吗？`,
        label: '标为已完成',
        partial: args,
      });
    },
    summarize(result) {
      const t = result as TopicDto;
      return `事项“${t.title}”已标为${TOPIC_STATUS_LABELS[t.status]}`;
    },
    card(db, result) {
      const row = findTopic(db, (result as TopicDto).id);
      return { topic: row ? toTopicDto(db, row) : null };
    },
    undo(result) {
      return { command: 'topics.setStatus', input: { id: (result as TopicDto).id, status: 'active' } };
    },
  },
  execute({ db, now, newId }, input): TopicDto {
    const row = liveTopic(db, input.id, input.revision);
    if (row.status === input.status) return toTopicDto(db, row);
    db.run(
      `UPDATE topics SET status = ?, completed_at = ?, revision = revision + 1, updated_at = ? WHERE id = ?`,
      input.status,
      input.status === 'done' ? now : null,
      now,
      input.id,
    );
    if (input.status !== 'active') closeFollowUpsForTarget(db, 'topic', input.id, input.status, now, newId);
    return mustLoad(db, input.id);
  },
});

export const forgetTopic = defineCommand({
  name: 'topics.forget',
  input: z.object({ id: Id }),
  invalidates: ['topics', 'reminders', 'inbox', 'tasks', 'context'],
  tool: {
    description: '用户要求忘记某件事时调用（“忘了面试那件事吧”）。之后不再用于对话，用户可以在小窝里恢复。id 必须来自系统提示里列出的事项。',
    parameters: z.object({ id: z.string().max(100).describe('事项 id') }),
    risk: 'undoable',
    prepare(raw, ctx) {
      const args = raw as { id: string };
      const topic = findTopic(ctx.db, args.id);
      if (!topic || topic.forgotten_at !== null) {
        return { kind: 'needs_input', missing: ['target'], question: '要忘记哪件事呢？', partial: args };
      }
      return requireExplicit(ctx, EXPLICIT_FORGET, { input: args }, {
        question: `要忘记“${topic.title}”吗？`,
        label: '忘记这件事',
        partial: args,
      });
    },
    summarize(result) {
      return `已忘记事项“${(result as TopicDto).title}”，之后不会再提起`;
    },
    card(db, result) {
      const row = findTopic(db, (result as TopicDto).id);
      return { topic: row ? toTopicDto(db, row) : null };
    },
    undo(result) {
      return { command: 'topics.restore', input: { id: (result as TopicDto).id } };
    },
  },
  execute({ db, now, newId }, input): TopicDto {
    const row = findTopic(db, input.id);
    if (!row) throw new CommandError(CommandErrorCodes.notFound);
    if (row.forgotten_at !== null) return toTopicDto(db, row);
    db.run('UPDATE topics SET forgotten_at = ?, revision = revision + 1, updated_at = ? WHERE id = ?', now, now, input.id);
    closeFollowUpsForTarget(db, 'topic', input.id, 'forgotten', now, newId);
    bumpContext(db, now, 'topic_forgotten', [row.source_message_id]);
    return mustLoad(db, input.id);
  },
});

export const restoreTopic = defineCommand({
  name: 'topics.restore',
  input: z.object({ id: Id }),
  invalidates: ['topics'],
  execute({ db, now }, input): TopicDto {
    const row = findTopic(db, input.id);
    if (!row) throw new CommandError(CommandErrorCodes.notFound);
    if (row.forgotten_at === null) return toTopicDto(db, row);
    db.run('UPDATE topics SET forgotten_at = NULL, revision = revision + 1, updated_at = ? WHERE id = ?', now, input.id);
    return mustLoad(db, input.id);
  },
});

/** 删除本机记录（R11.AC-7）：事项本身彻底删除；关联的待办保留但解除关联 */
export const deleteTopic = defineCommand({
  name: 'topics.delete',
  input: z.object({ id: Id, revision: Revision.optional() }),
  invalidates: ['topics', 'reminders', 'inbox', 'tasks', 'context'],
  execute({ db, now, newId }, input): { id: string } {
    const row = findTopic(db, input.id);
    requireRevision(row, input.revision);
    closeFollowUpsForTarget(db, 'topic', input.id, 'deleted', now, newId);
    db.run('UPDATE tasks SET topic_id = NULL, updated_at = ? WHERE topic_id = ?', now, input.id);
    db.run('DELETE FROM topics WHERE id = ?', input.id);
    bumpContext(db, now, 'topic_deleted', [(row as TopicRow).source_message_id]);
    return { id: input.id };
  },
});

export const topicCommands = [createTopic, updateTopic, recordTopicProgress, setTopicStatus, forgetTopic, restoreTopic, deleteTopic];

// ---------- 查询 ----------

/** 进行中、没有被忘记的事项：进入对话上下文（TD §9.3） */
export function activeTopics(db: Database, limit = 10): TopicRow[] {
  return db.all<TopicRow>(
    `SELECT ${COLUMNS} FROM topics WHERE forgotten_at IS NULL AND status = 'active' ORDER BY updated_at DESC LIMIT ?`,
    limit,
  );
}

/** 最近完成的事项：用户问起时可以回答“已经完成了” */
export function recentClosedTopics(db: Database, limit = 5): TopicRow[] {
  return db.all<TopicRow>(
    `SELECT ${COLUMNS} FROM topics WHERE forgotten_at IS NULL AND status != 'active' ORDER BY updated_at DESC LIMIT ?`,
    limit,
  );
}

function detail(db: Database, row: TopicRow): TopicDetailDto {
  return {
    ...toTopicDto(db, row),
    tasks: db.all<{ id: string; title: string; status: 'open' | 'done' }>(
      `SELECT id, title, status FROM tasks WHERE topic_id = ? AND deleted_at IS NULL ORDER BY created_at`,
      row.id,
    ),
    followUps: db
      .all<{ id: string; content: string; due_at: number; revision: number; stop_policy: 'on_target_closed' | 'none' }>(
        `SELECT id, content, due_at, revision, stop_policy FROM scheduled_actions
         WHERE kind = 'follow_up' AND target_type = 'topic' AND target_id = ? AND status = 'scheduled' ORDER BY due_at`,
        row.id,
      )
      .map((f) => ({ id: f.id, content: f.content, dueAt: f.due_at, revision: f.revision, stopPolicy: f.stop_policy })),
  };
}

export function searchTopics(db: Database, terms: { sql: string; params: string[] }, limit = 50): TopicDto[] {
  return db
    .all<TopicRow>(
      `SELECT ${COLUMNS} FROM topics WHERE forgotten_at IS NULL AND ${terms.sql} ORDER BY updated_at DESC LIMIT ?`,
      ...terms.params,
      limit,
    )
    .map((row) => toTopicDto(db, row));
}

export const topicQueries = [
  defineQuery({
    name: 'topics.list',
    input: z.object({}).strict(),
    run: ({ db }): { active: TopicDetailDto[]; closed: TopicDetailDto[]; forgotten: TopicDto[] } => ({
      active: db
        .all<TopicRow>(`SELECT ${COLUMNS} FROM topics WHERE forgotten_at IS NULL AND status = 'active' ORDER BY updated_at DESC`)
        .map((row) => detail(db, row)),
      closed: db
        .all<TopicRow>(
          `SELECT ${COLUMNS} FROM topics WHERE forgotten_at IS NULL AND status != 'active' ORDER BY updated_at DESC LIMIT 100`,
        )
        .map((row) => detail(db, row)),
      forgotten: db
        .all<TopicRow>(`SELECT ${COLUMNS} FROM topics WHERE forgotten_at IS NOT NULL ORDER BY forgotten_at DESC LIMIT 100`)
        .map((row) => toTopicDto(db, row)),
    }),
  }),
];

