import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

type Listener = (...args: any[]) => void;
interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}
interface FakeDisplay {
  id: number;
  bounds: Rect;
}

const fake = vi.hoisted(() => {
  class Emitter {
    private readonly listeners = new Map<string, Listener[]>();
    on(event: string, listener: Listener): this {
      this.listeners.set(event, [...(this.listeners.get(event) ?? []), listener]);
      return this;
    }
    off(event: string, listener: Listener): this {
      this.listeners.set(event, (this.listeners.get(event) ?? []).filter((l) => l !== listener));
      return this;
    }
    emit(event: string, ...args: unknown[]): void {
      for (const listener of this.listeners.get(event) ?? []) listener(...args);
    }
    listenerCount(event: string): number {
      return this.listeners.get(event)?.length ?? 0;
    }
    removeAllListeners(): void {
      this.listeners.clear();
    }
  }

  class FakeWindow extends Emitter {
    static instances: FakeWindow[] = [];
    /** Overrides loadFile for the next window created. */
    static nextLoad: (() => Promise<void>) | null = null;

    destroyed = false;
    focused = false;
    readonly webContents = { send: vi.fn() };
    readonly loadFile = vi.fn<(file: string) => Promise<void>>();
    readonly setAlwaysOnTop = vi.fn();
    readonly setVisibleOnAllWorkspaces = vi.fn();
    readonly setBounds = vi.fn();
    readonly show = vi.fn();
    readonly showInactive = vi.fn();
    readonly focus = vi.fn(() => {
      for (const win of FakeWindow.instances) win.focused = false;
      this.focused = true;
    });
    readonly destroy = vi.fn(() => {
      this.destroyed = true;
      this.focused = false;
    });
    readonly close = vi.fn(() => {
      this.tryClose();
    });

    constructor(readonly options: Record<string, unknown>) {
      super();
      const load = FakeWindow.nextLoad;
      FakeWindow.nextLoad = null;
      this.loadFile.mockImplementation(load ?? (() => Promise.resolve()));
      FakeWindow.instances.push(this);
    }

    isDestroyed(): boolean {
      return this.destroyed;
    }

    isFocused(): boolean {
      return this.focused;
    }

    /** Emits 'close' as Electron does for Alt+F4 / Cmd+W. Returns whether the window actually closed. */
    tryClose(): boolean {
      let prevented = false;
      this.emit('close', { preventDefault: () => (prevented = true) });
      if (!prevented) this.destroy();
      return !prevented;
    }
  }

  class FakeScreen extends Emitter {
    displays: FakeDisplay[] = [];
    cursorDisplayId = 1;
    getAllDisplays(): FakeDisplay[] {
      return this.displays;
    }
    getCursorScreenPoint(): { x: number; y: number } {
      return { x: 0, y: 0 };
    }
    getDisplayNearestPoint(): FakeDisplay | undefined {
      return this.displays.find((display) => display.id === this.cursorDisplayId) ?? this.displays[0];
    }
  }

  return { FakeWindow, screen: new FakeScreen(), ipcMain: new Emitter(), app: { focus: vi.fn() } };
});

vi.mock('electron', () => ({
  BrowserWindow: fake.FakeWindow,
  screen: fake.screen,
  ipcMain: fake.ipcMain,
  app: fake.app,
}));

import { Overlay, type FlashConfig } from '../src/overlay';

const PRIMARY: FakeDisplay = { id: 1, bounds: { x: 0, y: 0, width: 1920, height: 1080 } };
const SECONDARY: FakeDisplay = { id: 2, bounds: { x: 1920, y: 0, width: 2560, height: 1440 } };
const THIRD: FakeDisplay = { id: 3, bounds: { x: -1280, y: 0, width: 1280, height: 1024 } };
const FLASH: FlashConfig = { flashCount: 3, flashIntervalMs: 400, flashOpacity: 0.85, flashColor: '#FFFFFF', fadeMode: false };
const DISPLAY_EVENTS = ['display-added', 'display-removed', 'display-metrics-changed'];

function windows(): InstanceType<typeof fake.FakeWindow>[] {
  return fake.FakeWindow.instances;
}

function win(index: number): InstanceType<typeof fake.FakeWindow> {
  const found = windows()[index];
  if (found === undefined) throw new Error(`no window #${index}`);
  return found;
}

function sent(target: InstanceType<typeof fake.FakeWindow>, channel: string): unknown[] {
  return target.webContents.send.mock.calls.filter(([name]) => name === channel).map(([, payload]) => payload);
}

let overlay: Overlay;
let run: Promise<void>;

/** Starts a run and lets the flash finish, leaving the overlay in its break. */
async function startBreak(breakSeconds = 10, config: FlashConfig = FLASH): Promise<void> {
  run = overlay.run(config, breakSeconds);
  await vi.advanceTimersByTimeAsync(config.flashCount * Math.max(334, config.flashIntervalMs));
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date(2026, 8, 21, 9, 0, 0));
  fake.FakeWindow.instances = [];
  fake.FakeWindow.nextLoad = null;
  fake.screen.removeAllListeners();
  fake.ipcMain.removeAllListeners();
  fake.screen.displays = [PRIMARY, SECONDARY];
  fake.screen.cursorDisplayId = 1;
  overlay = new Overlay(() => new Date());
});

