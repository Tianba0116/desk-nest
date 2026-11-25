import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ManualClock } from '../../src/main/application/clock';
import { createAppCore, openDatabase, type AppCore } from '../../src/main/application/core';
import type { CommandMeta, CommandResult } from '../../src/shared/contracts/command';

/** 2026-11-24 09:00:00 +08:00 */
export const T0 = Date.UTC(2026, 10, 24, 1, 0, 0);

export interface TestCore extends AppCore {
  clock: ManualClock;
  dir: string;
  /** 用新的 operationId 执行命令 */
  exec<T = unknown>(name: string, input: unknown, meta?: Partial<CommandMeta>): CommandResult<T>;
  /** 执行并断言成功，返回结果 */
  ok<T = unknown>(name: string, input: unknown, meta?: Partial<CommandMeta>): T;
  /** 关闭并用同一个目录重新打开（模拟重启） */
  reopen(): TestCore;
  dispose(): void;
}

let counter = 0;

export function createTestCore(dir = mkdtempSync(join(tmpdir(), 'desk-nest-')), clock = new ManualClock(T0)): TestCore {
  let idCounter = 0;
  const core = createAppCore(openDatabase(dir, clock), clock, () => `id-${++idCounter}-${Math.random().toString(36).slice(2, 8)}`);
  const exec = <T,>(name: string, input: unknown, meta: Partial<CommandMeta> = {}): CommandResult<T> =>
    core.commands.run<T>(name, input, { operationId: `op-${++counter}-test`, origin: 'ui', ...meta });
  const test: TestCore = {
    ...core,
    clock,
    dir,
    exec,
    ok<T>(name: string, input: unknown, meta?: Partial<CommandMeta>): T {
      const result = exec<T>(name, input, meta);
      if (!result.ok) throw new Error(`${name} failed: ${result.errorCode} ${result.detail ?? ''}`);
      return result.result;
    },
    reopen() {
      core.close();
      return createTestCore(dir, clock);
    },
    dispose() {
      core.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
  return test;
}
