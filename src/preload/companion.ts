// 小窝窗口的沙箱 preload：只暴露命名的命令、查询和订阅（TD §13.3）。

import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron';
import type { DataTopic } from '../shared/contracts/command';
import { NestIpc, type NestBridge, type NestView } from '../shared/contracts/nest-ipc';

const nest: NestBridge = {
  command: (name, input, operationId) => ipcRenderer.invoke(NestIpc.command, name, input, operationId),
  query: (name, input) => ipcRenderer.invoke(NestIpc.query, name, input),
  onChanged: (listener) => {
    const handler = (_event: IpcRendererEvent, topics: DataTopic[]): void => listener(topics);
    ipcRenderer.on(NestIpc.changed, handler);
    return () => ipcRenderer.removeListener(NestIpc.changed, handler);
  },
  onNavigate: (listener) => {
    const handler = (_event: IpcRendererEvent, view: NestView): void => listener(view);
    ipcRenderer.on(NestIpc.navigate, handler);
    return () => ipcRenderer.removeListener(NestIpc.navigate, handler);
  },
  system: (request) => ipcRenderer.invoke(NestIpc.system, request),
  model: (request) => ipcRenderer.invoke(NestIpc.model, request),
  openFollowUp: (inboxId) => ipcRenderer.invoke(NestIpc.followUp, inboxId),
  data: (request) => ipcRenderer.invoke(NestIpc.data, request),
};

contextBridge.exposeInMainWorld('nest', nest);