afterEach(async () => {
  overlay.dispose();
  // A run disposed mid-flash still finishes its current flash period before resolving.
  await vi.advanceTimersByTimeAsync(2000);
  await run;
  vi.useRealTimers();
});

describe('Overlay windows', () => {
  it('creates one window per display with the overlay window settings', async () => {
    run = overlay.run(FLASH, 10);
    await vi.advanceTimersByTimeAsync(0);

    expect(windows()).toHaveLength(2);
    expect(win(1).options).toMatchObject({
      ...SECONDARY.bounds,
      show: false,
      frame: false,
      transparent: true,
      alwaysOnTop: true,
      skipTaskbar: true,
      hasShadow: false,
      resizable: false,
      enableLargerThanScreen: true,
      webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true },
    });
    expect(win(1).setAlwaysOnTop).toHaveBeenCalledWith(true, 'screen-saver');
    expect(win(1).setVisibleOnAllWorkspaces).toHaveBeenCalledWith(true, { visibleOnFullScreen: true });
    expect(win(1).setBounds).toHaveBeenCalledWith(SECONDARY.bounds);
    expect(win(1).loadFile.mock.calls[0]?.[0]).toMatch(/renderer[\\/]overlay\.html$/);
  });

  it('keeps no window and no display listener while idle', async () => {
    expect(windows()).toHaveLength(0);
    for (const event of DISPLAY_EVENTS) expect(fake.screen.listenerCount(event)).toBe(0);

    await startBreak();
    for (const event of DISPLAY_EVENTS) expect(fake.screen.listenerCount(event)).toBe(1);

    await vi.advanceTimersByTimeAsync(10_000);
    await run;
    for (const event of DISPLAY_EVENTS) expect(fake.screen.listenerCount(event)).toBe(0);
  });
});

describe('Overlay flash', () => {
  it('flashes flashCount times with the windows kept up', async () => {
    run = overlay.run(FLASH, 10);
    await vi.advanceTimersByTimeAsync(0);

    expect(overlay.state).toBe('flashing');
    expect(win(0).showInactive).toHaveBeenCalled();
    expect(sent(win(0), 'overlay:flash')).toEqual([
      { color: '#FFFFFF', opacity: 0.85, fade: false, periodMs: 400 },
    ]);

    await vi.advanceTimersByTimeAsync(800);
    expect(sent(win(0), 'overlay:flash')).toHaveLength(3);
    expect(sent(win(1), 'overlay:flash')).toHaveLength(3);
  });

  it('never flashes faster than 3 times a second', async () => {
    run = overlay.run({ ...FLASH, flashIntervalMs: 100 }, 10);
    await vi.advanceTimersByTimeAsync(0);

    expect(sent(win(0), 'overlay:flash')[0]).toMatchObject({ periodMs: 334 });
    await vi.advanceTimersByTimeAsync(333);
    expect(sent(win(0), 'overlay:flash')).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(sent(win(0), 'overlay:flash')).toHaveLength(2);
  });
});

describe('Overlay break', () => {
  it('counts down, focuses the window under the cursor, then closes every window', async () => {
    fake.screen.cursorDisplayId = 2;
    await startBreak(10);

    expect(overlay.state).toBe('breaking');
    expect(sent(win(0), 'overlay:tick')).toEqual([10]);
    expect(win(0).show).toHaveBeenCalled();
    expect(win(1).focus).toHaveBeenCalled();
    expect(win(0).focus).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(1000);
    expect(sent(win(1), 'overlay:tick')).toEqual([10, 9]);

    await vi.advanceTimersByTimeAsync(9000);
    await run;
    expect(overlay.state).toBe('idle');
    expect(windows().every((w) => w.destroyed)).toBe(true);
  });

  it('refuses to close from outside while the overlay is up', async () => {
    await startBreak();

    expect(win(0).tryClose()).toBe(false);
    expect(win(0).destroyed).toBe(false);
    expect(overlay.state).toBe('breaking');
  });

  it('ends the break only on a cancel sent by its own window', async () => {
    await startBreak();

    fake.ipcMain.emit('overlay:cancel', { sender: {} });
    await vi.advanceTimersByTimeAsync(0); // an accepted cancel would have closed everything by now
    expect(overlay.state).toBe('breaking');
    expect(win(0).destroyed).toBe(false);

    fake.ipcMain.emit('overlay:cancel', { sender: win(1).webContents });
    await run;
    expect(overlay.state).toBe('idle');
    expect(windows().every((w) => w.destroyed)).toBe(true);
  });

  it('ignores a cancel while still flashing', async () => {
    run = overlay.run(FLASH, 10);
    await vi.advanceTimersByTimeAsync(0);

    fake.ipcMain.emit('overlay:cancel', { sender: win(0).webContents });
    await vi.advanceTimersByTimeAsync(1200);
    expect(overlay.state).toBe('breaking');
  });

  it('dispose() ends a break and closes every window', async () => {
    await startBreak();

    overlay.dispose();
    await run;

    expect(overlay.state).toBe('idle');
    expect(windows().every((w) => w.destroyed)).toBe(true);
  });

  it('dispose() during the flash skips the break', async () => {
    run = overlay.run(FLASH, 10);
    await vi.advanceTimersByTimeAsync(0);

    overlay.dispose();
    await vi.advanceTimersByTimeAsync(1200);
    await run;

    expect(overlay.state).toBe('idle');
    expect(sent(win(0), 'overlay:tick')).toEqual([]);
  });

  it('releases the overlay when a Windows session ends', async () => {
    await startBreak();

    win(0).emit('query-session-end', {});
    await run;

    expect(overlay.state).toBe('idle');
    expect(windows().every((w) => w.destroyed)).toBe(true);
  });
});

