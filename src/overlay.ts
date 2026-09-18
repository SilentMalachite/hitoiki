import * as path from 'node:path';
import { app, BrowserWindow, ipcMain, screen, type Display, type IpcMainEvent } from 'electron';
import type { Config } from './config';
import { Channel, type FlashMessage } from './ipc';

export type FlashConfig = Pick<Config, 'flashCount' | 'flashIntervalMs' | 'flashOpacity' | 'flashColor' | 'fadeMode'>;
export type OverlayState = 'idle' | 'flashing' | 'breaking';

/** At most 3 flashes per second. */
const MIN_FLASH_INTERVAL_MS = 334;
const TICK_MS = 1000;
/** Lets focus settle when it merely moves between our own windows. */
const REFOCUS_DELAY_MS = 50;
const OVERLAY_HTML = path.join(__dirname, '..', 'renderer', 'overlay.html');
const PRELOAD_JS = path.join(__dirname, 'preload.js');

/**
 * Owns the per-display overlay windows: idle -> flashing -> breaking -> idle.
 * No window exists while idle.
 */
export class Overlay {
  private windows: BrowserWindow[] = [];
  /** Parallel to `windows`. */
  private displays: Display[] = [];
  private current: OverlayState = 'idle';
  /** Set while we close the windows ourselves; any other close is refused. */
  private closing = false;
  /** Set by dispose() to stop the current run early. */
  private aborted = false;
  private endBreak: (() => void) | null = null;

  constructor(private readonly now: () => Date) {
    ipcMain.on(Channel.Cancel, (event) => this.handleCancel(event));
  }

  get state(): OverlayState {
    return this.current;
  }

  /** Flashes every display, then keeps the windows as a break overlay. Resolves once back to idle. Does nothing unless idle. */
  async run(config: FlashConfig, breakSeconds: number): Promise<void> {
    if (this.current !== 'idle') return;
    this.current = 'flashing';
    this.closing = false;
    this.aborted = false;
    try {
      this.displays = screen.getAllDisplays();
      this.windows = [];
      // createWindow registers each window as soon as it exists, so a failure midway still closes the earlier ones.
      for (const display of this.displays) this.createWindow(display);
      await Promise.all(this.windows.map((win) => win.loadFile(OVERLAY_HTML)));
      await this.blink(config);
      if (this.aborted) return;
      this.current = 'breaking';
      await this.holdBreak(breakSeconds);
    } finally {
      this.closeAll();
      this.current = 'idle';
    }
  }

  /** Ends any flash or break and closes the windows. Called on app quit so that logout/shutdown is never blocked. */
  dispose(): void {
    this.aborted = true;
    this.endBreak?.();
    this.closeAll();
  }

  private async blink(config: FlashConfig): Promise<void> {
    const periodMs = Math.max(MIN_FLASH_INTERVAL_MS, config.flashIntervalMs);
    const message: FlashMessage = {
      color: config.flashColor,
      opacity: config.flashOpacity,
      fade: config.fadeMode,
      periodMs,
    };

    // The windows stay up for the whole flash and the renderer switches the opacity. Never hiding them
    // means no stale flash frame can reappear when the break view is shown.
    this.forEachWindow((win) => win.showInactive());
    for (let i = 0; i < config.flashCount && !this.aborted; i++) {
      this.forEachWindow((win) => win.webContents.send(Channel.Flash, message));
      await delay(periodMs);
    }
  }

  /** Counts down until the break is over or cancelled. */
  private holdBreak(breakSeconds: number): Promise<void> {
    const endsAt = this.now().getTime() + breakSeconds * 1000;
    return new Promise((resolve) => {
      let timer: ReturnType<typeof setInterval> | undefined;
      const finish = (): void => {
        clearInterval(timer);
        this.endBreak = null;
        resolve();
      };
      const tick = (): void => {
        const remaining = Math.max(0, Math.ceil((endsAt - this.now().getTime()) / 1000));
        this.forEachWindow((win) => win.webContents.send(Channel.Tick, remaining));
        if (remaining === 0) finish();
      };

      this.endBreak = finish;
      timer = setInterval(tick, TICK_MS);
      // Switch the renderer to the break view, then activate the windows so they take keys and clicks.
      tick();
      this.forEachWindow((win) => win.show());
      this.focusOverlay();
    });
  }

  /** Focuses the window on the display under the cursor so it receives keys and clicks. */
  private focusOverlay(): void {
    const cursorDisplay = screen.getDisplayNearestPoint(screen.getCursorScreenPoint());
    const index = this.displays.findIndex((display) => display.id === cursorDisplay.id);
    const target = [this.windows[index], ...this.windows].find((win) => win !== undefined && !win.isDestroyed());
    if (process.platform === 'darwin') app.focus({ steal: true });
    target?.focus();
  }

  /** Takes focus back when it leaves our windows during a break (e.g. Cmd+Tab / Alt+Tab). */
  private refocusIfLost(): void {
    if (this.current !== 'breaking') return;
    setTimeout(() => {
      if (this.current !== 'breaking') return;
      if (this.windows.some((win) => !win.isDestroyed() && win.isFocused())) return;
      this.focusOverlay();
    }, REFOCUS_DELAY_MS);
  }

  private handleCancel(event: IpcMainEvent): void {
    if (this.current !== 'breaking') return;
    if (!this.windows.some((win) => !win.isDestroyed() && win.webContents === event.sender)) return;
    this.endBreak?.();
  }

  /** Creates the overlay window for one display and registers it in `windows` right away. */
  private createWindow(display: Display): void {
    const { bounds } = display;
    const win = new BrowserWindow({
      ...bounds,
      show: false,
      frame: false,
      transparent: true,
      alwaysOnTop: true,
      skipTaskbar: true,
      hasShadow: false,
      resizable: false,
      // Otherwise macOS may push the window below the menu bar and leave the top edge uncovered.
      enableLargerThanScreen: true,
      webPreferences: {
        preload: PRELOAD_JS,
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
      },
    });
    this.windows.push(win);
    win.setAlwaysOnTop(true, 'screen-saver');
    win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
    // Match the display exactly instead of setFullScreen(true), which breaks transparency on Windows.
    win.setBounds(bounds);
    // Refuse Alt+F4 / Cmd+W and the like; only closeAll() may close the overlay.
    win.on('close', (event) => {
      if (!this.closing) event.preventDefault();
    });
    win.on('blur', () => this.refocusIfLost());
    // Windows log-off/shutdown does not emit before-quit; release the overlay here so it cannot block the session end.
    win.on('query-session-end', () => this.dispose());
    win.on('session-end', () => this.dispose());
  }

  private closeAll(): void {
    this.closing = true;
    this.forEachWindow((win) => win.close());
    this.windows = [];
    this.displays = [];
  }

  private forEachWindow(action: (win: BrowserWindow) => void): void {
    for (const win of this.windows) {
      if (!win.isDestroyed()) action(win);
    }
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
