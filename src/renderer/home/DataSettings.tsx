// 设置页的“聊天记录”和“数据”（R19.AC-3、AC-7、AC-8，D-08）。

import { useState } from 'react';
import { runCommand, useQuery } from './api';
import { useAction } from './useAction';

export function ChatHistorySection() {
  const { data } = useQuery('chat.settings', {}, ['settings', 'conversation']);
  const { busy, run } = useAction();
  const [message, setMessage] = useState<string | null>(null);

  const remove = async (range: 'hour' | 'today' | 'all', label: string): Promise<void> => {
    if (!window.confirm(`删除${label}的聊天记录？删除后不能恢复，宠物也不会再参考这些内容。`)) return;
    const result = await run<{ deleted: number }>('chat.deleteRange', { range });
    if (result.ok) setMessage(`已删除 ${result.result.deleted} 条消息`);
  };

  return (
    <div className="composer settings-form" aria-label="聊天记录">
      <h2 className="section-title">聊天记录</h2>
      <p className="view-hint">
        聊天记录只保存在本机（现在共 {data?.messageCount ?? 0} 条）。宠物每次只参考最近几轮，与保留多久无关。
        已经发送给模型服务的内容不受本机删除控制。
      </p>
      <label className="field">
        <span>保留期限</span>
        <select
          value={data?.retentionDays ?? ''}
          disabled={!data || busy}
          onChange={(event) => {
            const days = event.target.value === '30' ? 30 : event.target.value === '90' ? 90 : null;
            if (days && !window.confirm(`只保留最近 ${days} 天的聊天记录？更早的会被删除。`)) return;
            void runCommand<{ deleted: number }>('chat.setRetention', { days }).then((r) => {
              if (r.ok) setMessage(r.result.deleted > 0 ? `已删除 ${r.result.deleted} 条超过期限的消息` : '已保存');
            });
          }}
        >
          <option value="">永久保留</option>
          <option value="90">保留 90 天</option>
          <option value="30">保留 30 天</option>
        </select>
      </label>
      <div className="card-actions">
        <button type="button" disabled={busy} onClick={() => void remove('hour', '最近 1 小时')}>
          删除最近 1 小时
        </button>
        <button type="button" disabled={busy} onClick={() => void remove('today', '今天')}>
          删除今天
        </button>
        <button type="button" className="danger" disabled={busy} onClick={() => void remove('all', '全部')}>
          删除全部聊天记录
        </button>
      </div>
      {message && (
        <p className="ok-text" role="status">
          {message}
        </p>
      )}
    </div>
  );
}

export function DataSection() {
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);
  const act = async (action: 'export' | 'restore' | 'clear' | 'openFolder'): Promise<void> => {
    setBusy(true);
    setMessage(null);
    try {
      const result = await window.nest.data({ action });
      if (action !== 'openFolder') setMessage({ ok: result.ok, text: result.message });
    } catch {
      setMessage({ ok: false, text: '操作没有成功，现有数据没有变化' });
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="composer settings-form" aria-label="数据">
      <h2 className="section-title">数据</h2>
      <p className="view-hint">
        数据只保存在本机。导出文件包含全部笔记、待办、事项、记忆、提醒、聊天记录和设置，不包含密钥。
        恢复会先备份现在的数据，再整体替换；恢复失败时现有数据保持不变。
      </p>
      <div className="card-actions">
        <button type="button" className="primary" disabled={busy} onClick={() => void act('export')}>
          导出全部数据
        </button>
        <button type="button" disabled={busy} onClick={() => void act('restore')}>
          从导出文件恢复
        </button>
        <button type="button" disabled={busy} onClick={() => void act('openFolder')}>
          打开数据文件夹
        </button>
        <button type="button" className="danger" disabled={busy} onClick={() => void act('clear')}>
          清除所有数据
        </button>
      </div>
      {message && (
        <p className={message.ok ? 'ok-text' : 'warn'} role="status">
          {message.text}
        </p>
      )}
    </div>
  );
}
