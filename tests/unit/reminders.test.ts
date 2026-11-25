import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ReminderPresenter, type BubbleChannel } from '../../src/main/application/presenter';
import { Scheduler } from '../../src/main/application/scheduler';
import { countUpcoming, materializeDue, reminderJob } from '../../src/main/domains/reminders';
import type { TaskDto } from '../../src/shared/contracts/notebook';
import type { BubbleItem, InboxItemDto, ReminderDto } from '../../src/shared/contracts/reminders';
import { createTestCore, type TestCore } from '../helpers/core';

const MIN = 60_000;
const HOUR = 60 * MIN;
const TZ = 'Asia/Shanghai';

describe('提醒（R08）', () => {
  let core: TestCore;
  let seq = 0;
  const newId = (): string => `inbox-${++seq}`;

  beforeEach(() => {
    core = createTestCore();
  });
  afterEach(() => core.dispose());

  const create = (content: string, inMs: number, taskId: string | null = null): ReminderDto =>
    core.ok<ReminderDto>('reminders.create', { content, dueAt: core.clock.now() + inMs, timeZone: TZ, taskId });
  const inbox = (): InboxItemDto[] => core.queries.run('inbox.list', {});
  const list = (): { upcoming: ReminderDto[]; history: ReminderDto[] } => core.queries.run('reminders.list', {});

  it('过去的时间不创建，返回 PAST_TIME（R08.AC-4）', () => {
    const result = core.exec('reminders.create', { content: 'x', dueAt: core.clock.now() - 1, timeZone: TZ });
    expect(result).toMatchObject({ ok: false, errorCode: 'PAST_TIME' });
    expect(list().upcoming).toHaveLength(0);
  });

  it('到期后进入信箱，重复扫描不重复入箱', () => {
    create('改简历', 10 * MIN);
    expect(materializeDue(core.db, core.clock.now(), newId)).toBe(0);
    core.clock.advance(10 * MIN);
    expect(materializeDue(core.db, core.clock.now(), newId)).toBe(1);
    expect(materializeDue(core.db, core.clock.now(), newId)).toBe(0);
    expect(inbox()).toHaveLength(1);
    expect(inbox()[0]).toMatchObject({ status: 'unread', stale: false, reminder: { status: 'materialized' } });
  });

  it('改期后旧时间不再提示，新时间到期才入箱（R08.AC-5）', () => {
    const r = create('开会', 10 * MIN);
    core.ok('reminders.reschedule', { id: r.id, revision: r.revision, dueAt: core.clock.now() + 60 * MIN });
    core.clock.advance(10 * MIN);
    expect(materializeDue(core.db, core.clock.now(), newId)).toBe(0);
    core.clock.advance(50 * MIN);
    expect(materializeDue(core.db, core.clock.now(), newId)).toBe(1);
  });

  it('取消后不再触发；改期到过去被拒绝', () => {
    const r = create('取消我', 10 * MIN);
    expect(core.exec('reminders.reschedule', { id: r.id, revision: 1, dueAt: core.clock.now() - MIN })).toMatchObject({
      ok: false,
      errorCode: 'PAST_TIME',
    });
    core.ok('reminders.cancel', { id: r.id });
    core.clock.advance(HOUR);
    expect(materializeDue(core.db, core.clock.now(), newId)).toBe(0);
    expect(list().history[0]).toMatchObject({ status: 'cancelled', cancelReason: 'user' });
  });

  it('推迟：旧卡片失效且标为 stale，推迟时间到后产生新卡片', () => {
    const r = create('喝水', MIN);
    core.clock.advance(MIN);
    materializeDue(core.db, core.clock.now(), newId);
    core.ok('reminders.snooze', { id: r.id, minutes: 10 });
    expect(inbox()[0]).toMatchObject({ status: 'invalidated', stale: true, reminder: { status: 'scheduled' } });
    core.clock.advance(10 * MIN);
    expect(materializeDue(core.db, core.clock.now(), newId)).toBe(1);
    expect(inbox().map((i) => i.status)).toEqual(['unread', 'invalidated']);
  });

  it('推迟只接受预设的分钟数', () => {
    const r = create('x', MIN);
    expect(core.exec('reminders.snooze', { id: r.id, minutes: 7 }).ok).toBe(false);
  });

  it('删除待办时同一事务取消关联提醒（R07.AC-4）', () => {
    const task = core.ok<TaskDto>('tasks.create', { title: '改简历' });
    create('改简历', HOUR, task.id);
    const other = create('不相关', HOUR);
    core.ok('tasks.delete', { id: task.id });
    const { upcoming, history } = list();
    expect(upcoming.map((r) => r.id)).toEqual([other.id]);
    expect(history[0]).toMatchObject({ status: 'cancelled', cancelReason: 'target_deleted', task: { deleted: true } });
  });

  it('关联不存在的待办被拒绝', () => {
    expect(core.exec('reminders.create', { content: 'x', dueAt: core.clock.now() + MIN, timeZone: TZ, taskId: 'nope' }))
      .toMatchObject({ ok: false, errorCode: 'NOT_FOUND' });
  });

  it('重启后提醒仍在，到期照常入箱', () => {
    create('重启后', HOUR);
    core = core.reopen();
    expect(countUpcoming(core.db, core.clock.now())).toBe(1);
    core.clock.advance(HOUR);
    expect(materializeDue(core.db, core.clock.now(), newId)).toBe(1);
  });

  it('全部已读', () => {
    create('a', MIN);
    create('b', MIN);
    core.clock.advance(MIN);
    materializeDue(core.db, core.clock.now(), newId);
    core.ok('inbox.markAllRead', {});
    expect(core.queries.run('inbox.unreadCount', {})).toBe(0);
  });
});

