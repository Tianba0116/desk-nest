// 对话执行器（TD §7）：M5 只有纯聊天，没有工具调用。
// 每轮：读取已提交的轮次 → 构建有限上下文 → 流式请求 → 结束时短事务保存结果。

import type { LiveTurn, ModelErrorCode } from '../../shared/contracts/chat';
import type { Clock } from '../application/clock';
import type { Database } from '../storage/database';
import { finishTurn, loadTurn, markResponding, recentContext } from './conversation-store';
import type { ModelAdapter, ModelMessage } from './model-adapter';

/** 推送流式文字的最小间隔，避免每个字一次 IPC */
const LIVE_THROTTLE_MS = 50;

export interface RunnerHooks {
  onLive(turn: LiveTurn | null): void;
  onEnded(turnId: string, errorCode: ModelErrorCode | null): void;
}

export function systemPrompt(now: number, timeZone: string): string {
  const date = new Date(now);
  const local = date.toLocaleString('zh-CN', { timeZone, hour12: false, weekday: 'long' });
  return [
    '你是住在用户电脑桌面上的一只小宠物，性格温和、好奇、有点笨拙。用简短、自然、口语化的中文回复，一般不超过三四句话。',
    `现在是 ${local}（${timeZone}）。`,
    '能力边界：你现在只能聊天。你不能创建、修改或查看用户的提醒、笔记、待办，也不能上网搜索或操作电脑。',
    '如果用户请你做这些事，坦白说明你现在还做不到，并告诉用户可以在“小窝”里自己添加；不要假装已经完成。',
    '不知道的事情就说不知道，不要编造。',
  ].join('\n');
}

export class ConversationRunner {
  private active: { turnId: string; controller: AbortController } | null = null;
  private live: LiveTurn | null = null;

  constructor(
    private readonly db: Database,
    private readonly clock: Clock,
    private readonly hooks: RunnerHooks,
    private readonly newId: () => string = () => crypto.randomUUID(),
    private readonly timeZone: string = Intl.DateTimeFormat().resolvedOptions().timeZone,
  ) {}

  get liveTurn(): LiveTurn | null {
    return this.live;
  }

  get busy(): boolean {
    return this.active !== null;
  }

  /** 用户点“停止”：中止网络；已显示的部分保留并标为已停止（R05.AC-2） */
  stop(): void {
    this.active?.controller.abort();
  }

  /** 执行一个已提交（requesting 状态）的轮次；返回时轮次已结束并保存 */
  async run(turnId: string, adapter: ModelAdapter): Promise<void> {
    const turn = loadTurn(this.db, turnId);
    if (!turn || turn.state !== 'requesting' || this.active) return;
    const controller = new AbortController();
    this.active = { turnId, controller };

    const messages: ModelMessage[] = [
      { role: 'system', content: systemPrompt(this.clock.now(), this.timeZone) },
      ...recentContext(this.db, turn.user_message_id).map((m) => ({ role: m.role, content: m.content })),
    ];

    let text = '';
    let lastPush = 0;
    this.setLive({ turnId, userMessageId: turn.user_message_id, phase: 'requesting', text: '' });

    let errorCode: ModelErrorCode | null = null;
    let ended = false;
    try {
      for await (const event of adapter.stream({ messages, temperature: 0.8 }, controller.signal)) {
        if (event.type === 'text_delta') {
          if (!text) markResponding(this.db, turnId);
          text += event.text;
          const now = Date.now();
          if (now - lastPush >= LIVE_THROTTLE_MS) {
            lastPush = now;
            this.setLive({ turnId, userMessageId: turn.user_message_id, phase: 'responding', text });
          }
        } else if (event.type === 'end') {
          ended = true;
          break;
        } else if (event.type === 'error') {
          errorCode = event.code;
          break;
        }
      }
      if (!ended && !errorCode) errorCode = controller.signal.aborted ? 'ABORTED' : 'BAD_RESPONSE';
    } catch (error) {
      console.warn('[conversation] stream failed:', error instanceof Error ? error.name : 'unknown');
      errorCode = controller.signal.aborted ? 'ABORTED' : 'NETWORK';
    }
    if (controller.signal.aborted && !ended) errorCode = 'ABORTED';

    const now = this.clock.now();
    try {
      if (ended) finishTurn(this.db, turnId, { kind: 'completed', text: text.trim() ? text : '……' }, now, this.newId);
      else if (errorCode === 'ABORTED') finishTurn(this.db, turnId, { kind: 'cancelled', text }, now, this.newId);
      else finishTurn(this.db, turnId, { kind: 'failed', text, errorCode: errorCode ?? 'BAD_RESPONSE' }, now, this.newId);
    } finally {
      this.active = null;
      this.setLive(null);
      this.hooks.onEnded(turnId, ended ? null : errorCode);
    }
  }

  private setLive(turn: LiveTurn | null): void {
    this.live = turn;
    this.hooks.onLive(turn);
  }
}
