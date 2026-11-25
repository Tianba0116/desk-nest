// 模型服务扩展点（TD §7.1、§14.1）：实现 ModelAdapter → 在注册表登记 → 提供配置 schema。
// 对话流程只依赖这里的接口，不按具体服务写分支。

import type { z } from 'zod';
import type { ModelErrorCode } from '../../shared/contracts/chat';

export type ModelEvent =
  | { type: 'text_delta'; text: string }
  | { type: 'tool_delta'; callId: string; name?: string; argumentsDelta: string }
  | { type: 'tool_end'; callId: string }
  | { type: 'end'; reason: 'stop' | 'tool_calls' | 'length' }
  | { type: 'error'; code: ModelErrorCode; retryable: boolean; detail?: string };

export interface ModelMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export interface ModelRequest {
  messages: ModelMessage[];
  maxTokens?: number;
  temperature?: number;
}

export interface ModelCapabilities {
  streaming: boolean;
  toolCalls: boolean;
  structuredOutput: boolean;
}

export interface ModelAdapter {
  readonly capabilities: ModelCapabilities;
  /** 事件流；signal 中止时尽快结束并产出 ABORTED 错误事件 */
  stream(request: ModelRequest, signal: AbortSignal): AsyncIterable<ModelEvent>;
}

/** 网络请求函数：生产环境用 Electron net.fetch（跟随系统代理），测试用假实现 */
export type FetchLike = (url: string, init: RequestInit) => Promise<Response>;

export interface AdapterDefinition<S extends z.ZodType = z.ZodType> {
  id: string;
  label: string;
  /** 配置 schema（不含密钥）；加载时校验，失败则视为未配置 */
  configSchema: S;
  /** 这个协议是否需要密钥（本地服务可以没有） */
  create(config: z.output<S>, apiKey: string | null, fetch: FetchLike): ModelAdapter;
}
