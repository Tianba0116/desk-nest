// 事项（R11.AC-2、R12.AC-3）：不依赖模型，创建、编辑、记录进展、完成、归档、忘记、删除，并为事项约定跟进。

import { useState, type FormEvent } from 'react';
import {
  TOPIC_PROGRESS_MAX,
  TOPIC_STATUS_LABELS,
  TOPIC_TITLE_MAX,
  type SourceDto,
  type TopicDetailDto,
  type TopicDto,
} from '../../shared/contracts/memory';
import { formatTime, useQuery } from './api';
import { FollowUpForm } from './FollowUpForm';
import { useAction } from './useAction';

export function SourceLine({ source }: { source: SourceDto }) {
  return (
    <span className="source">
      来源：{source.type === 'conversation' ? `${formatTime(source.at)} 的对话` : `${formatTime(source.at)} 在小窝里添加`}
      {source.messageText && <>（“{source.messageText}”）</>}
    </span>
  );
}

export function TopicsView() {
  const { data, error } = useQuery('topics.list', {}, ['topics', 'tasks', 'reminders']);

  return (
    <section aria-labelledby="topics-title">
      <header className="view-header">
        <h1 id="topics-title">事项</h1>
        <p className="view-hint">
          正在进行的事和最新进展。宠物聊天时会用这里的最新内容；你也可以对它说“记住我在准备面试”。
        </p>
      </header>
      <TopicComposer />
      {error && <p className="load-error">{error}</p>}
      {data && data.active.length === 0 && <p className="empty">还没有正在进行的事项。</p>}
      <ul className="card-list" role="list" aria-label="进行中的事项">
        {data?.active.map((topic) => <TopicCard key={topic.id} topic={topic} />)}
      </ul>
      {data && data.closed.length > 0 && (
        <details className="done-section">
          <summary>已完成或归档（{data.closed.length}）</summary>
          <ul className="card-list" role="list" aria-label="已结束的事项">
            {data.closed.map((topic) => (
              <TopicCard key={topic.id} topic={topic} />
            ))}
          </ul>
        </details>
      )}
      {data && data.forgotten.length > 0 && (
        <details className="done-section">
          <summary>已忘记（{data.forgotten.length}）</summary>
          <p className="view-hint">已忘记的事项不再用于对话，可以恢复；“删除”会彻底删除本机记录。</p>
          <ul className="card-list" role="list" aria-label="已忘记的事项">
            {data.forgotten.map((topic) => (
              <ForgottenTopic key={topic.id} topic={topic} />
            ))}
          </ul>
        </details>
      )}
      <p className="view-hint">
        “忘记”和“删除”只影响本机的记录：已经发送给模型服务的聊天内容不受本机删除控制，本机以外的备份也需要你自己处理。
      </p>
    </section>
  );
}

function TopicComposer() {
  const [title, setTitle] = useState('');
  const { busy, run } = useAction();
  const submit = async (event: FormEvent): Promise<void> => {
    event.preventDefault();
    if (!title.trim() || busy) return;
    const result = await run('topics.create', { title });
    if (result.ok) setTitle('');
  };
  return (
    <form className="composer composer-row" onSubmit={submit} aria-label="添加事项">
      <input
        aria-label="事项名称"
        placeholder="一件正在进行的事，例如“准备产品经理面试”"
        value={title}
        maxLength={TOPIC_TITLE_MAX}
        onChange={(event) => setTitle(event.target.value)}
      />
      <button type="submit" className="primary" disabled={!title.trim() || busy}>
        添加
      </button>
    </form>
  );
}

type Mode = 'view' | 'edit' | 'progress' | 'followUp';

