// 气泡窗口的沙箱 preload。

import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron';
import { BubbleIpc, type BubbleBridge } from '../shared/contracts/bubble-ipc';
import type { BubbleItem } from '../shared/contracts/reminders';

const bubble: BubbleBridge = {
  onItems: (listener) => {
    const handler = (_event: IpcRendererEvent, items: BubbleItem[]): void => listener(items);
    ipcRenderer.on(BubbleIpc.items, handler);
    return () => ipcRenderer.removeListener(BubbleIpc.items, handler);
  },
  shown: (ids) => ipcRenderer.send(BubbleIpc.shown, ids),
  resize: (height) => ipcRenderer.send(BubbleIpc.resize, height),
  close: () => ipcRenderer.send(BubbleIpc.close),
  openInbox: () => ipcRenderer.send(BubbleIpc.openInbox),
  openFollowUp: (inboxId) => ipcRenderer.send(BubbleIpc.openFollowUp, inboxId),
  command: (name, input, operationId) => ipcRenderer.invoke(BubbleIpc.command, name, input, operationId),
};

contextBridge.exposeInMainWorld('bubble', bubble);
