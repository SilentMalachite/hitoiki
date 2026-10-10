import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

type Listener = (...args: any[]) => void;

const fake = vi.hoisted(() => {
  class Emitter {
    private readonly listeners = new Map<string, Listener[]>();
    on(event: string, listener: Listener): this {
      this.listeners.set(event, [...(this.listeners.get(event) ?? []), listener]);
      return this;
    }
    once(event: string, listener: Listener): this {
      const wrapper: Listener = (...args) => {
        this.listeners.set(event, (this.listeners.get(event) ?? []).filter((l) => l !== wrapper));
        listener(...args);
      };
      return this.on(event, wrapper);
    }
    emit(event: string, ...args: unknown[]): void {
      for (const listener of this.listeners.get(event) ?? []) listener(...args);
    }
  }

  class FakeWebContents extends Emitter {
    readonly setWindowOpenHandler = vi.fn();
    readonly selectAll = vi.fn();
    readonly copy = vi.fn();
    readonly paste = vi.fn();
    readonly cut = vi.fn();
    readonly undo = vi.fn();
    readonly redo = vi.fn();
  }

  class FakeWindow extends Emitter {
    static instances: FakeWindow[] = [];
    destroyed = false;
    minimized = false;
    readonly webContents = new FakeWebContents();
    readonly loadFile = vi.fn(() => Promise.resolve());
    readonly show = vi.fn();
    readonly focus = vi.fn();
    readonly restore = vi.fn();
    readonly isMinimized = vi.fn(() => this.minimized);
    readonly isDestroyed = vi.fn(() => this.destroyed);
    readonly destroy = vi.fn(() => {
      this.destroyed = true;
      this.emit('closed');
    });
    constructor(readonly options: Record<string, any>) {
      super();
      FakeWindow.instances.push(this);
    }
  }

  const handlers = new Map<string, Listener>();
  const listeners = new Map<string, Listener>();

  return {
    FakeWindow,
    handlers,
    listeners,
    app: { focus: vi.fn() },
    dialog: { showMessageBoxSync: vi.fn(() => 1) },
    ipcMain: {
      handle: vi.fn((channel: string, handler: Listener) => handlers.set(channel, handler)),
      on: vi.fn((channel: string, listener: Listener) => listeners.set(channel, listener)),
    },
  };
});

vi.mock('electron', () => ({
  app: fake.app,
  BrowserWindow: fake.FakeWindow,
  dialog: fake.dialog,
  ipcMain: fake.ipcMain,
}));

import { SettingsWindow } from '../src/settings';

let dir: string;
let configPath: string;
let errorSpy: ReturnType<typeof vi.spyOn>;
const onSaved = vi.fn();
const openConfigFile = vi.fn();

beforeEach(() => {
  vi.clearAllMocks();
  fake.FakeWindow.instances = [];
  fake.handlers.clear();
  fake.listeners.clear();
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hitoiki-settings-'));
  configPath = path.join(dir, 'config.json');
  errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  errorSpy.mockRestore();
  fs.rmSync(dir, { recursive: true, force: true });
});

function create(): SettingsWindow {
  return new SettingsWindow({ configPath, onSaved, openConfigFile });
}

function windows(): InstanceType<typeof fake.FakeWindow>[] {
  return fake.FakeWindow.instances;
}

function win(): InstanceType<typeof fake.FakeWindow> {
  const last = windows().at(-1);
  if (last === undefined) throw new Error('no window');
  return last;
}

function invoke(channel: string, sender: unknown, ...args: unknown[]): unknown {
  const handler = fake.handlers.get(channel);
  if (handler === undefined) throw new Error(`no handler for ${channel}`);
  return handler({ sender }, ...args);
}

const draft = {
  intervalMinutes: 25,
  clockTimes: [{ time: '12:00', breakSeconds: null }],
  flashCount: 3,
  flashIntervalMs: 400,
  flashOpacity: 0.85,
  flashColor: '#FFFFFF',
  fadeMode: false,
  breakSeconds: 180,
};

