// 本机聊天记录的保留和删除（R19.AC-7、D-08）：默认永久，可选 90 天、30 天；可以删除单条或按时间范围删除。
// 删除后不再进入上下文；相关动作账本一并清理（卡片随之消失，业务记录本身保留），来源显示“消息已删除”（TD §9.4）。

import { z } from 'zod';
import { CommandErrorCodes } from '../../shared/contracts/command';
import { CommandError, defineCommand } from '../application/commands';
import { defineQuery } from '../application/queries';
import type { Database } from '../storage/database';

export const RETENTION_KEY = 'chat.retentionDays';
export const RETENTION_OPTIONS = [30, 90] as const;
const DAY_MS = 24 * 60 * 60 * 1000;

export function readRetentionDays(db: Database): 30 | 90 | null {
  const row = db.get<{ value_json: string }>('SELECT value_json FROM app_settings WHERE key = ?', RETENTION_KEY);
  const value = row ? Number(JSON.parse(row.value_json)) : null;
  return value === 30 || value === 90 ? value : null;
}

function requireIdle(db: Database): void {
  if (db.get(`SELECT 1 FROM turns WHERE state IN ('requesting', 'responding')`)) {
    throw new CommandError(CommandErrorCodes.invalidState, '回复进行中，稍后再删除');
  }
}

/** 删除用户消息时连同它的各轮回复、轮次和动作账本；返回删除的消息数 */
function deleteMessageIds(db: Database, ids: string[]): number {
  let deleted = 0;
  for (const id of ids) {
    const message = db.get<{ id: string; role: string }>('SELECT id, role FROM messages WHERE id = ?', id);
    if (!message) continue;
    if (message.role === 'user') {
      const turns = db.all<{ id: string }>('SELECT id FROM turns WHERE user_message_id = ?', id).map((t) => t.id);
      for (const turnId of turns) {
        deleted += db.run('DELETE FROM messages WHERE turn_id = ? AND id != ?', turnId, id).changes;
        db.run('DELETE FROM turn_actions WHERE turn_id = ?', turnId);
        db.run('DELETE FROM turns WHERE id = ?', turnId);
      }
    }
    deleted += db.run('DELETE FROM messages WHERE id = ?', id).changes;
    db.run(`DELETE FROM context_exclusions WHERE source_type = 'message' AND source_id = ?`, id);
  }
  return deleted;
}

export const deleteChatMessage = defineCommand({
  name: 'chat.deleteMessage',
  input: z.object({ messageId: z.string().min(1).max(100) }),
  invalidates: ['conversation'],
  execute({ db }, input): { deleted: number } {
    requireIdle(db);
    if (!db.get('SELECT 1 FROM messages WHERE id = ?', input.messageId)) throw new CommandError(CommandErrorCodes.notFound);
    return { deleted: deleteMessageIds(db, [input.messageId]) };
  },
});

export const deleteChatRange = defineCommand({
  name: 'chat.deleteRange',
  input: z.object({ range: z.enum(['hour', 'today', 'all']) }),
  invalidates: ['conversation'],
  execute({ db, now }, input): { deleted: number } {
    requireIdle(db);
    let since = 0;
    if (input.range === 'hour') since = now - 60 * 60 * 1000;
    if (input.range === 'today') {
      const d = new Date(now);
      d.setHours(0, 0, 0, 0);
      since = d.getTime();
    }
    const ids = db.all<{ id: string }>('SELECT id FROM messages WHERE created_at >= ? ORDER BY created_at', since).map((m) => m.id);
    return { deleted: deleteMessageIds(db, ids) };
  },
});

export const setChatRetention = defineCommand({
  name: 'chat.setRetention',
  input: z.object({ days: z.union([z.literal(30), z.literal(90), z.null()]) }),
  invalidates: ['settings', 'conversation'],
  execute({ db, now }, input): { days: 30 | 90 | null; deleted: number } {
    if (input.days === null) db.run('DELETE FROM app_settings WHERE key = ?', RETENTION_KEY);
    else {
      db.run(
        `INSERT INTO app_settings (key, value_json, schema_version, updated_at) VALUES (?, ?, 1, ?)
         ON CONFLICT (key) DO UPDATE SET value_json = excluded.value_json, updated_at = excluded.updated_at`,
        RETENTION_KEY,
        JSON.stringify(input.days),
        now,
      );
    }
    return { days: input.days, deleted: input.days === null ? 0 : purgeExpiredChat(db, now) };
  },
});

/** 每天的维护：删除超过保留期限的聊天记录；进行中的轮次不动 */
export function purgeExpiredChat(db: Database, now: number): number {
  const days = readRetentionDays(db);
  if (days === null) return 0;
  const ids = db
    .all<{ id: string }>(
      `SELECT m.id FROM messages m WHERE m.created_at < ?
         AND NOT EXISTS (SELECT 1 FROM turns t WHERE t.state IN ('requesting', 'responding')
                         AND (t.user_message_id = m.id OR t.id = m.turn_id))`,
      now - days * DAY_MS,
    )
    .map((m) => m.id);
  return deleteMessageIds(db, ids);
}

export const chatHistoryCommands = [deleteChatMessage, deleteChatRange, setChatRetention];

export const chatHistoryQueries = [
  defineQuery({
    name: 'chat.settings',
    input: z.object({}).strict(),
    run: ({ db }): { retentionDays: 30 | 90 | null; messageCount: number } => ({
      retentionDays: readRetentionDays(db),
      messageCount: db.get<{ n: number }>('SELECT COUNT(*) AS n FROM messages')?.n ?? 0,
    }),
  }),
];
