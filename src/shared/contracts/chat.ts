// 对话窗口与模型设置的数据约定（R05、R18）。只放类型和常量。

import type { CommandResult } from './command';
import type { ReminderDto } from './reminders';

export type MessageStatus = 'sent' | 'pending_retry' | 'complete' | 'streaming' | 'cancelled' | 'failed' | 'interrupted';

export interface ChatMessageDto {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  status: MessageStatus;
  /** 所属轮次：用户消息是最近一次发送或重试的轮次 */
  turnId: string | null;
  createdAt: number;
}

/** 正在想 / 执行中 / 回复中 */
export type TurnPhase = 'requesting' | 'executing' | 'responding';

/** 正在进行的轮次（流式期间由主进程推送） */
export interface LiveTurn {
  turnId: string;
  userMessageId: string;
  phase: TurnPhase;
  /** 目前已收到的回复文字 */
  text: string;
  /** 单次流式 + 撤回（D-06）：已显示的文字因为出现工具调用而收起 */
  retracted?: boolean;
}

export type ModelErrorCode =
  | 'NOT_CONFIGURED'
  | 'NETWORK'
  | 'TIMEOUT'
  | 'AUTH'
  | 'MODEL_NOT_FOUND'
  | 'RATE_LIMITED'
  | 'SERVER'
  | 'BAD_RESPONSE'
  | 'ABORTED'
  | 'BUSY';

export const MODEL_ERROR_TEXT: Record<ModelErrorCode, string> = {
  NOT_CONFIGURED: '还没有配置模型，可以在小窝的“设置”里填写',
  NETWORK: '连不上模型服务，请检查网络后重试',
  TIMEOUT: '模型服务响应超时，请稍后重试',
  AUTH: '密钥无效或没有权限，请检查设置里的密钥',
  MODEL_NOT_FOUND: '找不到这个模型，请检查设置里的模型名',
  RATE_LIMITED: '请求太频繁或额度不足，请稍后再试',
  SERVER: '模型服务出错了，请稍后重试',
  BAD_RESPONSE: '模型服务返回的内容无法识别，请检查服务地址',
  ABORTED: '已停止',
  BUSY: '上一条消息还在回复中',
};

/** 主进程 → 对话窗口的推送 */
export type ChatEvent =
  | { type: 'live'; turn: LiveTurn | null }
  /** 一轮结束（完成、失败、停止）；失败时带错误码 */
  | { type: 'ended'; turnId: string; errorCode: ModelErrorCode | null }
  | { type: 'focus-input' };

export interface ChatStatus {
  configured: boolean;
  /** 当前模型的显示名，例如“DeepSeek · deepseek-chat” */
  modelLabel: string | null;
  /** 能否用一句话创建提醒、笔记、称呼；所选服务不支持工具调用时为 false，只能聊天 */
  toolCalls: boolean;
}

// ---------- 结果卡片（R05.AC-5、R08.AC-2） ----------

/** done 已执行；awaiting_input 等待补充信息；resolved 已由后续回答补全；expired 草稿过期或被放弃 */
export type ActionCardState = 'done' | 'awaiting_input' | 'failed' | 'cancelled' | 'resolved' | 'expired';

/** 由本地记录渲染的结果卡片；内容取实体的当前状态，不用模型文字 */
export interface ActionCardDto {
  operationId: string;
  turnId: string;
  /** 卡片所属的用户消息：轮次没有回复文字时，卡片显示在这条消息后面 */
  userMessageId: string;
  /** 命令名，例如 reminders.create */
  kind: string;
  state: ActionCardState;
  createdAt: number;
  reminder?: ReminderDto | null;
  note?: { id: string; label: string; deleted: boolean } | null;
  /** 设置后的称呼；null 表示已清除 */
  nickname?: string | null;
  /** 重复表达确认后只设置了下一次（R08.AC-7） */
  onceOnly?: boolean;
  /** 等待补充信息时的问题 */
  question?: string;
  /** 可以直接确认的建议，例如“只设置下一次（…）” */
  suggestionLabel?: string;
  /** 失败原因（本地文字） */
  errorText?: string;
}

/** 卡片上的按钮：全部走 UI 命令入口，不经过模型 */
export type ChatActionRequest =
  | { action: 'confirmDraft'; draftId: string }
  | { action: 'dismissDraft'; draftId: string }
  | { action: 'rescheduleReminder'; id: string; revision: number; dueAt: number }
  | { action: 'cancelReminder'; id: string; revision: number };

export type NestTarget = 'notes' | 'reminders' | 'settings';

/** 对话流式方案（D-06）：two_phase 两段式；stream_retract 单次流式 + 撤回 */
export type ConversationStrategy = 'two_phase' | 'stream_retract';
export const DEFAULT_STRATEGY: ConversationStrategy = 'two_phase';

