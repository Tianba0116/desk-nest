import { Fragment, useCallback, useEffect, useLayoutEffect, useRef, useState, type FormEvent } from 'react';
import {
  CHAT_MESSAGE_MAX,
  MODEL_ERROR_TEXT,
  type ActionCardDto,
  type ChatMessageDto,
  type ChatStatus,
  type LiveTurn,
  type ModelErrorCode,
} from '../../shared/contracts/chat';
import type { CommandResult } from '../../shared/contracts/command';
import { formatTime } from '../../shared/format-time';
import { ActionCard } from './ActionCard';

function opId(): string {
  return `chat-${crypto.randomUUID()}`;
}

/** 回复丢失时用同一 operationId 重试一次，不会重复保存消息（TD §6.3） */
async function withRetry<T>(call: (operationId: string) => Promise<CommandResult<T>>): Promise<CommandResult<T>> {
  const operationId = opId();
  try {
    return await call(operationId);
  } catch {
    return call(operationId);
  }
}

/** 卡片放在所属轮次的回复后面；轮次没有回复文字时放在对应的用户消息后面 */
function anchorCards(messages: ChatMessageDto[], cards: ActionCardDto[]): { byIndex: Map<number, ActionCardDto[]>; tail: ActionCardDto[] } {
  const byIndex = new Map<number, ActionCardDto[]>();
  const tail: ActionCardDto[] = [];
  for (const card of cards) {
    let index = -1;
    for (let i = messages.length - 1; i >= 0; i--) {
      const m = messages[i] as ChatMessageDto;
      if (m.role === 'assistant' && m.turnId === card.turnId) {
        index = i;
        break;
      }
    }
    if (index < 0) index = messages.findIndex((m) => m.id === card.userMessageId);
    if (index < 0) tail.push(card);
    else byIndex.set(index, [...(byIndex.get(index) ?? []), card]);
  }
  return { byIndex, tail };
}

const PHASE_TEXT: Record<LiveTurn['phase'], string> = { requesting: '正在想', executing: '执行中', responding: '回复中' };

const STATUS_TEXT: Partial<Record<ChatMessageDto['status'], string>> = {
  pending_retry: '未收到回复',
  cancelled: '已停止',
  failed: '回复没有完成',
  interrupted: '已中断',
};

