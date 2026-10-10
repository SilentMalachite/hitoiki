import * as path from 'node:path';
import { app, BrowserWindow, dialog, ipcMain, type IpcMainEvent, type IpcMainInvokeEvent, type WebContents } from 'electron';
import { RANGES, readSettings, saveConfig, type SaveResult, type SettingsDraft } from './config';
import { Channel, type SettingsSnapshot } from './ipc';

const SETTINGS_HTML = path.join(__dirname, '..', 'renderer', 'settings.html');
const PRELOAD_JS = path.join(__dirname, 'settings-preload.js');
const DISCARD_BUTTON = 0;
/** macOS editing shortcuts. The app has no menu (so a break cannot be escaped with Cmd+Q / Cmd+W), which also drops these. */
const MAC_EDIT_KEYS: Readonly<Record<string, (contents: WebContents, shift: boolean) => void>> = {
  a: (contents) => contents.selectAll(),
  c: (contents) => contents.copy(),
  v: (contents) => contents.paste(),
  x: (contents) => contents.cut(),
  z: (contents, shift) => (shift ? contents.redo() : contents.undo()),
};

export interface SettingsWindowOptions {
  configPath: string;
  /** Called after the settings window saved the config file. */
  onSaved: () => void;
  /** Opens the config file in the default app. */
  openConfigFile: () => void;
}

/**
 * Owns the settings window. At most one exists; it is created on open() and destroyed when closed,
 * so no renderer process is left while it is not shown.
 */
export class SettingsWindow {
  private win: BrowserWindow | null = null;
  /** What the window last loaded or saved; a save writes only the keys that differ from it. */
  private loaded: SettingsDraft | null = null;

  constructor(private readonly options: SettingsWindowOptions) {
    ipcMain.handle(Channel.SettingsGet, (event) => this.handleGet(event));
    ipcMain.handle(Channel.SettingsSave, (event, draft: unknown) => this.handleSave(event, draft));
    ipcMain.on(Channel.SettingsOpenFile, (event) => this.handleOpenFile(event));
  }

  /** Shows the settings window, creating it when there is none. */
  open(): void {
    if (this.win !== null && !this.win.isDestroyed()) {
      if (this.win.isMinimized()) this.win.restore();
      this.win.show();
      this.win.focus();
      if (process.platform === 'darwin') app.focus({ steal: true });
      return;
    }
    const win = new BrowserWindow({
      width: 460,
      height: 680,
      useContentSize: true,
      show: false,
      resizable: false,
      maximizable: false,
      fullscreenable: false,
      title: 'Hitoiki 設定',
      webPreferences: {
        preload: PRELOAD_JS,
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
      },
    });
    this.win = win;
    this.loaded = null;
    win.on('closed', () => {
      if (this.win !== win) return;
      this.win = null;
      this.loaded = null;
    });
    win.once('ready-to-show', () => {
      win.show();
      if (process.platform === 'darwin') app.focus({ steal: true });
    });
    // The page cancels its unload while it has unsaved changes; ask before discarding them.
    win.webContents.on('will-prevent-unload', (event) => {
      const choice = dialog.showMessageBoxSync(win, {
        type: 'question',
        buttons: ['破棄して閉じる', 'キャンセル'],
        defaultId: 1,
        cancelId: 1,
        message: '変更を保存していません',
        detail: '閉じると変更は失われます。',
      });
      // preventDefault() ignores the page's beforeunload handler and lets the window close.
      if (choice === DISCARD_BUTTON) event.preventDefault();
    });
    if (process.platform === 'darwin') {
      win.webContents.on('before-input-event', (event, input) => {
        if (input.type !== 'keyDown' || !input.meta || input.control || input.alt) return;
        const command = MAC_EDIT_KEYS[input.key.toLowerCase()];
        if (command === undefined) return;
        event.preventDefault();
        command(win.webContents, input.shift);
      });
    }
    // The page is local; never navigate away from it or open other windows.
    win.webContents.on('will-navigate', (event) => event.preventDefault());
    win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    // Windows log-off/shutdown does not emit before-quit; never let unsaved changes block the session end.
    win.on('query-session-end', () => this.dispose());
    win.on('session-end', () => this.dispose());
    void win.loadFile(SETTINGS_HTML);
  }

  /** Closes the window without asking about unsaved changes. Called on app quit. */
  dispose(): void {
    const win = this.win;
    this.win = null;
    this.loaded = null;
    // destroy() skips beforeunload, which would otherwise hold up quit, logout and shutdown.
    if (win !== null && !win.isDestroyed()) win.destroy();
  }

  private isFromWindow(event: IpcMainEvent | IpcMainInvokeEvent): boolean {
    return this.win !== null && !this.win.isDestroyed() && event.sender === this.win.webContents;
  }

  private handleGet(event: IpcMainInvokeEvent): SettingsSnapshot | null {
    if (!this.isFromWindow(event)) return null;
    const read = readSettings(this.options.configPath);
    this.loaded = read.draft;
    return { ...read, ranges: RANGES };
  }

  private handleSave(event: IpcMainInvokeEvent, draft: unknown): SaveResult {
    if (!this.isFromWindow(event)) return { ok: false, reason: '設定ウィンドウ以外からの保存は受け付けません' };
    if (this.loaded === null) return { ok: false, reason: '設定をまだ読み込んでいません' };
    const result = saveConfig(this.options.configPath, draft, this.loaded);
    if (result.ok) {
      this.loaded = result.draft;
      this.options.onSaved();
    }
    return result;
  }

  private handleOpenFile(event: IpcMainEvent): void {
    if (this.isFromWindow(event)) this.options.openConfigFile();
  }
}
