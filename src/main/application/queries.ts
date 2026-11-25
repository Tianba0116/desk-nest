// 只读查询注册表（TD §6.1）：不需要幂等键；输入经过 schema 校验并限制长度。

import { z } from 'zod';
import type { Database } from '../storage/database';
import type { Clock } from './clock';

export interface QueryDefinition<S extends z.ZodType = z.ZodType, O = unknown> {
  name: string;
  input: S;
  run(ctx: { db: Database; now: number }, input: z.output<S>): O;
}

export function defineQuery<S extends z.ZodType, O>(definition: QueryDefinition<S, O>): QueryDefinition<S, O> {
  return definition;
}

export class QueryError extends Error {
  constructor(readonly code: 'UNKNOWN_QUERY' | 'INVALID_INPUT', detail?: string) {
    super(detail ?? code);
  }
}

export class QueryService {
  private readonly registry = new Map<string, QueryDefinition>();

  constructor(
    private readonly db: Database,
    private readonly clock: Clock,
  ) {}

  register(...definitions: QueryDefinition[]): void {
    for (const definition of definitions) {
      if (this.registry.has(definition.name)) throw new Error(`重复注册查询 ${definition.name}`);
      this.registry.set(definition.name, definition);
    }
  }

  run<T = unknown>(name: string, rawInput: unknown): T {
    const definition = this.registry.get(name);
    if (!definition) throw new QueryError('UNKNOWN_QUERY', name);
    const input = definition.input.safeParse(rawInput ?? {});
    if (!input.success) throw new QueryError('INVALID_INPUT', z.prettifyError(input.error));
    return definition.run({ db: this.db, now: this.clock.now() }, input.data) as T;
  }
}
