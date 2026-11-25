import { useEffect, useRef, useState, type FormEvent } from 'react';
import { NOTE_BODY_MAX, NOTE_TITLE_MAX, type NoteDto } from '../../shared/contracts/notebook';
import { formatTime, useQuery } from './api';
import { useAction, useDeleteWithUndo } from './useAction';

export function NotesView({ focusId, onFocused }: { focusId: string | null; onFocused: () => void }) {
  const { data: notes, error } = useQuery('notebook.notes', {}, ['notes']);

  return (
    <section aria-labelledby="notes-title">
      <header className="view-header">
        <h1 id="notes-title">笔记</h1>
        <p className="view-hint">随手记下想法；删除后可在回收站保留 7 天。</p>
      </header>
      <NoteComposer />
      {error && <p className="load-error">{error}</p>}
      {notes && notes.length === 0 && <p className="empty">还没有笔记。</p>}
      <ul className="card-list" role="list" aria-label="笔记列表">
        {notes?.map((note) => (
          <NoteCard key={note.id} note={note} focused={focusId === note.id} onFocused={onFocused} />
        ))}
      </ul>
    </section>
  );
}

function NoteComposer() {
  const [title, setTitle] = useState('');
  const [body, setBody] = useState('');
  const { busy, run } = useAction();
  const empty = !title.trim() && !body.trim();

  const submit = async (event: FormEvent): Promise<void> => {
    event.preventDefault();
    if (empty || busy) return;
    const result = await run('notes.create', { title, body });
    if (result.ok) {
      setTitle('');
      setBody('');
    }
  };

  return (
    <form className="composer" onSubmit={submit} aria-label="新建笔记">
      <input
        aria-label="标题（可选）"
        placeholder="标题（可选）"
        value={title}
        maxLength={NOTE_TITLE_MAX}
        onChange={(event) => setTitle(event.target.value)}
      />
      <textarea
        aria-label="笔记内容"
        placeholder="写点什么…（Ctrl+Enter 保存）"
        value={body}
        maxLength={NOTE_BODY_MAX}
        rows={3}
        onChange={(event) => setBody(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === 'Enter' && event.ctrlKey) void submit(event);
        }}
      />
      <div className="composer-actions">
        <button type="submit" className="primary" disabled={empty || busy}>
          保存笔记
        </button>
      </div>
    </form>
  );
}

function NoteCard({ note, focused, onFocused }: { note: NoteDto; focused: boolean; onFocused: () => void }) {
  const [editing, setEditing] = useState(false);
  const [title, setTitle] = useState(note.title);
  const [body, setBody] = useState(note.body);
  const { busy, run } = useAction();
  const remove = useDeleteWithUndo();
  const ref = useRef<HTMLLIElement>(null);

  useEffect(() => {
    if (!focused) return;
    ref.current?.scrollIntoView({ block: 'center' });
    ref.current?.focus();
    onFocused();
  }, [focused, onFocused]);

  const startEdit = (): void => {
    setTitle(note.title);
    setBody(note.body);
    setEditing(true);
  };

  const save = async (event: FormEvent): Promise<void> => {
    event.preventDefault();
    const result = await run('notes.update', { id: note.id, revision: note.revision, title, body });
    if (result.ok) setEditing(false);
  };

  const label = note.title || note.body.slice(0, 20);

  return (
    <li className="card" ref={ref} tabIndex={-1} aria-label={`笔记：${label}`}>
      {editing ? (
        <form onSubmit={save} className="edit-form">
          <input
            aria-label="标题"
            value={title}
            maxLength={NOTE_TITLE_MAX}
            onChange={(event) => setTitle(event.target.value)}
          />
          <textarea
            aria-label="内容"
            value={body}
            rows={4}
            maxLength={NOTE_BODY_MAX}
            autoFocus
            onChange={(event) => setBody(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Escape') setEditing(false);
              if (event.key === 'Enter' && event.ctrlKey) void save(event);
            }}
          />
          <div className="card-actions">
            <button type="submit" className="primary" disabled={busy || (!title.trim() && !body.trim())}>
              保存
            </button>
            <button type="button" onClick={() => setEditing(false)}>
              取消
            </button>
          </div>
        </form>
      ) : (
        <>
          {note.title && <h2 className="card-title">{note.title}</h2>}
          {note.body && <p className="note-body">{note.body}</p>}
          <div className="card-footer">
            <span className="meta">更新于 {formatTime(note.updatedAt)}</span>
            <div className="card-actions">
              <button type="button" onClick={startEdit} aria-label={`编辑笔记：${label}`}>
                编辑
              </button>
              <button
                type="button"
                className="danger"
                onClick={() => void remove('notes', note.id, label)}
                aria-label={`删除笔记：${label}`}
              >
                删除
              </button>
            </div>
          </div>
        </>
      )}
    </li>
  );
}
