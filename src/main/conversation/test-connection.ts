// “测试连接”（R18.AC-1）：发一条很短的请求，看能否收到回复。

import type { ModelTestResult } from '../../shared/contracts/chat';
import type { ModelAdapter } from './model-adapter';

const TEST_TIMEOUT_MS = 20_000;

export async function testConnection(adapter: ModelAdapter, now: () => number = Date.now): Promise<ModelTestResult> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TEST_TIMEOUT_MS);
  const started = now();
  let sample = '';
  try {
    for await (const event of adapter.stream(
      { messages: [{ role: 'user', content: '请只回复两个字：你好' }], maxTokens: 16 },
      controller.signal,
    )) {
      if (event.type === 'text_delta') sample += event.text;
      if (event.type === 'end') return { ok: true, latencyMs: now() - started, sample: sample.slice(0, 40) };
      if (event.type === 'error') {
        const code = event.code === 'ABORTED' ? 'TIMEOUT' : event.code;
        return event.detail ? { ok: false, errorCode: code, detail: event.detail } : { ok: false, errorCode: code };
      }
    }
    return { ok: false, errorCode: 'BAD_RESPONSE' };
  } finally {
    clearTimeout(timer);
  }
}
