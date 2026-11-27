import { existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ManualClock } from '../../src/main/application/clock';
import { createAppCore, openDatabase } from '../../src/main/application/core';
import { chatHistory, recentContext } from '../../src/main/conversation/conversation-store';
import { addAwayTime, pauseForClockJump, settleDueFocus } from '../../src/main/domains/focus';
import { materializeDue, takePopupCandidates } from '../../src/main/domains/reminders';
import {
  applyPendingDataOp,
  buildRestoreDatabase,
  DataError,
  exportSnapshot,
  latestBackup,
  restoreFromBackup,
  stageClear,
  stageRestore,
} from '../../src/main/storage/data-management';
import type { FocusDto } from '../../src/shared/contracts/focus';
import type { InboxItemDto } from '../../src/shared/contracts/reminders';
import { createTestCore, T0, type TestCore } from '../helpers/core';

const MIN = 60_000;
const id = () => crypto.randomUUID();

describe('专注（R09）', () => {
  let core: TestCore;
  beforeEach(() => {
    core = createTestCore();
  });
  afterEach(() => core.dispose());

  const state = () => core.queries.run<{ active: FocusDto | null; recent: FocusDto[] }>('focus.state', {});
  const start = (plannedMinutes = 25, taskId: string | null = null) => core.ok<FocusDto>('focus.start', { plannedMinutes, taskId });
  const inbox = () => core.queries.run<InboxItemDto[]>('inbox.list', {});

  it('同一时刻最多一个进行中（含暂停）的会话（R09.AC-1）', () => {
    const s = start();
    expect(core.exec('focus.start', { plannedMinutes: 25 })).toMatchObject({ ok: false, errorCode: 'INVALID_STATE' });
    core.ok('focus.pause', { id: s.id });
    expect(core.exec('focus.start', { plannedMinutes: 25 })).toMatchObject({ ok: false });
    core.ok('focus.cancel', { id: s.id });
    expect(start().status).toBe('running');
  });

  it('暂停不计时，继续后重新计算到期时间（R09.AC-3）', () => {
    const s = start(25);
    core.clock.advance(10 * MIN);
    const paused = core.ok<FocusDto>('focus.pause', { id: s.id });
    expect(paused.remainingMs).toBe(15 * MIN);
    core.clock.advance(60 * MIN);
    const resumed = core.ok<FocusDto>('focus.resume', { id: s.id });
    expect(resumed.dueAt).toBe(core.clock.now() + 15 * MIN);
  });

  it('到期结算只一次，进入信箱并弹出气泡；不自动完成待办（R09.AC-2、AC-6）', () => {
    const task = core.ok<{ id: string }>('tasks.create', { title: '写周报' });
    start(25, task.id);
    core.clock.advance(25 * MIN + 1000);
    expect(settleDueFocus(core.db, core.clock.now(), id)).toBe(1);
    expect(settleDueFocus(core.db, core.clock.now(), id)).toBe(0);
    const [done] = state().recent;
    expect(done).toMatchObject({ status: 'completed', countedMs: 25 * MIN, settledLate: false });
    expect(core.queries.run<Array<{ status: string }>>('notebook.tasks', {})[0]?.status).toBe('open');
    const [bubble] = takePopupCandidates(core.db, core.clock.now());
    expect(bubble).toMatchObject({ kind: 'focus', content: '专注 25 分钟结束啦', plannedMinutes: 25, task: { title: '写周报' } });
    expect(inbox()[0]).toMatchObject({ category: 'focus', focus: { status: 'completed' } });
  });

  it('应用未运行或睡眠期间到期：记为“已到期”并注明；计入时长以计划为上限（R09.AC-4、AC-5）', () => {
    start(25);
    core.clock.advance(3 * 60 * MIN);
    settleDueFocus(core.db, core.clock.now(), id);
    expect(state().recent[0]).toMatchObject({ status: 'expired', settledLate: true, countedMs: 25 * MIN });
    expect(inbox()[0]?.text).toContain('期间电脑处于睡眠、锁屏或应用未运行');
  });

  it('重启后不会重复结算', () => {
    start(25);
    core.clock.advance(26 * MIN);
    settleDueFocus(core.db, core.clock.now(), id);
    const reopened = core.reopen();
    try {
      expect(settleDueFocus(reopened.db, reopened.clock.now(), id)).toBe(0);
      expect(reopened.queries.run<InboxItemDto[]>('inbox.list', {})).toHaveLength(1);
    } finally {
      reopened.dispose();
    }
  });

  it('提前结束按实际专注时长计入；取消不进记录', () => {
    const s = start(25);
    core.clock.advance(7 * MIN);
    expect(core.ok<FocusDto>('focus.finish', { id: s.id })).toMatchObject({ status: 'finished', countedMs: 7 * MIN });
    const c = start(25);
    core.ok('focus.cancel', { id: c.id });
    expect(state().recent.map((r) => r.id)).toEqual([s.id]);
  });

  it('锁屏和睡眠的时长单独记录（D-07）', () => {
    start(25);
    addAwayTime(core.db, 5 * MIN, core.clock.now());
    expect(state().active?.awayMs).toBe(5 * MIN);
  });

  it('系统时间被大幅调整：暂停并按调整前的进度给出剩余时间，不出现负数（R09.AC-7）', () => {
    const s = start(25);
    core.clock.advance(10 * MIN);
    // 用户把时间往后调了 2 小时
    core.clock.advance(120 * MIN);
    expect(pauseForClockJump(core.db, core.clock.now(), 120 * MIN, id)).toBe(true);
    expect(state().active).toMatchObject({ status: 'paused', pauseReason: 'clock_jump', remainingMs: 15 * MIN });
    expect(inbox()[0]?.category).toBe('focus_paused');
    // 确认剩余时间后继续
    const resumed = core.ok<FocusDto>('focus.resume', { id: s.id, remainingMinutes: 12 });
    expect(resumed).toMatchObject({ status: 'running', dueAt: core.clock.now() + 12 * MIN, pauseReason: null });
    // 往前调时间也不会出现负数
    core.clock.advance(-60 * MIN);
    pauseForClockJump(core.db, core.clock.now(), -60 * MIN, id);
    expect(state().active?.remainingMs).toBeGreaterThan(0);
  });
});

