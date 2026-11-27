// 评估集的执行与判定：mock 回放（单元测试）和真实服务评估共用。

import { openDrafts } from '../../src/main/conversation/actions';
import { chatHistory, type TurnMetrics } from '../../src/main/conversation/conversation-store';
import type { ModelAdapter } from '../../src/main/conversation/model-adapter';
import { ConversationRunner } from '../../src/main/conversation/runner';
import { readPreferences } from '../../src/main/domains/preferences';
import type { ConversationStrategy } from '../../src/shared/contracts/chat';
import { ManualClock } from '../../src/main/application/clock';
import { createTestCore, type TestCore } from '../helpers/core';
import { calls, isExpress, isRepair, mockModel, say } from '../helpers/model';
import { EVAL_BASE, EVAL_TZ, type EvalCase, type EvalTurn } from './m6-cases';

export interface CaseResult {
  id: string;
  category: string;
  strategy: ConversationStrategy;
  pass: boolean;
  problems: string[];
  metrics: TurnMetrics[];
  replies: string[];
}

const sh = (month: number, day: number, hour: number, minute: number): number => Date.UTC(2026, month - 1, day, hour - 8, minute);

/** 模拟“正确的模型”：决定阶段按样例调用，修复阶段不再调用，表达阶段简单回复 */
export function caseModel(core: TestCore, turn: EvalTurn): ModelAdapter {
  return mockModel((request) => {
    if (isExpress(request)) return say('好的～');
    if (isRepair(request)) return say('');
    if (!turn.mock?.length) return say('（聊天）');
    const draftId = openDrafts(core.db, core.clock.now())[0]?.operation_id ?? 'none';
    const topicId = core.db.get<{ id: string }>(`SELECT id FROM topics WHERE forgotten_at IS NULL ORDER BY updated_at DESC`)?.id ?? 'none';
    const memoryId = core.db.get<{ id: string }>(`SELECT id FROM memories WHERE forgotten_at IS NULL ORDER BY updated_at DESC`)?.id ?? 'none';
    return calls(
      turn.mock.map((c) => ({
        name: c.name,
        args:
          typeof c.args === 'string'
            ? c.args
            : JSON.parse(
                JSON.stringify(c.args)
                  .replaceAll('"$draft"', JSON.stringify(draftId))
                  .replaceAll('"$topic"', JSON.stringify(topicId))
                  .replaceAll('"$memory"', JSON.stringify(memoryId)),
              ),
      })),
    );
  });
}

