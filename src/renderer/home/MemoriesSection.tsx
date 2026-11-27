// 已保存的记忆（R11.AC-2、AC-7）：查看、编辑、忘记、恢复、删除，显示有效期和来源。

import { useState, type FormEvent } from 'react';
import { MEMORY_CONTENT_MAX, type MemoryDto } from '../../shared/contracts/memory';
import { formatTime, fromLocalInputValue, toLocalInputValue, useQuery } from './api';
import { SourceLine } from './TopicsView';
import { useAction } from './useAction';

export function MemoriesSection() {
  const { data } = useQuery('memories.list', {}, ['memories']);
  const [content, setContent] = useState('');
  const [until, setUntil] = useState('');
  const { busy, run } = useAction();

  const submit = async (event: FormEvent): Promise<void> => {
    event.preventDefault();
    if (!content.trim()) return;
    const result = await run('memories.create', { content, expiresAt: fromLocalInputValue(until) });
    if (result.ok) {
      setContent('');
      setUntil('');
    }
  };

  return (
    <div className="composer settings-form" aria-label="已保存的记忆">
      <h2 className="section-title">已保存的记忆</h2>
      <p className="view-hint">
        你明确让宠物记住的信息。聊天时只会用到与话题相关的几条；过期、忘记的不会再用。
        “忘记”可以恢复，“删除”会彻底删除本机记录；已经发送给模型服务的聊天内容不受本机删除控制。
      </p>
      <form className="composer-row" onSubmit={submit} aria-label="添加记忆">
        <input
          aria-label="要记住的信息"
          placeholder="例如“对花生过敏”"
          value={content}
          maxLength={MEMORY_CONTENT_MAX}
          onChange={(event) => setContent(event.target.value)}
        />
        <input
          type="datetime-local"
          aria-label="有效期至（可选）"
          title="有效期至（可选）"
          value={until}
          onChange={(event) => setUntil(event.target.value)}
        />
        <button type="submit" className="primary" disabled={busy || !content.trim()}>
          记住
        </button>
      </form>
      {data && data.active.length === 0 && <p className="meta">还没有保存的记忆。</p>}
      <ul className="card-list" role="list" aria-label="记忆">
        {data?.active.map((m) => <MemoryCard key={m.id} memory={m} />)}
      </ul>
      {data && data.forgotten.length > 0 && (
        <details className="done-section">
          <summary>已忘记（{data.forgotten.length}）</summary>
          <ul className="card-list" role="list" aria-label="已忘记的记忆">
            {data.forgotten.map((m) => (
              <MemoryCard key={m.id} memory={m} />
            ))}
          </ul>
        </details>
      )}
    </div>
  );
}

function MemoryCard({ memory }: { memory: MemoryDto }) {
  const [editing, setEditing] = useState(false);
  const [content, setContent] = useState(memory.content);
  const [until, setUntil] = useState(toLocalInputValue(memory.expiresAt));
  const { busy, run } = useAction();
  const forgotten = memory.forgottenAt !== null;

  const save = async (event: FormEvent): Promise<void> => {
    event.preventDefault();
    const result = await run('memories.update', {
      id: memory.id,
      revision: memory.revision,
      content,
      expiresAt: fromLocalInputValue(until),
    });
    if (result.ok) setEditing(false);
  };
  const remove = (): void => {
    if (window.confirm(`彻底删除“${memory.content}”？本机记录会被删除，不能恢复。`)) void run('memories.delete', { id: memory.id });
  };

  if (editing) {
    return (
      <li className="card">
        <form className="edit-form" onSubmit={save}>
          <input aria-label="内容" value={content} maxLength={MEMORY_CONTENT_MAX} autoFocus onChange={(event) => setContent(event.target.value)} />
          <input type="datetime-local" aria-label="有效期至（可选）" value={until} onChange={(event) => setUntil(event.target.value)} />
          <p className="view-hint">修改内容算一次更正：之前聊天里的旧说法不会再被宠物使用。</p>
          <div className="card-actions">
            <button type="submit" className="primary" disabled={busy || !content.trim()}>
              保存
            </button>
            <button type="button" onClick={() => setEditing(false)}>
              取消
            </button>
          </div>
        </form>
      </li>
    );
  }

  return (
    <li className={`card${forgotten || memory.expired ? ' is-done' : ''}`} aria-label={`记忆：${memory.content}`}>
      <p className="card-title">{memory.content}</p>
      <p className="meta">
        {memory.expiresAt !== null && <span>{memory.expired ? '已过期' : `有效到 ${formatTime(memory.expiresAt)}`}</span>}
        {forgotten && <span>忘记于 {formatTime(memory.forgottenAt as number)}</span>}
        <SourceLine source={memory.source} />
      </p>
      <div className="card-actions">
        {forgotten ? (
          <button type="button" disabled={busy} onClick={() => void run('memories.restore', { id: memory.id })}>
            恢复
          </button>
        ) : (
          <>
            <button
              type="button"
              onClick={() => {
                setContent(memory.content);
                setUntil(toLocalInputValue(memory.expiresAt));
                setEditing(true);
              }}
            >
              编辑
            </button>
            <button type="button" disabled={busy} onClick={() => void run('memories.forget', { id: memory.id })}>
              忘记
            </button>
          </>
        )}
        <button type="button" className="danger" disabled={busy} onClick={remove}>
          删除本机记录
        </button>
      </div>
    </li>
  );
}
