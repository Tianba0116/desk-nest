import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { classifyStatus, OpenAICompatibleAdapter, splitSse } from '../../src/main/conversation/adapters/openai-compatible';
import {
  chatHistory,
  CONTEXT_MESSAGE_LIMIT,
  interruptUnfinishedTurns,
  recentContext,
} from '../../src/main/conversation/conversation-store';
import type { FetchLike, ModelAdapter, ModelEvent } from '../../src/main/conversation/model-adapter';
import { ModelSettings, ModelSettingsError, type SecretCipher } from '../../src/main/conversation/model-settings';
import { ConversationRunner } from '../../src/main/conversation/runner';
import type { LiveTurn, ModelErrorCode } from '../../src/shared/contracts/chat';
import { createTestCore, type TestCore } from '../helpers/core';

// ---------- OpenAI 兼容适配器 ----------

function sseResponse(chunks: string[], status = 200): Response {
  const encoder = new TextEncoder();
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
      controller.close();
    },
  });
  return new Response(body, { status, headers: { 'Content-Type': 'text/event-stream' } });
}

const delta = (content: string, finish: string | null = null): string =>
  `data: ${JSON.stringify({ choices: [{ delta: { content }, finish_reason: finish }] })}\n\n`;

async function collect(adapter: ModelAdapter, signal = new AbortController().signal): Promise<ModelEvent[]> {
  const events: ModelEvent[] = [];
  for await (const e of adapter.stream({ messages: [{ role: 'user', content: 'hi' }] }, signal)) events.push(e);
  return events;
}

const config = { baseUrl: 'https://api.example.com/v1/', model: 'm1' };

describe('OpenAI 兼容适配器', () => {
  it('解析分块到达的 SSE，跨块的行也能拼起来', async () => {
    const full = delta('你') + delta('好') + delta('', 'stop') + 'data: [DONE]\n\n';
    const chunks = [full.slice(0, 10), full.slice(10, 47), full.slice(47)];
    const seen: { url: string; body: unknown; auth: string | null }[] = [];
    const fetch: FetchLike = async (url, init) => {
      seen.push({ url, body: JSON.parse(String(init.body)), auth: new Headers(init.headers).get('authorization') });
      return sseResponse(chunks);
    };
    const events = await collect(new OpenAICompatibleAdapter(config, 'sk-x', fetch));
    expect(events).toEqual([
      { type: 'text_delta', text: '你' },
      { type: 'text_delta', text: '好' },
      { type: 'end', reason: 'stop' },
    ]);
    expect(seen[0]?.url).toBe('https://api.example.com/v1/chat/completions');
    expect(seen[0]?.auth).toBe('Bearer sk-x');
    expect(seen[0]?.body).toMatchObject({ model: 'm1', stream: true });
  });

  it('没有密钥时不发送 Authorization（本地服务）', async () => {
    let auth: string | null = 'unset';
    const fetch: FetchLike = async (_url, init) => {
      auth = new Headers(init.headers).get('authorization');
      return sseResponse([delta('x', 'stop'), 'data: [DONE]\n\n']);
    };
    await collect(new OpenAICompatibleAdapter(config, null, fetch));
    expect(auth).toBeNull();
  });

  it.each([
    [401, 'AUTH'],
    [404, 'MODEL_NOT_FOUND'],
    [429, 'RATE_LIMITED'],
    [503, 'SERVER'],
    [400, 'BAD_RESPONSE'],
  ])('HTTP %i → %s', async (status, code) => {
    const fetch: FetchLike = async () => new Response('{"error":"x"}', { status });
    const events = await collect(new OpenAICompatibleAdapter(config, 'k', fetch));
    expect(events).toMatchObject([{ type: 'error', code }]);
    expect(classifyStatus(status).code).toBe(code);
  });

  it('网络失败 → NETWORK（可重试）', async () => {
    const fetch: FetchLike = async () => {
      throw new TypeError('fetch failed');
    };
    expect(await collect(new OpenAICompatibleAdapter(config, 'k', fetch))).toEqual([
      { type: 'error', code: 'NETWORK', retryable: true },
    ]);
  });

  it('流中途断开 → NETWORK；不是流式响应 → BAD_RESPONSE', async () => {
    const cut: FetchLike = async () => sseResponse([delta('半句')]);
    expect((await collect(new OpenAICompatibleAdapter(config, 'k', cut))).at(-1)).toMatchObject({ code: 'NETWORK' });
    const html: FetchLike = async () => sseResponse(['<html>not sse</html>']);
    expect((await collect(new OpenAICompatibleAdapter(config, 'k', html))).at(-1)).toMatchObject({ code: 'BAD_RESPONSE' });
  });

  it('用户中止 → ABORTED', async () => {
    const controller = new AbortController();
    const fetch: FetchLike = (_url, init) =>
      new Promise((_resolve, reject) => {
        init.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')));
        controller.abort();
      });
    expect(await collect(new OpenAICompatibleAdapter(config, 'k', fetch), controller.signal)).toEqual([
      { type: 'error', code: 'ABORTED', retryable: false },
    ]);
  });

  it('splitSse 保留未完成的行', () => {
    expect(splitSse('data: a\n\ndata: b')).toEqual({ events: ['a'], rest: 'data: b' });
    expect(splitSse(': keep-alive\r\ndata: c\r\n')).toEqual({ events: ['c'], rest: '' });
  });
});