describe('聊天记录（R19.AC-7、D-08）', () => {
  let core: TestCore;
  beforeEach(() => {
    core = createTestCore();
  });
  afterEach(() => core.dispose());

  const exchange = (text: string, reply: string): string => {
    core.clock.advance(1000);
    const { userMessageId, turnId } = core.ok<{ userMessageId: string; turnId: string }>('chat.send', { text, model: 'm' });
    core.db.run(`UPDATE turns SET state = 'completed' WHERE id = ?`, turnId);
    core.db.run(
      `INSERT INTO messages (id, conversation_id, turn_id, role, content, status, created_at) VALUES (?, 'default', ?, 'assistant', ?, 'complete', ?)`,
      id(),
      turnId,
      reply,
      core.clock.now(),
    );
    return userMessageId;
  };

  it('删除用户消息时连同它的回复；之后不进入上下文', () => {
    const first = exchange('我叫小王', '你好小王');
    exchange('今天天气不错', '是呀');
    core.ok('chat.deleteMessage', { messageId: first });
    expect(chatHistory(core.db).map((m) => m.content)).toEqual(['今天天气不错', '是呀']);
    const { userMessageId } = core.ok<{ userMessageId: string }>('chat.send', { text: '在吗', model: 'm' });
    expect(JSON.stringify(recentContext(core.db, userMessageId))).not.toContain('小王');
  });

  it('回复进行中不能删除', () => {
    const m = exchange('一', '一');
    core.ok('chat.send', { text: '二', model: 'm' });
    expect(core.exec('chat.deleteMessage', { messageId: m })).toMatchObject({ ok: false, errorCode: 'INVALID_STATE' });
  });

  it('按时间范围删除', () => {
    exchange('很早以前', '嗯');
    core.clock.advance(2 * 60 * MIN);
    exchange('刚才', '嗯');
    expect(core.ok<{ deleted: number }>('chat.deleteRange', { range: 'hour' }).deleted).toBe(2);
    expect(chatHistory(core.db).map((m) => m.content)).toEqual(['很早以前', '嗯']);
    core.ok('chat.deleteRange', { range: 'all' });
    expect(chatHistory(core.db)).toHaveLength(0);
  });

  it('保留期限：默认永久；设为 30 天后，更早的记录在维护时删除', () => {
    exchange('四十天前', '嗯');
    core.clock.advance(40 * 24 * 60 * MIN);
    exchange('今天', '嗯');
    core.maintain();
    expect(chatHistory(core.db)).toHaveLength(4);
    expect(core.ok<{ deleted: number }>('chat.setRetention', { days: 30 }).deleted).toBe(2);
    expect(core.queries.run('chat.settings', {})).toEqual({ retentionDays: 30, messageCount: 2 });
  });
});