function TopicCard({ topic }: { topic: TopicDetailDto }) {
  const [mode, setMode] = useState<Mode>('view');
  const [title, setTitle] = useState(topic.title);
  const [progress, setProgress] = useState(topic.progressNote);
  const { busy, run } = useAction();
  const active = topic.status === 'active';

  const begin = (next: Mode): void => {
    setTitle(topic.title);
    setProgress(topic.progressNote);
    setMode(next);
  };

  const saveTitle = async (event: FormEvent): Promise<void> => {
    event.preventDefault();
    const result = await run('topics.update', { id: topic.id, revision: topic.revision, title });
    if (result.ok) setMode('view');
  };
  const saveProgress = async (event: FormEvent): Promise<void> => {
    event.preventDefault();
    const result = await run('topics.recordProgress', { id: topic.id, revision: topic.revision, note: progress });
    if (result.ok) setMode('view');
  };
  const setStatus = (status: 'active' | 'done' | 'archived'): void => {
    void run('topics.setStatus', { id: topic.id, revision: topic.revision, status });
  };
  const forget = (): void => {
    if (window.confirm(`忘记“${topic.title}”？之后宠物不会再提起它，未到期的跟进也会取消。你可以在“已忘记”里恢复。`)) {
      void run('topics.forget', { id: topic.id });
    }
  };

  return (
    <li className={`card topic-card${active ? '' : ' is-done'}`} aria-label={`事项：${topic.title}`}>
      {mode === 'edit' ? (
        <form onSubmit={saveTitle} className="edit-form">
          <input
            aria-label="事项名称"
            value={title}
            maxLength={TOPIC_TITLE_MAX}
            autoFocus
            onChange={(event) => setTitle(event.target.value)}
            onKeyDown={(event) => event.key === 'Escape' && setMode('view')}
          />
          <p className="view-hint">修改名称算一次更正：之前聊天里的旧说法不会再被宠物使用。</p>
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
          <h2 className="card-title">
            {topic.title}
            {!active && <span className="badge">{TOPIC_STATUS_LABELS[topic.status]}</span>}
          </h2>
          {topic.progressNote && mode !== 'progress' && (
            <p className="progress-note">
              <span className="progress-label">最新进展</span>
              {topic.progressNote}
              {topic.progressUpdatedAt !== null && <span className="meta"> · {formatTime(topic.progressUpdatedAt)}</span>}
            </p>
          )}
          {!topic.progressNote && active && <p className="meta">还没有记录进展</p>}
          {(topic.tasks.length > 0 || topic.followUps.length > 0) && (
            <ul className="linked-list" aria-label="关联的待办和跟进">
              {topic.tasks.map((t) => (
                <li key={t.id}>
                  ✅ 待办：{t.title}
                  {t.status === 'done' ? '（已完成）' : ''}
                </li>
              ))}
              {topic.followUps.map((f) => (
                <li key={f.id}>
                  💬 {formatTime(f.dueAt)} 来问“{f.content}”{f.stopPolicy === 'none' ? '（完成后复盘）' : ''}
                </li>
              ))}
            </ul>
          )}
          <p className="meta">
            <SourceLine source={topic.source} />
          </p>
          {mode === 'progress' && (
            <form onSubmit={saveProgress} className="edit-form">
              <textarea
                aria-label="最新进展"
                placeholder="最新进展，例如“简历改好了，下周一面”"
                value={progress}
                rows={2}
                maxLength={TOPIC_PROGRESS_MAX}
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
          )}
          {mode === 'followUp' && <FollowUpForm topicId={topic.id} onDone={() => setMode('view')} />}
          {mode === 'view' && (
            <div className="card-actions">
              {active && (
                <>
                  <button type="button" onClick={() => begin('progress')}>
                    记录进展
                  </button>
                  <button type="button" onClick={() => begin('followUp')}>
                    约定跟进
                  </button>
                  <button type="button" disabled={busy} onClick={() => setStatus('done')}>
                    标为完成
                  </button>
                  <button type="button" disabled={busy} onClick={() => setStatus('archived')}>
                    归档
                  </button>
                </>
              )}
              {!active && (
                <button type="button" disabled={busy} onClick={() => setStatus('active')}>
                  重新打开
                </button>
              )}
              <button type="button" onClick={() => begin('edit')}>
                改名称
              </button>
              <button type="button" className="danger" disabled={busy} onClick={forget}>
                忘记
              </button>
            </div>
          )}
        </>
      )}
    </li>
  );
}

function ForgottenTopic({ topic }: { topic: TopicDto }) {
  const { busy, run } = useAction();
  const remove = (): void => {
    if (window.confirm(`彻底删除“${topic.title}”？本机记录会被删除，不能恢复；关联的待办会保留。`)) {
      void run('topics.delete', { id: topic.id });
    }
  };
  return (
    <li className="card topic-card is-done" aria-label={`已忘记的事项：${topic.title}`}>
      <h2 className="card-title">{topic.title}</h2>
      <p className="meta">
        <span>忘记于 {formatTime(topic.forgottenAt ?? topic.updatedAt)}</span>
        <SourceLine source={topic.source} />
      </p>
      <div className="card-actions">
        <button type="button" disabled={busy} onClick={() => void run('topics.restore', { id: topic.id })}>
          恢复
        </button>
        <button type="button" className="danger" disabled={busy} onClick={remove}>
          删除本机记录
        </button>
      </div>
    </li>
  );
}