// ---------- 模型设置 ----------

const fakeCipher = (available = true): SecretCipher => ({
  available: () => available,
  encrypt: (plain) => Buffer.from(`enc:${plain}`),
  decrypt: (data) => data.toString().replace(/^enc:/, ''),
});

describe('模型设置（R18）', () => {
  let core: TestCore;
  beforeEach(() => {
    core = createTestCore();
  });
  afterEach(() => core.dispose());

  const fetch: FetchLike = async () => sseResponse([]);
  const input = {
    presetId: 'deepseek',
    adapterId: 'openai-compatible',
    baseUrl: 'https://api.deepseek.com/v1',
    model: 'deepseek-chat',
    apiKey: 'sk-secret-123',
    consent: true,
  };

  it('未配置时不能创建适配器', () => {
    expect(new ModelSettings(core.settings, fakeCipher()).createAdapter(fetch)).toBeNull();
  });

  it('云服务首次配置必须确认发送范围（R18.AC-3）', () => {
    const settings = new ModelSettings(core.settings, fakeCipher());
    expect(() => settings.save({ ...input, consent: false })).toThrow(ModelSettingsError);
    settings.save(input);
    // 同一服务再次保存不需要重复确认；换了服务需要
    expect(() => settings.save({ ...input, consent: false, apiKey: undefined })).not.toThrow();
    expect(() => settings.save({ ...input, baseUrl: 'https://api.moonshot.cn/v1', consent: false })).toThrow(
      ModelSettingsError,
    );
  });

  it('密钥加密保存，不以明文出现在数据库中；界面只看到“已保存”', () => {
    const settings = new ModelSettings(core.settings, fakeCipher());
    const dto = settings.save(input);
    expect(dto).toMatchObject({ hasKey: true, keyStorage: 'encrypted' });
    expect(JSON.stringify(dto)).not.toContain('sk-secret-123');
    const rows = core.db.all<{ value_json: string }>('SELECT value_json FROM app_settings');
    expect(rows.some((r) => r.value_json.includes('sk-secret-123'))).toBe(false);
    expect(settings.createAdapter(fetch)?.label).toBe('DeepSeek · deepseek-chat');
  });

  it('系统加密不可用时只保存在内存（R18.AC-2）', () => {
    const settings = new ModelSettings(core.settings, fakeCipher(false));
    expect(settings.save(input)).toMatchObject({ keyStorage: 'memory', encryptionAvailable: false });
    expect(core.db.get(`SELECT 1 FROM app_settings WHERE key = 'model.secret'`)).toBeUndefined();
    expect(settings.createAdapter(fetch)).not.toBeNull();
    // 重启后（新实例）密钥不在了
    expect(new ModelSettings(core.settings, fakeCipher(false)).createAdapter(fetch)).toBeNull();
  });

  it('空字符串清除密钥；云服务没有密钥视为未配置', () => {
    const settings = new ModelSettings(core.settings, fakeCipher());
    settings.save(input);
    expect(settings.save({ ...input, apiKey: '' })).toMatchObject({ hasKey: false });
    expect(settings.createAdapter(fetch)).toBeNull();
  });

  it('本地服务不需要密钥和确认', () => {
    const settings = new ModelSettings(core.settings, fakeCipher());
    settings.save({ ...input, presetId: 'ollama', baseUrl: 'http://localhost:11434/v1', model: 'qwen2.5:7b', apiKey: '', consent: false });
    expect(settings.createAdapter(fetch)).not.toBeNull();
  });

  it('无效地址被拒绝', () => {
    const settings = new ModelSettings(core.settings, fakeCipher());
    expect(() => settings.save({ ...input, baseUrl: 'ftp://x' })).toThrow(ModelSettingsError);
    expect(() => settings.save({ ...input, model: '' })).toThrow(ModelSettingsError);
  });
});

// ---------- 对话执行器 ----------

/** 按脚本产出事件的假适配器；gate 用于在流中途停下来 */
function scripted(events: ModelEvent[], gate?: Promise<void>): ModelAdapter & { requests: unknown[] } {
  const requests: unknown[] = [];
  return {
    capabilities: { streaming: true, toolCalls: false, structuredOutput: false },
    requests,
    async *stream(request, signal) {
      requests.push(request);
      for (const [i, event] of events.entries()) {
        if (i === 1 && gate) await gate;
        if (signal.aborted) {
          yield { type: 'error', code: 'ABORTED', retryable: false };
          return;
        }
        yield event;
      }
    },
  };
}

