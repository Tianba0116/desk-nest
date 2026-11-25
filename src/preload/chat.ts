// 对话窗口的沙箱 preload。

import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron';
import { ChatIpc, type ChatBridge, type ChatEvent } from '../shared/contracts/chat';

const chat: ChatBridge = {
  history: () => ipcRenderer.invoke(ChatIpc.history),
  send: (text, operationId) => ipcRenderer.invoke(ChatIpc.send, text, operationId),
  retry: (userMessageId, operationId) => ipcRenderer.invoke(ChatIpc.retry, userMessageId, operationId),
  stop: () => ipcRenderer.send(ChatIpc.stop),
  status: () => ipcRenderer.invoke(ChatIpc.status),
  openSettings: () => ipcRenderer.send(ChatIpc.openSettings),
  hide: () => ipcRenderer.send(ChatIpc.hide),
  onEvent: (listener) => {
    const handler = (_event: IpcRendererEvent, payload: ChatEvent): void => listener(payload);
    ipcRenderer.on(ChatIpc.event, handler);
    return () => ipcRenderer.removeListener(ChatIpc.event, handler);
  },
  onChanged: (listener) => {
    const handler = (): void => listener();
    ipcRenderer.on(ChatIpc.changed, handler);
    return () => ipcRenderer.removeListener(ChatIpc.changed, handler);
  },
};

contextBridge.exposeInMainWorld('chat', chat);
