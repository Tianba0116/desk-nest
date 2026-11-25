import { useEffect, useRef, useState, type FormEvent } from 'react';
import { TASK_PROGRESS_MAX, TASK_TITLE_MAX, type TaskDto } from '../../shared/contracts/notebook';
import { formatTime, fromLocalInputValue, toLocalInputValue, useQuery } from './api';
import { useAction, useDeleteWithUndo } from './useAction';

export function TasksView({ focusId, onFocused }: { focusId: string | null; onFocused: () => void }) {
  const { data: tasks, error } = useQuery('notebook.tasks', {}, ['tasks']);
  const open = tasks?.filter((task) => task.status === 'open') ?? [];
  const done = tasks?.filter((task) => task.status === 'done') ?? [];

  return (
    <section aria-labelledby="tasks-title">
      <header className="view-header">
        <h1 id="tasks-title">待办</h1>
        <p className="view-hint">只有你勾选时才会标记完成。截止时间只用于显示，不会自动提醒。</p>
      </header>
      <TaskComposer />
      {error && <p className="load-error">{error}</p>}
      {tasks && tasks.length === 0 && <p className="empty">没有待办，轻松一下。</p>}
      <ul className="card-list" role="list" aria-label="未完成的待办">
        {open.map((task) => (
          <TaskCard key={task.id} task={task} focused={focusId === task.id} onFocused={onFocused} />
        ))}
      </ul>
      {done.length > 0 && (
        <details className="done-section" open={done.some((task) => task.id === focusId) || undefined}>
          <summary>已完成（{done.length}）</summary>
          <ul className="card-list" role="list" aria-label="已完成的待办">
            {done.map((task) => (
              <TaskCard key={task.id} task={task} focused={focusId === task.id} onFocused={onFocused} />
            ))}
          </ul>
        </details>
      )}
    </section>
  );
}

function TaskComposer() {
  const [title, setTitle] = useState('');
  const [due, setDue] = useState('');
  const { busy, run } = useAction();

  const submit = async (event: FormEvent): Promise<void> => {
    event.preventDefault();
    if (!title.trim() || busy) return;
    const result = await run('tasks.create', { title, dueAt: fromLocalInputValue(due) });
    if (result.ok) {
      setTitle('');
      setDue('');
    }
  };

  return (
    <form className="composer composer-row" onSubmit={submit} aria-label="添加待办">
      <input
        aria-label="待办内容"
        placeholder="添加一件要做的事，回车保存"
        value={title}
        maxLength={TASK_TITLE_MAX}
        onChange={(event) => setTitle(event.target.value)}
      />
      <input
        type="datetime-local"
        aria-label="截止时间（可选）"
        title="截止时间（可选）"
        value={due}
        onChange={(event) => setDue(event.target.value)}
      />
      <button type="submit" className="primary" disabled={!title.trim() || busy}>
        添加
      </button>
    </form>
  );
}

type Mode = 'view' | 'edit' | 'progress';

function TaskCard({ task, focused, onFocused }: { task: TaskDto; focused: boolean; onFocused: () => void }) {
  const [mode, setMode] = useState<Mode>('view');
  const [title, setTitle] = useState(task.title);
  const [due, setDue] = useState(toLocalInputValue(task.dueAt));
  const [progress, setProgress] = useState(task.progressNote);
  const { busy, run } = useAction();
  const remove = useDeleteWithUndo();
  const ref = useRef<HTMLLIElement>(null);
  const done = task.status === 'done';

  useEffect(() => {
    if (!focused) return;
    ref.current?.scrollIntoView({ block: 'center' });
    ref.current?.focus();
    onFocused();
  }, [focused, onFocused]);

  const begin = (next: Mode): void => {
    setTitle(task.title);
    setDue(toLocalInputValue(task.dueAt));
    setProgress(task.progressNote);
    setMode(next);
  };

  const saveEdit = async (event: FormEvent): Promise<void> => {
    event.preventDefault();
    const result = await run('tasks.update', {
      id: task.id,
      revision: task.revision,
      title,
      dueAt: fromLocalInputValue(due),
    });
    if (result.ok) setMode('view');
  };

  const saveProgress = async (event: FormEvent): Promise<void> => {
    event.preventDefault();
    const result = await run('tasks.recordProgress', { id: task.id, revision: task.revision, note: progress });
    if (result.ok) setMode('view');
  };

  return (
    <li className={`card task-card${done ? ' is-done' : ''}`} ref={ref} tabIndex={-1} aria-label={`待办：${task.title}`}>
      {mode === 'edit' ? (
        <form onSubmit={saveEdit} className="edit-form">
          <input
            aria-label="待办内容"
            value={title}
            maxLength={TASK_TITLE_MAX}
            autoFocus
            onChange={(event) => setTitle(event.target.value)}
            onKeyDown={(event) => event.key === 'Escape' && setMode('view')}
          />
          <input
            type="datetime-local"
            aria-label="截止时间（可选）"
            value={due}
            onChange={(event) => setDue(event.target.value)}
          />
          <div className="card-actions">
            <button type="submit" className="primary" disabled={busy || !title.trim()}>
              保存
            </button>
            <button type="button" onClick={() => setMode('view')}>
              取消
            </button>
          </div>
        </form>
      ) : (
        <>
          <div className="task-main">
            <input
              type="checkbox"
              className="task-check"
              checked={done}
              disabled={busy}
              aria-label={done ? `标记为未完成：${task.title}` : `标记为完成：${task.title}`}
              onChange={() => void run('tasks.setStatus', { id: task.id, revision: task.revision, status: done ? 'open' : 'done' })}
            />
            <div className="task-text">
              <h2 className="card-title">{task.title}</h2>
              <p className="meta">
                {task.dueAt !== null && <span>截止 {formatTime(task.dueAt)}</span>}
                {done && task.completedAt !== null && <span>完成于 {formatTime(task.completedAt)}</span>}
              </p>
              {task.progressNote && mode !== 'progress' && (
                <p className="progress-note">
                  <span className="progress-label">进展</span>
                  {task.progressNote}
                  {task.progressUpdatedAt !== null && <span className="meta"> · {formatTime(task.progressUpdatedAt)}</span>}
                </p>
              )}
            </div>
          </div>
          {mode === 'progress' ? (
            <form onSubmit={saveProgress} className="edit-form">
              <textarea
                aria-label="最新进展"
                placeholder="最新进展，例如“简历改到第二版”"
                value={progress}
                rows={2}
                maxLength={TASK_PROGRESS_MAX}
                autoFocus
                onChange={(event) => setProgress(event.target.value)}
                onKeyDown={(event) => event.key === 'Escape' && setMode('view')}
              />
              <div className="card-actions">
                <button type="submit" className="primary" disabled={busy}>
                  保存进展
                </button>
                <button type="button" onClick={() => setMode('view')}>
                  取消
                </button>
              </div>
            </form>
          ) : (
            <div className="card-actions">
              <button type="button" onClick={() => begin('progress')} aria-label={`记录进展：${task.title}`}>
                记录进展
              </button>
              <button type="button" onClick={() => begin('edit')} aria-label={`编辑待办：${task.title}`}>
                编辑
              </button>
              <button
                type="button"
                className="danger"
                onClick={() => void remove('tasks', task.id, task.title)}
                aria-label={`删除待办：${task.title}`}
              >
                删除
              </button>
            </div>
          )}
        </>
      )}
    </li>
  );
}
