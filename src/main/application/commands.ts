// 统一命令入口（TD §6）：UI 和模型走同一个入口；写操作带 operationId，
// 业务写入与收据在同一事务提交；提交后发失效通知。

import { createHash } from 'node:crypto';
import { z } from 'zod';
import {
  CommandErrorCodes,
  type CommandErrorCode,
  type CommandMeta,
  type CommandResult,
  type DataTopic,
} from '../../shared/contracts/command';
import type { Database } from '../storage/database';
import type { Clock } from './clock';

/** 业务前提不满足时抛出；不会写入收据，事务回滚 */
export class CommandError extends Error {
  constructor(
    readonly code: CommandErrorCode,
    detail?: string,
  ) {
    super(detail ?? code);
  }
}

export interface CommandContext {
  db: Database;
  now: number;
  meta: CommandMeta;
  newId(): string;
}

export interface CommandDefinition<S extends z.ZodType = z.ZodType, O = unknown> {
  name: string;
  input: S;
  /** 在事务内同步执行；不能 await，不能发网络请求 */
  execute(ctx: CommandContext, input: z.output<S>): O;
  /** 成功后通知哪些数据范围变化 */
  invalidates: readonly DataTopic[];
  /** 是否开放给模型工具调用（TD §6.1）；默认否 */
  exposeToModel?: boolean;
}

export function defineCommand<S extends z.ZodType, O>(definition: CommandDefinition<S, O>): CommandDefinition<S, O> {
  return definition;
}

const MetaSchema = z.object({
  operationId: z.string().min(8).max(100),
  origin: z.enum(['ui', 'conversation', 'scheduler']),
  turnId: z.string().max(100).optional(),
});

interface ReceiptRow {
  kind: string;
  args_hash: string;
  result_json: string;
}

export class CommandService {
  private readonly registry = new Map<string, CommandDefinition>();
  private readonly listeners = new Set<(topics: readonly DataTopic[]) => void>();

  constructor(
    private readonly db: Database,
    private readonly clock: Clock,
    private readonly newId: () => string = () => crypto.randomUUID(),
  ) {}

  register(...definitions: CommandDefinition[]): void {
    for (const definition of definitions) {
      if (this.registry.has(definition.name)) throw new Error(`重复注册命令 ${definition.name}`);
      this.registry.set(definition.name, definition);
    }
  }

  has(name: string): boolean {
    return this.registry.has(name);
  }

  /** 提交后通知；监听器异常不影响命令结果 */
  onCommitted(listener: (topics: readonly DataTopic[]) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  run<T = unknown>(name: string, rawInput: unknown, rawMeta: CommandMeta): CommandResult<T> {
    const operationId = typeof rawMeta?.operationId === 'string' ? rawMeta.operationId : '';
    const definition = this.registry.get(name);
    if (!definition) return failure(operationId, CommandErrorCodes.unknownCommand, name);

    const meta = MetaSchema.safeParse(rawMeta);
    if (!meta.success) return failure(operationId, CommandErrorCodes.invalidInput, 'operationId 无效');
    const input = definition.input.safeParse(rawInput);
    // schema 错误不写收据（TD §6.2）
    if (!input.success) return failure(operationId, CommandErrorCodes.invalidInput, z.prettifyError(input.error));

    const argsHash = hashArgs(name, input.data);
    let replayed = false;
    let result: unknown;
    try {
      result = this.db.transaction(() => {
        const receipt = this.db.get<ReceiptRow>(
          'SELECT kind, args_hash, result_json FROM command_receipts WHERE operation_id = ?',
          meta.data.operationId,
        );
        if (receipt) {
          if (receipt.kind !== name || receipt.args_hash !== argsHash) {
            throw new CommandError(CommandErrorCodes.idempotencyConflict, '同一个 operationId 的参数不同');
          }
          replayed = true;
          return JSON.parse(receipt.result_json) as unknown;
        }
        const now = this.clock.now();
        const output = definition.execute({ db: this.db, now, meta: meta.data, newId: this.newId }, input.data);
        this.db.run(
          `INSERT INTO command_receipts (operation_id, kind, args_hash, result_json, origin, created_at)
           VALUES (?, ?, ?, ?, ?, ?)`,
          meta.data.operationId,
          name,
          argsHash,
          JSON.stringify(output ?? null),
          meta.data.origin,
          now,
        );
        return output;
      });
    } catch (error) {
      if (error instanceof CommandError) return failure(meta.data.operationId, error.code, error.message);
      console.error(`[command] ${name} failed:`, error);
      return failure(meta.data.operationId, CommandErrorCodes.internal);
    }

    if (!replayed) this.notify(definition.invalidates);
    return { ok: true, operationId: meta.data.operationId, result: result as T, replayed };
  }

  private notify(topics: readonly DataTopic[]): void {
    for (const listener of this.listeners) {
      try {
        listener(topics);
      } catch (error) {
        console.warn('[command] listener failed:', error);
      }
    }
  }
}

function failure(operationId: string, errorCode: CommandErrorCode, detail?: string): CommandResult<never> {
  return detail === undefined ? { ok: false, operationId, errorCode } : { ok: false, operationId, errorCode, detail };
}

/** 参数标准化后计算 hash：只用于检测同一 operationId 的参数是否变化（TD §6.3） */
export function hashArgs(name: string, args: unknown): string {
  return createHash('sha256').update(`${name}\n${stableStringify(args)}`).digest('hex');
}

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${stableStringify(v)}`).join(',')}}`;
}

/** 修改前检查实体版本（TD §5.2）；不存在或已删除视为 NOT_FOUND */
export function requireRevision(
  row: { revision: number; deleted_at?: number | null } | undefined,
  expected: number | undefined,
  options: { allowDeleted?: boolean } = {},
): asserts row is { revision: number; deleted_at?: number | null } {
  if (!row || (!options.allowDeleted && row.deleted_at != null)) throw new CommandError(CommandErrorCodes.notFound);
  if (expected !== undefined && row.revision !== expected) {
    throw new CommandError(CommandErrorCodes.revisionConflict, '内容已在别处修改，请刷新后重试');
  }
}
