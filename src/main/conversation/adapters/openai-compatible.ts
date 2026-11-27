// OpenAI 兼容协议（/chat/completions + SSE）。DeepSeek、通义千问、Kimi、智谱、Ollama 等都提供这个接口。
// 流式文字 + 工具调用（tools / delta.tool_calls）。对话历史只用 system/user/assistant 三种角色，
// 本地执行结果以系统消息告诉模型，不依赖各家对 tool 角色消息的兼容程度。

import { z } from 'zod';
import type { ModelErrorCode } from '../../../shared/contracts/chat';
import type { AdapterDefinition, FetchLike, ModelAdapter, ModelEvent, ModelRequest } from '../model-adapter';

export const OpenAICompatibleConfig = z.object({
  baseUrl: z
    .string()
    .trim()
    .url()
    .refine((u) => /^https?:\/\//i.test(u), '只支持 http/https 地址'),
  model: z.string().trim().min(1).max(200),
});

/** 首个字节前的等待上限；流开始后每段之间的空闲上限 */
const CONNECT_TIMEOUT_MS = 30_000;
const IDLE_TIMEOUT_MS = 60_000;

export function classifyStatus(status: number): { code: ModelErrorCode; retryable: boolean } {
  if (status === 401 || status === 403) return { code: 'AUTH', retryable: false };
  if (status === 404) return { code: 'MODEL_NOT_FOUND', retryable: false };
  if (status === 402 || status === 429) return { code: 'RATE_LIMITED', retryable: true };
  if (status >= 500) return { code: 'SERVER', retryable: true };
  return { code: 'BAD_RESPONSE', retryable: false };
}

/** 从 SSE 文本块里取出完整的 data 行；返回剩余未完成的部分 */
export function splitSse(buffer: string): { events: string[]; rest: string } {
  const events: string[] = [];
  const lines = buffer.split(/\r?\n/);
  const rest = lines.pop() ?? '';
  for (const line of lines) {
    if (line.startsWith('data:')) events.push(line.slice(5).trim());
  }
  return { events, rest };
}

interface ToolCallDelta {
  index?: number;
  id?: string;
  function?: { name?: string; arguments?: string };
}

interface ChunkShape {
  choices?: Array<{ delta?: { content?: string | null; tool_calls?: ToolCallDelta[] | null }; finish_reason?: string | null }>;
  error?: { message?: string };
}

export class OpenAICompatibleAdapter implements ModelAdapter {
  // 协议支持工具调用；具体服务或模型不支持时会返回 HTTP 400，由对话执行器降级为只聊天
  readonly capabilities = { streaming: true, toolCalls: true, structuredOutput: false };

  constructor(
    private readonly config: z.output<typeof OpenAICompatibleConfig>,
    private readonly apiKey: string | null,
    private readonly fetch: FetchLike,
  ) {}

  async *stream(request: ModelRequest, signal: AbortSignal): AsyncIterable<ModelEvent> {
    const controller = new AbortController();
    const onAbort = (): void => controller.abort();
    signal.addEventListener('abort', onAbort);
    let timedOut = false;
    let timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, CONNECT_TIMEOUT_MS);
    const resetIdle = (): void => {
      clearTimeout(timer);
      timer = setTimeout(() => {
        timedOut = true;
        controller.abort();
      }, IDLE_TIMEOUT_MS);
    };

    const fail = (code: ModelErrorCode, retryable: boolean, detail?: string): ModelEvent =>
      signal.aborted ? { type: 'error', code: 'ABORTED', retryable: false } : { type: 'error', code, retryable, detail };

    try {
      let response: Response;
      try {
        response = await this.fetch(`${this.config.baseUrl.replace(/\/+$/, '')}/chat/completions`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Accept: 'text/event-stream',
            ...(this.apiKey ? { Authorization: `Bearer ${this.apiKey}` } : {}),
          },
          body: JSON.stringify({
            model: this.config.model,
            messages: request.messages,
            stream: true,
            ...(request.maxTokens ? { max_tokens: request.maxTokens } : {}),
            ...(request.temperature !== undefined ? { temperature: request.temperature } : {}),
            ...(request.tools?.length
              ? {
                  tools: request.tools.map((t) => ({
                    type: 'function',
                    function: { name: t.name, description: t.description, parameters: t.parameters },
                  })),
                  tool_choice: 'auto',
                }
              : {}),
          }),
          signal: controller.signal,
        });
      } catch {
        yield fail(timedOut ? 'TIMEOUT' : 'NETWORK', true);
        return;
      }

      if (!response.ok) {
        const { code, retryable } = classifyStatus(response.status);
        // 错误正文可能包含服务端信息，只截取少量用于界面诊断，不写日志
        const detail = (await response.text().catch(() => '')).slice(0, 300);
        yield fail(code, retryable, `HTTP ${response.status} ${detail}`.trim());
        return;
      }
      if (!response.body) {
        yield fail('BAD_RESPONSE', false, '没有响应内容');
        return;
      }

      resetIdle();
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      let finish: 'stop' | 'length' | 'tool_calls' | null = null;
      let sawData = false;
      // 工具调用按 index 分段到达；id 只在第一段出现
      const callIds = new Map<number, string>();
      const endCalls = function* (): Generator<ModelEvent> {
        for (const callId of callIds.values()) yield { type: 'tool_end', callId };
        callIds.clear();
      };
      while (true) {
        let chunk: Awaited<ReturnType<typeof reader.read>>;
        try {
          chunk = await reader.read();
        } catch {
          yield fail(timedOut ? 'TIMEOUT' : 'NETWORK', true, '连接中断');
          return;
        }
        if (chunk.done) break;
        resetIdle();
        buffer += decoder.decode(chunk.value, { stream: true });
        const { events, rest } = splitSse(buffer);
        buffer = rest;
        for (const data of events) {
          if (data === '[DONE]') {
            yield* endCalls();
            yield { type: 'end', reason: finish ?? 'stop' };
            return;
          }
          let parsed: ChunkShape;
          try {
            parsed = JSON.parse(data) as ChunkShape;
          } catch {
            continue;
          }
          sawData = true;
          if (parsed.error) {
            yield fail('SERVER', true, parsed.error.message?.slice(0, 300));
            return;
          }
          const choice = parsed.choices?.[0];
          const text = choice?.delta?.content;
          if (text) yield { type: 'text_delta', text };
          for (const call of choice?.delta?.tool_calls ?? []) {
            const index = call.index ?? 0;
            let callId = callIds.get(index);
            if (!callId) {
              callId = call.id || `call-${index}`;
              callIds.set(index, callId);
            }
            const name = call.function?.name;
            yield {
              type: 'tool_delta',
              callId,
              ...(name ? { name } : {}),
              argumentsDelta: call.function?.arguments ?? '',
            };
          }
          const reason = choice?.finish_reason;
          if (reason === 'stop' || reason === 'length' || reason === 'tool_calls') finish = reason;
        }
      }
      yield* endCalls();
      if (finish) yield { type: 'end', reason: finish };
      else yield fail(sawData ? 'NETWORK' : 'BAD_RESPONSE', sawData, sawData ? '回复没有正常结束' : '不是流式响应');
    } finally {
      clearTimeout(timer);
      signal.removeEventListener('abort', onAbort);
    }
  }
}

export const openAICompatible: AdapterDefinition<typeof OpenAICompatibleConfig> = {
  id: 'openai-compatible',
  label: 'OpenAI 兼容协议',
  configSchema: OpenAICompatibleConfig,
  create: (config, apiKey, fetch) => new OpenAICompatibleAdapter(config, apiKey, fetch),
};
