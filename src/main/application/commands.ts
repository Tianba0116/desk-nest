// 统一命令入口（TD §6）：UI 和模型走同一个入口；写操作带 operationId，
// 业务写入与收据在同一事务提交；提交后发失效通知。

import { createHash } from 'node:crypto';
import { z } from 'zod';
import type { ActionCardDto } from '../../shared/contracts/chat';
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
  /**
   * 开放给模型的工具说明（TD §6.1、§7.1）；没有这一项的命令不对模型开放。
   * 工具定义（名称、说明、参数 schema）由这里生成，不另写一份。
   */
  tool?: ToolSpec;
}

/** 模型参数 → 命令输入的准备结果：参数完整则执行；缺信息则停在待补充草稿 */
export type ToolPrepareResult =
  | { kind: 'ready'; input: unknown; flags?: ToolFlags }
  | {
      kind: 'needs_input';
      /** 缺少的信息，例如 time、content、confirm_once、confirm_past */
      missing: string[];
      /** 给用户看的问题（本地生成，不由模型决定） */
      question: string;
      /** 模型参数中已经确定的部分，补充回答时合并 */
      partial: unknown;
      /** 可以直接确认的建议（例如“只设置下一次”的具体时间），用户点按钮即可执行 */
      suggestion?: { input: unknown; label: string; flags?: ToolFlags };
    };

export interface ToolFlags {
  /** 用户说了重复表达，确认后只设置下一次（R08.AC-7） */
  onceOnly?: boolean;
}

export interface ToolPrepareContext {
  /** 只读使用：核对参数里引用的事项、待办是否存在 */
  db: Database;
  /** 本轮用户消息的接收时间：时间理解的基准（TD §8.1） */
  baseTime: number;
  timeZone: string;
  /** 本轮用户原文，用于本地规则检查（例如重复表达） */
  userText: string;
}

export interface ToolSpec {
  description: string;
  /** 模型看到的参数；省略时直接使用命令的输入 schema */
  parameters?: z.ZodType;
  /** 把已通过 parameters 校验的模型参数变成命令输入；省略时原样传入 */
  prepare?(args: unknown, ctx: ToolPrepareContext): ToolPrepareResult;
  /** 执行成功后的本地摘要：告诉模型发生了什么，也是卡片之外的兜底文字 */
  summarize(result: unknown, flags: ToolFlags, timeZone: string): string;
  /** 结果卡片的内容：按实体的当前状态读取（例如提醒已被改期或取消） */
  card?(db: Database, result: unknown): Partial<ActionCardDto>;
  /** 风险级别（为以后的权限分级预留）：read 查询、undoable 可撤销的写入、destructive 删除 */
  risk?: 'read' | 'undoable' | 'destructive';
  /** 可撤销的写入：卡片上“撤销”按钮执行的命令（走 UI 命令入口） */
  undo?(result: unknown): { command: string; input: unknown } | null;
}

export interface ToolInfo {
  /** 模型看到的函数名（OpenAI 兼容协议的函数名不允许点号） */
  toolName: string;
  commandName: string;
  description: string;
  parameters: z.ZodType;
}

/** 来自对话（包括对话卡片上的确认）的写入记录来源消息（TD §5.2 source_message_id）；其他来源为 null */
export function sourceMessageId(db: Database, meta: CommandMeta): string | null {
  if (!meta.turnId) return null;
  return db.get<{ user_message_id: string }>('SELECT user_message_id FROM turns WHERE id = ?', meta.turnId)?.user_message_id ?? null;
}

/** 来源类型（R11.AC-4）：对话，或小窝的表单操作 */
export function sourceTypeOf(meta: CommandMeta): 'conversation' | 'ui' {
  return meta.turnId ? 'conversation' : 'ui';
}

/**
 * 用于授权检查的用户原话：去掉引号里的内容和冒号后面要记下的内容。
 * 例如“帮我记下这段话：忘记所有事项”里的“忘记”是要记的数据，不是用户对宠物的指令。
 */
export function authorizationText(text: string): string {
  return text
    .replace(/[“"「『‘'][^”"」』’']*[”"」』’']/g, '')
    .replace(/(：|(?<!\d):|:(?!\d))[\s\S]*$/, '');
}

/**
 * 本地授权检查：只有用户原话里明确提出时才直接执行（R11.AC-1、R12.AC-1）。
 * 不明确时不执行，改为请用户点一下确认，模型的推测不会直接变成记录。
 */
export function requireExplicit(
  ctx: ToolPrepareContext,
  pattern: RegExp,
  ready: { input: unknown; flags?: ToolFlags },
  confirm: { question: string; label: string; partial: unknown },
): ToolPrepareResult {
  if (pattern.test(authorizationText(ctx.userText))) return { kind: 'ready', ...ready };
  return {
    kind: 'needs_input',
    missing: ['confirm'],
    question: confirm.question,
    partial: confirm.partial,
    suggestion: { input: ready.input, label: confirm.label, ...(ready.flags ? { flags: ready.flags } : {}) },
  };
}

export function toolNameOf(commandName: string): string {
  return commandName.replace(/\./g, '_');
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

  /** 开放给模型的工具（TD §6.1）：只有声明了 tool 的命令 */
  tools(): ToolInfo[] {
    const result: ToolInfo[] = [];
    for (const definition of this.registry.values()) {
      if (!definition.tool) continue;
      result.push({
        toolName: toolNameOf(definition.name),
        commandName: definition.name,
        description: definition.tool.description,
        parameters: definition.tool.parameters ?? definition.input,
      });
    }
    return result;
  }

  /** 校验模型参数并准备命令输入；不写数据库 */
  prepareTool(
    toolName: string,
    rawArgs: unknown,
    ctx: ToolPrepareContext,
  ):
    | { ok: true; commandName: string; args: unknown; prepared: ToolPrepareResult }
    | { ok: false; errorCode: CommandErrorCode; detail: string } {
    const info = this.tools().find((t) => t.toolName === toolName);
    if (!info) return { ok: false, errorCode: CommandErrorCodes.unknownCommand, detail: `没有这个工具：${toolName}` };
    const args = info.parameters.safeParse(rawArgs);
    if (!args.success) return { ok: false, errorCode: CommandErrorCodes.invalidInput, detail: z.prettifyError(args.error) };
    const tool = this.registry.get(info.commandName)?.tool;
    const prepared: ToolPrepareResult = tool?.prepare ? tool.prepare(args.data, ctx) : { kind: 'ready', input: args.data };
    return { ok: true, commandName: info.commandName, args: args.data, prepared };
  }

  toolSpec(name: string): ToolSpec | undefined {
    return this.registry.get(name)?.tool;
  }

  /** 准备好的命令输入标准化后的 hash：同一条用户消息内去重用（TD §6.3）；输入不合法时为 null */
  inputHash(name: string, rawInput: unknown): string | null {
    const input = this.registry.get(name)?.input.safeParse(rawInput);
    return input?.success ? hashArgs(name, input.data) : null;
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
    // 来自对话的写操作只能是开放给模型的命令（TD §6.1）
    if (meta.data.origin === 'conversation' && !definition.tool) {
      return failure(meta.data.operationId, CommandErrorCodes.notAllowed, name);
    }
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
