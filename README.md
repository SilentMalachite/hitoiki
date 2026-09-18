# Hitoiki

[![CI](https://github.com/SilentMalachite/hitoiki/actions/workflows/ci.yml/badge.svg)](https://github.com/SilentMalachite/hitoiki/actions/workflows/ci.yml)
[![TypeScript](https://img.shields.io/github/package-json/dependency-version/SilentMalachite/hitoiki/dev/typescript?logo=typescript&logoColor=white&label=TypeScript&color=3178C6)](https://www.typescriptlang.org/)

English | [日本語](README.ja.md)

Hitoiki is a small tray app for macOS and Windows that interrupts hyperfocus. At a set interval or clock
time it flashes every screen a few times, then covers them with a dark overlay and a countdown until the
break is over.

*Hitoiki* (一息) is Japanese for "a breather".

## Features

- **Two schedules, usable together**: every N minutes (default 50), and fixed clock times such as `15:00`.
  Breaks that fall in the same minute are merged into one.
- **Flash on every display at once.** Never more than 3 flashes per second (period of 334 ms or longer).
- **Break overlay** on every display: translucent black with a large countdown. It takes keyboard focus,
  and takes it back if you switch to another app.
- **Emergency exit**: hold Esc for 3 seconds (a ring shows the progress). A short press does nothing.
- **Follows display changes**: displays connected, disconnected or rearranged during a flash or break are
  covered, dropped or refitted.
- **Tray only**: no main window and, on macOS, no Dock icon. The tray tooltip shows the next break time.
- **Light and private**: one JSON settings file, no network access, no polling. While waiting there are no
  overlay windows, so no renderer process runs.

## Install

Hitoiki is not signed with an Apple Developer ID or a Windows code signing certificate, so your OS asks you
to confirm the first launch of a downloaded copy.

### Build it yourself

Requires Node.js 22.

```bash
git clone https://github.com/SilentMalachite/hitoiki.git
cd hitoiki
npm ci
npm run dist
```

Run `npm run dist` on the OS you are packaging for. The output goes to `release/`: a `.dmg` and a `.zip` on
macOS, an installer `.exe` (NSIS) on Windows.

An app you build on your own Mac is not marked as downloaded, so it opens without the approval steps below.

### First launch on macOS

The macOS build is ad-hoc signed only. The first time you open a downloaded copy:

1. Open `hitoiki.app`. macOS says it cannot verify the app. Click **Done**.
2. Open **System Settings → Privacy & Security**. In the **Security** section, next to the message that
   hitoiki was blocked, click **Open Anyway**.
3. Enter your password, then confirm with **Open Anyway**.

After that it opens normally. On macOS 14 or earlier you can instead Control-click the app in Finder and
choose **Open**.

### First launch on Windows

SmartScreen may say "Windows protected your PC". Click **More info**, then **Run anyway**.

## Usage

Hitoiki lives in the menu bar (macOS) or the notification area (Windows). The menu is in Japanese:

| Menu item | Meaning |
|---|---|
| 今すぐ休憩 | Take a break now |
| 休憩時間 ▸ 1 / 3 / 5 / 10 / 15 / 30 / 60 分 | Break length. Saved as `breakSeconds` in the settings file |
| 30 分間停止 / 再開 | Pause for 30 minutes / resume now |
| 設定ファイルを開く | Open the settings file |
| 設定を再読込 | Reload the settings file |
| 終了 | Quit |

During a break, hold **Esc** for 3 seconds to end it early.

Only one copy of Hitoiki runs at a time. It does not start at login by itself. To start it automatically,
add it to your login items (macOS: **System Settings → General → Login Items**; Windows: put a shortcut in
the `shell:startup` folder).

## Settings

Choose **設定ファイルを開く** (Open the settings file), edit it, then choose **設定を再読込** (Reload).
The file is created with the defaults on the first launch:

- macOS: `~/Library/Application Support/hitoiki/config.json`
- Windows: `%APPDATA%\hitoiki\config.json`

```json
{
  "intervalMinutes": 50,
  "clockTimes": ["15:00", "17:30", { "time": "12:00", "breakSeconds": 3600 }],
  "flashCount": 3,
  "flashIntervalMs": 400,
  "flashOpacity": 0.85,
  "flashColor": "#FFFFFF",
  "fadeMode": false,
  "breakSeconds": 180
}
```

| Key | Default | Range | Description |
|---|---|---|---|
| `intervalMinutes` | `50` | `0` or 1–480 | Break every N minutes, counted from launch, resume or wake from sleep. `0` turns it off. |
| `clockTimes` | `[]` | | Break at these local times. Each entry is `"HH:mm"`, or `{ "time": "HH:mm", "breakSeconds": n }` to give that time its own break length. |
| `flashCount` | `3` | 1–10 | Number of flashes before the break. |
| `flashIntervalMs` | `400` | 334–2000 | Flash period in milliseconds. The screen is lit for the first half. |
| `flashOpacity` | `0.85` | 0.1–1.0 | Peak opacity of the flash. |
| `flashColor` | `"#FFFFFF"` | | Flash color (a CSS color). |
| `fadeMode` | `false` | | `true` fades in and out; `false` switches instantly. |
| `breakSeconds` | `180` | 10–3600 | Default break length in seconds. |

- Numbers out of range are clamped to the nearest limit. Values of the wrong type fall back to the default,
  and clock times that are not `"HH:mm"` are skipped.
- If the file is not valid JSON, Hitoiki runs on the defaults and leaves the file alone. Problems are
  reported on standard error.
- When an interval break and a clock break fall in the same minute, you get one break with the clock
  entry's length. If two clock entries collide, the longer one wins.
- A break that falls due during another break is skipped.

## Limitations

- Hitoiki is a nudge, not a lock. It does not use OS-level input hooks, so a keystroke typed right after
  Cmd+Tab / Alt+Tab can reach another app before Hitoiki takes focus back. Holding Esc for 3 seconds always
  ends a break.
- There is no settings window. Edit the JSON file; only the break length can be changed from the tray.
- Out of scope: statistics, Pomodoro management, multiple profiles and auto-update.
- The packaged app is about 150 MB, since it includes Electron.

## Development

```bash
npm ci
npm run build   # tsc -> dist/
npm test        # vitest
npm start       # run dist/main.js with Electron
npm run dist    # package with electron-builder -> release/
```

```
src/main.ts            app lifecycle, tray, wiring
src/scheduler.ts       next break time and the single timer (no Electron imports)
src/config.ts          load, validate and save settings (no Electron imports)
src/overlay.ts         overlay windows: idle -> flashing -> breaking -> idle
src/preload.ts         minimal renderer API (onFlash, onTick, cancel)
src/ipc.ts             IPC channel names
renderer/overlay.html  flash and break view (inline CSS and JS)
test/                  vitest tests, with Electron mocked
```

The specification is [SPEC.md](SPEC.md) (in Japanese). It is the source of truth for behavior.
[CLAUDE.md](CLAUDE.md) and [AGENTS.md](AGENTS.md) are instructions for coding agents.

## License

[MIT](LICENSE) © 2026 Silent Malachite
