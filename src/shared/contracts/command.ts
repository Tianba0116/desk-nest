// 统一命令入口的结果约定（TD §6.1）。只放类型和常量。

export type CommandOrigin = 'ui' | 'conversation' | 'scheduler';

export interface CommandMeta {
  /** 一次逻辑写入的稳定 ID：UI 在一次点击开始时生成，等待结果期间重试复用 */
  operationId: string;
  origin: CommandOrigin;
  turnId?: string;
}

export type CommandResult<T = unknown> =
  | { ok: true; operationId: string; result: T; /** 命中已有收据，没有重新执行 */ replayed: boolean }
  | { ok: false; operationId: string; errorCode: CommandErrorCode; detail?: string };

export const CommandErrorCodes = {
  invalidInput: 'INVALID_INPUT',
  unknownCommand: 'UNKNOWN_COMMAND',
  notAllowed: 'NOT_ALLOWED',
  notFound: 'NOT_FOUND',
  revisionConflict: 'REVISION_CONFLICT',
  idempotencyConflict: 'IDEMPOTENCY_CONFLICT',
  expired: 'EXPIRED',
  invalidState: 'INVALID_STATE',
  /** 指定的时间已经过去（R08.AC-4） */
  pastTime: 'PAST_TIME',
  internal: 'INTERNAL',
} as const;

export type CommandErrorCode = (typeof CommandErrorCodes)[keyof typeof CommandErrorCodes];

/** 数据变化的范围：界面收到后重新查询对应列表（TD §4.2） */
export type DataTopic = 'notes' | 'tasks' | 'reminders' | 'inbox' | 'settings' | 'conversation' | 'topics' | 'memories' | 'context';
