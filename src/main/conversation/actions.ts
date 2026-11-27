// 模型动作账本（TD §5.2 turn_actions、§6.3、§7.4）。
// 每个工具调用先记录再执行；重试、重启时据此恢复，不重新执行已经提交的写入。
// 待补充草稿只保存已知参数，参数完整并通过校验后才形成可执行的操作。

import type { ActionCardDto, ActionCardState } from '../../shared/contracts/chat';
import { CommandErrorCodes, type CommandErrorCode, type CommandResult } from '../../shared/contracts/command';
import type { CommandService, ToolFlags } from '../application/commands';
import type { Database } from '../storage/database';

/** 草稿的有效期（04-roadmap M6） */
export const DRAFT_TTL_MS = 30 * 60_000;
/** 每轮最多的写操作（TD §7.2） */
export const MAX_WRITES_PER_TURN = 4;

export type ActionState = 'awaiting_input' | 'ready' | 'committed' | 'failed' | 'cancelled' | 'resolved';

export interface ActionRow {
  operation_id: string;
  turn_id: string;
  user_message_id: string;
  ordinal: number;
  kind: string;
  args_json: string;
  args_hash: string | null;
  state: ActionState;
  missing_json: string | null;
  question: string | null;
  suggestion_json: string | null;
  error_code: string | null;
  error_detail: string | null;
  result_json: string | null;
  resolved_by: string | null;
  expires_at: number | null;
  created_at: number;
  updated_at: number;
}

export interface StoredSuggestion {
  input: unknown;
  label: string;
  flags?: ToolFlags;
}

interface StoredReady {
  input: unknown;
  flags: ToolFlags;
}

interface ActionBase {
  operationId: string;
  turnId: string;
  userMessageId: string;
  ordinal: number;
  kind: string;
  now: number;
}

export function loadAction(db: Database, operationId: string): ActionRow | undefined {
  return db.get<ActionRow>('SELECT * FROM turn_actions WHERE operation_id = ?', operationId);
}

export function recordDraft(
  db: Database,
  base: ActionBase & { partial: unknown; missing: string[]; question: string; suggestion?: StoredSuggestion },
): void {
  db.run(
    `INSERT INTO turn_actions (operation_id, turn_id, user_message_id, ordinal, kind, args_json, state,
       missing_json, question, suggestion_json, expires_at, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, 'awaiting_input', ?, ?, ?, ?, ?, ?)`,
    base.operationId,
    base.turnId,
    base.userMessageId,
    base.ordinal,
    base.kind,
    JSON.stringify(base.partial ?? {}),
    JSON.stringify(base.missing),
    base.question,
    base.suggestion ? JSON.stringify(base.suggestion) : null,
    base.now + DRAFT_TTL_MS,
    base.now,
    base.now,
  );
}

/** 执行前记录：之后即使进程崩溃，也能凭收据判断是否已经提交 */
export function recordReady(db: Database, base: ActionBase & { input: unknown; hash: string; flags: ToolFlags }): void {
  db.run(
    `INSERT INTO turn_actions (operation_id, turn_id, user_message_id, ordinal, kind, args_json, args_hash, state,
       created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, 'ready', ?, ?)`,
    base.operationId,
    base.turnId,
    base.userMessageId,
    base.ordinal,
    base.kind,
    JSON.stringify({ input: base.input, flags: base.flags } satisfies StoredReady),
    base.hash,
    base.now,
    base.now,
  );
}

/** 超出本轮写操作上限：不执行，只留下记录 */
export function recordSkipped(db: Database, base: ActionBase & { input: unknown }): void {
  db.run(
    `INSERT INTO turn_actions (operation_id, turn_id, user_message_id, ordinal, kind, args_json, state, error_code,
       created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, 'cancelled', 'LIMIT', ?, ?)`,
    base.operationId,
    base.turnId,
    base.userMessageId,
    base.ordinal,
    base.kind,
    JSON.stringify({ input: base.input, flags: {} }),
    base.now,
    base.now,
  );
}

export function markCommitted(db: Database, operationId: string, result: unknown, now: number): void {
  db.run(
    `UPDATE turn_actions SET state = 'committed', result_json = ?, updated_at = ? WHERE operation_id = ?`,
    JSON.stringify(result ?? null),
    now,
    operationId,
  );
}

