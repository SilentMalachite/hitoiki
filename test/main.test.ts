import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

type Listener = (...args: any[]) => void;
interface MenuItem {
  label?: string;
  type?: string;
  checked?: boolean;
  enabled?: boolean;
  submenu?: MenuItem[];
  click?: () => void;
}

const fake = vi.hoisted(() => {
  class Emitter {
    private readonly listeners = new Map<string, Listener[]>();
    on(event: string, listener: Listener): this {
      this.listeners.set(event, [...(this.listeners.get(event) ?? []), listener]);
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

  const appEvents = new Emitter();
  const app = {
    userData: '',
    requestSingleInstanceLock: vi.fn(() => true),
    quit: vi.fn(),
    on: vi.fn((event: string, listener: Listener) => appEvents.on(event, listener)),
    whenReady: vi.fn(() => Promise.resolve()),
    dock: { hide: vi.fn() },
    getPath: vi.fn(() => app.userData),
    events: appEvents,
  };

  class FakeTray {
    static last: FakeTray | undefined;
    readonly setToolTip = vi.fn();
    readonly setContextMenu = vi.fn();
    constructor() {
      FakeTray.last = this;
    }
  }

  class FakeOverlay {
    static last: FakeOverlay | undefined;
    state: 'idle' | 'flashing' | 'breaking' = 'idle';
    private finish: (() => void) | null = null;
    readonly run = vi.fn(
      (_config: unknown, _breakSeconds: number) =>
        new Promise<void>((resolve) => {
          this.state = 'flashing';
          this.finish = () => {
            this.state = 'idle';
            resolve();
          };
        }),
    );
    readonly dispose = vi.fn();
    constructor() {
      FakeOverlay.last = this;
    }
    endBreak(): void {
      this.finish?.();
    }
  }

  return {
    app,
    FakeTray,
    FakeOverlay,
    powerMonitor: new Emitter(),
    Menu: {
      setApplicationMenu: vi.fn(),
      buildFromTemplate: vi.fn((template: MenuItem[]) => ({ template })),
    },
    nativeImage: { createEmpty: vi.fn(() => ({ addRepresentation: vi.fn(), setTemplateImage: vi.fn() })) },
    shell: { openPath: vi.fn(() => Promise.resolve('')) },
  };
});

vi.mock('electron', () => ({
  app: fake.app,
  Menu: fake.Menu,
  Tray: fake.FakeTray,
  nativeImage: fake.nativeImage,
  powerMonitor: fake.powerMonitor,
  shell: fake.shell,
}));
vi.mock('../src/overlay', () => ({ Overlay: fake.FakeOverlay }));

/** Local time on 2026-09-21. */
function at(hours: number, minutes: number): Date {
  return new Date(2026, 8, 21, hours, minutes, 0);
}

/** Imports main.ts afresh (it starts the app at import time) and lets whenReady() resolve. */
async function launch(): Promise<void> {
  vi.resetModules();
  await import('../src/main');
  await vi.advanceTimersByTimeAsync(0);
}

function tray(): InstanceType<typeof fake.FakeTray> {
  const current = fake.FakeTray.last;
  if (current === undefined) throw new Error('no tray');
  return current;
}

function overlay(): InstanceType<typeof fake.FakeOverlay> {
  const current = fake.FakeOverlay.last;
  if (current === undefined) throw new Error('no overlay');
  return current;
}

function tooltip(): unknown {
  return tray().setToolTip.mock.lastCall?.[0];
}

function menu(): MenuItem[] {
  const built = tray().setContextMenu.mock.lastCall?.[0] as { template: MenuItem[] } | undefined;
  if (built === undefined) throw new Error('no menu');
  return built.template;
}

function item(label: string, items: MenuItem[] = menu()): MenuItem {
  const found = items.find((entry) => entry.label?.startsWith(label));
  if (found === undefined) throw new Error(`no menu item "${label}"`);
  return found;
}

function breakItems(): MenuItem[] {
  return item('休憩時間').submenu ?? [];
}

let userData: string;
let configPath: string;

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(at(9, 0));
  vi.clearAllMocks();
  fake.app.requestSingleInstanceLock.mockReturnValue(true);
  fake.app.events.removeAllListeners();
  fake.powerMonitor.removeAllListeners();
  fake.FakeTray.last = undefined;
  fake.FakeOverlay.last = undefined;
  userData = fs.mkdtempSync(path.join(os.tmpdir(), 'hitoiki-main-'));
  configPath = path.join(userData, 'config.json');
  fake.app.userData = userData;
});

afterEach(() => {
  vi.useRealTimers();
  fs.rmSync(userData, { recursive: true, force: true });
});

describe('main startup', () => {
  it('quits at once when another instance is already running', async () => {
    fake.app.requestSingleInstanceLock.mockReturnValue(false);

    await launch();

    expect(fake.app.quit).toHaveBeenCalled();
    expect(fake.app.whenReady).not.toHaveBeenCalled();
    expect(fake.FakeTray.last).toBeUndefined();
  });

  it('starts as a tray-only app with no application menu', async () => {
    await launch();

    expect(fake.app.dock.hide).toHaveBeenCalled();
    expect(fake.Menu.setApplicationMenu).toHaveBeenCalledWith(null);
    expect(fake.app.events.listenerCount('window-all-closed')).toBe(1);
    expect(fs.existsSync(configPath)).toBe(true);
    expect(tooltip()).toBe('Hitoiki: 次回 09:50');
  });
});

