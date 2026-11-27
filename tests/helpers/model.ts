// 测试用的模型：按请求返回预先写好的事件，记录每次请求。

import type { ModelAdapter, ModelEvent, ModelRequest } from '../../src/main/conversation/model-adapter';

export type Responder = (request: ModelRequest, index: number) => ModelEvent[] | Promise<ModelEvent[]>;

export interface MockModel extends ModelAdapter {
  requests: ModelRequest[];
}

/** responses：按顺序返回；也可以传函数按请求内容决定 */
export function mockModel(responses: ModelEvent[][] | Responder, options: { toolCalls?: boolean } = {}): MockModel {
  const requests: ModelRequest[] = [];
  const respond: Responder = typeof responses === 'function' ? responses : (_r, i) => responses[i] ?? say('（没有更多回复）');
  return {
    capabilities: { streaming: true, toolCalls: options.toolCalls ?? true, structuredOutput: false },
    requests,
    async *stream(request, signal) {
      const index = requests.length;
      requests.push(request);
      const events = await respond(request, index);
      for (const event of events) {
        await Promise.resolve();
        if (signal.aborted) {
          yield { type: 'error', code: 'ABORTED', retryable: false };
          return;
        }
        yield event;
      }
    },
  };
}

export function say(text: string): ModelEvent[] {
  return [
    { type: 'text_delta', text },
    { type: 'end', reason: 'stop' },
  ];
}

export interface Call {
  name: string;
  args: Record<string, unknown> | string;
}

/** 模型的工具调用；参数分两段到达，检验拼接 */
export function calls(list: Call[], leadingText = ''): ModelEvent[] {
  const events: ModelEvent[] = leadingText ? [{ type: 'text_delta', text: leadingText }] : [];
  list.forEach((call, i) => {
    const json = typeof call.args === 'string' ? call.args : JSON.stringify(call.args);
    const half = Math.floor(json.length / 2);
    events.push({ type: 'tool_delta', callId: `call-${i}`, name: call.name, argumentsDelta: json.slice(0, half) });
    events.push({ type: 'tool_delta', callId: `call-${i}`, argumentsDelta: json.slice(half) });
  });
  list.forEach((_c, i) => events.push({ type: 'tool_end', callId: `call-${i}` }));
  events.push({ type: 'end', reason: 'tool_calls' });
  return events;
}

export function isRepair(request: ModelRequest): boolean {
  return request.messages.some((m) => m.role === 'system' && m.content.startsWith('【系统】你刚才的工具调用'));
}

export function isExpress(request: ModelRequest): boolean {
  return !request.tools;
}