export function markFailed(db: Database, operationId: string, code: string, detail: string | undefined, now: number): void {
  db.run(
    `UPDATE turn_actions SET state = 'failed', error_code = ?, error_detail = ?, updated_at = ? WHERE operation_id = ?`,
    code,
    detail?.slice(0, 300) ?? null,
    now,
    operationId,
  );
}

/** 草稿已由后续回答补全（或换成新的草稿） */
export function resolveDraft(db: Database, draftId: string, resolvedBy: string, now: number): void {
  db.run(
    `UPDATE turn_actions SET state = 'resolved', resolved_by = ?, updated_at = ?
     WHERE operation_id = ? AND state = 'awaiting_input'`,
    resolvedBy,
    now,
    draftId,
  );
}

/** 仍然有效的草稿 */
export function loadDraft(db: Database, draftId: string, now: number): ActionRow | undefined {
  return db.get<ActionRow>(
    `SELECT * FROM turn_actions WHERE operation_id = ? AND state = 'awaiting_input' AND expires_at > ?`,
    draftId,
    now,
  );
}

export function openDrafts(db: Database, now: number, limit = 3): ActionRow[] {
  return db.all<ActionRow>(
    `SELECT * FROM turn_actions WHERE state = 'awaiting_input' AND expires_at > ?
     ORDER BY created_at DESC, ordinal DESC LIMIT ?`,
    now,
    limit,
  );
}

/** 过期的草稿作废 */
export function expireDrafts(db: Database, now: number): void {
  db.run(
    `UPDATE turn_actions SET state = 'cancelled', error_code = 'EXPIRED', updated_at = ?
     WHERE state = 'awaiting_input' AND expires_at <= ?`,
    now,
    now,
  );
}

/** 用户转去聊别的或开始新的操作：之前轮次里没有被补全的草稿作废（04-roadmap M6） */
export function abandonDrafts(db: Database, exceptTurnId: string, now: number): void {
  db.run(
    `UPDATE turn_actions SET state = 'cancelled', error_code = 'ABANDONED', updated_at = ?
     WHERE state = 'awaiting_input' AND turn_id != ?`,
    now,
    exceptTurnId,
  );
}

/** 同一条用户消息此前已经提交的操作（失败重试时取回原结果，不再执行） */
export function committedForMessage(db: Database, userMessageId: string): ActionRow[] {
  return db.all<ActionRow>(
    `SELECT * FROM turn_actions WHERE user_message_id = ? AND state = 'committed' ORDER BY created_at, ordinal`,
    userMessageId,
  );
}

export function readyFlags(row: ActionRow): ToolFlags {
  try {
    return (JSON.parse(row.args_json) as Partial<StoredReady>).flags ?? {};
  } catch {
    return {};
  }
}

/**
 * 启动时：执行前已记录、但不知道是否提交的操作，按命令收据恢复（TD §7.4）。
 * 有收据 → 已提交；没有 → 没有执行，标为失败，不自动重新执行。
 */
export function reconcileReadyActions(db: Database, now: number): number {
  return db.transaction(() => {
    const rows = db.all<ActionRow>(`SELECT * FROM turn_actions WHERE state = 'ready'`);
    for (const row of rows) {
      const receipt = db.get<{ result_json: string }>(
        'SELECT result_json FROM command_receipts WHERE operation_id = ?',
        row.operation_id,
      );
      if (receipt) {
        db.run(
          `UPDATE turn_actions SET state = 'committed', result_json = ?, updated_at = ? WHERE operation_id = ?`,
          receipt.result_json,
          now,
          row.operation_id,
        );
      } else {
        markFailed(db, row.operation_id, 'INTERRUPTED', undefined, now);
      }
    }
    return rows.length;
  });
}

// ---------- 卡片上的按钮 ----------

/**
 * 确认草稿的建议（例如“只设置下一次”）：走统一命令入口，来源是 UI。
 * operationId 由草稿决定，重复点击或通信重试会取回同一个结果，不会建第二份。
 */
