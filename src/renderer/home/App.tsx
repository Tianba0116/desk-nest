import { useCallback, useEffect, useState } from 'react';
import type { NestView } from '../../shared/contracts/nest-ipc';
import { useQuery } from './api';
import { InboxView } from './InboxView';
import { NotesView } from './NotesView';
import { RecycleView } from './RecycleView';
import { RemindersView } from './RemindersView';
import { SearchResults } from './SearchResults';
import { SettingsView } from './SettingsView';
import { TasksView } from './TasksView';
import { TopicsView } from './TopicsView';
import { ToastProvider } from './toast';

const SECTIONS: Array<{ label: string; views: Array<{ id: NestView; label: string; icon: string }> }> = [
  {
    label: '信箱与提醒',
    views: [
      { id: 'inbox', label: '信箱', icon: '📬' },
      { id: 'reminders', label: '提醒', icon: '⏰' },
    ],
  },
  {
    label: '小本子',
    views: [
      { id: 'topics', label: '事项', icon: '🧭' },
      { id: 'notes', label: '笔记', icon: '📝' },
      { id: 'tasks', label: '待办', icon: '✅' },
      { id: 'recycle', label: '回收站', icon: '🗑️' },
    ],
  },
  {
    label: '相处设置',
    views: [{ id: 'settings', label: '设置', icon: '⚙️' }],
  },
];

export function App() {
  const [view, setView] = useState<NestView>('notes');
  const [query, setQuery] = useState('');
  const [focusId, setFocusId] = useState<string | null>(null);
  const { data: unread } = useQuery('inbox.unreadCount', {}, ['inbox', 'reminders']);

  useEffect(
    () =>
      window.nest.onNavigate((next) => {
        setView(next);
        setQuery('');
      }),
    [],
  );

  const openItem = useCallback((type: 'note' | 'task' | 'topic', id: string) => {
    setQuery('');
    setView(type === 'note' ? 'notes' : type === 'task' ? 'tasks' : 'topics');
    setFocusId(id);
  }, []);

  const searching = query.trim().length > 0;

  return (
    <ToastProvider>
      <div className="nest">
        <nav className="nest-nav" aria-label="小窝">
          <div className="nest-brand" aria-hidden="true">
            🪺 小窝
          </div>
          {SECTIONS.map((section) => (
            <div key={section.label}>
              <p className="nest-section-label">{section.label}</p>
              <ul role="list">
                {section.views.map((item) => (
                  <li key={item.id}>
                    <button
                      type="button"
                      className="nav-item"
                      aria-current={!searching && view === item.id ? 'page' : undefined}
                      onClick={() => {
                        setQuery('');
                        setView(item.id);
                      }}
                    >
                      <span aria-hidden="true">{item.icon}</span> {item.label}
                      {item.id === 'inbox' && !!unread && (
                        <span className="nav-count" aria-label={`${unread} 条未读`}>
                          {unread}
                        </span>
                      )}
                    </button>
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </nav>
        <main className="nest-main">
          <div className="search-bar" role="search">
            <input
              type="search"
              aria-label="搜索笔记、待办和事项"
              placeholder="搜索笔记、待办和事项，例如“简历”"
              value={query}
              maxLength={200}
              onChange={(event) => setQuery(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Escape') setQuery('');
              }}
            />
          </div>
          <div className="nest-content">
            {searching ? (
              <SearchResults query={query} onOpen={openItem} />
            ) : view === 'inbox' ? (
              <InboxView />
            ) : view === 'reminders' ? (
              <RemindersView />
            ) : view === 'settings' ? (
              <SettingsView />
            ) : view === 'notes' ? (
              <NotesView focusId={focusId} onFocused={() => setFocusId(null)} />
            ) : view === 'tasks' ? (
              <TasksView focusId={focusId} onFocused={() => setFocusId(null)} />
            ) : view === 'topics' ? (
              <TopicsView />
            ) : (
              <RecycleView />
            )}
          </div>
        </main>
      </div>
    </ToastProvider>
  );
}