describe('SettingsWindow', () => {
  it('creates no window until opened', () => {
    create();
    expect(windows()).toHaveLength(0);
  });

  it('opens one sandboxed window and shows it once ready', () => {
    create().open();

    expect(windows()).toHaveLength(1);
    expect(win().options).toMatchObject({
      show: false,
      webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true },
    });
    expect(win().options.webPreferences.preload).toMatch(/settings-preload\.js$/);
    expect(win().loadFile).toHaveBeenCalledWith(expect.stringMatching(/renderer[\\/]settings\.html$/));
    expect(win().show).not.toHaveBeenCalled();

    win().emit('ready-to-show');
    expect(win().show).toHaveBeenCalledTimes(1);
  });

  it('brings the open window to the front instead of opening another', () => {
    const settings = create();
    settings.open();
    win().minimized = true;

    settings.open();

    expect(windows()).toHaveLength(1);
    expect(win().restore).toHaveBeenCalled();
    expect(win().show).toHaveBeenCalled();
    expect(win().focus).toHaveBeenCalled();
  });

  it('opens a new window after the previous one closed', () => {
    const settings = create();
    settings.open();
    win().destroyed = true;
    win().emit('closed');

    settings.open();

    expect(windows()).toHaveLength(2);
  });

  it('blocks navigation and new windows', () => {
    create().open();
    const event = { preventDefault: vi.fn() };

    win().webContents.emit('will-navigate', event);

    expect(event.preventDefault).toHaveBeenCalled();
    const handler = win().webContents.setWindowOpenHandler.mock.lastCall?.[0] as () => unknown;
    expect(handler()).toEqual({ action: 'deny' });
  });
});

describe('SettingsWindow edit shortcuts', () => {
  const platform = process.platform;
  afterEach(() => {
    Object.defineProperty(process, 'platform', { value: platform });
  });

  function press(key: string, modifiers: { meta?: boolean; shift?: boolean; control?: boolean } = {}) {
    const event = { preventDefault: vi.fn() };
    win().webContents.emit('before-input-event', event, { type: 'keyDown', key, meta: false, shift: false, control: false, alt: false, ...modifiers });
    return event;
  }

  it('handles Cmd+A/C/V/X/Z and Cmd+Shift+Z on macOS, where the app has no Edit menu', () => {
    Object.defineProperty(process, 'platform', { value: 'darwin' });
    create().open();
    const contents = win().webContents;

    for (const key of ['a', 'c', 'v', 'x', 'z']) expect(press(key, { meta: true }).preventDefault).toHaveBeenCalled();
    press('Z', { meta: true, shift: true });

    expect(contents.selectAll).toHaveBeenCalledOnce();
    expect(contents.copy).toHaveBeenCalledOnce();
    expect(contents.paste).toHaveBeenCalledOnce();
    expect(contents.cut).toHaveBeenCalledOnce();
    expect(contents.undo).toHaveBeenCalledOnce();
    expect(contents.redo).toHaveBeenCalledOnce();
  });

  it('leaves other keys alone', () => {
    Object.defineProperty(process, 'platform', { value: 'darwin' });
    create().open();

    expect(press('c').preventDefault).not.toHaveBeenCalled();
    expect(press('q', { meta: true }).preventDefault).not.toHaveBeenCalled();
    expect(press('c', { meta: true, control: true }).preventDefault).not.toHaveBeenCalled();
    expect(win().webContents.copy).not.toHaveBeenCalled();
  });

  it('adds no key handling on other platforms, where Ctrl+C/V work without a menu', () => {
    Object.defineProperty(process, 'platform', { value: 'win32' });
    create().open();

    expect(press('c', { meta: true }).preventDefault).not.toHaveBeenCalled();
    expect(win().webContents.copy).not.toHaveBeenCalled();
  });
});

describe('SettingsWindow unsaved changes', () => {
  it('closes when the user chooses to discard the changes', () => {
    create().open();
    fake.dialog.showMessageBoxSync.mockReturnValue(0);
    const event = { preventDefault: vi.fn() };

    win().webContents.emit('will-prevent-unload', event);

    expect(fake.dialog.showMessageBoxSync).toHaveBeenCalledWith(win(), expect.objectContaining({ message: '変更を保存していません' }));
    expect(event.preventDefault).toHaveBeenCalled();
  });

  it('stays open when the user cancels', () => {
    create().open();
    fake.dialog.showMessageBoxSync.mockReturnValue(1);
    const event = { preventDefault: vi.fn() };

    win().webContents.emit('will-prevent-unload', event);

    expect(event.preventDefault).not.toHaveBeenCalled();
  });

  it('destroys the window without asking on dispose, logoff and shutdown', () => {
    const settings = create();
    settings.open();
    settings.dispose();
    expect(win().destroy).toHaveBeenCalledTimes(1);

    settings.open();
    win().emit('query-session-end');
    expect(win().destroy).toHaveBeenCalledTimes(1);

    settings.open();
    win().emit('session-end');
    expect(win().destroy).toHaveBeenCalledTimes(1);
    expect(fake.dialog.showMessageBoxSync).not.toHaveBeenCalled();
  });

  it('does nothing on dispose when no window is open', () => {
    expect(() => create().dispose()).not.toThrow();
  });
});

