// 沙漏（R09）：开始、暂停、继续、提前结束、取消；结束后由你选择完成待办、记录进展或再来一轮。

import { useEffect, useState, type FormEvent } from 'react';
import { FOCUS_MAX_MINUTES, FOCUS_PRESETS_MINUTES, type FocusDto } from '../../shared/contracts/focus';
import { TASK_PROGRESS_MAX } from '../../shared/contracts/notebook';
import { formatTime, useQuery } from './api';
import { useAction } from './useAction';

function minutesText(ms: number): string {
  const total = Math.max(0, Math.round(ms / 1000));
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}

function duration(ms: number): string {
  const minutes = Math.round(ms / 60_000);
  return minutes >= 1 ? `${minutes} 分钟` : `${Math.round(ms / 1000)} 秒`;
}

export function FocusView() {
  const { data, error } = useQuery('focus.state', {}, ['focus', 'tasks']);
  return (
    <section aria-labelledby="focus-title">
      <header className="view-header">
        <h1 id="focus-title">沙漏</h1>
        <p className="view-hint">按真实经过的时间计时：睡眠、锁屏、应用退出期间也在走；暂停时不计时。专注期间提醒只进信箱，不弹气泡。</p>
      </header>
      {error && <p className="load-error">{error}</p>}
      {data && (data.active ? <ActiveFocus session={data.active} /> : <StartFocus />)}
      {data && data.recent.length > 0 && (
        <>
          <h2 className="section-title">最近的专注</h2>
          <ul className="card-list" role="list" aria-label="最近的专注">
            {data.recent.map((s, i) => (
              <FocusResult key={s.id} session={s} latest={i === 0} />
            ))}
          </ul>
        </>
      )}
    </section>
  );
}

function StartFocus() {
  const { data: tasks } = useQuery('notebook.tasks', {}, ['tasks']);
  const [minutes, setMinutes] = useState(25);
  const [taskId, setTaskId] = useState('');
  const { busy, run } = useAction();
  const open = tasks?.filter((t) => t.status === 'open') ?? [];
  const start = async (event: FormEvent): Promise<void> => {
    event.preventDefault();
    await run('focus.start', { plannedMinutes: minutes, taskId: taskId || null });
  };
  return (
    <form className="composer focus-start" onSubmit={start} aria-label="开始专注">
      <div className="preset-row" role="group" aria-label="专注时长">
        {FOCUS_PRESETS_MINUTES.map((m) => (
          <button key={m} type="button" className={minutes === m ? 'primary' : ''} aria-pressed={minutes === m} onClick={() => setMinutes(m)}>
            {m} 分钟
          </button>
        ))}
        <label className="inline-field">
          <span>自定义</span>
          <input
            type="number"
            min={1}
            max={FOCUS_MAX_MINUTES}
            value={minutes}
            aria-label="自定义分钟数"
            onChange={(event) => setMinutes(Math.max(1, Math.min(FOCUS_MAX_MINUTES, Number(event.target.value) || 1)))}
          />
          <span>分钟</span>
        </label>
      </div>
      <label className="field">
        <span>关联待办（可选；专注结束不会自动完成它）</span>
        <select value={taskId} onChange={(event) => setTaskId(event.target.value)}>
          <option value="">不关联</option>
          {open.map((t) => (
            <option key={t.id} value={t.id}>
              {t.title}
            </option>
          ))}
        </select>
      </label>
      <div className="card-actions">
        <button type="submit" className="primary" disabled={busy}>
          开始专注 {minutes} 分钟
        </button>
      </div>
    </form>
  );
}

