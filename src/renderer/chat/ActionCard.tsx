// 结果卡片（R05.AC-5、R08.AC-2）：只按本地记录渲染，不使用模型文字。
// 按钮全部走 UI 命令入口（chat.action），不经过模型。

import { useState } from 'react';
import type { ActionCardDto, ChatActionRequest } from '../../shared/contracts/chat';
import type { CommandResult } from '../../shared/contracts/command';
import { formatFullDateTime, fromLocalInputValue, toLocalInputValue } from '../../shared/format-time';

const ACTION_ERROR: Record<string, string> = {
  PAST_TIME: '这个时间已经过去了，请选择以后的时间',
  EXPIRED: '这个确认已经过期了，可以重新说一遍',
  REVISION_CONFLICT: '提醒已在别处修改，请看最新的卡片',
  INVALID_STATE: '当前状态下不能这样操作',
  NOT_FOUND: '找不到这条记录',
};

async function runAction(request: ChatActionRequest): Promise<CommandResult> {
  const operationId = `card-${crypto.randomUUID()}`;
  try {
    return await window.chat.action(request, operationId);
  } catch {
    // 回复丢失：用同一个 operationId 重试一次，不会重复执行（TD §6.3）
    return window.chat.action(request, operationId);
  }
}

const TITLE: Record<string, string> = {
  'reminders.create': '提醒',
  'notes.create': '随手记',
  'preferences.setNickname': '称呼',
};

export function ActionCard({ card }: { card: ActionCardDto }) {
  const [editing, setEditing] = useState(false);
  const [due, setDue] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const act = async (request: ChatActionRequest): Promise<boolean> => {
    setBusy(true);
    setError(null);
    try {
      const result = await runAction(request);
      if (!result.ok) setError(ACTION_ERROR[result.errorCode] ?? result.detail ?? '没有成功，请稍后再试');
      return result.ok;
    } catch {
      setError('没有成功，请稍后再试');
      return false;
    } finally {
      setBusy(false);
    }
  };

  const title = TITLE[card.kind] ?? '操作';

  if (card.state === 'resolved') {
    return <div className="action-card compact">{title}：已补充信息，见下方</div>;
  }
  if (card.state === 'expired') {
    return <div className="action-card compact">{title}：没有补全，已作废</div>;
  }
  if (card.state === 'cancelled' && !card.errorText) {
    return <div className="action-card compact">{title}：已取消，没有创建</div>;
  }
  if (card.state === 'failed' || card.state === 'cancelled') {
    return (
      <div className="action-card failed" role="status">
        <div className="card-title">{title} · 没有完成</div>
        <p>{card.errorText}</p>
      </div>
    );
  }

  if (card.state === 'awaiting_input') {
    return (
      <div className="action-card pending" role="status">
        <div className="card-title">{title} · 等待补充信息</div>
        <p>{card.question}</p>
        <div className="card-actions">
          {card.suggestionLabel && (
            <button type="button" className="primary" disabled={busy} onClick={() => void act({ action: 'confirmDraft', draftId: card.operationId })}>
              {card.suggestionLabel}
            </button>
          )}
          <button type="button" disabled={busy} onClick={() => void act({ action: 'dismissDraft', draftId: card.operationId })}>
            不用了
          </button>
        </div>
        {error && <p className="card-error">{error}</p>}
      </div>
    );
  }

  // 已执行
  if (card.kind === 'reminders.create') {
    const r = card.reminder;
    if (!r) return <div className="action-card compact">提醒：记录已不存在</div>;
    const status =
      r.status === 'cancelled' ? '已取消' : r.status === 'materialized' ? '已提醒' : r.revision > 1 ? '已改期' : '已创建';
    return (
      <div className={`action-card done${r.status === 'cancelled' ? ' stale' : ''}`} role="status">
        <div className="card-title">
          提醒 · {status}
          {card.onceOnly && <span className="tag">仅一次</span>}
        </div>
        <p className="card-main">{r.content}</p>
        <p className="card-time">{formatFullDateTime(r.dueAt)}</p>
        {r.status === 'scheduled' && !editing && (
          <div className="card-actions">
            <button
              type="button"
              disabled={busy}
              onClick={() => {
                setDue(toLocalInputValue(r.dueAt));
                setEditing(true);
              }}
            >
              修改时间
            </button>
            <button
              type="button"
              className="danger"
              disabled={busy}
              onClick={() => void act({ action: 'cancelReminder', id: r.id, revision: r.revision })}
            >
              取消提醒
            </button>
          </div>
        )}
        {editing && (
          <form
            className="card-edit"
            onSubmit={(event) => {
              event.preventDefault();
              const dueAt = fromLocalInputValue(due);
              if (dueAt === null) return;
              void act({ action: 'rescheduleReminder', id: r.id, revision: r.revision, dueAt }).then((ok) => {
                if (ok) setEditing(false);
              });
            }}
          >
            <input type="datetime-local" aria-label="新的提醒时间" value={due} required onChange={(event) => setDue(event.target.value)} />
            <button type="submit" className="primary" disabled={busy}>
              保存
            </button>
            <button type="button" disabled={busy} onClick={() => setEditing(false)}>
              取消
            </button>
          </form>
        )}
        {error && <p className="card-error">{error}</p>}
      </div>
    );
  }

  if (card.kind === 'notes.create') {
    const n = card.note;
    return (
      <div className={`action-card done${!n || n.deleted ? ' stale' : ''}`} role="status">
        <div className="card-title">随手记 · {!n ? '记录已不存在' : n.deleted ? '已删除' : '已记下'}</div>
        {n && <p className="card-main">{n.label}</p>}
        {n && !n.deleted && (
          <div className="card-actions">
            <button type="button" onClick={() => window.chat.openNest('notes')}>
              在小窝打开
            </button>
          </div>
        )}
      </div>
    );
  }

  if (card.kind === 'preferences.setNickname') {
    return (
      <div className="action-card done" role="status">
        <div className="card-title">称呼 · {card.nickname ? '已设置' : '已清除'}</div>
        {card.nickname && <p className="card-main">以后叫你“{card.nickname}”</p>}
        <div className="card-actions">
          <button type="button" onClick={() => window.chat.openNest('settings')}>
            修改
          </button>
        </div>
      </div>
    );
  }

  return <div className="action-card compact">{title}：已完成</div>;
}
