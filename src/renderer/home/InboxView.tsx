import type { InboxItemDto } from '../../shared/contracts/reminders';
import { formatTime } from '../../shared/format-time';
import { useQuery } from './api';
import { FocusResult } from './FocusView';
import { useAction } from './useAction';

export function InboxView() {
  const { data: items } = useQuery('inbox.list', {}, ['inbox', 'reminders', 'focus', 'tasks']);
  const { busy, run } = useAction();
  const unread = items?.filter((i) => i.status === 'unread').length ?? 0;

  return (
    <section aria-labelledby="inbox-title">
      <header className="view-header with-action">
        <div>
          <h1 id="inbox-title">信箱</h1>
          <p className="view-hint">到期的提醒和约好的跟进都会留在这里；关闭气泡不会删除，也不会完成待办。</p>
        </div>
        {unread > 0 && (
          <button type="button" disabled={busy} onClick={() => void run('inbox.markAllRead', {})}>
            全部标为已读
          </button>
        )}
      </header>
      {items && items.length === 0 && <p className="empty">信箱是空的。</p>}
      <ul className="card-list" role="list" aria-label="信箱">
        {items?.map((item) => <InboxCard key={item.id} item={item} />)}
      </ul>
    </section>
  );
}

function InboxCard({ item }: { item: InboxItemDto }) {
  const { busy, run } = useAction();
  const r = item.reminder;
  const unread = item.status === 'unread';

  // 专注结束（R09.AC-2）：由你选择完成待办、记录进展或再来一轮；因时间调整暂停的提示（R09.AC-7）
  if (item.category === 'focus' || item.category === 'focus_paused') {
    return (
      <li className={`card inbox-card${unread ? ' is-unread' : ''}`} aria-label={`${unread ? '未读' : '已读'}：${item.text ?? '专注'}`}>
        <div className="inbox-head">
          {unread && <span className="unread-dot" aria-hidden="true" />}
          <span className="badge">⏳ 专注</span>
          <h3 className="card-title-inline">{item.text}</h3>
        </div>
        {item.category === 'focus' && item.focus && (
          <ul className="card-list" role="list">
            <FocusResult session={item.focus} latest={item.focus.status !== 'running' && item.focus.status !== 'paused'} />
          </ul>
        )}
        {unread && (
          <div className="card-actions spaced">
            <button type="button" disabled={busy} onClick={() => void run('inbox.markRead', { ids: [item.id] })}>
              知道了
            </button>
          </div>
        )}
      </li>
    );
  }

  // 跟进因对象完成或删除而自动取消的说明（R12.AC-5）
  if (item.category === 'auto_cancelled') {
    return (
      <li className={`card inbox-card${unread ? ' is-unread' : ''}`} aria-label={`${unread ? '未读' : '已读'}：跟进已自动取消`}>
        <div className="inbox-head">
          {unread && <span className="unread-dot" aria-hidden="true" />}
          <span className="badge">💬 跟进已自动取消</span>
        </div>
        <p>{item.text}</p>
        {unread && (
          <div className="card-actions spaced">
            <button type="button" disabled={busy} onClick={() => void run('inbox.markRead', { ids: [item.id] })}>
              知道了
            </button>
          </div>
        )}
      </li>
    );
  }

  // 跟进到期：按对象的最新状态发问（R12.AC-4）
  if (item.category === 'follow_up') {
    const live = !item.stale && r?.status === 'materialized';
    return (
      <li className={`card inbox-card${unread ? ' is-unread' : ''}`} aria-label={`${unread ? '未读' : '已读'}跟进：${r?.content ?? ''}`}>
        <div className="inbox-head">
          {unread && <span className="unread-dot" aria-hidden="true" />}
          <span className="badge">💬 约好的跟进</span>
          <h3 className="card-title-inline">{r?.content ?? '（已删除）'}</h3>
        </div>
        {live && <p>{item.text}</p>}
        <p className="meta">
          {item.dueAt !== null && <span>{formatTime(item.dueAt)} 到期</span>}
          {r?.topic && <span>事项：{r.topic.title}</span>}
          {!live && r && <span>{r.status === 'cancelled' ? '已取消' : '已改期'}</span>}
        </p>
        {unread && (
          <div className="card-actions spaced">
            {live && (
              <button type="button" className="primary" onClick={() => void window.nest.openFollowUp(item.id)}>
                去聊聊
              </button>
            )}
            <button type="button" disabled={busy} onClick={() => void run('inbox.markRead', { ids: [item.id] })}>
              知道了
            </button>
          </div>
        )}
      </li>
    );
  }

  // 按提醒的当前状态说明：入箱后被推迟/改期/取消的卡片只显示状态（R15.AC-4）
  let state: string | null = null;
  if (!r) state = '提醒已不存在';
  else if (r.status === 'cancelled') state = '已取消';
  else if (item.stale && r.status === 'scheduled') state = `已推迟到 ${formatTime(r.dueAt)}`;
  else if (item.stale) state = '已改期';

  const actionable = unread && !item.stale && r?.status === 'materialized';

  return (
    <li className={`card inbox-card${unread ? ' is-unread' : ''}`} aria-label={`${unread ? '未读' : '已读'}提醒：${r?.content ?? ''}`}>
      <div className="inbox-head">
        {unread && <span className="unread-dot" aria-hidden="true" />}
        <span className="badge">⏰ 提醒</span>
        <h3 className="card-title-inline">{r?.content ?? '（已删除）'}</h3>
      </div>
      <p className="meta">
        {item.dueAt !== null && <span>{formatTime(item.dueAt)} 到期</span>}
        {r?.task && <span>关联待办：{r.task.title}</span>}
        {state && <span>{state}</span>}
        {!unread && item.readAt !== null && <span>已读</span>}
      </p>
      {actionable && r && (
        <div className="card-actions spaced">
          <button type="button" className="primary" disabled={busy} onClick={() => void run('inbox.markRead', { ids: [item.id] })}>
            知道了
          </button>
          {[10, 60].map((minutes) => (
            <button key={minutes} type="button" disabled={busy} onClick={() => void run('reminders.snooze', { id: r.id, minutes })}>
              {minutes === 60 ? '1 小时后' : `${minutes} 分钟后`}再提醒
            </button>
          ))}
        </div>
      )}
      {unread && !actionable && (
        <div className="card-actions spaced">
          <button type="button" disabled={busy} onClick={() => void run('inbox.markRead', { ids: [item.id] })}>
            标为已读
          </button>
        </div>
      )}
    </li>
  );
}
