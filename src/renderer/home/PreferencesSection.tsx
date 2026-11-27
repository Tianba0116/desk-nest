// 称呼（R10.AC-1～3 的称呼部分）：不依赖模型，直接设置、修改、清除。

import { useEffect, useState, type FormEvent } from 'react';
import { NICKNAME_MAX, STYLE_LABELS, STYLES, type PreferencesDto, type Style } from '../../shared/contracts/preferences';
import { describeError, runCommand, useQuery } from './api';

export function PreferencesSection() {
  const { data } = useQuery('preferences.get', {}, ['settings']);
  const [value, setValue] = useState('');
  const [message, setMessage] = useState<{ tone: 'ok' | 'error'; text: string } | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    setValue(data?.nickname ?? '');
  }, [data?.nickname]);

  const save = async (nickname: string | null): Promise<void> => {
    if (!data) return;
    setBusy(true);
    setMessage(null);
    try {
      const result = await runCommand<PreferencesDto>('preferences.setNickname', { nickname, revision: data.revision });
      if (result.ok) setMessage({ tone: 'ok', text: result.result.nickname ? `以后叫你“${result.result.nickname}”` : '已清除称呼' });
      else setMessage({ tone: 'error', text: describeError(result) });
    } finally {
      setBusy(false);
    }
  };

  const submit = (event: FormEvent): void => {
    event.preventDefault();
    const trimmed = value.trim();
    void save(trimmed ? trimmed : null);
  };

  return (
    <form className="composer settings-form" onSubmit={submit} aria-label="称呼">
      <h2 className="section-title first">称呼与说话方式</h2>
      <label className="field">
        <span>宠物怎么叫你（也可以在对话里说“叫我小林”）</span>
        <input value={value} maxLength={NICKNAME_MAX} onChange={(event) => setValue(event.target.value)} placeholder="不填就不使用称呼" />
      </label>
      <label className="field">
        <span>说话方式（也可以在对话里说“说话简短一点”）</span>
        <select
          value={data?.style ?? ''}
          disabled={!data || busy}
          onChange={(event) => {
            const style = (STYLES as readonly string[]).includes(event.target.value) ? (event.target.value as Style) : null;
            void runCommand('preferences.setStyle', { style });
          }}
        >
          <option value="">默认</option>
          {STYLES.map((s) => (
            <option key={s} value={s}>
              {STYLE_LABELS[s]}
            </option>
          ))}
        </select>
      </label>
      {message && (
        <p className={message.tone === 'ok' ? 'ok-text' : 'warn'} role="status">
          {message.text}
        </p>
      )}
      <div className="card-actions">
        <button type="submit" className="primary" disabled={busy || !data || value.trim() === (data.nickname ?? '')}>
          保存称呼
        </button>
        {data?.nickname && (
          <button type="button" disabled={busy} onClick={() => void save(null)}>
            清除
          </button>
        )}
      </div>
    </form>
  );
}
