import { contextBridge, ipcRenderer } from 'electron';
import type { SaveResult, SettingsDraft } from './config';
import { Channel, type SettingsSnapshot } from './ipc';

contextBridge.exposeInMainWorld('hitoikiSettings', {
  get(): Promise<SettingsSnapshot | null> {
    return ipcRenderer.invoke(Channel.SettingsGet);
  },
  save(draft: SettingsDraft): Promise<SaveResult> {
    return ipcRenderer.invoke(Channel.SettingsSave, draft);
  },
  openConfigFile(): void {
    ipcRenderer.send(Channel.SettingsOpenFile);
  },
});
