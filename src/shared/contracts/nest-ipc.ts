// 小窝（CompanionWindow）与主进程之间的 IPC 约定。只放常量和类型。

import type { ModelSettingsDto, ModelSettingsInput, ModelTestResult } from './chat';
import type { CommandResult, DataTopic } from './command';
import type { NoteDto, RecycledItem, SearchHit, TaskDto } from './notebook';
import type { InboxItemDto, ReminderDto } from './reminders';

export const NestIpc = {
  /** 渲染层 → 主进程（invoke）：执行命令 (name, input, operationId) → CommandResult */
  command: 'nest:command',
  /** 渲染层 → 主进程（invoke）：只读查询 (name, input) → 结果 */
  query: 'nest:query',
  /** 主进程 → 渲染层：DataTopic[]，对应数据已变化，请重新查询 */
  changed: 'nest:changed',
  /** 主进程 → 渲染层：NestView，切换到指定页面 */
  navigate: 'nest:navigate',
  /** 渲染层 → 主进程（invoke）：系统相关操作（开机启动），见 SystemRequest */
  system: 'nest:system',
  /** 渲染层 → 主进程（invoke）：模型设置，见 ModelRequest */
  model: 'nest:model',
} as const;

export type NestView = 'inbox' | 'reminders' | 'notes' | 'tasks' | 'recycle' | 'settings';

export type ModelRequest =
  | { action: 'get' }
  | { action: 'save'; input: ModelSettingsInput }
  | { action: 'test'; input: ModelSettingsInput };

export type ModelResponse =
  | { ok: true; settings: ModelSettingsDto; test?: ModelTestResult }
  | { ok: false; error: string; settings: ModelSettingsDto };

/** 运行条件：开机启动状态与首次提醒时的提示（R01.AC-5～6） */
export interface StartupState {
  /** 仅打包版可以设置开机启动 */
  supported: boolean;
  openAtLogin: boolean;
  promptDismissed: boolean;
}

export type SystemRequest =
  | { action: 'getStartup' }
  | { action: 'setOpenAtLogin'; value: boolean }
  | { action: 'dismissStartupPrompt' };

/** 查询名称 → 输入/输出类型 */
export interface NestQueries {
  'notebook.notes': { input: Record<string, never>; output: NoteDto[] };
  'notebook.tasks': { input: Record<string, never>; output: TaskDto[] };
  'notebook.search': { input: { query: string }; output: SearchHit[] };
  'notebook.recycleBin': { input: Record<string, never>; output: RecycledItem[] };
  'reminders.list': { input: Record<string, never>; output: { upcoming: ReminderDto[]; history: ReminderDto[] } };
  'inbox.list': { input: Record<string, never>; output: InboxItemDto[] };
  'inbox.unreadCount': { input: Record<string, never>; output: number };
}

export type QueryName = keyof NestQueries;

/** 查询失败时 invoke 抛出的错误里带的代码 */
export type QueryErrorCode = 'UNKNOWN_QUERY' | 'INVALID_INPUT' | 'INTERNAL';

/** preload 暴露给小窝窗口的接口（window.nest） */
export interface NestBridge {
  command<T = unknown>(name: string, input: unknown, operationId: string): Promise<CommandResult<T>>;
  query<K extends QueryName>(name: K, input: NestQueries[K]['input']): Promise<NestQueries[K]['output']>;
  /** 返回取消订阅函数 */
  onChanged(listener: (topics: DataTopic[]) => void): () => void;
  onNavigate(listener: (view: NestView) => void): () => void;
  system(request: SystemRequest): Promise<StartupState>;
  model(request: ModelRequest): Promise<ModelResponse>;
}