describe('展示（R08.AC-6、AC-8，R15.AC-3）', () => {
  let core: TestCore;
  let seq = 0;
  const newId = (): string => `inbox-${++seq}`;
  let gateOpen: boolean;
  let notifyWhenClosed: boolean;
  let shown: BubbleItem[][];
  let notified: BubbleItem[][];
  let unread: number[];
  let bubble: BubbleChannel & { ids: string[] };
  let presenter: ReminderPresenter;

  beforeEach(() => {
    core = createTestCore();
    gateOpen = true;
    notifyWhenClosed = false;
    shown = [];
    notified = [];
    unread = [];
    bubble = {
      ids: [],
      get visibleIds() {
        return this.ids;
      },
      show(items) {
        this.ids = items.map((i) => i.inboxId);
        shown.push(items);
      },
      hide() {
        this.ids = [];
      },
    };
    presenter = new ReminderPresenter({
      db: core.db,
      clock: core.clock,
      gate: { check: () => (gateOpen ? { open: true } : { open: false, reason: 'QUIET_MODE' }) },
      bubble,
      notifyWhenClosed: () => notifyWhenClosed,
      systemNotify: (items) => notified.push(items),
      onUnreadChanged: (n) => unread.push(n),
    });
  });
  afterEach(() => core.dispose());

  const create = (content: string, inMs: number): ReminderDto =>
    core.ok<ReminderDto>('reminders.create', { content, dueAt: core.clock.now() + inMs, timeZone: TZ });
  const due = (): void => {
    materializeDue(core.db, core.clock.now(), newId);
    presenter.check();
  };

  it('相近到期的多个提醒合并成一个气泡', () => {
    create('a', MIN);
    create('b', MIN + 1000);
    core.clock.advance(2 * MIN);
    due();
    expect(shown).toHaveLength(1);
    expect(shown[0]?.map((i) => i.content)).toEqual(['a', 'b']);
    expect(unread.at(-1)).toBe(2);
  });

  it('确认显示前崩溃：重启后汇总提示一次，确认后不再弹出', () => {
    create('a', MIN);
    core.clock.advance(MIN);
    due();
    expect(shown).toHaveLength(1);
    // 未确认 → 下次检查仍是候选（例如重启后汇总一次）
    presenter.check();
    expect(shown).toHaveLength(2);
    presenter.acknowledge(bubble.ids);
    presenter.check();
    expect(shown).toHaveLength(2);
  });

  it('超过 24 小时的错过提醒只进信箱，不弹出（R08.AC-6）', () => {
    create('昨天的', MIN);
    create('刚才的', 30 * HOUR);
    core.clock.advance(30 * HOUR + MIN);
    due();
    expect(shown[0]?.map((i) => i.content)).toEqual(['刚才的']);
    expect(core.queries.run('inbox.unreadCount', {})).toBe(2);
  });

  it('安静模式：只进信箱，之后也不补弹（R08.AC-8）', () => {
    gateOpen = false;
    create('安静时到期', MIN);
    core.clock.advance(MIN);
    due();
    expect(shown).toHaveLength(0);
    expect(notified).toHaveLength(0);
    gateOpen = true;
    presenter.check();
    expect(shown).toHaveLength(0);
    expect(presenter.lastSuppressedReason).toBe('QUIET_MODE');
    expect(core.queries.run('inbox.unreadCount', {})).toBe(1);
  });

  it('安静时开启系统通知则发系统通知', () => {
    gateOpen = false;
    notifyWhenClosed = true;
    create('x', MIN);
    core.clock.advance(MIN);
    due();
    expect(notified).toHaveLength(1);
  });

  it('关闭气泡不等于已读；在信箱标为已读后气泡移除该项（R15.AC-3）', () => {
    create('a', MIN);
    create('b', MIN);
    core.clock.advance(MIN);
    due();
    bubble.hide();
    expect(core.queries.run('inbox.unreadCount', {})).toBe(2);
    due();
    const items = core.queries.run<InboxItemDto[]>('inbox.list', {});
    core.ok('inbox.markRead', { ids: [items[0]?.id] });
    bubble.ids = items.map((i) => i.id);
    presenter.onInboxChanged();
    expect(bubble.ids).toEqual([items[1]?.id]);
  });
});

describe('Scheduler', () => {
  let core: TestCore;
  beforeEach(() => {
    vi.useFakeTimers();
    core = createTestCore();
  });
  afterEach(() => {
    vi.useRealTimers();
    core.dispose();
  });

  it('到期时由定时器触发，入箱后回调', () => {
    core.ok('reminders.create', { content: 'x', dueAt: core.clock.now() + 5 * MIN, timeZone: TZ });
    const produced: number[] = [];
    let seq = 0;
    const scheduler = new Scheduler(core.db, core.clock, (n) => produced.push(n));
    scheduler.register(reminderJob(() => `i-${++seq}`));
    scheduler.start();
    expect(produced).toEqual([]);
    core.clock.advance(5 * MIN);
    vi.advanceTimersByTime(5 * MIN + 100);
    expect(produced).toEqual([1]);
    scheduler.stop();
  });

  it('系统时钟向前跳变（睡眠恢复）时兜底扫描也能补上', () => {
    core.ok('reminders.create', { content: 'x', dueAt: core.clock.now() + 2 * HOUR, timeZone: TZ });
    const produced: number[] = [];
    let seq = 0;
    const scheduler = new Scheduler(core.db, core.clock, (n) => produced.push(n));
    scheduler.register(reminderJob(() => `i-${++seq}`));
    scheduler.start();
    core.clock.advance(3 * HOUR);
    vi.advanceTimersByTime(20_000);
    expect(produced).toEqual([1]);
    scheduler.stop();
  });
});
