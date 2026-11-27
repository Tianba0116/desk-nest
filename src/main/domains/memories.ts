// 记忆（R11）：用户明确要求记住的简短信息，例如“我对花生过敏”。临时信息带有效期，过期后不再使用（R11.AC-6）。
// 忘记：不再用于对话但保留，可以恢复；删除：彻底删除本机记录（R11.AC-7）。

import { z } from 'zod';
import { CommandErrorCodes } from '../../shared/contracts/command';
import { MEMORY_CONTENT_MAX, type MemoryDto } from '../../shared/contracts/memory';
import { formatTime } from '../../shared/format-time';
import { CommandError, defineCommand, requireExplicit, sourceMessageId, sourceTypeOf } from '../application/commands';
import { bumpContext } from '../application/context-state';
import { defineQuery } from '../application/queries';
import { endOfPeriod } from '../application/time-resolver';
import type { Database } from '../storage/database';
import { normalizeForSearch } from './text-search';
import { EXPLICIT_REMEMBER, sourceOf } from './topics';

interface MemoryRow {
  id: string;
  content: string;
  expires_at: number | null;
  search_text: string;
  source_type: 'conversation' | 'ui';
  source_message_id: string | null;
  forgotten_at: number | null;
  revision: number;
  created_at: number;
  updated_at: number;
}

const COLUMNS =
  'id, content, expires_at, search_text, source_type, source_message_id, forgotten_at, revision, created_at, updated_at';

function findMemory(db: Database, id: string): MemoryRow | undefined {
  return db.get<MemoryRow>(`SELECT ${COLUMNS} FROM memories WHERE id = ?`, id);
}

