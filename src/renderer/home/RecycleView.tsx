import { RECYCLE_RETENTION_DAYS, RECYCLE_RETENTION_MS, type RecycledItem } from '../../shared/contracts/notebook';
import { formatTime, useQuery } from './api';
import { useAction } from './useAction';

export function RecycleView() {
  const { data: items, error } = useQuery('notebook.recycleBin', {}, ['notes', 'tasks']);

  return (
    <section aria-labelledby="recycle-title">
      <header className="view-header">
        <h1 id="recycle-title">回收站</h1>
        <p className="view-hint">删除的笔记和待办保留 {RECYCLE_RETENTION_DAYS} 天，之后自动清除。</p>
      </header>
      {error && <p className="load-error">{error}</p>}
      {items && items.length === 0 && <p className="empty">回收站是空的。</p>}
      <ul className="card-list" role="list" aria-label="回收站">
        {items?.map((entry) => <RecycledCard key={`${entry.type}:${entry.item.id}`} entry={entry} />)}
      </ul>
    </section>
  );
}

function RecycledCard({ entry }: { entry: RecycledItem }) {
  const { busy, run } = useAction();
  const kind = entry.type === 'note' ? 'notes' : 'tasks';
  const label = entry.type === 'note' ? entry.item.title || entry.item.body.slice(0, 40) : entry.item.title;
  const deletedAt = entry.item.deletedAt ?? 0;
  const daysLeft = Math.max(0, Math.ceil((deletedAt + RECYCLE_RETENTION_MS - Date.now()) / 86_400_000));

  const purge = (): void => {
    if (window.confirm(`彻底删除“${label}”？此操作不能撤销。`)) void run(`${kind}.purge`, { id: entry.item.id });
  };

  return (
    <li className="card recycled">
      <div>
        <span className="badge">{entry.type === 'note' ? '笔记' : '待办'}</span>
        <span className="card-title-inline">{label}</span>
      </div>
      <div className="card-footer">
        <span className="meta">
          删除于 {formatTime(deletedAt)} · 还剩 {daysLeft} 天
        </span>
        <div className="card-actions">
          <button type="button" disabled={busy} onClick={() => void run(`${kind}.restore`, { id: entry.item.id })}>
            恢复
          </button>
          <button type="button" className="danger" disabled={busy} onClick={purge}>
            彻底删除
          </button>
        </div>
      </div>
    </li>
  );
}