describe('main tray menu', () => {
  it('lists the SPEC menu items in order', async () => {
    await launch();

    expect(menu().map((entry) => entry.label ?? entry.type)).toEqual([
      '今すぐ休憩',
      '休憩時間',
      '30 分間停止',
      'separator',
      '設定ファイルを開く',
      '設定を再読込',
      'separator',
      '終了',
    ]);
    expect(breakItems().map((entry) => entry.label)).toEqual(['1 分', '3 分', '5 分', '10 分', '15 分', '30 分', '60 分']);
    expect(breakItems().filter((entry) => entry.checked).map((entry) => entry.label)).toEqual(['3 分']);
  });

  it('saves the chosen break length and keeps the schedule', async () => {
    await launch();

    item('5 分', breakItems()).click?.();

    expect(JSON.parse(fs.readFileSync(configPath, 'utf8')).breakSeconds).toBe(300);
    expect(breakItems().filter((entry) => entry.checked).map((entry) => entry.label)).toEqual(['5 分']);
    expect(tooltip()).toBe('Hitoiki: 次回 09:50');
  });

  it('shows a value missing from the list as an extra checked item', async () => {
    fs.writeFileSync(configPath, JSON.stringify({ breakSeconds: 240 }));

    await launch();

    expect(breakItems().filter((entry) => entry.checked).map((entry) => entry.label)).toEqual(['4 分']);
  });

  it('shows a broken config file in the tray until a reload succeeds', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    fs.writeFileSync(configPath, '{ "breakSeconds": 600,');

    await launch();

    expect(menu().slice(0, 3).map((entry) => entry.label ?? entry.type)).toEqual([
      '⚠ 設定ファイルにエラー',
      'separator',
      '今すぐ休憩',
    ]);
    expect(tooltip()).toMatch(/^Hitoiki: 設定ファイルにエラー（JSON として不正です: .+）$/);

    // Choosing a break length cannot save into the broken file: the check stays on the value in use.
    item('5 分', breakItems()).click?.();
    expect(fs.readFileSync(configPath, 'utf8')).toBe('{ "breakSeconds": 600,');
    expect(breakItems().filter((entry) => entry.checked).map((entry) => entry.label)).toEqual(['3 分']);
    expect(tooltip()).toMatch(/^Hitoiki: 設定ファイルにエラー（休憩時間を保存できません: .+）$/);

    item('⚠ 設定ファイルにエラー').click?.();
    expect(fake.shell.openPath).toHaveBeenCalledWith(configPath);

    fs.writeFileSync(configPath, JSON.stringify({ breakSeconds: 600 }));
    item('設定を再読込').click?.();

    expect(menu()[0]?.label).toBe('今すぐ休憩');
    expect(breakItems().filter((entry) => entry.checked).map((entry) => entry.label)).toEqual(['10 分']);
    expect(tooltip()).toBe('Hitoiki: 次回 09:50');
    errorSpy.mockRestore();
  });

  it('pauses for 30 minutes and then resumes on its own, counting from the resume', async () => {
    await launch();

    item('30 分間停止').click?.();
    expect(tooltip()).toBe('Hitoiki: 停止中（09:30 に再開）');
    expect(item('再開').label).toBe('再開（09:30 に自動再開）');

    await vi.advanceTimersByTimeAsync(30 * 60_000);
    expect(tooltip()).toBe('Hitoiki: 次回 10:20');
    expect(item('30 分間停止')).toBeDefined();
  });

  it('opens the config file', async () => {
    await launch();

    item('設定ファイルを開く').click?.();

    expect(fake.shell.openPath).toHaveBeenCalledWith(configPath);
  });

  it('quits from the tray', async () => {
    await launch();

    item('終了').click?.();

    expect(fake.app.quit).toHaveBeenCalled();
  });
});

describe('main breaks', () => {
  it('starts a break on schedule with the configured length', async () => {
    await launch();

    await vi.advanceTimersByTimeAsync(50 * 60_000);

    expect(overlay().run).toHaveBeenCalledOnce();
    expect(overlay().run.mock.lastCall?.[1]).toBe(180);
  });

  it('takes a break now, then drops fires that fell due during it', async () => {
    await launch();
    await vi.advanceTimersByTimeAsync(45 * 60_000); // 09:45

    item('今すぐ休憩').click?.();
    expect(tooltip()).toBe('Hitoiki: 休憩中');
    expect(item('今すぐ休憩').enabled).toBe(false);

    // The main process stalls: the clock reaches 09:55 but the 09:50 timer callback has not run yet.
    vi.setSystemTime(at(9, 55));
    overlay().endBreak();
    await vi.advanceTimersByTimeAsync(10 * 60_000); // the delayed 09:50 callback would run now

    expect(overlay().run).toHaveBeenCalledOnce();
    expect(tooltip()).toBe('Hitoiki: 次回 10:40');
  });
});

describe('main lifecycle', () => {
  it('restarts counting from the wake time after sleep', async () => {
    await launch();
    vi.setSystemTime(at(9, 20));

    fake.powerMonitor.emit('resume');

    expect(tooltip()).toBe('Hitoiki: 次回 10:10');
  });

  it('keeps a pause across sleep and re-arms its end', async () => {
    await launch();
    item('30 分間停止').click?.();
    vi.setSystemTime(at(9, 40)); // slept past the pause end; the pause timer did not run

    fake.powerMonitor.emit('resume');
    await vi.advanceTimersByTimeAsync(0);

    expect(tooltip()).toBe('Hitoiki: 次回 10:30');
  });

  it('releases the overlay before quitting', async () => {
    await launch();

    fake.app.events.emit('before-quit');

    expect(overlay().dispose).toHaveBeenCalled();
  });
});