function toMemoryDto(db: Database, row: MemoryRow, now: number): MemoryDto {
  return {
    id: row.id,
    content: row.content,
    expiresAt: row.expires_at,
    expired: row.expires_at !== null && row.expires_at <= now,
    forgottenAt: row.forgotten_at,
    source: sourceOf(db, row.source_type, row.source_message_id, row.created_at),
    revision: row.revision,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function mustLoad(db: Database, id: string, now: number): MemoryDto {
  const row = findMemory(db, id);
  if (!row) throw new CommandError(CommandErrorCodes.notFound);
  return toMemoryDto(db, row, now);
}

const Id = z.string().min(1).max(100);
const Content = z.string().trim().min(1, '内容不能为空').max(MEMORY_CONTENT_MAX);
const ExpiresAt = z.number().int().positive().nullable();
const EXPLICIT_FORGET = /忘|别再提|不要再提|不用记|删掉|删除/;

const MemoryToolArgs = z.object({
  content: z.string().trim().max(MEMORY_CONTENT_MAX).describe('要记住的信息，用用户的原话整理成一句，例如“对花生过敏”'),
  validFor: z
    .object({
      until: z.enum(['today', 'this_week', 'this_month']).nullish().describe('“今天”today，“这周”this_week，“这个月”this_month'),
      days: z.number().int().min(1).max(365).nullish().describe('“接下来 N 天”填 N'),
    })
    .nullish()
    .describe('只在用户说了期限时填，例如“这周都在出差”；长期有效就留空'),
});

export const createMemory = defineCommand({
  name: 'memories.create',
  input: z.object({ content: Content, expiresAt: ExpiresAt.default(null) }),
  invalidates: ['memories'],
  tool: {
    description:
      '记住用户明确要求记住的一条简短信息，例如“记住我对花生过敏”“记住我这周都在出差”。正在进行的一件事请用 topics_create。一般的聊天内容不要调用。',
    parameters: MemoryToolArgs,
    risk: 'undoable',
    prepare(raw, ctx) {
      const args = raw as z.output<typeof MemoryToolArgs>;
      if (!args.content) return { kind: 'needs_input', missing: ['content'], question: '要我记住什么呢？', partial: args };
      const expiresAt = args.validFor ? endOfPeriod(ctx.baseTime, ctx.timeZone, args.validFor) : null;
      return requireExplicit(ctx, EXPLICIT_REMEMBER, { input: { content: args.content, expiresAt } }, {
        question: `要我记住“${args.content}”吗？`,
        label: '记住',
        partial: args,
      });
    },
    summarize(result) {
      const m = result as MemoryDto;
      return `已记住“${m.content}”${m.expiresAt ? `（到 ${formatTime(m.expiresAt)} 为止）` : ''}`;
    },
    card(db, result) {
      const row = findMemory(db, (result as MemoryDto).id);
      return { memory: row ? toMemoryDto(db, row, Date.now()) : null };
    },
    undo(result) {
      return { command: 'memories.forget', input: { id: (result as MemoryDto).id } };
    },
  },
  execute({ db, now, newId, meta }, input): MemoryDto {
    if (input.expiresAt !== null && input.expiresAt <= now) {
      throw new CommandError(CommandErrorCodes.pastTime, '有效期已经过去了');
    }
    const id = newId();
    db.run(
      `INSERT INTO memories (id, content, expires_at, search_text, source_type, source_message_id, revision, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?)`,
      id,
      input.content,
      input.expiresAt,
      normalizeForSearch(input.content),
      sourceTypeOf(meta),
      sourceMessageId(db, meta),
      now,
      now,
    );
    return mustLoad(db, id, now);
  },
});

/** 修改内容是一次纠正：旧说法不再通过聊天历史出现（TD §9.4） */
export const updateMemory = defineCommand({
  name: 'memories.update',
  input: z.object({ id: Id, revision: z.number().int().positive(), content: Content, expiresAt: ExpiresAt }),
  invalidates: ['memories', 'context'],
  execute({ db, now }, input): MemoryDto {
    const row = findMemory(db, input.id);
    if (!row || row.forgotten_at !== null) throw new CommandError(CommandErrorCodes.notFound);
    if (row.revision !== input.revision) throw new CommandError(CommandErrorCodes.revisionConflict, '内容已在别处修改，请刷新后重试');
    db.run(
      `UPDATE memories SET content = ?, expires_at = ?, search_text = ?, revision = revision + 1, updated_at = ? WHERE id = ?`,
      input.content,
      input.expiresAt,
      normalizeForSearch(input.content),
      now,
      input.id,
    );
    if (row.content !== input.content) bumpContext(db, now, 'memory_corrected', [row.source_message_id]);
    return mustLoad(db, input.id, now);
  },
});

export const forgetMemory = defineCommand({
  name: 'memories.forget',
  input: z.object({ id: Id }),
  invalidates: ['memories', 'context'],
  tool: {
    description: '用户要求忘记某条已记住的信息时调用（“忘掉我对花生过敏这件事”）。id 必须来自系统提示里列出的记忆。',
    parameters: z.object({ id: z.string().max(100).describe('记忆 id') }),
    risk: 'undoable',
    prepare(raw, ctx) {
      const args = raw as { id: string };
      const memory = findMemory(ctx.db, args.id);
      if (!memory || memory.forgotten_at !== null) {
        return { kind: 'needs_input', missing: ['target'], question: '要忘记哪一条呢？我没找到。', partial: args };
      }
      return requireExplicit(ctx, EXPLICIT_FORGET, { input: args }, {
        question: `要忘记“${memory.content}”吗？`,
        label: '忘记这一条',
        partial: args,
      });
    },
    summarize(result) {
      return `已忘记“${(result as MemoryDto).content}”，之后不会再提起`;
    },
    card(db, result) {
      const row = findMemory(db, (result as MemoryDto).id);
      return { memory: row ? toMemoryDto(db, row, Date.now()) : null };
    },
    undo(result) {
      return { command: 'memories.restore', input: { id: (result as MemoryDto).id } };
    },
  },
  execute({ db, now }, input): MemoryDto {
    const row = findMemory(db, input.id);
    if (!row) throw new CommandError(CommandErrorCodes.notFound);
    if (row.forgotten_at !== null) return toMemoryDto(db, row, now);
    db.run('UPDATE memories SET forgotten_at = ?, revision = revision + 1, updated_at = ? WHERE id = ?', now, now, input.id);
    bumpContext(db, now, 'memory_forgotten', [row.source_message_id]);
    return mustLoad(db, input.id, now);
  },
});

export const restoreMemory = defineCommand({
  name: 'memories.restore',
  input: z.object({ id: Id }),
  invalidates: ['memories'],
  execute({ db, now }, input): MemoryDto {
    const row = findMemory(db, input.id);
    if (!row) throw new CommandError(CommandErrorCodes.notFound);
    if (row.forgotten_at === null) return toMemoryDto(db, row, now);
    db.run('UPDATE memories SET forgotten_at = NULL, revision = revision + 1, updated_at = ? WHERE id = ?', now, input.id);
    return mustLoad(db, input.id, now);
  },
});

/** 删除本机记录（R11.AC-7） */
export const deleteMemory = defineCommand({
  name: 'memories.delete',
  input: z.object({ id: Id }),
  invalidates: ['memories', 'context'],
  execute({ db, now }, input): { id: string } {
    const row = findMemory(db, input.id);
    if (!row) throw new CommandError(CommandErrorCodes.notFound);
    db.run('DELETE FROM memories WHERE id = ?', input.id);
    bumpContext(db, now, 'memory_deleted', [row.source_message_id]);
    return { id: input.id };
  },
});

export const memoryCommands = [createMemory, updateMemory, forgetMemory, restoreMemory, deleteMemory];

// ---------- 上下文与查询 ----------

/** 中文两字组：用于不分词的匹配 */
function bigrams(text: string): Set<string> {
  const chars = [...text.replace(/\s+/g, '')];
  const result = new Set<string>();
  for (let i = 0; i + 1 < chars.length; i++) result.add(`${chars[i]}${chars[i + 1]}`);
  return result;
}

/** 泛泛地问“你还记得什么”时带上全部有效记忆（数量不多时） */
const RECALL = /记得|记住了?什么|你知道我|关于我|我的情况/;

/**
 * 与本轮输入匹配的有效记忆（TD §9.3）：已忘记、已过期的不进入上下文。
 * 按两字组重合数和最近更新排序，最多 limit 条；没有明显命中时返回空，不拿无关内容凑数。
 */
export function relevantMemories(db: Database, userText: string, now: number, limit = 8): MemoryDto[] {
  const rows = db.all<MemoryRow>(
    `SELECT ${COLUMNS} FROM memories WHERE forgotten_at IS NULL AND (expires_at IS NULL OR expires_at > ?)
     ORDER BY updated_at DESC LIMIT 200`,
    now,
  );
  const input = bigrams(normalizeForSearch(userText));
  const scored = rows
    .map((row) => {
      let score = 0;
      for (const gram of bigrams(row.search_text)) if (input.has(gram)) score++;
      return { row, score };
    })
    .filter((x) => x.score > 0);
  const picked = scored.length > 0 || !RECALL.test(userText) ? scored : rows.map((row) => ({ row, score: 0 }));
  return picked
    .sort((a, b) => b.score - a.score || b.row.updated_at - a.row.updated_at)
    .slice(0, limit)
    .map(({ row }) => toMemoryDto(db, row, now));
}

export const memoryQueries = [
  defineQuery({
    name: 'memories.list',
    input: z.object({}).strict(),
    run: ({ db, now }): { active: MemoryDto[]; forgotten: MemoryDto[] } => ({
      active: db
        .all<MemoryRow>(`SELECT ${COLUMNS} FROM memories WHERE forgotten_at IS NULL ORDER BY updated_at DESC LIMIT 300`)
        .map((row) => toMemoryDto(db, row, now)),
      forgotten: db
        .all<MemoryRow>(`SELECT ${COLUMNS} FROM memories WHERE forgotten_at IS NOT NULL ORDER BY forgotten_at DESC LIMIT 100`)
        .map((row) => toMemoryDto(db, row, now)),
    }),
  }),
];
