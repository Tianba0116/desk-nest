// 对话的持久化（TD §5.2 turns/messages、§7.2）。
// 发送和重试是带 operationId 的命令：用户消息与轮次在同一事务提交，网络请求在事务外。

import { z } from 'zod';
import { CHAT_MESSAGE_MAX, type ChatMessageDto, type MessageStatus, type ModelErrorCode } from '../../shared/contracts/chat';
import { CommandErrorCodes } from '../../shared/contracts/command';
import { CommandError, defineCommand } from '../application/commands';
import type { Database } from '../storage/database';
import { reconcileReadyActions } from './actions';

export const DEFAULT_CONVERSATION = 'default';
/** 模型只携带有限的近期历史（R05.AC-6） */
export const CONTEXT_MESSAGE_LIMIT = 12;

interface MessageRow {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  status: MessageStatus;
  turn_id: string | null;
  created_at: number;
}

export interface TurnRow {
  id: string;
  conversation_id: string;
  user_message_id: string;
  state: 'requesting' | 'responding' | 'completed' | 'failed' | 'cancelled' | 'interrupted';
  error_code: string | null;
  model: string | null;
  created_at: number;
}

function toDto(row: MessageRow): ChatMessageDto {
  return { id: row.id, role: row.role, content: row.content, status: row.status, turnId: row.turn_id, createdAt: row.created_at };
}

function activeTurn(db: Database, conversationId: string): TurnRow | undefined {
  return db.get<TurnRow>(
    `SELECT * FROM turns WHERE conversation_id = ? AND state IN ('requesting', 'responding')`,
    conversationId,
  );
}

export const sendMessage = defineCommand({
  name: 'chat.send',
  input: z.object({
    text: z.string().trim().min(1, '消息不能为空').max(CHAT_MESSAGE_MAX),
    model: z.string().max(300),
  }),
  invalidates: ['conversation'],
  execute({ db, now, newId }, input): { userMessageId: string; turnId: string } {
    // 同一对话同一时间只有一个进行中的轮次（TD §7.2）
    if (activeTurn(db, DEFAULT_CONVERSATION)) throw new CommandError(CommandErrorCodes.invalidState, 'BUSY');
    const userMessageId = newId();
    const turnId = newId();
    db.run(
      `INSERT INTO messages (id, conversation_id, turn_id, role, content, status, created_at)
       VALUES (?, ?, ?, 'user', ?, 'sent', ?)`,
      userMessageId,
      DEFAULT_CONVERSATION,
      turnId,
      input.text,
      now,
    );
    db.run(
      `INSERT INTO turns (id, conversation_id, user_message_id, state, model, created_at)
       VALUES (?, ?, ?, 'requesting', ?, ?)`,
      turnId,
      DEFAULT_CONVERSATION,
      userMessageId,
      input.model,
      now,
    );
    return { userMessageId, turnId };
  },
});

/** 失败、停止或中断后重试：沿用同一条用户消息，不重复保存（R05.AC-4） */
export const retryMessage = defineCommand({
  name: 'chat.retry',
  input: z.object({ userMessageId: z.string().min(1).max(100), model: z.string().max(300) }),
  invalidates: ['conversation'],
  execute({ db, now, newId }, input): { turnId: string } {
    const message = db.get<MessageRow>(`SELECT * FROM messages WHERE id = ? AND role = 'user'`, input.userMessageId);
    if (!message) throw new CommandError(CommandErrorCodes.notFound);
    if (activeTurn(db, DEFAULT_CONVERSATION)) throw new CommandError(CommandErrorCodes.invalidState, 'BUSY');
    const answered = db.get(
      `SELECT 1 FROM turns WHERE user_message_id = ? AND state = 'completed'`,
      input.userMessageId,
    );
    if (answered) throw new CommandError(CommandErrorCodes.invalidState, '这条消息已经有回复了');
    const turnId = newId();
    // 上次未完成的回复不再进入上下文
    db.run(
      `UPDATE messages SET context_excluded_at = ? WHERE role = 'assistant' AND turn_id IN
         (SELECT id FROM turns WHERE user_message_id = ?) AND context_excluded_at IS NULL`,
      now,
      input.userMessageId,
    );
    db.run(`UPDATE messages SET status = 'sent', turn_id = ? WHERE id = ?`, turnId, input.userMessageId);
    db.run(
      `INSERT INTO turns (id, conversation_id, user_message_id, state, model, created_at)
       VALUES (?, ?, ?, 'requesting', ?, ?)`,
      turnId,
      DEFAULT_CONVERSATION,
      input.userMessageId,
      input.model,
      now,
    );
    return { turnId };
  },
});

export const chatCommands = [sendMessage, retryMessage];

// ---------- 轮次结束（runner 调用；短事务，不经过 UI） ----------

export function loadTurn(db: Database, turnId: string): TurnRow | undefined {
  return db.get<TurnRow>('SELECT * FROM turns WHERE id = ?', turnId);
}

export function loadMessage(db: Database, id: string): { id: string; content: string; created_at: number } | undefined {
  return db.get('SELECT id, content, created_at FROM messages WHERE id = ?', id);
}

