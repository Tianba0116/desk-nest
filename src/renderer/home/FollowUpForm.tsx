// 为事项或待办创建约定跟进（R12.AC-3）：不依赖模型。

import { useState, type FormEvent } from 'react';
import { FOLLOW_UP_PURPOSE_MAX, type TopicDto } from '../../shared/contracts/memory';
import { fromLocalInputValue, toLocalInputValue, useQuery } from './api';
import { useAction } from './useAction';

function tomorrowEvening(): string {
  const d = new Date();
  d.setDate(d.getDate() + 1);
  d.setHours(20, 0, 0, 0);
  return toLocalInputValue(d.getTime());
}

export function FollowUpForm({
  topicId = null,
  taskId = null,
  onDone,
}: {
  topicId?: string | null;
  taskId?: string | null;
  onDone: () => void;
}) {
  const [purpose, setPurpose] = useState('');
  const [due, setDue] = useState(tomorrowEvening());
  const [review, setReview] = useState(false);
  const { busy, run } = useAction();

  const submit = async (event: FormEvent): Promise<void> => {
    event.preventDefault();
    const dueAt = fromLocalInputValue(due);
    if (!purpose.trim() || dueAt === null) return;
    const result = await run('followUps.create', {
      purpose,
      dueAt,
      timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
      topicId,
      taskId,
      stopPolicy: review ? 'none' : 'on_target_closed',
    });
    if (result.ok) onDone();
  };

  return (
    <form className="edit-form follow-up-form" onSubmit={submit} aria-label="约定跟进">
      <input
        aria-label="到时候问什么"
        placeholder="到时候问什么，例如“面试准备得怎么样”"
        value={purpose}
        maxLength={FOLLOW_UP_PURPOSE_MAX}
        autoFocus
        onChange={(event) => setPurpose(event.target.value)}
        onKeyDown={(event) => event.key === 'Escape' && onDone()}
      />
      <input type="datetime-local" aria-label="什么时候来问" value={due} required onChange={(event) => setDue(event.target.value)} />
      <label className="inline-check">
        <input type="checkbox" checked={review} onChange={(event) => setReview(event.target.checked)} />
        <span>完成后也来问（复盘）：这件事完成后不会自动取消</span>
      </label>
      <div className="card-actions">
        <button type="submit" className="primary" disabled={busy || !purpose.trim()}>
          约好了
        </button>
        <button type="button" onClick={onDone}>
          取消
        </button>
      </div>
    </form>
  );
}

/** 选择关联的事项（R07.AC-3） */
export function TopicSelect({ value, onChange }: { value: string | null; onChange: (id: string | null) => void }) {
  const { data } = useQuery('topics.list', {}, ['topics']);
  const options: TopicDto[] = data?.active ?? [];
  const current = value && !options.some((t) => t.id === value) ? data?.closed.find((t) => t.id === value) : undefined;
  return (
    <select aria-label="关联的事项" value={value ?? ''} onChange={(event) => onChange(event.target.value || null)}>
      <option value="">不关联事项</option>
      {options.map((t) => (
        <option key={t.id} value={t.id}>
          事项：{t.title}
        </option>
      ))}
      {current && <option value={current.id}>事项：{current.title}（已结束）</option>}
    </select>
  );
}
