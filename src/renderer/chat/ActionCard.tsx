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
  'followUps.create': '约定跟进',
  'notes.create': '随手记',
  'preferences.setNickname': '称呼',
  'preferences.setStyle': '说话方式',
  'topics.create': '事项',
  'topics.recordProgress': '事项进展',
  'topics.setStatus': '事项',
  'topics.forget': '忘记事项',
  'memories.create': '记忆',
  'memories.forget': '忘记',
};

const STYLE_TEXT: Record<string, string> = { brief: '简短', lively: '活泼', gentle: '温柔' };
const TOPIC_STATUS: Record<string, string> = { active: '进行中', done: '已完成', archived: '已归档' };

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

  /** 可撤销的操作：卡片上的“撤销”走 UI 命令入口 */
  const undo = card.canUndo ? (
    <button type="button" disabled={busy} onClick={() => void act({ action: 'undo', operationId: card.operationId })}>
      撤销
    </button>
  ) : null;
  const undone = card.undone ? <span className="tag">已撤销</span> : null;

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
  if (card.kind === 'reminders.create' || card.kind === 'followUps.create') {
    const r = card.reminder;
    if (!r) return <div className="action-card compact">{title}：记录已不存在</div>;
    const follow = r.kind === 'follow_up';
    const status =
      r.status === 'cancelled'
        ? r.cancelReason?.startsWith('target_')
          ? '已自动取消'
          : '已取消'
        : r.status === 'materialized'
          ? follow
            ? '已来问过'
            : '已提醒'
          : r.revision > 1
            ? '已改期'
            : follow
              ? '已约好'
              : '已创建';
    return (
      <div className={`action-card done${r.status === 'cancelled' ? ' stale' : ''}`} role="status">
        <div className="card-title">
          {follow ? '约定跟进' : '提醒'} · {status}
          {card.onceOnly && <span className="tag">仅一次</span>}
        </div>
        <p className="card-main">{follow ? `到时候来问：${r.content}` : r.content}</p>
        <p className="card-time">{formatFullDateTime(r.dueAt)}</p>
        {r.topic && <p className="card-sub">事项：{r.topic.title}</p>}
        {follow && r.stopPolicy === 'none' && <p className="card-sub">完成后也会来问（复盘）</p>}
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
              {follow ? '取消跟进' : '取消提醒'}
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

  if (card.kind.startsWith('topics.')) {
    const t = card.topic;
    if (!t) return <div className="action-card compact">{title}：记录已删除</div>;
    const forgotten = t.forgottenAt !== null;
    const head =
      card.kind === 'topics.create'
        ? '已记住'
        : card.kind === 'topics.recordProgress'
          ? '已记下进展'
          : card.kind === 'topics.forget'
            ? '已忘记'
            : `已标为${TOPIC_STATUS[t.status] ?? ''}`;
    return (
      <div className={`action-card done${forgotten && card.kind !== 'topics.forget' ? ' stale' : ''}`} role="status">
        <div className="card-title">
          {title} · {head}
          {undone}
          {forgotten && card.kind !== 'topics.forget' && <span className="tag">已忘记</span>}
        </div>
        <p className="card-main">{t.title}</p>
        {t.progressNote && !forgotten && <p className="card-sub">最新进展：{t.progressNote}</p>}
        {card.kind === 'topics.forget' && !card.undone && <p className="card-sub">之后不会再提起；可以在小窝里恢复</p>}
        {card.kind === 'topics.setStatus' && !card.undone && t.status !== 'active' && (
          <p className="card-sub">未到期的跟进已自动取消</p>
        )}
        <div className="card-actions">
          {undo}
          <button type="button" onClick={() => window.chat.openNest('topics')}>
            在小窝查看
          </button>
        </div>
        {error && <p className="card-error">{error}</p>}
      </div>
    );
  }

  if (card.kind.startsWith('memories.')) {
    const m = card.memory;
    if (!m) return <div className="action-card compact">{title}：记录已删除</div>;
    const forgotten = m.forgottenAt !== null;
    return (
      <div className={`action-card done${forgotten && card.kind === 'memories.create' ? ' stale' : ''}`} role="status">
        <div className="card-title">
          {card.kind === 'memories.forget' ? '已忘记' : '记忆 · 已记住'}
          {undone}
          {forgotten && card.kind === 'memories.create' && <span className="tag">已忘记</span>}
        </div>
        <p className="card-main">{m.content}</p>
        {m.expiresAt !== null && <p className="card-sub">有效到 {formatFullDateTime(m.expiresAt - 1)}</p>}
        <div className="card-actions">
          {undo}
          <button type="button" onClick={() => window.chat.openNest('settings')}>
            在小窝查看
          </button>
        </div>
        {error && <p className="card-error">{error}</p>}
      </div>
    );
  }

  if (card.kind === 'preferences.setStyle') {
    return (
      <div className="action-card done" role="status">
        <div className="card-title">说话方式 · 已设置</div>
        <p className="card-main">{card.style ? `之后说话${STYLE_TEXT[card.style] ?? ''}一些` : '恢复默认'}</p>
        <div className="card-actions">
          <button type="button" onClick={() => window.chat.openNest('settings')}>
            修改
          </button>
        </div>
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