export function markResponding(db: Database, turnId: string): void {
  db.run(`UPDATE turns SET state = 'responding' WHERE id = ? AND state = 'requesting'`, turnId);
}

export type TurnOutcome =
  | { kind: 'completed'; text: string }
  | { kind: 'cancelled'; text: string }
  | { kind: 'failed'; text: string; errorCode: ModelErrorCode };

/** 对比流式方案用的计时与计数（D-06）；只存本机 */
export interface TurnMetrics {
  strategy: string;
  /** 本轮模型请求次数 */
  requests: number;
  /** 从开始请求到界面出现第一个字（毫秒）；没有显示文字时为 null */
  firstVisibleMs: number | null;
  totalMs: number;
  toolCalls: number;
  /** 单次流式 + 撤回：是否收起过已显示的文字，收起前显示了多少字、是否包含成功声明 */
  retracted: boolean;
  retractedChars: number;
  retractedClaim: boolean;
  /** 发送和收到的字符数（服务没有统一返回 token 用量，用字符数近似） */
  promptChars: number;
  outputChars: number;
  repaired: boolean;
  /** 操作已执行、但表达阶段失败：用本地文字收尾 */
  expressFailed: boolean;
  /** 服务拒绝了带工具的请求，本轮改为只聊天 */
  toolsRejected: boolean;
}

export function finishTurn(
  db: Database,
  turnId: string,
  outcome: TurnOutcome,
  now: number,
  newId: () => string,
  metrics?: TurnMetrics,
): void {
  db.transaction(() => {
    const turn = loadTurn(db, turnId);
    if (!turn || (turn.state !== 'requesting' && turn.state !== 'responding')) return;
    const state = outcome.kind;
    db.run(
      `UPDATE turns SET state = ?, error_code = ?, ended_at = ?, strategy = ?, metrics_json = ? WHERE id = ?`,
      state,
      outcome.kind === 'failed' ? outcome.errorCode : null,
      now,
      metrics?.strategy ?? null,
      metrics ? JSON.stringify(metrics) : null,
      turnId,
    );
    if (outcome.text) {
      const status: MessageStatus = outcome.kind === 'completed' ? 'complete' : outcome.kind === 'cancelled' ? 'cancelled' : 'failed';
      db.run(
        `INSERT INTO messages (id, conversation_id, turn_id, role, content, status, created_at)
         VALUES (?, ?, ?, 'assistant', ?, ?, ?)`,
        newId(),
        turn.conversation_id,
        turnId,
        outcome.text,
        status,
        now,
      );
    }
    // 没有拿到完整回复：用户消息保留为“待重试”，由用户决定是否重发（R18.AC-5）
    if (outcome.kind !== 'completed') {
      db.run(`UPDATE messages SET status = 'pending_retry' WHERE id = ?`, turn.user_message_id);
    }
  });
}

/** 启动时：上次运行中未完成的轮次标为中断，不自动重发（TD §7.4） */
export function interruptUnfinishedTurns(db: Database, now: number): number {
  // 先按收据恢复执行到一半的模型操作，已提交的保留为结果卡片
  reconcileReadyActions(db, now);
  return db.transaction(() => {
    const rows = db.all<TurnRow>(`SELECT * FROM turns WHERE state IN ('requesting', 'responding')`);
    for (const row of rows) {
      db.run(`UPDATE turns SET state = 'interrupted', ended_at = ? WHERE id = ?`, now, row.id);
      db.run(`UPDATE messages SET status = 'pending_retry' WHERE id = ?`, row.user_message_id);
    }
    return rows.length;
  });
}

/** 有效的近期历史：已发送的用户消息和完整的回复，不含失败、停止、被排除的内容 */
export function recentContext(db: Database, beforeMessageId: string, limit = CONTEXT_MESSAGE_LIMIT): ChatMessageDto[] {
  const current = db.get<MessageRow>('SELECT * FROM messages WHERE id = ?', beforeMessageId);
  if (!current) return [];
  const rows = db.all<MessageRow>(
    `SELECT m.* FROM messages m
     WHERE m.conversation_id = ? AND m.created_at <= ? AND m.id != ? AND m.context_excluded_at IS NULL
       AND ((m.role = 'assistant' AND m.status = 'complete')
         OR (m.role = 'user' AND EXISTS (SELECT 1 FROM turns t WHERE t.user_message_id = m.id AND t.state = 'completed')))
     ORDER BY m.created_at DESC, m.rowid DESC LIMIT ?`,
    DEFAULT_CONVERSATION,
    current.created_at,
    current.id,
    limit,
  );
  const ordered = rows.reverse().map(toDto);
  // 上下文从用户消息开始，不留下孤立的回复
  while (ordered[0]?.role === 'assistant') ordered.shift();
  return [...ordered, toDto(current)];
}

export function chatHistory(db: Database, limit = 200): ChatMessageDto[] {
  return db
    .all<MessageRow>(
      `SELECT * FROM messages WHERE conversation_id = ? ORDER BY created_at DESC, rowid DESC LIMIT ?`,
      DEFAULT_CONVERSATION,
      limit,
    )
    .reverse()
    .map(toDto);
}