export const ChatIpc = {
  /** invoke：历史消息与进行中的轮次 */
  history: 'chat:history',
  /** invoke：(text, operationId) 发送 → CommandResult */
  send: 'chat:send',
  /** invoke：(userMessageId, operationId) 重试 → CommandResult */
  retry: 'chat:retry',
  /** send：停止当前轮次 */
  stop: 'chat:stop',
  /** invoke：模型配置状态 */
  status: 'chat:status',
  /** send：打开小窝的设置页 */
  openSettings: 'chat:open-settings',
  /** send：(NestTarget) 打开小窝的指定页 */
  openNest: 'chat:open-nest',
  /** invoke：(ChatActionRequest, operationId) 卡片按钮 → CommandResult */
  action: 'chat:action',
  /** send：收起对话窗口 */
  hide: 'chat:hide',
  /** 主进程 → 渲染层：ChatEvent */
  event: 'chat:event',
  /** 主进程 → 渲染层：消息列表有变化，请重新读取历史 */
  changed: 'chat:changed',
} as const;

export interface ChatHistory {
  messages: ChatMessageDto[];
  live: LiveTurn | null;
  cards: ActionCardDto[];
}

export interface ChatBridge {
  history(): Promise<ChatHistory>;
  send(text: string, operationId: string): Promise<CommandResult<{ userMessageId: string; turnId: string | null }>>;
  retry(userMessageId: string, operationId: string): Promise<CommandResult<{ turnId: string }>>;
  stop(): void;
  status(): Promise<ChatStatus>;
  openSettings(): void;
  openNest(target: NestTarget): void;
  action(request: ChatActionRequest, operationId: string): Promise<CommandResult>;
  hide(): void;
  onEvent(listener: (event: ChatEvent) => void): () => void;
  onChanged(listener: () => void): () => void;
}

export const CHAT_MESSAGE_MAX = 4000;

// ---------- 模型设置 ----------

export interface ModelPreset {
  id: string;
  label: string;
  adapterId: string;
  baseUrl: string;
  /** 建议的模型名；服务商会更新型号，以服务商文档为准 */
  model: string;
  /** 本地服务不需要密钥，也不会把内容发到外部 */
  local?: boolean;
  docsHint?: string;
}

/** 预设只是填表的起点，用户可以修改每一项 */
export const MODEL_PRESETS: ModelPreset[] = [
  { id: 'deepseek', label: 'DeepSeek', adapterId: 'openai-compatible', baseUrl: 'https://api.deepseek.com/v1', model: 'deepseek-chat' },
  {
    id: 'qwen',
    label: '通义千问（阿里云百炼）',
    adapterId: 'openai-compatible',
    baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
    model: 'qwen-plus',
  },
  { id: 'kimi', label: 'Kimi（月之暗面）', adapterId: 'openai-compatible', baseUrl: 'https://api.moonshot.cn/v1', model: 'moonshot-v1-8k' },
  { id: 'zhipu', label: '智谱 GLM', adapterId: 'openai-compatible', baseUrl: 'https://open.bigmodel.cn/api/paas/v4', model: 'glm-4-flash' },
  {
    id: 'ollama',
    label: '本地 Ollama',
    adapterId: 'openai-compatible',
    baseUrl: 'http://localhost:11434/v1',
    model: 'qwen2.5:7b',
    local: true,
  },
  { id: 'custom', label: '自定义（OpenAI 兼容）', adapterId: 'openai-compatible', baseUrl: '', model: '' },
];

export interface ModelSettingsDto {
  presetId: string;
  adapterId: string;
  baseUrl: string;
  model: string;
  hasKey: boolean;
  /** 密钥保存方式：encrypted（系统加密，重启后仍在）、memory（仅本次运行）、none */
  keyStorage: 'encrypted' | 'memory' | 'none';
  /** 系统加密是否可用 */
  encryptionAvailable: boolean;
  /** 已确认把对话内容发送到这个服务（R18.AC-3） */
  consentedHost: string | null;
  /** 对话流式方案（D-06） */
  strategy: ConversationStrategy;
  /** 当前服务和模型拒绝过带工具的请求，只能聊天；重新保存设置后再试 */
  toolsRejected: boolean;
}

export interface ModelSettingsInput {
  presetId: string;
  adapterId: string;
  baseUrl: string;
  model: string;
  /** undefined：不修改已保存的密钥；空字符串：清除 */
  apiKey?: string;
  /** 用户勾选了“我知道对话内容会发送到这个服务” */
  consent: boolean;
}

export type ModelTestResult = { ok: true; latencyMs: number; sample: string } | { ok: false; errorCode: ModelErrorCode; detail?: string };

export function isLocalUrl(baseUrl: string): boolean {
  try {
    const host = new URL(baseUrl).hostname;
    return host === 'localhost' || host === '127.0.0.1' || host === '::1' || host === '[::1]';
  } catch {
    return false;
  }
}

export function hostOf(baseUrl: string): string | null {
  try {
    return new URL(baseUrl).host;
  } catch {
    return null;
  }
}
