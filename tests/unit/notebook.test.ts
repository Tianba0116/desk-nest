import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { normalizeForSearch } from '../../src/main/domains/text-search';
import {
  RECYCLE_RETENTION_MS,
  type NoteDto,
  type RecycledItem,
  type SearchHit,
  type TaskDto,
} from '../../src/shared/contracts/notebook';
import { createTestCore, type TestCore } from '../helpers/core';

describe('随手记（R06）', () => {
  let core: TestCore;
  beforeEach(() => {
    core = createTestCore();
  });
  afterEach(() => core.dispose());

  const notes = (): NoteDto[] => core.queries.run('notebook.notes', {});

  it('创建、修改、列表按更新时间倒序', () => {
    const a = core.ok<NoteDto>('notes.create', { title: '购物', body: '牛奶' });
    core.clock.advance(1000);
    core.ok<NoteDto>('notes.create', { body: '第二条' });
    core.clock.advance(1000);
    const updated = core.ok<NoteDto>('notes.update', { id: a.id, revision: a.revision, title: '购物', body: '牛奶、面包' });
    expect(updated.revision).toBe(2);
    expect(notes().map((n) => n.body)).toEqual(['牛奶、面包', '第二条']);
  });

  it('版本过期的修改被拒绝（REVISION_CONFLICT）', () => {
    const a = core.ok<NoteDto>('notes.create', { body: 'v1' });
    core.ok('notes.update', { id: a.id, revision: 1, title: '', body: 'v2' });
    expect(core.exec('notes.update', { id: a.id, revision: 1, title: '', body: 'v3' })).toMatchObject({
      ok: false,
      errorCode: 'REVISION_CONFLICT',
    });
    expect(notes()[0]?.body).toBe('v2');
  });

  it('删除后进入回收站，可恢复', () => {
    const a = core.ok<NoteDto>('notes.create', { body: '误删的' });
    core.ok('notes.delete', { id: a.id });
    expect(notes()).toHaveLength(0);
    expect(core.queries.run<RecycledItem[]>('notebook.recycleBin', {})).toHaveLength(1);
    core.ok('notes.restore', { id: a.id });
    expect(notes()).toHaveLength(1);
  });

  it('回收站保留 7 天，过期后不能恢复并被清理', () => {
    const a = core.ok<NoteDto>('notes.create', { body: '旧的' });
    core.ok('notes.delete', { id: a.id });
    core.clock.advance(RECYCLE_RETENTION_MS + 1);
    expect(core.exec('notes.restore', { id: a.id })).toMatchObject({ ok: false, errorCode: 'EXPIRED' });
    expect(core.queries.run<RecycledItem[]>('notebook.recycleBin', {})).toHaveLength(0);
    core.maintain();
    expect(core.db.get('SELECT 1 FROM notes WHERE id = ?', a.id)).toBeUndefined();
  });

  it('彻底删除只对回收站中的笔记有效', () => {
    const a = core.ok<NoteDto>('notes.create', { body: 'x' });
    expect(core.exec('notes.purge', { id: a.id })).toMatchObject({ ok: false, errorCode: 'INVALID_STATE' });
    core.ok('notes.delete', { id: a.id });
    core.ok('notes.purge', { id: a.id });
    expect(core.queries.run<RecycledItem[]>('notebook.recycleBin', {})).toHaveLength(0);
  });

  it('标题和内容不能都为空，超长被拒绝', () => {
    expect(core.exec('notes.create', { title: ' ', body: '  ' }).ok).toBe(false);
    expect(core.exec('notes.create', { body: 'x'.repeat(20_001) }).ok).toBe(false);
  });

  it('重启后数据仍在', () => {
    core.ok('notes.create', { body: '持久化' });
    core = core.reopen();
    expect(notes().map((n) => n.body)).toEqual(['持久化']);
  });
});

