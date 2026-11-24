// 沙箱 preload：只暴露宠物窗口需要的窄接口，不暴露 ipcRenderer 本身（TD §13.3）。

import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron';
import { PetIpc, type PetBridge, type PetEvent } from '../shared/contracts/pet-ipc';

const petBridge: PetBridge = {
  dragStart: () => ipcRenderer.send(PetIpc.dragStart),
  dragEnd: () => ipcRenderer.send(PetIpc.dragEnd),
  setInteractive: (interactive) => ipcRenderer.send(PetIpc.setInteractive, interactive === true),
  onEvent: (listener) => {
    const handler = (_event: IpcRendererEvent, payload: PetEvent): void => listener(payload);
    ipcRenderer.on(PetIpc.event, handler);
    return () => ipcRenderer.removeListener(PetIpc.event, handler);
  },
};

contextBridge.exposeInMainWorld('petBridge', petBridge);