describe('SettingsWindow IPC', () => {
  it('sends the settings and ranges to its own window only', () => {
    fs.writeFileSync(configPath, JSON.stringify({ intervalMinutes: 25, clockTimes: ['12:00'] }));
    create().open();

    const snapshot = invoke('settings:get', win().webContents) as { draft: typeof draft; error: unknown; ranges: unknown };

    expect(snapshot.draft).toEqual(draft);
    expect(snapshot.error).toBeNull();
    expect(snapshot.ranges).toMatchObject({ breakSeconds: [10, 3600], intervalMinutes: [1, 480] });
    expect(invoke('settings:get', { other: true })).toBeNull();
  });

  it('reports a broken file to the window', () => {
    fs.writeFileSync(configPath, '{ "breakSeconds": 180,');
    create().open();

    const snapshot = invoke('settings:get', win().webContents) as { error: string };

    expect(snapshot.error).toMatch(/^JSON として不正です: /);
  });

  it('saves a valid draft and then calls onSaved', () => {
    fs.writeFileSync(configPath, '{}');
    create().open();

    invoke('settings:get', win().webContents);
    expect(invoke('settings:save', win().webContents, draft)).toEqual({ ok: true, draft });

    expect(JSON.parse(fs.readFileSync(configPath, 'utf8'))).toMatchObject({ intervalMinutes: 25, clockTimes: ['12:00'] });
    expect(onSaved).toHaveBeenCalledTimes(1);
  });

  it('returns the reason and does not call onSaved when the save fails', () => {
    fs.writeFileSync(configPath, '{}');
    create().open();

    invoke('settings:get', win().webContents);
    const result = invoke('settings:save', win().webContents, { ...draft, flashIntervalMs: 100 });

    expect(result).toEqual({ ok: false, reason: expect.stringMatching(/^設定を保存できません: /) });
    expect(fs.readFileSync(configPath, 'utf8')).toBe('{}');
    expect(onSaved).not.toHaveBeenCalled();
  });

  it('refuses a save before the window loaded the settings', () => {
    fs.writeFileSync(configPath, '{}');
    create().open();

    expect(invoke('settings:save', win().webContents, draft)).toMatchObject({ ok: false });
    expect(fs.readFileSync(configPath, 'utf8')).toBe('{}');
  });

  it('keeps a value the tray changed after the window loaded the file', () => {
    fs.writeFileSync(configPath, JSON.stringify({ breakSeconds: 180 }));
    create().open();
    const loaded = (invoke('settings:get', win().webContents) as { draft: typeof draft }).draft;
    fs.writeFileSync(configPath, JSON.stringify({ breakSeconds: 300 }));

    const result = invoke('settings:save', win().webContents, { ...loaded, flashCount: 5 });

    expect(JSON.parse(fs.readFileSync(configPath, 'utf8'))).toEqual({ breakSeconds: 300, flashCount: 5 });
    expect(result).toMatchObject({ ok: true, draft: { breakSeconds: 300, flashCount: 5 } });
  });

  it('compares the next save with what the previous save wrote', () => {
    fs.writeFileSync(configPath, '{}');
    create().open();
    invoke('settings:get', win().webContents);
    invoke('settings:save', win().webContents, { ...draft, flashCount: 5 });
    fs.writeFileSync(configPath, JSON.stringify({ ...JSON.parse(fs.readFileSync(configPath, 'utf8')), breakSeconds: 300 }));

    invoke('settings:save', win().webContents, { ...draft, flashCount: 6 });

    expect(JSON.parse(fs.readFileSync(configPath, 'utf8'))).toMatchObject({ flashCount: 6, breakSeconds: 300 });
  });

  it('refuses a save from any other sender', () => {
    fs.writeFileSync(configPath, '{}');
    create().open();

    expect(invoke('settings:save', { other: true }, draft)).toMatchObject({ ok: false });
    expect(fs.readFileSync(configPath, 'utf8')).toBe('{}');
    expect(onSaved).not.toHaveBeenCalled();
  });

  it('refuses everything once the window is gone', () => {
    const settings = create();
    settings.open();
    const contents = win().webContents;
    settings.dispose();

    expect(invoke('settings:get', contents)).toBeNull();
    expect(invoke('settings:save', contents, draft)).toMatchObject({ ok: false });
  });

  it('opens the config file for its own window only', () => {
    create().open();
    const listener = fake.listeners.get('settings:open-file');

    listener?.({ sender: { other: true } });
    expect(openConfigFile).not.toHaveBeenCalled();

    listener?.({ sender: win().webContents });
    expect(openConfigFile).toHaveBeenCalledTimes(1);
  });
});