export async function runCase(
  c: EvalCase,
  strategy: ConversationStrategy,
  model: (core: TestCore, turn: EvalTurn) => ModelAdapter,
): Promise<CaseResult> {
  const core = createTestCore(undefined, new ManualClock(EVAL_BASE));
  const runner = new ConversationRunner(core.db, core.clock, { onLive: () => undefined, onEnded: () => undefined }, undefined, EVAL_TZ, core.commands);
  const metrics: TurnMetrics[] = [];
  const problems: string[] = [];
  const sentByTurn: string[][] = [];
  try {
    for (const [i, turn] of c.turns.entries()) {
      core.clock.set(EVAL_BASE + i * 30_000);
      const sent = core.ok<{ turnId: string }>('chat.send', { text: turn.say, model: 'eval' });
      const inner = model(core, turn);
      const recorded: string[] = [];
      sentByTurn.push(recorded);
      // 记录实际发给模型的消息（不含工具定义），用于回流检查
      const adapter: ModelAdapter = {
        capabilities: inner.capabilities,
        stream: (request, signal) => {
          recorded.push(...request.messages.map((m) => m.content));
          return inner.stream(request, signal);
        },
      };
      await runner.run(sent.turnId, adapter, { strategy });
      const row = core.db.get<{ state: string; metrics_json: string | null }>('SELECT state, metrics_json FROM turns WHERE id = ?', sent.turnId);
      if (row?.metrics_json) metrics.push(JSON.parse(row.metrics_json) as TurnMetrics);
      if (row?.state !== 'completed') problems.push(`第 ${i + 1} 轮没有完成：${row?.state}`);
    }

    const e = c.expect;
    const reminders = core.db.all<{ content: string; due_at: number }>(
      `SELECT content, due_at FROM scheduled_actions WHERE status != 'cancelled' ORDER BY due_at`,
    );
    if (e.reminders) {
      if (reminders.length !== e.reminders.length) {
        problems.push(`提醒数量 ${reminders.length}，期望 ${e.reminders.length}：${reminders.map((x) => x.content).join('、')}`);
      }
      for (const want of e.reminders) {
        const dueAt = sh(...want.at);
        if (!reminders.some((x) => want.content.test(x.content) && x.due_at === dueAt)) {
          problems.push(`没有找到提醒 ${want.content} @ ${want.at.join('/')}`);
        }
      }
    }
    if (e.notes !== undefined) {
      const notes = core.db.get<{ n: number }>('SELECT COUNT(*) AS n FROM notes WHERE deleted_at IS NULL')?.n ?? 0;
      if (notes !== e.notes) problems.push(`笔记数量 ${notes}，期望 ${e.notes}`);
    }
    if (e.nickname !== undefined) {
      const nickname = readPreferences(core.db).nickname;
      if (nickname !== e.nickname) problems.push(`称呼 ${nickname}，期望 ${e.nickname}`);
    }
    if (e.activeTopics) {
      const titles = core.db.all<{ title: string }>(`SELECT title FROM topics WHERE forgotten_at IS NULL AND status = 'active'`).map((t) => t.title);
      if (titles.length !== e.activeTopics.length || !e.activeTopics.every((p) => titles.some((t) => p.test(t)))) {
        problems.push(`进行中的事项：${titles.join('、') || '（无）'}`);
      }
    }
    if (e.doneTopics !== undefined) {
      const n = core.db.get<{ n: number }>(`SELECT COUNT(*) AS n FROM topics WHERE forgotten_at IS NULL AND status = 'done'`)?.n ?? 0;
      if (n !== e.doneTopics) problems.push(`已完成的事项 ${n}，期望 ${e.doneTopics}`);
    }
    if (e.topicProgress) {
      const progress = core.db.all<{ p: string }>(`SELECT progress_note AS p FROM topics`).map((r) => r.p);
      if (!progress.some((p) => e.topicProgress?.test(p))) problems.push(`事项进展：${progress.join('、') || '（无）'}`);
    }
    if (e.memories !== undefined) {
      const n = core.db.get<{ n: number }>(`SELECT COUNT(*) AS n FROM memories WHERE forgotten_at IS NULL`)?.n ?? 0;
      if (n !== e.memories) problems.push(`记忆数量 ${n}，期望 ${e.memories}`);
    }
    if (e.followUps !== undefined) {
      const n = core.db.get<{ n: number }>(`SELECT COUNT(*) AS n FROM scheduled_actions WHERE kind = 'follow_up' AND status = 'scheduled'`)?.n ?? 0;
      if (n !== e.followUps) problems.push(`跟进数量 ${n}，期望 ${e.followUps}`);
    }
    if (e.noLeak) {
      const { after, terms } = e.noLeak;
      sentByTurn.slice(after).forEach((messages, offset) => {
        for (const term of terms) {
          if (messages.some((m) => m.includes(term))) problems.push(`第 ${after + offset + 1} 轮发给模型的内容里还有“${term}”`);
        }
      });
    }
    if (e.pendingDraft !== undefined) {
      const pending = openDrafts(core.db, core.clock.now()).length > 0;
      if (pending !== e.pendingDraft) problems.push(pending ? '留下了意外的待补充草稿' : '应该先询问缺少的信息');
    }
    const replies = chatHistory(core.db)
      .filter((m) => m.role === 'assistant')
      .map((m) => m.content);
    return { id: c.id, category: c.category, strategy, pass: problems.length === 0, problems, metrics, replies };
  } finally {
    core.dispose();
  }
}
