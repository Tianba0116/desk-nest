import { useEffect, useState, type FormEvent } from 'react';
import {
  hostOf,
  isLocalUrl,
  MODEL_ERROR_TEXT,
  MODEL_PRESETS,
  type ModelSettingsDto,
  type ModelSettingsInput,
  type ModelTestResult,
} from '../../shared/contracts/chat';

export function SettingsView() {
  const [saved, setSaved] = useState<ModelSettingsDto | null>(null);
  const [presetId, setPresetId] = useState('deepseek');
  const [baseUrl, setBaseUrl] = useState('');
  const [model, setModel] = useState('');
  const [apiKey, setApiKey] = useState('');
  const [consent, setConsent] = useState(false);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ tone: 'ok' | 'error'; text: string } | null>(null);
  const [test, setTest] = useState<ModelTestResult | null>(null);

  useEffect(() => {
    void window.nest.model({ action: 'get' }).then((response) => {
      const s = response.settings;
      setSaved(s);
      setPresetId(s.presetId);
      setBaseUrl(s.baseUrl);
      setModel(s.model);
    });
  }, []);

  const local = isLocalUrl(baseUrl);
  const host = hostOf(baseUrl);
  const needsConsent = !local && !!host && saved?.consentedHost !== host;

  const choosePreset = (id: string): void => {
    setPresetId(id);
    const preset = MODEL_PRESETS.find((p) => p.id === id);
    if (preset && preset.id !== 'custom') {
      setBaseUrl(preset.baseUrl);
      setModel(preset.model);
    }
    setTest(null);
  };

  const input = (): ModelSettingsInput => ({
    presetId,
    adapterId: 'openai-compatible',
    baseUrl: baseUrl.trim(),
    model: model.trim(),
    ...(apiKey ? { apiKey } : {}),
    consent,
  });

  const save = async (event: FormEvent): Promise<void> => {
    event.preventDefault();
    setBusy(true);
    setMessage(null);
    try {
      const response = await window.nest.model({ action: 'save', input: input() });
      setSaved(response.settings);
      if (response.ok) {
        setApiKey('');
        setConsent(false);
        setMessage({ tone: 'ok', text: '已保存。单击宠物就可以开始聊天了。' });
      } else {
        setMessage({ tone: 'error', text: response.error });
      }
    } finally {
      setBusy(false);
    }
  };

  const runTest = async (): Promise<void> => {
    setBusy(true);
    setTest(null);
    setMessage(null);
    try {
      const response = await window.nest.model({ action: 'test', input: input() });
      if (response.ok && response.test) setTest(response.test);
      else if (!response.ok) setMessage({ tone: 'error', text: response.error });
    } finally {
      setBusy(false);
    }
  };

  const clearKey = async (): Promise<void> => {
    if (!saved || !window.confirm('清除已保存的密钥？')) return;
    const response = await window.nest.model({
      action: 'save',
      input: { presetId: saved.presetId, adapterId: saved.adapterId, baseUrl: saved.baseUrl, model: saved.model, apiKey: '', consent: false },
    });
    setSaved(response.settings);
    setMessage(response.ok ? { tone: 'ok', text: '密钥已清除' } : { tone: 'error', text: response.error });
  };

  const preset = MODEL_PRESETS.find((p) => p.id === presetId);

  return (
    <section aria-labelledby="settings-title">
      <header className="view-header">
        <h1 id="settings-title">设置</h1>
        <p className="view-hint">配置模型后，单击宠物就能聊天。不配置模型时，笔记、待办、提醒都照常可用。</p>
      </header>

      <form className="composer settings-form" onSubmit={save} aria-label="模型设置">
        <h2 className="section-title first">模型服务</h2>
        <label className="field">
          <span>服务</span>
          <select value={presetId} onChange={(event) => choosePreset(event.target.value)}>
            {MODEL_PRESETS.map((p) => (
              <option key={p.id} value={p.id}>
                {p.label}
              </option>
            ))}
          </select>
        </label>
        <label className="field">
          <span>服务地址（OpenAI 兼容，通常以 /v1 结尾）</span>
          <input value={baseUrl} onChange={(event) => setBaseUrl(event.target.value)} placeholder="https://..." spellCheck={false} />
        </label>
        <label className="field">
          <span>模型名{preset && preset.id !== 'custom' ? '（预设值可能过时，以服务商文档为准）' : ''}</span>
          <input value={model} onChange={(event) => setModel(event.target.value)} spellCheck={false} />
        </label>
        <label className="field">
          <span>
            密钥（API Key）
            {saved?.hasKey && (saved.keyStorage === 'encrypted' ? ' · 已保存（系统加密）' : ' · 已保存（仅本次运行）')}
            {local && ' · 本地服务可以不填'}
          </span>
          <input
            type="password"
            value={apiKey}
            autoComplete="off"
            onChange={(event) => setApiKey(event.target.value)}
            placeholder={saved?.hasKey ? '留空表示不修改' : 'sk-...'}
          />
        </label>
        {saved && !saved.encryptionAvailable && (
          <p className="warn">这台电脑无法使用系统加密保存密钥，密钥只在本次运行期间保存在内存中，重启后需要重新填写。</p>
        )}

        {needsConsent && (
          <label className="consent">
            <input type="checkbox" checked={consent} onChange={(event) => setConsent(event.target.checked)} />
            <span>
              我知道和宠物聊天时，我发送的消息和最近的聊天记录会发送到 <strong>{host}</strong>，并按该服务的规则处理。
              笔记、待办和提醒不会被发送。
            </span>
          </label>
        )}

        {message && (
          <p className={message.tone === 'ok' ? 'ok-text' : 'warn'} role="status">
            {message.text}
          </p>
        )}
        {test && (
          <p className={test.ok ? 'ok-text' : 'warn'} role="status">
            {test.ok
              ? `连接成功，${(test.latencyMs / 1000).toFixed(1)} 秒收到回复：“${test.sample}”`
              : `连接失败：${MODEL_ERROR_TEXT[test.errorCode]}${test.detail ? `（${test.detail}）` : ''}`}
          </p>
        )}

        <div className="card-actions">
          <button type="submit" className="primary" disabled={busy || !baseUrl.trim() || !model.trim() || (needsConsent && !consent)}>
            保存
          </button>
          <button type="button" disabled={busy || !baseUrl.trim() || !model.trim()} onClick={() => void runTest()}>
            {busy ? '请稍候…' : '测试连接'}
          </button>
          {saved?.hasKey && (
            <button type="button" className="danger" disabled={busy} onClick={() => void clearKey()}>
              清除密钥
            </button>
          )}
        </div>
      </form>

      <p className="view-hint">
        密钥只保存在本机并由系统加密，不会显示在界面、写入日志或导出文件。当前版本的宠物只能聊天，不能替你创建提醒或笔记。
      </p>
    </section>
  );
}