describe('Overlay focus', () => {
  it('takes focus back when it leaves the overlay during a break', async () => {
    await startBreak();
    const focusCalls = win(0).focus.mock.calls.length;

    win(0).focused = false; // e.g. Cmd+Tab to another app
    win(0).emit('blur');
    await vi.advanceTimersByTimeAsync(50);

    expect(win(0).focus.mock.calls.length).toBe(focusCalls + 1);
  });

  it('leaves focus alone when it only moved to another overlay window', async () => {
    await startBreak();
    const focusCalls = win(0).focus.mock.calls.length;

    win(1).focus(); // e.g. a click on the other display
    win(0).emit('blur');
    await vi.advanceTimersByTimeAsync(50);

    expect(win(0).focus.mock.calls.length).toBe(focusCalls);
  });
});

describe('Overlay display changes', () => {
  it('covers a display added during the break, showing the remaining time first', async () => {
    await startBreak(10);
    await vi.advanceTimersByTimeAsync(3000);

    fake.screen.displays = [PRIMARY, SECONDARY, THIRD];
    fake.screen.emit('display-added', {}, THIRD);
    await vi.advanceTimersByTimeAsync(0);

    const added = win(2);
    expect(added.options).toMatchObject(THIRD.bounds);
    expect(sent(added, 'overlay:tick')).toEqual([7]);
    expect(added.show).toHaveBeenCalled();
    expect(added.webContents.send.mock.invocationCallOrder[0]).toBeLessThan(added.show.mock.invocationCallOrder[0] ?? 0);
  });

  it('drops the window of a removed display and moves focus to the rest', async () => {
    await startBreak();
    expect(win(0).focused).toBe(true);

    fake.screen.displays = [SECONDARY];
    fake.screen.cursorDisplayId = 2;
    fake.screen.emit('display-removed', {}, PRIMARY);

    expect(win(0).destroy).toHaveBeenCalled();
    expect(win(1).focused).toBe(true);
    expect(overlay.state).toBe('breaking');
  });

  it('refits a window when its display changes', async () => {
    await startBreak();
    const resized = { id: 1, bounds: { x: 0, y: 0, width: 3840, height: 2160 } };

    fake.screen.emit('display-metrics-changed', {}, resized, ['bounds', 'scaleFactor']);

    expect(win(0).setBounds).toHaveBeenLastCalledWith(resized.bounds);
  });

  it('ignores an aborted load of a window that was dropped meanwhile', async () => {
    await startBreak();
    let rejectLoad: (reason: Error) => void = () => {};
    fake.FakeWindow.nextLoad = () => new Promise<void>((_, reject) => (rejectLoad = reject));

    fake.screen.emit('display-added', {}, THIRD);
    fake.screen.emit('display-removed', {}, THIRD);
    rejectLoad(new Error('ERR_ABORTED (-3) loading overlay.html'));
    await vi.advanceTimersByTimeAsync(0);

    expect(win(2).destroyed).toBe(true);
    expect(win(2).show).not.toHaveBeenCalled();
  });

  it('carries on with the other displays when one is removed while the first windows load', async () => {
    let rejectLoad: (reason: Error) => void = () => {};
    fake.FakeWindow.nextLoad = () => new Promise<void>((_, reject) => (rejectLoad = reject));

    run = overlay.run(FLASH, 10);
    fake.screen.displays = [SECONDARY];
    fake.screen.cursorDisplayId = 2;
    fake.screen.emit('display-removed', {}, PRIMARY);
    rejectLoad(new Error('ERR_ABORTED (-3) loading overlay.html'));
    await vi.advanceTimersByTimeAsync(FLASH.flashCount * FLASH.flashIntervalMs);

    expect(win(0).destroyed).toBe(true);
    expect(sent(win(1), 'overlay:flash')).toHaveLength(FLASH.flashCount);
    expect(overlay.state).toBe('breaking');
    expect(win(1).focused).toBe(true);
  });
});
