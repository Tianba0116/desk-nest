import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { CommandResult } from '../../shared/contracts/command';
import type { BubbleItem } from '../../shared/contracts/reminders';
import { formatTime } from '../../shared/format-time';

async function run(name: 'inbox.markRead' | 'reminders.snooze', input: unknown): Promise<CommandResult> {
  const operationId = `bubble-${crypto.randomUUID()}`;
  try {
    return await window.bubble.command(name, input, operationId);
  } catch {
    // 回复丢失：同一 ID 重试，主进程返回已提交的结果（TD §6.3）
    return window.bubble.command(name, input, operationId);
  }
}

export function Bubble() {
  const [items, setItems] = useState<BubbleItem[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => window.bubble.onItems((next) => {
    setItems(next);
    setError(null);
  }), []);

  // 实际渲染后再回传确认（TD §11：发送成功不等于用户看见）
  useEffect(() => {
    if (items.length > 0) window.bubble.shown(items.map((i) => i.inboxId));
  }, [items]);

  useLayoutEffect(() => {
    if (ref.current) window.bubble.resize(ref.current.getBoundingClientRect().height + 16);
  }, [items, error]);

  const act = async (name: 'inbox.markRead' | 'reminders.snooze', input: unknown): Promise<void> => {
    setBusy(true);
    try {
      const result = await run(name, input);
      if (!result.ok) setError(result.errorCode === 'INVALID_STATE' ? '提醒已被取消' : '操作没有成功，请在信箱里处理');
    } catch {
      setError('操作没有成功，请在信箱里处理');
    } finally {
      setBusy(false);
    }
  };

  if (items.length === 0) return null;
  const single = items.length === 1 ? items[0] : undefined;

  return (
    <div className="bubble" ref={ref} role="alertdialog" aria-labelledby="bubble-title">
      <div className="bubble-head">
        <span id="bubble-title">⏰ {single ? '到点啦' : `有 ${items.length} 个提醒到期`}</span>
        <button type="button" className="icon" aria-label="收起（不影响信箱）" title="收起（不影响信箱）" onClick={() => window.bubble.close()}>
          ×
        </button>
      </div>
      <ul className="bubble-list">
        {items.map((item) => (
          <li key={item.inboxId}>
            <span className="content">{item.content}</span>
            <span className="time">{formatTime(item.dueAt)}</span>
          </li>
        ))}
      </ul>
      {error && <p className="error">{error}</p>}
      <div className="bubble-actions">
        <button
          type="button"
          className="primary"
          disabled={busy}
          onClick={() => void act('inbox.markRead', { ids: items.map((i) => i.inboxId) })}
        >
          知道了
        </button>
        {single && (
          <button type="button" disabled={busy} onClick={() => void act('reminders.snooze', { id: single.reminderId, minutes: 10 })}>
            10 分钟后再提醒
          </button>
        )}
        <button type="button" className="link" onClick={() => window.bubble.openInbox()}>
          打开信箱
        </button>
      </div>
    </div>
  );
}