function ActiveFocus({ session }: { session: FocusDto }) {
  const [now, setNow] = useState(Date.now());
  const [remaining, setRemaining] = useState(Math.round((session.remainingMs ?? 0) / 60_000) || 1);
  const { busy, run } = useAction();
  useEffect(() => {
    if (session.status !== 'running') return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [session.status]);
  useEffect(() => setRemaining(Math.max(1, Math.round((session.remainingMs ?? 0) / 60_000))), [session.remainingMs]);
  const left = session.status === 'running' ? (session.dueAt ?? now) - now : (session.remainingMs ?? 0);
  const clockJump = session.status === 'paused' && session.pauseReason === 'clock_jump';

  return (
    <div className="card focus-active" role="timer" aria-label={`专注剩余 ${minutesText(left)}`}>
      <p className="focus-clock" aria-hidden="true">
        {minutesText(left)}
      </p>
      <p className="meta">
        <span>{session.status === 'running' ? '专注中' : '已暂停'}</span>
        <span>计划 {duration(session.plannedMs)}</span>
        {session.task && <span>待办：{session.task.title}</span>}
        {session.awayMs > 0 && <span>期间锁屏或睡眠 {duration(session.awayMs)}</span>}
      </p>
      {clockJump && (
        <div className="warn" role="alert">
          <p>系统时间变化较大，专注已暂停。请确认剩余时间后继续：</p>
          <label className="inline-field">
            <span>剩余</span>
            <input type="number" min={1} max={FOCUS_MAX_MINUTES} value={remaining} onChange={(event) => setRemaining(Math.max(1, Number(event.target.value) || 1))} />
            <span>分钟</span>
          </label>
        </div>
      )}
      <div className="card-actions">
        {session.status === 'running' ? (
          <button type="button" disabled={busy} onClick={() => void run('focus.pause', { id: session.id })}>
            暂停
          </button>
        ) : (
          <button
            type="button"
            className="primary"
            disabled={busy}
            onClick={() => void run('focus.resume', clockJump ? { id: session.id, remainingMinutes: remaining } : { id: session.id })}
          >
            继续
          </button>
        )}
        <button type="button" disabled={busy} onClick={() => void run('focus.finish', { id: session.id })}>
          提前结束
        </button>
        <button
          type="button"
          className="danger"
          disabled={busy}
          onClick={() => window.confirm('取消这次专注？取消的不计入专注记录。') && void run('focus.cancel', { id: session.id })}
        >
          取消
        </button>
      </div>
    </div>
  );
}

/** 单次结果（D-07）：计入时长以计划时长为上限；锁屏和睡眠时长单独显示 */
export function FocusResult({ session, latest }: { session: FocusDto; latest: boolean }) {
  const [progress, setProgress] = useState('');
  const [mode, setMode] = useState<'view' | 'progress'>('view');
  const { busy, run } = useAction();
  const status =
    session.status === 'finished' ? '提前结束' : session.status === 'expired' ? '已到期' : '已完成';
  const task = session.task && !session.task.deleted ? session.task : null;

  const save = async (event: FormEvent): Promise<void> => {
    event.preventDefault();
    if (!task) return;
    const result = await run('tasks.recordProgress', { id: task.id, note: progress });
    if (result.ok) setMode('view');
  };

  return (
    <li className="card" aria-label={`专注 ${duration(session.plannedMs)}：${status}`}>
      <p className="card-title">
        专注 {duration(session.plannedMs)} · {status}
      </p>
      <p className="meta">
        <span>{formatTime(session.endedAt ?? session.startedAt)}</span>
        {session.countedMs !== null && <span>计入 {duration(session.countedMs)}</span>}
        {session.awayMs > 0 && <span>期间锁屏或睡眠 {duration(session.awayMs)}（不计入）</span>}
        {task && <span>待办：{task.title}{task.status === 'done' ? '（已完成）' : ''}</span>}
      </p>
      {session.settledLate && <p className="meta">到期时电脑处于睡眠、锁屏或应用未运行，回来后才结算。</p>}
      {mode === 'progress' && task && (
        <form className="edit-form" onSubmit={save}>
          <textarea
            aria-label={`记录进展：${task.title}`}
            value={progress}
            rows={2}
            maxLength={TASK_PROGRESS_MAX}
            autoFocus
            onChange={(event) => setProgress(event.target.value)}
          />
          <div className="card-actions">
            <button type="submit" className="primary" disabled={busy || !progress.trim()}>
              保存进展
            </button>
            <button type="button" onClick={() => setMode('view')}>
              取消
            </button>
          </div>
        </form>
      )}
      {latest && mode === 'view' && (
        <div className="card-actions">
          {task && task.status === 'open' && (
            <>
              <button type="button" disabled={busy} onClick={() => void run('tasks.setStatus', { id: task.id, status: 'done' })}>
                完成待办
              </button>
              <button type="button" onClick={() => setMode('progress')}>
                记录进展
              </button>
            </>
          )}
          <button
            type="button"
            disabled={busy}
            onClick={() => void run('focus.start', { plannedMinutes: Math.round(session.plannedMs / 60_000), taskId: task?.id ?? null })}
          >
            再来一轮
          </button>
        </div>
      )}
    </li>
  );
}
