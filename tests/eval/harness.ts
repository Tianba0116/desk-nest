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
    return calls(
      turn.mock.map((c) => ({
        name: c.name,
        args: typeof c.args === 'string' ? c.args : JSON.parse(JSON.stringify(c.args).replaceAll('"$draft"', JSON.stringify(draftId))),
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
  try {
    for (const [i, turn] of c.turns.entries()) {
      core.clock.set(EVAL_BASE + i * 30_000);
      const sent = core.ok<{ turnId: string }>('chat.send', { text: turn.say, model: 'eval' });
      await runner.run(sent.turnId, model(core, turn), { strategy });
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
