// 模型设置（R18）：服务配置存 app_settings；密钥只在主进程，用系统加密保存（TD §13.3）。
// 系统加密不可用时密钥只留在内存，不明文落盘（R18.AC-2）。

import { z } from 'zod';
import {
  hostOf,
  isLocalUrl,
  MODEL_PRESETS,
  type ModelSettingsDto,
  type ModelSettingsInput,
} from '../../shared/contracts/chat';
import type { AppSettings } from '../storage/app-settings';
import { getAdapterDefinition } from './adapters/registry';
import type { FetchLike, ModelAdapter } from './model-adapter';

/** 系统加密能力（Electron safeStorage）的最小接口，测试中可替换 */
export interface SecretCipher {
  available(): boolean;
  encrypt(plain: string): Buffer;
  decrypt(data: Buffer): string;
}

const ConfigSchema = z.object({
  schemaVersion: z.literal(1),
  presetId: z.string().max(50),
  adapterId: z.string().max(50),
  /** 适配器自己的配置，用适配器的 schema 校验 */
  adapterConfig: z.unknown(),
  consentedHost: z.string().nullable(),
});

type StoredConfig = z.output<typeof ConfigSchema>;

const CONFIG_KEY = 'model.config';
const SECRET_KEY = 'model.secret';

export class ModelSettingsError extends Error {
  constructor(
    readonly code: 'INVALID_CONFIG' | 'CONSENT_REQUIRED' | 'UNKNOWN_ADAPTER',
    message: string,
  ) {
    super(message);
  }
}

export class ModelSettings {
  private memoryKey: string | null = null;
  private readonly listeners = new Set<() => void>();

  constructor(
    private readonly settings: AppSettings,
    private readonly cipher: SecretCipher,
  ) {}

  onChange(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  get(): ModelSettingsDto {
    const stored = this.settings.get(CONFIG_KEY, ConfigSchema);
    const preset = MODEL_PRESETS[0];
    const adapterConfig = stored ? parseAdapterConfig(stored) : null;
    const keyStorage = this.memoryKey !== null ? 'memory' : this.settings.has(SECRET_KEY) ? 'encrypted' : 'none';
    return {
      presetId: stored?.presetId ?? preset?.id ?? 'custom',
      adapterId: stored?.adapterId ?? 'openai-compatible',
      baseUrl: adapterConfig?.baseUrl ?? preset?.baseUrl ?? '',
      model: adapterConfig?.model ?? preset?.model ?? '',
      hasKey: keyStorage !== 'none',
      keyStorage,
      encryptionAvailable: this.cipher.available(),
      consentedHost: stored?.consentedHost ?? null,
    };
  }

  /** 保存配置。云服务首次配置（或换了服务地址）时必须确认发送范围（R18.AC-3） */
  save(input: ModelSettingsInput): ModelSettingsDto {
    const definition = getAdapterDefinition(input.adapterId);
    if (!definition) throw new ModelSettingsError('UNKNOWN_ADAPTER', '不支持的协议');
    const parsed = definition.configSchema.safeParse({ baseUrl: input.baseUrl, model: input.model });
    if (!parsed.success) throw new ModelSettingsError('INVALID_CONFIG', '服务地址或模型名不正确');

    const host = hostOf(input.baseUrl);
    const previous = this.settings.get(CONFIG_KEY, ConfigSchema);
    const local = isLocalUrl(input.baseUrl);
    let consentedHost = previous?.consentedHost ?? null;
    if (!local && consentedHost !== host) {
      if (!input.consent) {
        throw new ModelSettingsError('CONSENT_REQUIRED', '请确认对话内容会发送到这个服务');
      }
      consentedHost = host;
    }

    const config: StoredConfig = {
      schemaVersion: 1,
      presetId: input.presetId,
      adapterId: input.adapterId,
      adapterConfig: parsed.data,
      consentedHost,
    };
    this.settings.set(CONFIG_KEY, config);
    if (input.apiKey !== undefined) this.setKey(input.apiKey.trim());
    this.notify();
    return this.get();
  }

  /** 已配置且可以创建适配器时返回；否则 null（未配置） */
  createAdapter(fetch: FetchLike): { adapter: ModelAdapter; label: string } | null {
    const stored = this.settings.get(CONFIG_KEY, ConfigSchema);
    if (!stored) return null;
    const definition = getAdapterDefinition(stored.adapterId);
    if (!definition) return null;
    const config = definition.configSchema.safeParse(stored.adapterConfig);
    if (!config.success) return null;
    const baseUrl = (config.data as { baseUrl?: string }).baseUrl ?? '';
    // 云服务必须已确认发送范围
    if (!isLocalUrl(baseUrl) && stored.consentedHost !== hostOf(baseUrl)) return null;
    const key = this.readKey();
    if (!key && !isLocalUrl(baseUrl)) return null;
    const preset = MODEL_PRESETS.find((p) => p.id === stored.presetId);
    const model = (config.data as { model?: string }).model ?? '';
    return {
      adapter: definition.create(config.data, key, fetch),
      label: `${preset && preset.id !== 'custom' ? preset.label : (hostOf(baseUrl) ?? '模型')} · ${model}`,
    };
  }

  /** “测试连接”：用表单里尚未保存的值（密钥留空时用已保存的）创建临时适配器 */
  createForTest(input: ModelSettingsInput, fetch: FetchLike): ModelAdapter {
    const definition = getAdapterDefinition(input.adapterId);
    if (!definition) throw new ModelSettingsError('UNKNOWN_ADAPTER', '不支持的协议');
    const parsed = definition.configSchema.safeParse({ baseUrl: input.baseUrl, model: input.model });
    if (!parsed.success) throw new ModelSettingsError('INVALID_CONFIG', '服务地址或模型名不正确');
    const key = input.apiKey ? input.apiKey.trim() : this.readKey();
    return definition.create(parsed.data, key || null, fetch);
  }

  private setKey(key: string): void {
    this.memoryKey = null;
    this.settings.delete(SECRET_KEY);
    if (!key) return;
    if (this.cipher.available()) {
      this.settings.set(SECRET_KEY, this.cipher.encrypt(key).toString('base64'));
    } else {
      this.memoryKey = key;
    }
  }

  private readKey(): string | null {
    if (this.memoryKey !== null) return this.memoryKey;
    const stored = this.settings.get(SECRET_KEY, z.string());
    if (!stored || !this.cipher.available()) return null;
    try {
      return this.cipher.decrypt(Buffer.from(stored, 'base64'));
    } catch {
      // 系统加密的主密钥变化（例如换了 Windows 账户）：视为没有密钥
      return null;
    }
  }

  private notify(): void {
    for (const listener of this.listeners) listener();
  }
}

function parseAdapterConfig(stored: StoredConfig): { baseUrl: string; model: string } | null {
  const definition = getAdapterDefinition(stored.adapterId);
  const parsed = definition?.configSchema.safeParse(stored.adapterConfig);
  return parsed?.success ? (parsed.data as { baseUrl: string; model: string }) : null;
}