export function confirmDraft(db: Database, commands: CommandService, draftId: string, now: number): CommandResult {
  const operationId = `confirm-${draftId}`;
  const row = loadAction(db, draftId);
  if (!row) return { ok: false, operationId, errorCode: CommandErrorCodes.notFound };
  // 已经确认过：返回原结果
  if (row.state === 'committed' && row.resolved_by === operationId) {
    return { ok: true, operationId, result: JSON.parse(row.result_json ?? 'null'), replayed: true };
  }
  if (row.state !== 'awaiting_input') return { ok: false, operationId, errorCode: CommandErrorCodes.invalidState };
  if ((row.expires_at ?? 0) <= now) return { ok: false, operationId, errorCode: CommandErrorCodes.expired };
  if (!row.suggestion_json) return { ok: false, operationId, errorCode: CommandErrorCodes.invalidState };
  const suggestion = JSON.parse(row.suggestion_json) as StoredSuggestion;
  const result = commands.run(row.kind, suggestion.input, { operationId, origin: 'ui' });
  if (result.ok) {
    db.run(
      `UPDATE turn_actions SET state = 'committed', args_json = ?, result_json = ?, resolved_by = ?, updated_at = ?
       WHERE operation_id = ?`,
      JSON.stringify({ input: suggestion.input, flags: suggestion.flags ?? {} } satisfies StoredReady),
      JSON.stringify(result.result ?? null),
      operationId,
      now,
      draftId,
    );
  }
  return result;
}

export function dismissDraft(db: Database, draftId: string, now: number): boolean {
  return (
    db.run(
      `UPDATE turn_actions SET state = 'cancelled', error_code = 'DISMISSED', updated_at = ?
       WHERE operation_id = ? AND state = 'awaiting_input'`,
      now,
      draftId,
    ).changes > 0
  );
}

// ---------- 卡片 ----------

const ERROR_TEXT: Partial<Record<CommandErrorCode | 'INTERRUPTED' | 'LIMIT', string>> = {
  PAST_TIME: '这个时间已经过去了，没有创建',
  INVALID_INPUT: '内容不符合要求，没有保存',
  NOT_FOUND: '找不到相关的记录',
  REVISION_CONFLICT: '内容已在别处修改，没有保存',
  INTERRUPTED: '应用中途关闭，这一项没有执行',
  LIMIT: '这一轮要做的事太多，这一项没有执行',
  INTERNAL: '保存失败',
};

function cardState(row: ActionRow): ActionCardState {
  switch (row.state) {
    case 'committed':
      return 'done';
    case 'awaiting_input':
      return 'awaiting_input';
    case 'resolved':
      return 'resolved';
    case 'cancelled':
      return row.error_code === 'EXPIRED' || row.error_code === 'ABANDONED' ? 'expired' : 'cancelled';
    default:
      return 'failed';
  }
}

/** 指定轮次的卡片；按实体当前状态渲染 */
export function actionCards(db: Database, commands: CommandService, turnIds: string[], now: number): ActionCardDto[] {
  if (turnIds.length === 0) return [];
  const rows = db.all<ActionRow>(
    `SELECT * FROM turn_actions WHERE turn_id IN (${turnIds.map(() => '?').join(',')}) AND state != 'ready'
     ORDER BY created_at, ordinal`,
    ...turnIds,
  );
  return rows.map((row) => {
    let state = cardState(row);
    if (state === 'awaiting_input' && (row.expires_at ?? 0) <= now) state = 'expired';
    const card: ActionCardDto = {
      operationId: row.operation_id,
      turnId: row.turn_id,
      userMessageId: row.user_message_id,
      kind: row.kind,
      state,
      createdAt: row.created_at,
    };
    if (state === 'done' && row.result_json) {
      const spec = commands.toolSpec(row.kind);
      Object.assign(card, spec?.card?.(db, JSON.parse(row.result_json)) ?? {});
      if (readyFlags(row).onceOnly) card.onceOnly = true;
    }
    if (state === 'awaiting_input') {
      card.question = row.question ?? '';
      if (row.suggestion_json) card.suggestionLabel = (JSON.parse(row.suggestion_json) as StoredSuggestion).label;
    }
    if (state === 'failed' || (state === 'cancelled' && row.error_code === 'LIMIT')) {
      card.errorText = ERROR_TEXT[row.error_code as CommandErrorCode] ?? '没有完成';
    }
    return card;
  });
}