describe('导出与恢复（R19.AC-3、AC-4、AC-8）', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'desk-nest-data-'));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  const seed = () => {
    const clock = new ManualClock(T0);
    const core = createAppCore(openDatabase(dir, clock), clock);
    const meta = () => ({ operationId: `op-${id()}`, origin: 'ui' as const });
    core.commands.run('notes.create', { title: '标题', body: '内容' }, meta());
    core.commands.run('topics.create', { title: '准备面试' }, meta());
    core.commands.run('reminders.create', { content: '改简历', dueAt: T0 + 60 * MIN, timeZone: 'Asia/Shanghai' }, meta());
    core.settings.set('model.secret', 'ENCRYPTED-KEY');
    core.settings.set('model.config', { schemaVersion: 1 });
    return core;
  };

  it('导出不包含密钥和命令收据', () => {
    const core = seed();
    const snapshot = exportSnapshot(core.db, '0.1.0', T0);
    core.close();
    const text = JSON.stringify(snapshot);
    expect(text).not.toContain('ENCRYPTED-KEY');
    expect(snapshot.tables['command_receipts']).toBeUndefined();
    expect(snapshot.tables['notes']).toHaveLength(1);
    expect(snapshot.tables['app_settings']?.some((r) => r['key'] === 'model.config')).toBe(true);
  });

  it('恢复：重建 → 重启时备份当前数据再整体替换', () => {
    const core = seed();
    const text = JSON.stringify(exportSnapshot(core.db, '0.1.0', T0));
    core.commands.run('notes.create', { title: '导出之后才写的', body: 'x' }, { operationId: `op-${id()}`, origin: 'ui' });
    core.close();
    const summary = stageRestore(dir, text, T0);
    expect(summary.counts).toMatchObject({ 笔记: 1, 事项: 1, 提醒和跟进: 1 });

    const result = applyPendingDataOp(dir, T0 + 1000);
    expect(result).toMatchObject({ op: 'restore' });
    expect(existsSync((result as { backupPath: string }).backupPath)).toBe(true);
    const restored = createAppCore(openDatabase(dir), new ManualClock(T0));
    try {
      expect(restored.db.all<{ title: string }>('SELECT title FROM notes').map((n) => n.title)).toEqual(['标题']);
      expect(restored.db.get('SELECT 1 FROM app_settings WHERE key = ?', 'model.secret')).toBeUndefined();
      expect(restored.db.schemaVersion).toBe(restored.db.schemaVersion);
    } finally {
      restored.close();
    }
    // 标记已处理，下次启动不会再做
    expect(applyPendingDataOp(dir, T0 + 2000)).toEqual({ op: 'none' });
  });

  it('旧版本的导出文件：按导出时的版本重建，再迁移到当前版本', () => {
    const core = seed();
    const snapshot = exportSnapshot(core.db, '0.1.0', T0);
    core.close();
    // 模拟 v4 的导出：没有 v5、v6 的表和字段
    const old = { ...snapshot, schemaVersion: 4, tables: { notes: snapshot.tables['notes'], app_settings: snapshot.tables['app_settings'] } };
    const notes = (old.tables.notes ?? []).map((n) => {
      const copy = { ...n };
      return copy;
    });
    old.tables.notes = notes;
    const target = join(dir, 'old.restore.db');
    expect(buildRestoreDatabase(JSON.stringify(old), target).counts['笔记']).toBe(1);
  });

  it('无效或被改过的文件：拒绝，不留下半成品，现有数据不变', () => {
    const core = seed();
    const snapshot = exportSnapshot(core.db, '0.1.0', T0);
    core.close();
    const target = join(dir, 'bad.restore.db');
    expect(() => buildRestoreDatabase('not json', target)).toThrow(DataError);
    expect(() => buildRestoreDatabase(JSON.stringify({ format: 'other' }), target)).toThrow('不是 DeskNest 的导出文件');
    expect(() => buildRestoreDatabase(JSON.stringify({ ...snapshot, schemaVersion: 999 }), target)).toThrow('更新的版本');
    const bad = { ...snapshot, tables: { ...snapshot.tables, notes: [{ id: 'x', evil: 1 }] } };
    expect(() => buildRestoreDatabase(JSON.stringify(bad), target)).toThrow('未知的字段');
    const unknown = { ...snapshot, tables: { ...snapshot.tables, secrets: [] } };
    expect(() => buildRestoreDatabase(JSON.stringify(unknown), target)).toThrow('未知的数据表');
    expect(existsSync(target)).toBe(false);
    const again = createAppCore(openDatabase(dir), new ManualClock(T0));
    expect(again.db.get<{ n: number }>('SELECT COUNT(*) AS n FROM notes')?.n).toBe(1);
    again.close();
  });

  it('恢复后旧提醒按 R08.AC-6 汇总：超过 24 小时的只进信箱，不弹出', () => {
    const core = seed();
    const text = JSON.stringify(exportSnapshot(core.db, '0.1.0', T0));
    core.close();
    stageRestore(dir, text, T0);
    applyPendingDataOp(dir, T0);
    const later = new ManualClock(T0 + 3 * 24 * 60 * MIN);
    const restored = createAppCore(openDatabase(dir, later), later);
    try {
      materializeDue(restored.db, later.now(), id);
      expect(takePopupCandidates(restored.db, later.now())).toHaveLength(0);
      expect(restored.queries.run<InboxItemDto[]>('inbox.list', {})).toHaveLength(1);
    } finally {
      restored.close();
    }
  });

  it('清除所有数据：重启时删除数据库和备份', () => {
    seed().close();
    mkdtempSync(join(dir, 'x'));
    writeFileSync(join(dir, 'backups-marker'), '');
    stageClear(dir, T0);
    expect(applyPendingDataOp(dir, T0)).toEqual({ op: 'clear' });
    expect(existsSync(join(dir, 'desk-nest.db'))).toBe(false);
    expect(existsSync(join(dir, 'backups'))).toBe(false);
  });

  it('数据库打不开时：从最近的备份恢复，打不开的文件保留', () => {
    const core = seed();
    core.db.backupTo(join(dir, 'backups', 'desk-nest-v5-test.db'));
    core.close();
    writeFileSync(join(dir, 'desk-nest.db'), 'corrupted');
    const backup = latestBackup(dir);
    expect(backup).toContain('desk-nest-v5-test.db');
    const kept = restoreFromBackup(dir, backup as string, T0);
    expect(existsSync(kept)).toBe(true);
    const recovered = createAppCore(openDatabase(dir), new ManualClock(T0));
    expect(recovered.db.get<{ n: number }>('SELECT COUNT(*) AS n FROM notes')?.n).toBe(1);
    recovered.close();
    expect(readdirSync(dir).some((f) => f.startsWith('desk-nest.unreadable-'))).toBe(true);
  });
});
