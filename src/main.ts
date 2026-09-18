import * as path from 'node:path';
import { app, Menu, nativeImage, powerMonitor, shell, Tray, type MenuItemConstructorOptions, type NativeImage } from 'electron';
import { loadConfig, saveBreakSeconds } from './config';
import { Overlay } from './overlay';
import { Scheduler } from './scheduler';

const PAUSE_MINUTES = 30;
const BREAK_CHOICES_SECONDS = [1, 3, 5, 10, 15, 30, 60].map((minutes) => minutes * 60);
const TRAY_ICON_SIZE = 16;

const now = (): Date => new Date(Date.now());

// Module-level reference so the tray icon is not garbage-collected.
let tray: Tray | null = null;

// Single instance: a second one would double every break and fight over focus.
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  // Resident app: keep running with no windows.
  app.on('window-all-closed', () => {});
  void app.whenReady().then(start);
}

function start(): void {
  app.dock?.hide();
  // No application menu, so Cmd+Q / Cmd+W cannot be used to escape a break. Quit from the tray.
  Menu.setApplicationMenu(null);

  const configPath = path.join(app.getPath('userData'), 'config.json');
  let config = loadConfig(configPath);
  /** Interval fires are counted from here. */
  let anchor = now();
  let pausedUntil: Date | null = null;
  let pauseTimer: ReturnType<typeof setTimeout> | null = null;

  const overlay = new Overlay(now);
  const scheduler = new Scheduler({
    now,
    isBreaking: () => overlay.state !== 'idle',
    onFire: (breakSeconds) => takeBreak(breakSeconds),
  });
  tray = new Tray(createTrayIcon());

  function refreshTray(): void {
    tray?.setToolTip(tooltip());
    tray?.setContextMenu(buildMenu());
  }

  function takeBreak(breakSeconds: number): void {
    if (overlay.state !== 'idle') return;
    const run = overlay.run(config, breakSeconds);
    refreshTray();
    void run.finally(refreshTray);
  }

  /** Restarts interval counting from now. Used on launch, resume from pause and wake from sleep. */
  function restartFromNow(): void {
    anchor = now();
    scheduler.start(config, anchor);
    refreshTray();
  }

  function pause(): void {
    scheduler.stop();
    pausedUntil = new Date(now().getTime() + PAUSE_MINUTES * 60_000);
    armPauseEnd();
    refreshTray();
  }

  function armPauseEnd(): void {
    if (pauseTimer !== null) clearTimeout(pauseTimer);
    if (pausedUntil === null) return;
    pauseTimer = setTimeout(resume, Math.max(0, pausedUntil.getTime() - now().getTime()));
  }

  function resume(): void {
    if (pauseTimer !== null) clearTimeout(pauseTimer);
    pauseTimer = null;
    pausedUntil = null;
    restartFromNow();
  }

  /** Re-reads the config. Keeps the anchor so that changing a setting does not push the next break back. */
  function reload(): void {
    config = loadConfig(configPath);
    if (pausedUntil === null) scheduler.start(config, anchor);
    refreshTray();
  }

  function chooseBreak(seconds: number): void {
    if (saveBreakSeconds(configPath, seconds)) {
      reload();
    } else {
      refreshTray(); // puts the radio check back on the current value
    }
  }

  function openConfig(): void {
    void shell.openPath(configPath).then((error) => {
      if (error) console.error(`[tray] cannot open ${configPath}: ${error}`);
    });
  }

  function tooltip(): string {
    if (overlay.state !== 'idle') return 'Hitoiki: 休憩中';
    if (pausedUntil !== null) return `Hitoiki: 停止中（${formatTime(pausedUntil)} に再開）`;
    const next = scheduler.next;
    return next === null ? 'Hitoiki: 予定なし' : `Hitoiki: 次回 ${formatTime(next)}`;
  }

  function buildMenu(): Menu {
    const choices = BREAK_CHOICES_SECONDS.includes(config.breakSeconds)
      ? BREAK_CHOICES_SECONDS
      : [...BREAK_CHOICES_SECONDS, config.breakSeconds].sort((a, b) => a - b);
    const breakItems: MenuItemConstructorOptions[] = choices.map((seconds) => ({
      label: formatDuration(seconds),
      type: 'radio',
      checked: seconds === config.breakSeconds,
      click: () => chooseBreak(seconds),
    }));

    const template: MenuItemConstructorOptions[] = [
      { label: '今すぐ休憩', enabled: overlay.state === 'idle', click: () => takeBreak(config.breakSeconds) },
      { label: '休憩時間', submenu: breakItems },
      pausedUntil === null
        ? { label: `${PAUSE_MINUTES} 分間停止`, click: pause }
        : { label: `再開（${formatTime(pausedUntil)} に自動再開）`, click: resume },
      { type: 'separator' },
      { label: '設定ファイルを開く', click: openConfig },
      { label: '設定を再読込', click: reload },
      { type: 'separator' },
      { label: '終了', click: () => app.quit() },
    ];
    return Menu.buildFromTemplate(template);
  }

  // Timers can be delayed across sleep, so re-arm everything on wake.
  powerMonitor.on('resume', () => {
    if (pausedUntil === null) {
      restartFromNow();
    } else {
      armPauseEnd();
    }
  });

  // Overlay windows refuse to close during a break; release them so quit, logout and shutdown go through.
  app.on('before-quit', () => overlay.dispose());

  restartFromNow();
}

/** "HH:mm", prefixed with "M/D " when not today. */
function formatTime(date: Date): string {
  const hhmm = `${pad(date.getHours())}:${pad(date.getMinutes())}`;
  return date.toDateString() === now().toDateString() ? hhmm : `${date.getMonth() + 1}/${date.getDate()} ${hhmm}`;
}

function formatDuration(seconds: number): string {
  const minutes = Math.floor(seconds / 60);
  const rest = seconds % 60;
  if (minutes === 0) return `${rest} 秒`;
  return rest === 0 ? `${minutes} 分` : `${minutes} 分 ${rest} 秒`;
}

function pad(value: number): string {
  return String(value).padStart(2, '0');
}

/** A single-color ring drawn in code. On macOS it is a template image that follows the menu bar color. */
function createTrayIcon(): NativeImage {
  const image = nativeImage.createEmpty();
  for (const scaleFactor of [1, 2]) {
    const size = TRAY_ICON_SIZE * scaleFactor;
    image.addRepresentation({ scaleFactor, width: size, height: size, buffer: drawRing(size) });
  }
  if (process.platform === 'darwin') image.setTemplateImage(true);
  return image;
}

/** Premultiplied BGRA bitmap of an anti-aliased ring. */
function drawRing(size: number): Buffer {
  const [blue, green, red] = process.platform === 'darwin' ? [0x00, 0x00, 0x00] : [0xe7, 0x8c, 0x3c];
  const buffer = Buffer.alloc(size * size * 4);
  const center = size / 2;
  const radius = size * 0.34;
  const halfWidth = size * 0.09;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const distance = Math.hypot(x + 0.5 - center, y + 0.5 - center);
      const coverage = Math.min(1, Math.max(0, halfWidth + 0.5 - Math.abs(distance - radius)));
      const offset = (y * size + x) * 4;
      buffer[offset] = Math.round(blue * coverage);
      buffer[offset + 1] = Math.round(green * coverage);
      buffer[offset + 2] = Math.round(red * coverage);
      buffer[offset + 3] = Math.round(255 * coverage);
    }
  }
  return buffer;
}
