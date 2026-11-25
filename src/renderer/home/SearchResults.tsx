import { useDeferredValue } from 'react';
import { formatTime, useQuery } from './api';

export function SearchResults({ query, onOpen }: { query: string; onOpen: (type: 'note' | 'task', id: string) => void }) {
  const deferred = useDeferredValue(query.trim());
  const { data: hits, error } = useQuery('notebook.search', { query: deferred }, ['notes', 'tasks']);

  return (
    <section aria-labelledby="search-title">
      <header className="view-header">
        <h1 id="search-title">搜索“{deferred}”</h1>
        <p className="view-hint">按 Esc 清除搜索。</p>
      </header>
      {error && <p className="load-error">{error}</p>}
      {hits && hits.length === 0 && <p className="empty">没有找到相关的笔记或待办。</p>}
      <ul className="card-list" role="list" aria-label="搜索结果">
        {hits?.map((hit) => {
          const title =
            hit.type === 'note' ? hit.item.title || hit.item.body.split('\n')[0] || '' : hit.item.title;
          const snippet = hit.type === 'note' ? hit.item.body : hit.item.progressNote;
          return (
            <li key={`${hit.type}:${hit.item.id}`}>
              <button type="button" className="card search-hit" onClick={() => onOpen(hit.type, hit.item.id)}>
                <span className="badge">
                  {hit.type === 'note' ? '笔记' : hit.item.status === 'done' ? '待办 · 已完成' : '待办'}
                </span>
                <span className="card-title-inline">{title}</span>
                {snippet && snippet !== title && <span className="snippet">{snippet}</span>}
                <span className="meta">更新于 {formatTime(hit.item.updatedAt)}</span>
              </button>
            </li>
          );
        })}
      </ul>
    </section>
  );
}
