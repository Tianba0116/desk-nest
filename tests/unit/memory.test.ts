import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { readContextState } from '../../src/main/application/context-state';
import { actionCards, undoAction } from '../../src/main/conversation/actions';
import { chatHistory, recentContext } from '../../src/main/conversation/conversation-store';
import { ConversationRunner } from '../../src/main/conversation/runner';
import { relevantMemories } from '../../src/main/domains/memories';
import { followUpQuestion, materializeDue, takePopupCandidates } from '../../src/main/domains/reminders';
import type { MemoryDto, TopicDetailDto, TopicDto } from '../../src/shared/contracts/memory';
import type { InboxItemDto, ReminderDto } from '../../src/shared/contracts/reminders';
import { createTestCore, T0, type TestCore } from '../helpers/core';
import { calls, mockModel, say, type MockModel } from '../helpers/model';

const TZ = 'Asia/Shanghai';
const HOUR = 3600_000;

describe('事项、记忆、约定跟进（M7）', () => {
  let core: TestCore;
  let runner: ConversationRunner;
  let superseded: string[];

  beforeEach(() => {
    core = createTestCore();
    superseded = [];
    runner = new ConversationRunner(
      core.db,
      core.clock,
      { onLive: () => undefined, onEnded: () => undefined, onSuperseded: (id) => superseded.push(id) },
      () => crypto.randomUUID(),
      TZ,
      core.commands,
    );
  });
  afterEach(() => core.dispose());

  const send = (text: string): { userMessageId: string; turnId: string } => {
    core.clock.advance(1000);
    return core.ok('chat.send', { text, model: 'm' });
  };
  const turn = async (text: string, model: MockModel) => {
    const sent = send(text);
    await runner.run(sent.turnId, model);
    return sent;
  };
  const topics = () => core.queries.run<{ active: TopicDetailDto[]; closed: TopicDetailDto[]; forgotten: TopicDto[] }>('topics.list', {});
  const inbox = () => core.queries.run<InboxItemDto[]>('inbox.list', {});
  const cards = (turnId: string) => actionCards(core.db, core.commands, [turnId], core.clock.now());
  const newTopic = (title: string, progress = ''): TopicDto => core.ok<TopicDto>('topics.create', { title, progress });
  const followUp = (input: Record<string, unknown>): ReminderDto =>
    core.ok<ReminderDto>('followUps.create', { purpose: '准备得怎么样', dueAt: core.clock.now() + HOUR, timeZone: TZ, ...input });

  // ---------- 事项 ----------

  it('“记住我在准备产品经理面试”创建事项，来源是这条消息（R11.AC-1、AC-4）', async () => {
    const { turnId, userMessageId } = await turn(
      '记住我在准备产品经理面试',
      mockModel([calls([{ name: 'topics_create', args: { title: '准备产品经理面试' } }]), say('记住啦')]),
    );
    const [topic] = topics().active;
    expect(topic).toMatchObject({ title: '准备产品经理面试', status: 'active', source: { type: 'conversation', messageText: '记住我在准备产品经理面试' } });
    expect(cards(turnId)).toMatchObject([{ kind: 'topics.create', state: 'done', canUndo: true, topic: { title: '准备产品经理面试' } }]);
    expect(core.db.get<{ m: string }>('SELECT source_message_id AS m FROM topics')?.m).toBe(userMessageId);
  });

  it('一般分享不会自动创建事项：模型调用了也只出确认卡片（R11.AC-1）', async () => {
    const { turnId } = await turn(
      '最近在准备面试，有点紧张',
      mockModel([calls([{ name: 'topics_create', args: { title: '准备面试' } }]), say('加油')]),
    );
    expect(topics().active).toHaveLength(0);
    expect(cards(turnId)).toMatchObject([{ state: 'awaiting_input', suggestionLabel: '记住这件事' }]);
  });

  it('进行中的事项和最新进展进入系统提示；回答时以最新进展为准（R11.AC-3）', async () => {
    const t = newTopic('准备产品经理面试');
    core.ok('topics.recordProgress', { id: t.id, note: '简历改好了' });
    const model = mockModel([say('x'), say('简历已经改好啦')]);
    await turn('面试那件事还记得吗', model);
    const system = model.requests[0]?.messages[0]?.content ?? '';
    expect(system).toContain(`id=${t.id}，“准备产品经理面试”，最新进展：“简历改好了”`);
    expect(system).toContain('没有进展就问用户，不要编造结果');
  });

  it('对话里记录进展、标记完成；完成可以撤销', async () => {
    const t = newTopic('准备产品经理面试');
    await turn('简历改好了，帮我记一下进展', mockModel([calls([{ name: 'topics_recordProgress', args: { id: t.id, note: '简历改好了' } }]), say('好')]));
    expect(topics().active[0]?.progressNote).toBe('简历改好了');

    const done = await turn('面试结束了，这件事完成了', mockModel([calls([{ name: 'topics_setStatus', args: { id: t.id, status: 'done' } }]), say('恭喜')]));
    expect(topics().closed[0]).toMatchObject({ status: 'done' });
    const card = cards(done.turnId)[0];
    expect(card).toMatchObject({ canUndo: true });
    expect(undoAction(core.db, core.commands, card?.operationId as string, core.clock.now()).ok).toBe(true);
    expect(topics().active[0]).toMatchObject({ id: t.id, status: 'active' });
    expect(cards(done.turnId)[0]).toMatchObject({ undone: true });
    // 重复点击撤销：取回同一个结果，不会再执行一次
    expect(undoAction(core.db, core.commands, card?.operationId as string, core.clock.now())).toMatchObject({ ok: true, replayed: true });
  });

  it('引用不存在的事项 id：先问，不写入', async () => {
    const { turnId } = await turn('简历改好了，记一下进展', mockModel([calls([{ name: 'topics_recordProgress', args: { id: 'nope', note: '简历改好了' } }]), say('哪件事？')]));
    expect(cards(turnId)).toMatchObject([{ state: 'awaiting_input', question: '是哪件事的进展呢？' }]);
  });

  it('待办可以关联事项；被忘记的事项不能再关联（R07.AC-3）', () => {
    const t = newTopic('准备面试');
    const task = core.ok<{ id: string; topicId: string }>('tasks.create', { title: '改简历', topicId: t.id });
    expect(task.topicId).toBe(t.id);
    expect(topics().active[0]?.tasks).toMatchObject([{ title: '改简历' }]);
    core.ok('topics.forget', { id: t.id });
    expect(core.exec('tasks.create', { title: '再改一次', topicId: t.id })).toMatchObject({ ok: false, errorCode: 'NOT_FOUND' });
  });

  // ---------- 约定跟进 ----------

  it('明确约定才创建跟进；只是分享时只出确认卡片（R12.AC-1）', async () => {
    const t = newTopic('准备面试');
    const when = { weekday: 5, period: 'evening', hour: 8 };
    const shared = await turn('周五晚上八点要面试了', mockModel([calls([{ name: 'followUps_create', args: { purpose: '面试怎么样', topicId: t.id, when } }]), say('加油')]));
    expect(cards(shared.turnId)).toMatchObject([{ state: 'awaiting_input', suggestionLabel: '好，到时候来问我' }]);

    const asked = await turn('周五晚上八点问问我面试准备得怎么样', mockModel([calls([{ name: 'followUps_create', args: { purpose: '面试准备得怎么样', topicId: t.id, when } }]), say('好')]));
    const [card] = cards(asked.turnId);
    expect(card).toMatchObject({ state: 'done', reminder: { kind: 'follow_up', content: '面试准备得怎么样', topic: { id: t.id } } });
    // 2026-11-24 周二 → 周五 11-27 20:00（上海）
    expect(card?.reminder?.dueAt).toBe(Date.UTC(2026, 10, 27, 12, 0));
  });

  it('到期时按对象的最新状态发问，不用安排时的旧内容（R12.AC-4）', () => {
    const t = newTopic('准备产品经理面试');
    const f = followUp({ topicId: t.id });
    core.ok('topics.recordProgress', { id: t.id, note: '一面过了' });
    core.clock.advance(HOUR + 1000);
    expect(materializeDue(core.db, core.clock.now(), () => crypto.randomUUID())).toBe(1);
    const [bubble] = takePopupCandidates(core.db, core.clock.now());
    expect(bubble).toMatchObject({ kind: 'follow_up', reminderId: f.id });
    expect(bubble?.content).toBe('约好来问问你啦～关于“准备产品经理面试”，上次你说“一面过了”。准备得怎么样？');
    expect(inbox()[0]).toMatchObject({ category: 'follow_up', text: bubble?.content });
  });

  it('“去聊聊”：宠物把问题说出来；用户的回答带着这个问题进入上下文；重复点击只出现一次', () => {
    const t = newTopic('准备面试');
    followUp({ topicId: t.id });
    core.clock.advance(HOUR + 1000);
    materializeDue(core.db, core.clock.now(), () => crypto.randomUUID());
    const inboxId = inbox()[0]?.id as string;
    const meta = { operationId: `followup-open-${inboxId}` };
    core.ok('chat.openFollowUp', { inboxId }, meta);
    expect(core.exec('chat.openFollowUp', { inboxId }, meta)).toMatchObject({ replayed: true });
    const history = chatHistory(core.db);
    expect(history).toHaveLength(1);
    expect(history[0]).toMatchObject({ role: 'assistant', followUp: true });
    expect(inbox()[0]?.status).toBe('read');
    const { userMessageId } = send('还行，一面过了');
    expect(recentContext(core.db, userMessageId).map((m) => m.role)).toEqual(['assistant', 'user']);
  });

  it('事项完成后，未到期的跟进自动取消并在信箱说明；“完成后复盘”的不取消（R12.AC-5）', () => {
    const t = newTopic('准备面试');
    const normal = followUp({ topicId: t.id, purpose: '准备得怎么样' });
    const review = followUp({ topicId: t.id, purpose: '复盘一下', stopPolicy: 'none' });
    core.ok('topics.setStatus', { id: t.id, status: 'done' });
    const list = core.queries.run<{ upcoming: ReminderDto[]; history: ReminderDto[] }>('reminders.list', {});
    expect(list.upcoming.map((r) => r.id)).toEqual([review.id]);
    expect(list.history.find((r) => r.id === normal.id)).toMatchObject({ status: 'cancelled', cancelReason: 'target_done' });
    const note = inbox().find((i) => i.category === 'auto_cancelled');
    expect(note?.text).toContain('事项“准备面试”已经完成');
    expect(note?.text).toContain('已自动取消');
    // 说明只进信箱，不弹气泡
    expect(takePopupCandidates(core.db, core.clock.now())).toHaveLength(0);
  });

  it('删除或忘记事项时，连“完成后复盘”的跟进也取消', () => {
    const t = newTopic('准备面试');
    followUp({ topicId: t.id, stopPolicy: 'none' });
    core.ok('topics.forget', { id: t.id });
    expect(core.queries.run<{ upcoming: ReminderDto[] }>('reminders.list', {}).upcoming).toHaveLength(0);
  });

  it('待办完成或删除时，关联的跟进同样自动取消', () => {
    const task = core.ok<{ id: string }>('tasks.create', { title: '改简历' });
    followUp({ taskId: task.id });
    core.ok('tasks.setStatus', { id: task.id, status: 'done' });
    expect(core.queries.run<{ upcoming: ReminderDto[] }>('reminders.list', {}).upcoming).toHaveLength(0);
    expect(inbox()[0]?.text).toContain('待办“改简历”已经完成');
  });

  it('兜底：到期时对象已经结束，不再发问', () => {
    const t = newTopic('准备面试');
    followUp({ topicId: t.id });
    // 绕过命令直接改状态，模拟没有走自动取消的情况
    core.db.run(`UPDATE topics SET status = 'done' WHERE id = ?`, t.id);
    core.clock.advance(HOUR + 1000);
    materializeDue(core.db, core.clock.now(), () => crypto.randomUUID());
    expect(inbox().map((i) => i.category)).toEqual(['auto_cancelled']);
  });

  it('跟进可以改期、取消（与提醒共用）', () => {
    const f = followUp({});
    const moved = core.ok<ReminderDto>('reminders.reschedule', { id: f.id, revision: f.revision, dueAt: core.clock.now() + 2 * HOUR });
    expect(moved).toMatchObject({ kind: 'follow_up', revision: 2 });
    core.ok('reminders.cancel', { id: f.id });
    expect(followUpQuestion(core.db, f.id)).toContain('准备得怎么样');
  });

  // ---------- 记忆 ----------

  it('记住一条信息；只有与本轮输入相关时才进入上下文；没有命中时如实说没找到', async () => {
    await turn('记住我对花生过敏', mockModel([calls([{ name: 'memories_create', args: { content: '对花生过敏' } }]), say('记住了')]));
    const asked = mockModel([say('x'), say('你对花生过敏')]);
    await turn('我对什么过敏来着', asked);
    expect(asked.requests[0]?.messages[0]?.content).toContain('对花生过敏');
    const unrelated = mockModel([say('x'), say('不记得')]);
    await turn('我喜欢什么颜色', unrelated);
    const system = unrelated.requests[0]?.messages[0]?.content ?? '';
    expect(system).not.toContain('对花生过敏');
    expect(system).toContain('（没有找到）');
  });

  it('临时信息有有效期，过期后不再使用（R11.AC-6）', async () => {
    await turn('记住我这周都在出差', mockModel([calls([{ name: 'memories_create', args: { content: '这周都在出差', validFor: { until: 'this_week' } } }]), say('好')]));
    const [m] = core.queries.run<{ active: MemoryDto[] }>('memories.list', {}).active;
    // 2026-11-24 周二 → 周日结束，即 11-30 00:00（上海）
    expect(m?.expiresAt).toBe(Date.UTC(2026, 10, 29, 16, 0));
    expect(relevantMemories(core.db, '我在出差吗', core.clock.now())).toHaveLength(1);
    core.clock.set(Date.UTC(2026, 10, 29, 16, 1));
    expect(relevantMemories(core.db, '我在出差吗', core.clock.now())).toHaveLength(0);
    expect(core.queries.run<{ active: MemoryDto[] }>('memories.list', {}).active[0]?.expired).toBe(true);
  });

  // ---------- 纠正与忘记 ----------

  it('改称呼之后，旧称呼所在的聊天历史不再进入上下文（R10.AC-3，解决 M6 的已知限制）', async () => {
    await turn('叫我小王', mockModel([calls([{ name: 'preferences_setNickname', args: { nickname: '小王' } }]), say('好的小王')]));
    await turn('你好', mockModel([say('x'), say('小王你好呀')]));
    await turn('别叫我小王了，叫我小林', mockModel([calls([{ name: 'preferences_setNickname', args: { nickname: '小林' } }]), say('好的小林')]));
    const next = mockModel([say('x'), say('在呢')]);
    await turn('在吗', next);
    const sent = JSON.stringify(next.requests.map((r) => r.messages));
    expect(sent).not.toContain('小王');
    expect(sent).toContain('称呼对方为“小林”');
  });

  it('忘记一条记忆：之后每一次发给模型的内容都不包含它，来源消息被排除；可以恢复（R11.AC-5）', async () => {
    await turn('记住我对花生过敏', mockModel([calls([{ name: 'memories_create', args: { content: '对花生过敏' } }]), say('记住了，对花生过敏')]));
    const memory = core.queries.run<{ active: MemoryDto[] }>('memories.list', {}).active[0] as MemoryDto;
    const epoch = readContextState(core.db).epoch;
    await turn('忘掉我对花生过敏这件事', mockModel([calls([{ name: 'memories_forget', args: { id: memory.id } }]), say('好，已经忘了')]));
    expect(readContextState(core.db).epoch).toBeGreaterThan(epoch);
    const later = mockModel([say('x'), say('不记得哦')]);
    await turn('我对什么过敏？', later);
    const leaked = later.requests.flatMap((r) => r.messages).filter((m) => m.content.includes('花生'));
    expect(leaked).toEqual([]);
    core.ok('memories.restore', { id: memory.id });
    expect(relevantMemories(core.db, '花生过敏', core.clock.now())).toHaveLength(1);
  });

  it('删除本机记录：事项彻底删除，关联待办保留但解除关联', () => {
    const t = newTopic('准备面试');
    const task = core.ok<{ id: string }>('tasks.create', { title: '改简历', topicId: t.id });
    core.ok('topics.delete', { id: t.id });
    expect(core.db.get('SELECT 1 FROM topics WHERE id = ?', t.id)).toBeUndefined();
    expect(core.db.get<{ topic_id: string | null }>('SELECT topic_id FROM tasks WHERE id = ?', task.id)?.topic_id).toBeNull();
  });

  it('回复生成到一半时在小窝里纠正：中断这次请求，标为旧回复，并通知重试（TD §9.4）', async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const model = mockModel(async () => {
      await gate;
      return say('小王你好');
    });
    const sent = send('你好');
    const running = runner.run(sent.turnId, model, { tools: false });
    await new Promise((r) => setTimeout(r, 0));
    expect(runner.supersede()).toBe(true);
    release();
    await running;
    expect(superseded).toEqual([sent.userMessageId]);
    const row = core.db.get<{ state: string; error_code: string }>('SELECT state, error_code FROM turns WHERE id = ?', sent.turnId);
    expect(row).toEqual({ state: 'cancelled', error_code: 'SUPERSEDED' });
  });

  it('本轮自己的工具调用引起的纠正不会打断本轮', async () => {
    let interrupted = false;
    core.commands.onCommitted((topics) => {
      if (topics.includes('context')) interrupted = runner.supersede() || interrupted;
    });
    await turn('叫我小林', mockModel([calls([{ name: 'preferences_setNickname', args: { nickname: '小林' } }]), say('好的小林')]));
    expect(interrupted).toBe(false);
    expect(chatHistory(core.db).at(-1)).toMatchObject({ content: '好的小林', status: 'complete' });
  });

  it('表达方式进入系统提示（R10.AC-1）', async () => {
    await turn('以后说话简短一点', mockModel([calls([{ name: 'preferences_setStyle', args: { style: 'brief' } }]), say('好')]));
    const next = mockModel([say('x'), say('嗯')]);
    await turn('今天好累', next);
    expect(next.requests[0]?.messages[0]?.content).toContain('用户希望你说话简短');
  });
});

describe('基准时间', () => {
  it('测试时钟从 2026-11-24 09:00（上海）开始', () => {
    expect(new Date(T0).toISOString()).toBe('2026-11-24T01:00:00.000Z');
  });
});