describe('待办（R07）', () => {
  let core: TestCore;
  beforeEach(() => {
    core = createTestCore();
  });
  afterEach(() => core.dispose());

  const tasks = (): TaskDto[] => core.queries.run('notebook.tasks', {});

  it('创建、完成、取消完成，未完成排在前面', () => {
    const a = core.ok<TaskDto>('tasks.create', { title: '改简历' });
    core.clock.advance(1000);
    core.ok<TaskDto>('tasks.create', { title: '买菜' });
    const done = core.ok<TaskDto>('tasks.setStatus', { id: a.id, status: 'done' });
    expect(done.completedAt).toBe(core.clock.now());
    expect(tasks().map((t) => [t.title, t.status])).toEqual([
      ['买菜', 'open'],
      ['改简历', 'done'],
    ]);
    const reopened = core.ok<TaskDto>('tasks.setStatus', { id: a.id, status: 'open' });
    expect(reopened.completedAt).toBeNull();
  });

  it('记录进展不改变完成状态（R07.AC-2）', () => {
    const a = core.ok<TaskDto>('tasks.create', { title: '准备面试' });
    const updated = core.ok<TaskDto>('tasks.recordProgress', { id: a.id, note: '看完了公司资料' });
    expect(updated.status).toBe('open');
    expect(updated.progressNote).toBe('看完了公司资料');
    expect(updated.progressUpdatedAt).toBe(core.clock.now());
  });

  it('修改标题和截止时间', () => {
    const a = core.ok<TaskDto>('tasks.create', { title: '旧标题' });
    const updated = core.ok<TaskDto>('tasks.update', { id: a.id, revision: 1, title: '新标题', dueAt: 123 });
    expect(updated).toMatchObject({ title: '新标题', dueAt: 123, revision: 2 });
  });

  it('删除后可撤销', () => {
    const a = core.ok<TaskDto>('tasks.create', { title: 'x' });
    core.ok('tasks.delete', { id: a.id });
    expect(tasks()).toHaveLength(0);
    core.ok('tasks.restore', { id: a.id });
    expect(tasks()).toHaveLength(1);
  });

  it('空标题被拒绝', () => {
    expect(core.exec('tasks.create', { title: '  ' }).ok).toBe(false);
  });
});

describe('搜索（R06.AC-3）', () => {
  let core: TestCore;
  beforeEach(() => {
    core = createTestCore();
  });
  afterEach(() => core.dispose());

  const search = (query: string): SearchHit[] => core.queries.run('notebook.search', { query });

  it('两个字的查询可以命中', () => {
    core.ok('notes.create', { title: '求职', body: '周五前改好简历' });
    core.ok('tasks.create', { title: '投简历' });
    core.ok('notes.create', { body: '无关内容' });
    expect(search('简历').map((h) => h.type).sort()).toEqual(['note', 'task']);
  });

  it('一个字也能搜', () => {
    core.ok('notes.create', { body: '猫粮' });
    expect(search('猫')).toHaveLength(1);
  });

  it('全半角和大小写不影响结果', () => {
    core.ok('notes.create', { body: 'ＰＭ面试 Notes' });
    expect(search('pm')).toHaveLength(1);
    expect(search('NOTES')).toHaveLength(1);
  });

  it('多个词需全部命中', () => {
    core.ok('notes.create', { body: '面试 周五' });
    core.ok('notes.create', { body: '面试 周一' });
    expect(search('面试 周五')).toHaveLength(1);
  });

  it('% 和 _ 按字面匹配', () => {
    core.ok('notes.create', { body: '完成 100% 了' });
    core.ok('notes.create', { body: '完成 1000 了' });
    expect(search('100%')).toHaveLength(1);
    expect(search('a_b')).toHaveLength(0);
  });

  it('搜索包含待办的进展，不包含已删除的', () => {
    const t = core.ok<TaskDto>('tasks.create', { title: '面试' });
    core.ok('tasks.recordProgress', { id: t.id, note: '已投递字节' });
    expect(search('字节')).toHaveLength(1);
    core.ok('tasks.delete', { id: t.id });
    expect(search('字节')).toHaveLength(0);
  });

  it('空查询返回空结果', () => {
    core.ok('notes.create', { body: 'x' });
    expect(search('   ')).toEqual([]);
  });

  it('规范化', () => {
    expect(normalizeForSearch('  Ａ\tB  ｃ ')).toBe('a b c');
  });
});
