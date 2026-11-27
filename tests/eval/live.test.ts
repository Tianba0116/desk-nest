// 在真实模型服务上跑 M6 评估集，并比较两种流式方案（D-06）。默认跳过；需要用户提供服务和密钥：
//
//   DESK_NEST_EVAL_BASE_URL=https://api.deepseek.com/v1
//   DESK_NEST_EVAL_MODEL=deepseek-chat
//   DESK_NEST_EVAL_API_KEY=sk-...            （本地 Ollama 可以不填）
//   DESK_NEST_EVAL_STRATEGIES=two_phase,stream_retract   （可选，默认两种都跑）
//   npx vitest run tests/eval/live.test.ts
//
// 结果写到 eval-output/（不提交），包含每条样例的结论、回复和计时；密钥不会写入。

import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { OpenAICompatibleAdapter } from '../../src/main/conversation/adapters/openai-compatible';
import type { ConversationStrategy } from '../../src/shared/contracts/chat';
import { runCase, type CaseResult } from './harness';
import { M6_CASES } from './m6-cases';

const baseUrl = process.env['DESK_NEST_EVAL_BASE_URL'];
const model = process.env['DESK_NEST_EVAL_MODEL'] ?? '';
const apiKey = process.env['DESK_NEST_EVAL_API_KEY'] ?? null;
const strategies = (process.env['DESK_NEST_EVAL_STRATEGIES'] ?? 'two_phase,stream_retract')
  .split(',')
  .map((s) => s.trim())
  .filter((s): s is ConversationStrategy => s === 'two_phase' || s === 'stream_retract');

function percentile(values: number[], p: number): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1)] ?? null;
}

function summarize(results: CaseResult[]) {
  const turns = results.flatMap((r) => r.metrics);
  const visible = turns.flatMap((m) => (m.firstVisibleMs === null ? [] : [m.firstVisibleMs]));
  const actionTurns = turns.filter((m) => m.toolCalls > 0);
  return {
    cases: results.length,
    passed: results.filter((r) => r.pass).length,
    failed: results.filter((r) => !r.pass).map((r) => ({ id: r.id, problems: r.problems })),
    firstVisibleMs: { p50: percentile(visible, 50), p90: percentile(visible, 90) },
    actionTotalMs: { p50: percentile(actionTurns.map((m) => m.totalMs), 50), p90: percentile(actionTurns.map((m) => m.totalMs), 90) },
    requestsPerTurn: turns.length ? turns.reduce((n, m) => n + m.requests, 0) / turns.length : null,
    charsPerTurn: turns.length ? turns.reduce((n, m) => n + m.promptChars + m.outputChars, 0) / turns.length : null,
    retractedTurns: turns.filter((m) => m.retracted).length,
    retractedWithClaim: turns.filter((m) => m.retractedClaim).length,
    toolsRejected: turns.some((m) => m.toolsRejected),
  };
}

describe.skipIf(!baseUrl)('M6 评估集（真实服务）', () => {
  it(
    '零误执行、零重复写入；记录两种流式方案的延迟和撤回',
    async () => {
      const adapter = new OpenAICompatibleAdapter({ baseUrl: baseUrl as string, model }, apiKey, (url, init) => fetch(url, init));
      const report: Record<string, unknown> = { service: baseUrl, model, ranAt: new Date().toISOString(), strategies: {} };
      const failures: string[] = [];
      for (const strategy of strategies) {
        const results: CaseResult[] = [];
        for (const c of M6_CASES) {
          const result = await runCase(c, strategy, () => adapter);
          results.push(result);
          if (!result.pass) failures.push(`${strategy} ${c.id}: ${result.problems.join('；')}`);
        }
        (report['strategies'] as Record<string, unknown>)[strategy] = { summary: summarize(results), results };
      }
      const dir = join(process.cwd(), 'eval-output');
      mkdirSync(dir, { recursive: true });
      const file = join(dir, `m6-${new Date().toISOString().replace(/[:.]/g, '-')}.json`);
      writeFileSync(file, JSON.stringify(report, null, 2));
      console.log(`[eval] 报告：${file}`);
      for (const strategy of strategies) {
        console.log(`[eval] ${strategy}`, JSON.stringify((report['strategies'] as Record<string, { summary: unknown }>)[strategy]?.summary, null, 2));
      }
      expect(failures).toEqual([]);
    },
    60 * 60_000,
  );
});
