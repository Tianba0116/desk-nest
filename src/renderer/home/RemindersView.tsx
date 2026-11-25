import { useEffect, useState, type FormEvent } from 'react';
import type { StartupState } from '../../shared/contracts/nest-ipc';
import { REMINDER_CONTENT_MAX, type ReminderDto } from '../../shared/contracts/reminders';
import { formatFullDateTime, formatTime, fromLocalInputValue, toLocalInputValue } from '../../shared/format-time';
import { useQuery } from './api';
import { useAction } from './useAction';

const TIME_ZONE = Intl.DateTimeFormat().resolvedOptions().timeZone;

/** 默认时间：一小时后的整点或半点 */
function defaultDue(): string {
  const d = new Date(Date.now() + 60 * 60 * 1000);
  d.setMinutes(d.getMinutes() < 30 ? 30 : 60, 0, 0);
  return toLocalInputValue(d.getTime());
}

export function RemindersView() {
  const { data } = useQuery('reminders.list', {}, ['reminders', 'tasks']);
  const [created, setCreated] = useState<ReminderDto | null>(null);

  // 成功卡片显示提醒的当前状态（之后若被改期/取消，同步显示）
  const current = created ? (data?.upcoming.find((r) => r.id === created.id) ?? data?.history.find((r) => r.id === created.id) ?? created) : null;

  return (
    <section aria-labelledby="reminders-title">
      <header className="view-header">
        <h1 id="reminders-title">提醒</h1>
        <p className="view-hint">一次性提醒。到时间会进入信箱，并在宠物旁弹出（安静模式下只进信箱）。</p>
      </header>
      <ReminderComposer onCreated={setCreated} />
      {current && <SuccessCard reminder={current} onClose={() => setCreated(null)} />}
      <h2 className="section-title">即将到来</h2>
      {data && data.upcoming.length === 0 && <p className="empty">没有待到期的提醒。</p>}
      <ul className="card-list" role="list" aria-label="即将到来的提醒">
        {data?.upcoming.map((r) => <ReminderCard key={r.id} reminder={r} />)}
      </ul>
      {data && data.history.length > 0 && (
        <details className="done-section">
          <summary>最近 30 天已到期或已取消（{data.history.length}）</summary>
          <ul className="card-list" role="list" aria-label="已到期或已取消的提醒">
            {data.history.map((r) => <ReminderCard key={r.id} reminder={r} />)}
          </ul>
        </details>
      )}
    </section>
  );
}

function ReminderComposer({ onCreated }: { onCreated: (r: ReminderDto) => void }) {
  const [content, setContent] = useState('');
  const [due, setDue] = useState(defaultDue);
  const [taskId, setTaskId] = useState('');
  const { data: tasks } = useQuery('notebook.tasks', {}, ['tasks']);
  const { busy, run } = useAction();
  const dueAt = fromLocalInputValue(due);

  const submit = async (event: FormEvent): Promise<void> => {
    event.preventDefault();
    if (!content.trim() || dueAt === null || busy) return;
    const result = await run<ReminderDto>('reminders.create', {
      content,
      dueAt,
      timeZone: TIME_ZONE,
      taskId: taskId || null,
    });
    if (result.ok) {
      onCreated(result.result);
      setContent('');
      setTaskId('');
      setDue(defaultDue());
    }
  };

  return (
    <form className="composer" onSubmit={submit} aria-label="新建提醒">
      <input
        aria-label="提醒内容"
        placeholder="提醒我做什么，例如“改简历”"
        value={content}
        maxLength={REMINDER_CONTENT_MAX}
        onChange={(event) => setContent(event.target.value)}
      />
      <div className="composer-row">
        <label className="field">
          <span>时间</span>
          <input type="datetime-local" value={due} required onChange={(event) => setDue(event.target.value)} />
        </label>
        <label className="field">
          <span>关联待办（可选）</span>
          <select value={taskId} onChange={(event) => setTaskId(event.target.value)}>
            <option value="">不关联</option>
            {tasks
              ?.filter((t) => t.status === 'open')
              .map((t) => (
                <option key={t.id} value={t.id}>
                  {t.title}
                </option>
              ))}
          </select>
        </label>
        <button type="submit" className="primary" disabled={!content.trim() || dueAt === null || busy}>
          设置提醒
        </button>
      </div>
      {dueAt !== null && <p className="meta">将在 {formatFullDateTime(dueAt)} 提醒（只提醒一次）</p>}
    </form>
  );
}

