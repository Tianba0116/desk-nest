// 评估集的 mock 回放：给定模型的调用，本地链路必须零误执行、零重复写入（需求 §9.4）。
// 真实服务上的评估见 tests/eval/live.test.ts。

import { describe, expect, it } from 'vitest';
import { caseModel, runCase } from '../eval/harness';
import { M6_CASES } from '../eval/m6-cases';
import { M7_CASES } from '../eval/m7-cases';

describe('M6 评估集（mock 回放）', () => {
  it('样例数量与分类覆盖需求 §9.4', () => {
    expect(M6_CASES.length).toBeGreaterThanOrEqual(30);
    expect(M6_CASES.length).toBeLessThanOrEqual(50);
    const categories = new Set(M6_CASES.map((c) => c.category));
    for (const c of ['普通聊天', '明确创建', '含糊时间', '重复表达', '多个目标', '否定', '改口', '取消', '重复请求', '恶意指令']) {
      expect(categories).toContain(c);
    }
    expect(new Set(M6_CASES.map((c) => c.id)).size).toBe(M6_CASES.length);
  });

  for (const strategy of ['two_phase', 'stream_retract'] as const) {
    it.each(M6_CASES.map((c) => [c.id, c] as const))(`${strategy} · %s`, async (_id, c) => {
      const result = await runCase(c, strategy, caseModel);
      expect(result.problems).toEqual([]);
    });
  }

  it('M7 样例数量与分类覆盖 P1-B', () => {
    expect(M7_CASES.length).toBeGreaterThanOrEqual(20);
    expect(M7_CASES.length).toBeLessThanOrEqual(30);
    const categories = new Set(M7_CASES.map((c) => c.category));
    for (const c of ['闲聊不保存', '明确记住', '进展更新', '按最新进展回答', '跟进授权', '完成后自动取消', '纠正', '忘记']) {
      expect(categories).toContain(c);
    }
    expect(new Set([...M6_CASES, ...M7_CASES].map((c) => c.id)).size).toBe(M6_CASES.length + M7_CASES.length);
  });

  for (const strategy of ['two_phase', 'stream_retract'] as const) {
    it.each(M7_CASES.map((c) => [c.id, c] as const))(`M7 ${strategy} · %s`, async (_id, c) => {
      const result = await runCase(c, strategy, caseModel);
      expect(result.problems).toEqual([]);
    });
  }
});