export function Chat() {
  const [messages, setMessages] = useState<ChatMessageDto[]>([]);
  const [cards, setCards] = useState<ActionCardDto[]>([]);
  const [live, setLive] = useState<LiveTurn | null>(null);
  const [status, setStatus] = useState<ChatStatus | null>(null);
  const [draft, setDraft] = useState('');
  const [notice, setNotice] = useState<{ text: string; settings?: boolean } | null>(null);
  const [sending, setSending] = useState(false);
  const listRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);

  const reload = useCallback(async () => {
    const [history, nextStatus] = await Promise.all([window.chat.history(), window.chat.status()]);
    setMessages(history.messages);
    setCards(history.cards);
    setLive(history.live);
    setStatus(nextStatus);
  }, []);

  useEffect(() => {
    const offEvent = window.chat.onEvent((event) => {
      if (event.type === 'live') setLive(event.turn);
      else if (event.type === 'focus-input') inputRef.current?.focus();
      else if (event.type === 'ended') {
        setLive(null);
        if (event.errorCode && event.errorCode !== 'ABORTED') showError(event.errorCode);
      }
    });
    const offChanged = window.chat.onChanged(() => void reload());
    void reload();
    return () => {
      offEvent();
      offChanged();
    };
  }, [reload]);

  const showError = (code: ModelErrorCode): void =>
    setNotice({ text: MODEL_ERROR_TEXT[code], settings: code === 'AUTH' || code === 'MODEL_NOT_FOUND' || code === 'NOT_CONFIGURED' });

  // 新消息和流式文字出现时滚到底部
  useLayoutEffect(() => {
    const el = listRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [messages, cards.length, live?.text, live?.phase]);

  const busy = sending || live !== null;

  const send = async (event?: FormEvent): Promise<void> => {
    event?.preventDefault();
    const text = draft.trim();
    if (!text || busy) return;
    setNotice(null);
    setSending(true);
    try {
      const result = await withRetry((id) => window.chat.send(text, id));
      if (result.ok) setDraft('');
      else if (result.detail === 'NOT_CONFIGURED') showError('NOT_CONFIGURED');
      else if (result.detail === 'BUSY') showError('BUSY');
      else setNotice({ text: '消息没有发出去，请重试' });
    } catch {
      setNotice({ text: '消息没有发出去，请重试' });
    } finally {
      setSending(false);
    }
  };

  const retry = async (userMessageId: string): Promise<void> => {
    setNotice(null);
    const result = await withRetry((id) => window.chat.retry(userMessageId, id));
    if (!result.ok) {
      if (result.detail === 'NOT_CONFIGURED') showError('NOT_CONFIGURED');
      else if (result.detail === 'BUSY') showError('BUSY');
      else setNotice({ text: '重试没有成功' });
    }
  };

  const anchored = anchorCards(messages, cards);
  // 停止或失败、但已经有操作执行了：如实标为“部分完成”（R05.AC-2）
  const doneTurns = new Set(cards.filter((c) => c.state === 'done').map((c) => c.turnId));
  const doneMessages = new Set(cards.filter((c) => c.state === 'done').map((c) => c.userMessageId));
  const partial = new Set(
    messages
      .filter((m) =>
        m.role === 'assistant'
          ? (m.status === 'cancelled' || m.status === 'failed') && !!m.turnId && doneTurns.has(m.turnId)
          : m.status === 'pending_retry' && doneMessages.has(m.id),
      )
      .map((m) => m.id),
  );
  const retryable = new Set(
    messages.filter((m) => m.role === 'user' && m.status === 'pending_retry').map((m) => m.id),
  );

  return (
    <div className="chat">
      <header className="chat-head">
        <div>
          <strong>和宠物聊天</strong>
          <span className="model">
            {status ? (status.configured ? `${status.modelLabel ?? ''}${status.toolCalls ? '' : ' · 只能聊天'}` : '未配置模型') : ''}
          </span>
        </div>
        <div className="head-actions">
          <button type="button" className="link" onClick={() => window.chat.openSettings()}>
            设置
          </button>
          <button type="button" className="icon" aria-label="收起对话" title="收起（Esc）" onClick={() => window.chat.hide()}>
            ×
          </button>
        </div>
      </header>

      <div className="chat-list" ref={listRef} role="log" aria-live="polite" aria-label="聊天记录">
        {status && !status.configured && messages.length === 0 && (
          <div className="hint-card">
            <p>还没有配置模型，暂时只能用小窝里的笔记、待办和提醒。</p>
            <p>支持 DeepSeek、通义千问、Kimi、智谱、本地 Ollama 等 OpenAI 兼容服务。</p>
            <button type="button" className="primary" onClick={() => window.chat.openSettings()}>
              去配置模型
            </button>
          </div>
        )}
        {status?.configured && messages.length === 0 && !live && (
          <p className="empty">
            说点什么吧～
            {status.toolCalls && (
              <>
                <br />
                也可以说“明天下午三点提醒我改简历”
              </>
            )}
          </p>
        )}
        {messages.map((m, index) => (
          <Fragment key={m.id}>
          <div className={`msg ${m.role}${m.status === 'complete' || m.status === 'sent' ? '' : ' muted'}`}>
            <div className="bubble-text">{m.content}</div>
            <div className="msg-meta">
              <span>{formatTime(m.createdAt)}</span>
              {m.followUp && <span className="follow">💬 约好的跟进</span>}
              {m.superseded ? (
                <span className="state">旧回复：内容已更新，已按新内容重来</span>
              ) : partial.has(m.id) ? (
                <span className="state">部分完成</span>
              ) : (
                STATUS_TEXT[m.status] && <span className="state">{STATUS_TEXT[m.status]}</span>
              )}
              {retryable.has(m.id) && !busy && (
                <button type="button" className="link" onClick={() => void retry(m.id)}>
                  重试
                </button>
              )}
            </div>
          </div>
          {anchored.byIndex.get(index)?.map((card) => <ActionCard key={card.operationId} card={card} />)}
          </Fragment>
        ))}
        {anchored.tail.map((card) => (
          <ActionCard key={card.operationId} card={card} />
        ))}
        {live && (
          <div className="msg assistant live">
            <div className="bubble-text">
              {live.text || (
                <span className="thinking" aria-label={PHASE_TEXT[live.phase]}>
                  {PHASE_TEXT[live.phase]}…
                </span>
              )}
            </div>
            <div className="msg-meta">
              <span className="state">{live.text ? '回复中' : PHASE_TEXT[live.phase]}</span>
            </div>
          </div>
        )}
      </div>

      {notice && (
        <div className="notice" role="alert">
          <span>{notice.text}</span>
          {notice.settings && (
            <button type="button" className="link" onClick={() => window.chat.openSettings()}>
              打开设置
            </button>
          )}
          <button type="button" className="icon" aria-label="关闭提示" onClick={() => setNotice(null)}>
            ×
          </button>
        </div>
      )}

      <form className="composer" onSubmit={send}>
        <textarea
          ref={inputRef}
          aria-label="输入消息"
          placeholder={status?.configured === false ? '先在设置里配置模型' : '输入消息，Enter 发送，Shift+Enter 换行'}
          value={draft}
          maxLength={CHAT_MESSAGE_MAX}
          rows={2}
          onChange={(event) => setDraft(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
              event.preventDefault();
              void send();
            }
            if (event.key === 'Escape' && !busy) window.chat.hide();
          }}
        />
        {live ? (
          <button type="button" className="stop" onClick={() => window.chat.stop()}>
            停止
          </button>
        ) : (
          <button type="submit" className="primary" disabled={!draft.trim() || busy}>
            发送
          </button>
        )}
      </form>
    </div>
  );
}