/** 结果卡片：完整本地日期、星期、时刻，并可立即修改（R08.AC-2）；运行条件提示（R01.AC-5～6） */
function SuccessCard({ reminder, onClose }: { reminder: ReminderDto; onClose: () => void }) {
  const [startup, setStartup] = useState<StartupState | null>(null);
  useEffect(() => {
    void window.nest.system({ action: 'getStartup' }).then(setStartup);
  }, []);

  const statusText =
    reminder.status === 'scheduled' ? '已设置提醒' : reminder.status === 'cancelled' ? '这条提醒已取消' : '这条提醒已到期';

  return (
    <div className="card result-card" role="status">
      <div className="result-head">
        <strong>✅ {statusText}</strong>
        <button type="button" className="icon-button" aria-label="关闭结果卡片" onClick={onClose}>
          ×
        </button>
      </div>
      <p className="result-main">{reminder.content}</p>
      <p className="result-time">{formatFullDateTime(reminder.dueAt)} · 仅一次</p>
      {reminder.task && <p className="meta">关联待办：{reminder.task.title}</p>}
      {startup && !startup.openAtLogin && <p className="meta">应用运行时会准时提醒；退出后不会弹出，下次启动可在信箱查看。</p>}
      {startup && startup.supported && !startup.openAtLogin && !startup.promptDismissed && (
        <div className="startup-prompt">
          <span>提醒需要应用在后台运行。要开机自动启动吗？</span>
          <div className="card-actions">
            <button type="button" className="primary" onClick={() => void window.nest.system({ action: 'setOpenAtLogin', value: true }).then(setStartup)}>
              开启开机启动
            </button>
            <button type="button" onClick={() => void window.nest.system({ action: 'dismissStartupPrompt' }).then(setStartup)}>
              不再提示
            </button>
          </div>
        </div>
      )}
      {reminder.status === 'scheduled' && <ReminderActions reminder={reminder} />}
    </div>
  );
}

function ReminderCard({ reminder }: { reminder: ReminderDto }) {
  const status =
    reminder.status === 'cancelled'
      ? reminder.cancelReason === 'target_deleted'
        ? '已取消（关联待办已删除）'
        : '已取消'
      : reminder.status === 'materialized'
        ? '已到期'
        : null;
  return (
    <li className={`card${reminder.status === 'scheduled' ? '' : ' is-past'}`} aria-label={`提醒：${reminder.content}`}>
      <div className="reminder-row">
        <div>
          <h3 className="card-title">{reminder.content}</h3>
          <p className="meta">
            <span>{formatTime(reminder.dueAt)}</span>
            {reminder.task && <span>关联待办：{reminder.task.title}</span>}
            {status && <span>{status}</span>}
          </p>
        </div>
      </div>
      {/* 已取消/已到期的历史卡片只显示状态，没有操作按钮（R15.AC-4） */}
      {reminder.status === 'scheduled' && <ReminderActions reminder={reminder} />}
    </li>
  );
}

function ReminderActions({ reminder }: { reminder: ReminderDto }) {
  const [editing, setEditing] = useState(false);
  const [due, setDue] = useState(toLocalInputValue(reminder.dueAt));
  const { busy, run } = useAction();

  const save = async (event: FormEvent): Promise<void> => {
    event.preventDefault();
    const dueAt = fromLocalInputValue(due);
    if (dueAt === null) return;
    const result = await run('reminders.reschedule', { id: reminder.id, revision: reminder.revision, dueAt });
    if (result.ok) setEditing(false);
  };

  if (editing) {
    return (
      <form className="edit-form inline-form" onSubmit={save} aria-label={`改期：${reminder.content}`}>
        <input type="datetime-local" aria-label="新的时间" value={due} autoFocus onChange={(event) => setDue(event.target.value)} />
        <div className="card-actions">
          <button type="submit" className="primary" disabled={busy}>
            保存
          </button>
          <button type="button" onClick={() => setEditing(false)}>
            取消
          </button>
        </div>
      </form>
    );
  }
  return (
    <div className="card-actions spaced">
      <button
        type="button"
        onClick={() => {
          setDue(toLocalInputValue(reminder.dueAt));
          setEditing(true);
        }}
        aria-label={`改期：${reminder.content}`}
      >
        改时间
      </button>
      <button
        type="button"
        className="danger"
        disabled={busy}
        onClick={() => {
          if (window.confirm(`取消提醒“${reminder.content}”？`)) void run('reminders.cancel', { id: reminder.id, revision: reminder.revision });
        }}
        aria-label={`取消提醒：${reminder.content}`}
      >
        取消提醒
      </button>
    </div>
  );
}