describe('对话执行器（R05）', () => {
  let core: TestCore;
  let lives: Array<LiveTurn | null>;
  let ended: Array<[string, ModelErrorCode | null]>;
  let runner: ConversationRunner;

  beforeEach(() => {
    core = createTestCore();
    lives = [];
    ended = [];
    runner = new ConversationRunner(
      core.db,
      core.clock,
      { onLive: (t) => lives.push(t), onEnded: (id, code) => ended.push([id, code]) },
      () => crypto.randomUUID(),
      'Asia/Shanghai',
    );
  });
  afterEach(() => core.dispose());

  const send = (text: string, meta = {}): { userMessageId: string; turnId: string } =>
    core.ok('chat.send', { text, model: 'm' }, meta);
  const ok = (text: string): ModelEvent[] => [
    { type: 'text_delta', text },
    { type: 'end', reason: 'stop' },
  ];

  it('完成一轮：保存完整回复，界面先显示“正在想”再结束', async () => {
    const { turnId } = send('你好');
    await runner.run(turnId, scripted(ok('你好呀')));
    expect(chatHistory(core.db).map((m) => [m.role, m.content, m.status])).toEqual([
      ['user', '你好', 'sent'],
      ['assistant', '你好呀', 'complete'],
    ]);
    expect(lives[0]?.phase).toBe('requesting');
    expect(lives.at(-1)).toBeNull();
    expect(ended).toEqual([[turnId, null]]);
  });

  it('网络失败：用户消息标为待重试，不自动重发；重试沿用同一条消息（R18.AC-5、R05.AC-4）', async () => {
    const { userMessageId, turnId } = send('在吗');
    await runner.run(turnId, scripted([{ type: 'error', code: 'NETWORK', retryable: true }]));
    expect(chatHistory(core.db)).toMatchObject([{ id: userMessageId, status: 'pending_retry' }]);
    expect(ended).toEqual([[turnId, 'NETWORK']]);

    const retryMeta = { operationId: 'op-retry-chat-1' };
    const { turnId: second } = core.ok<{ turnId: string }>('chat.retry', { userMessageId, model: 'm' }, retryMeta);
    // 同一 operationId 重放不会再建一轮
    expect(core.exec('chat.retry', { userMessageId, model: 'm' }, retryMeta)).toMatchObject({ replayed: true });
    await runner.run(second, scripted(ok('在的')));
    const history = chatHistory(core.db);
    expect(history.filter((m) => m.role === 'user')).toHaveLength(1);
    expect(history.at(-1)).toMatchObject({ role: 'assistant', content: '在的' });
    // 已经有回复的消息不能再重试
    expect(core.exec('chat.retry', { userMessageId, model: 'm' })).toMatchObject({ ok: false, errorCode: 'INVALID_STATE' });
  });

  it('停止：保留已显示的部分并标为已停止（R05.AC-2）', async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const { turnId } = send('讲个长故事');
    const running = runner.run(
      turnId,
      scripted([{ type: 'text_delta', text: '从前' }, { type: 'text_delta', text: '有座山' }, { type: 'end', reason: 'stop' }], gate),
    );
    await new Promise((r) => setTimeout(r, 0));
    runner.stop();
    release();
    await running;
    expect(chatHistory(core.db).at(-1)).toMatchObject({ role: 'assistant', content: '从前', status: 'cancelled' });
    expect(ended[0]?.[1]).toBe('ABORTED');
  });

  it('同一时间只有一轮：进行中再发送返回 BUSY', async () => {
    send('第一条');
    expect(core.exec('chat.send', { text: '第二条', model: 'm' })).toMatchObject({ ok: false, detail: 'BUSY' });
  });

  it('重启时未完成的轮次标为中断，不自动重发', () => {
    const { userMessageId } = send('重启前发的');
    expect(interruptUnfinishedTurns(core.db, core.clock.now())).toBe(1);
    expect(chatHistory(core.db)).toMatchObject([{ id: userMessageId, status: 'pending_retry' }]);
    expect(core.exec('chat.send', { text: '新的', model: 'm' }).ok).toBe(true);
  });

  it('只携带最近的有效消息；失败和停止的回复不进入上下文（R05.AC-6）', async () => {
    for (let i = 0; i < 10; i++) {
      core.clock.advance(1000);
      const { turnId } = send(`问${i}`);
      await runner.run(turnId, scripted(ok(`答${i}`)));
    }
    core.clock.advance(1000);
    const failed = send('失败的');
    await runner.run(failed.turnId, scripted([{ type: 'text_delta', text: '半句' }, { type: 'error', code: 'SERVER', retryable: true }]));
    core.clock.advance(1000);
    const current = send('现在');
    const context = recentContext(core.db, current.userMessageId);
    expect(context).toHaveLength(CONTEXT_MESSAGE_LIMIT + 1);
    expect(context.at(-1)?.content).toBe('现在');
    expect(context[0]?.role).toBe('user');
    expect(context.some((m) => m.content === '半句' || m.content === '失败的')).toBe(false);
  });

  it('系统提示词说明不能代为操作（R05.AC-5）', async () => {
    const adapter = scripted(ok('好'));
    const { turnId } = send('明天提醒我开会');
    await runner.run(turnId, adapter);
    const request = adapter.requests[0] as { messages: Array<{ role: string; content: string }> };
    expect(request.messages[0]?.role).toBe('system');
    expect(request.messages[0]?.content).toContain('不能创建、修改或查看用户的提醒');
  });
});
