// 模型适配器注册表（TD §14.1）。新协议：实现 AdapterDefinition 并加入这里，对话流程不变。

import type { AdapterDefinition } from '../model-adapter';
import { openAICompatible } from './openai-compatible';

const adapters = new Map<string, AdapterDefinition>([[openAICompatible.id, openAICompatible as AdapterDefinition]]);

export function getAdapterDefinition(id: string): AdapterDefinition | undefined {
  return adapters.get(id);
}

export function listAdapters(): Array<{ id: string; label: string }> {
  return [...adapters.values()].map(({ id, label }) => ({ id, label }));
}
