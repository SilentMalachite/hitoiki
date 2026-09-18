import { contextBridge, ipcRenderer } from 'electron';
import { Channel, type FlashMessage } from './ipc';

contextBridge.exposeInMainWorld('hitoiki', {
  onFlash(callback: (message: FlashMessage) => void): void {
    ipcRenderer.on(Channel.Flash, (_event, message: FlashMessage) => callback(message));
  },
  onTick(callback: (remainingSeconds: number) => void): void {
    ipcRenderer.on(Channel.Tick, (_event, remainingSeconds: number) => callback(remainingSeconds));
  },
  cancel(): void {
    ipcRenderer.send(Channel.Cancel);
  },
});
