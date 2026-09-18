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
  /** Display id -> its overlay window. */
  private readonly windows = new Map<number, BrowserWindow>();
  private current: OverlayState = 'idle';
  /** Set while we close the windows ourselves; any other close is refused. */
  private closing = false;
  /** Set by dispose() to stop the current run early. */
  private aborted = false;
  private endBreak: (() => void) | null = null;
  private breakEndsAt: number | null = null;

  // Display listeners, attached only while the overlay is up so nothing listens while idle.
  private readonly onDisplayAdded = (_event: unknown, display: Display): void => {
    void this.addDisplay(display);
  };
  private readonly onDisplayRemoved = (_event: unknown, display: Display): void => {
    this.removeDisplay(display);
  };
  private readonly onDisplayChanged = (_event: unknown, display: Display): void => {
    const win = this.windows.get(display.id);
    if (win !== undefined && !win.isDestroyed()) win.setBounds(display.bounds);
  };

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
      this.watchDisplays();
      // createWindow registers each window as soon as it exists, so a failure midway still closes the earlier ones.
      for (const display of screen.getAllDisplays()) this.createWindow(display);
      await Promise.all([...this.windows].map(([displayId, win]) => this.load(displayId, win)));
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
    this.breakEndsAt = this.now().getTime() + breakSeconds * 1000;
    return new Promise((resolve) => {
      let timer: ReturnType<typeof setInterval> | undefined;
      const finish = (): void => {
        clearInterval(timer);
        this.endBreak = null;
        this.breakEndsAt = null;
        resolve();
      };
      const tick = (): void => {
        const remaining = this.remainingSeconds();
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

  private remainingSeconds(): number {
    if (this.breakEndsAt === null) return 0;
    return Math.max(0, Math.ceil((this.breakEndsAt - this.now().getTime()) / 1000));
  }

  /** Focuses the window on the display under the cursor so it receives keys and clicks. */
  private focusOverlay(): void {
    const cursorDisplay = screen.getDisplayNearestPoint(screen.getCursorScreenPoint());
    const target = [this.windows.get(cursorDisplay.id), ...this.liveWindows()].find(
      (win) => win !== undefined && !win.isDestroyed(),
    );
    if (process.platform === 'darwin') app.focus({ steal: true });
    target?.focus();
  }

  /** Takes focus back when it leaves our windows during a break (e.g. Cmd+Tab / Alt+Tab). */
  private refocusIfLost(): void {
    if (this.current !== 'breaking') return;
    setTimeout(() => {
      if (this.current !== 'breaking') return;
      if (this.liveWindows().some((win) => win.isFocused())) return;
      this.focusOverlay();
    }, REFOCUS_DELAY_MS);
  }

  private handleCancel(event: IpcMainEvent): void {
    if (this.current !== 'breaking') return;
    if (!this.liveWindows().some((win) => win.webContents === event.sender)) return;
    this.endBreak?.();
  }

  private watchDisplays(): void {
    screen.on('display-added', this.onDisplayAdded);
    screen.on('display-removed', this.onDisplayRemoved);
    screen.on('display-metrics-changed', this.onDisplayChanged);
  }

  private unwatchDisplays(): void {
    screen.off('display-added', this.onDisplayAdded);
    screen.off('display-removed', this.onDisplayRemoved);
    screen.off('display-metrics-changed', this.onDisplayChanged);
  }

  /** A display was connected while the overlay is up: cover it too. */
  private async addDisplay(display: Display): Promise<void> {
    if (this.windows.has(display.id)) return;
    const win = this.createWindow(display);
    if (!(await this.load(display.id, win))) return;
    if (this.current === 'breaking') {
      win.webContents.send(Channel.Tick, this.remainingSeconds());
      win.show();
    } else {
      win.showInactive(); // still flashing: it joins the remaining flash cycles
    }
  }

  /** Loads the overlay page into a display's window. Resolves whether the window is still in use afterwards. */
  private async load(displayId: number, win: BrowserWindow): Promise<boolean> {
    const inUse = (): boolean => this.windows.get(displayId) === win && !win.isDestroyed();
    await win.loadFile(OVERLAY_HTML).catch((err: unknown) => {
      // Loading is aborted when the window was discarded meanwhile (display removed, or overlay closed).
      if (inUse()) throw err;
    });
    return inUse();
  }

  /** A display was disconnected: drop its window, keeping keyboard focus on the overlay. */
  private removeDisplay(display: Display): void {
    const win = this.windows.get(display.id);
    if (win === undefined) return;
    this.windows.delete(display.id);
    if (win.isDestroyed()) return;
    const hadFocus = win.isFocused();
    // destroy() skips the 'close' event, which refuses to close the overlay.
    win.destroy();
    if (hadFocus && this.current === 'breaking') this.focusOverlay();
  }

  /** Creates the overlay window for one display and registers it right away. */
  private createWindow(display: Display): BrowserWindow {
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
    this.windows.set(display.id, win);
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
    return win;
  }

  private closeAll(): void {
    this.unwatchDisplays();
    this.closing = true;
    this.forEachWindow((win) => win.close());
    this.windows.clear();
  }

  private liveWindows(): BrowserWindow[] {
    return [...this.windows.values()].filter((win) => !win.isDestroyed());
  }

  private forEachWindow(action: (win: BrowserWindow) => void): void {
    for (const win of this.liveWindows()) action(win);
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
