import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { CommandError, defineCommand, hashArgs } from '../../src/main/application/commands';
import type { NoteDto } from '../../src/shared/contracts/notebook';
import { createTestCore, type TestCore } from '../helpers/core';

describe('CommandService', () => {
  let core: TestCore;

  beforeEach(() => {
    core = createTestCore();
  });

  afterEach(() => core.dispose());

  it('同一 operationId、同样参数重试时返回原结果，不重复创建', () => {
    const meta = { operationId: 'op-retry-0001' };
    const first = core.exec<NoteDto>('notes.create', { body: '买牛奶' }, meta);
    const second = core.exec<NoteDto>('notes.create', { body: '买牛奶' }, meta);
    expect(first.ok && second.ok).toBe(true);
    if (!first.ok || !second.ok) return;
    expect(second.replayed).toBe(true);
    expect(second.result.id).toBe(first.result.id);
    expect(core.queries.run<NoteDto[]>('notebook.notes', {})).toHaveLength(1);
  });

  it('同一 operationId、不同参数返回 IDEMPOTENCY_CONFLICT', () => {
    const meta = { operationId: 'op-conflict-1' };
    core.ok('notes.create', { body: 'A' }, meta);
    const result = core.exec('notes.create', { body: 'B' }, meta);
    expect(result).toMatchObject({ ok: false, errorCode: 'IDEMPOTENCY_CONFLICT' });
    expect(core.queries.run<NoteDto[]>('notebook.notes', {})).toHaveLength(1);
  });

  it('用户明确的第二次相同操作（新 operationId）不会被吞掉（NFR-02）', () => {
    core.ok('notes.create', { body: '同样的内容' });
    core.ok('notes.create', { body: '同样的内容' });
    expect(core.queries.run<NoteDto[]>('notebook.notes', {})).toHaveLength(2);
  });

  it('参数校验失败不写收据，修正后可用同一 ID 重试', () => {
    const meta = { operationId: 'op-invalid-1' };
    expect(core.exec('notes.create', { body: '' }, meta)).toMatchObject({ ok: false, errorCode: 'INVALID_INPUT' });
    expect(core.exec('notes.create', { body: '好了' }, meta).ok).toBe(true);
  });

  it('业务错误时整体回滚，不写收据', () => {
    core.commands.register(
      defineCommand({
        name: 'test.halfway',
        input: z.object({}),
        invalidates: [],
        execute({ db, now }) {
          db.run(
            `INSERT INTO notes (id, title, body, search_text, created_at, updated_at) VALUES ('x', '', 'b', 'b', ?, ?)`,
            now,
            now,
          );
          throw new CommandError('INVALID_STATE', '中途失败');
        },
      }),
    );
    const result = core.exec('test.halfway', {}, { operationId: 'op-halfway-1' });
    expect(result).toMatchObject({ ok: false, errorCode: 'INVALID_STATE' });
    expect(core.db.get('SELECT 1 FROM notes WHERE id = ?', 'x')).toBeUndefined();
    expect(core.db.get('SELECT 1 FROM command_receipts WHERE operation_id = ?', 'op-halfway-1')).toBeUndefined();
  });

  it('提交后“回复丢失”：重启后用同一 operationId 重试取回原结果', () => {
    const meta = { operationId: 'op-lost-reply' };
    const first = core.ok<NoteDto>('notes.create', { body: '重启前' }, meta);
    core = core.reopen();
    const again = core.exec<NoteDto>('notes.create', { body: '重启前' }, meta);
    expect(again).toMatchObject({ ok: true, replayed: true, result: { id: first.id } });
  });

  it('未知命令和无效 operationId 被拒绝', () => {
    expect(core.exec('nope', {})).toMatchObject({ ok: false, errorCode: 'UNKNOWN_COMMAND' });
    expect(core.exec('notes.create', { body: 'x' }, { operationId: 'short' })).toMatchObject({
      ok: false,
      errorCode: 'INVALID_INPUT',
    });
  });

  it('成功提交后发出失效通知，重放不再通知', () => {
    const seen: string[][] = [];
    core.commands.onCommitted((topics) => seen.push([...topics]));
    const meta = { operationId: 'op-notify-001' };
    core.ok('notes.create', { body: 'x' }, meta);
    core.ok('notes.create', { body: 'x' }, meta);
    expect(seen).toEqual([['notes']]);
  });

  it('参数 hash 与键顺序无关', () => {
    expect(hashArgs('a', { x: 1, y: [1, { b: 2, a: 1 }] })).toBe(hashArgs('a', { y: [1, { a: 1, b: 2 }], x: 1 }));
    expect(hashArgs('a', { x: 1 })).not.toBe(hashArgs('b', { x: 1 }));
  });
});
