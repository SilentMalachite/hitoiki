import type { NumericKey, SettingsRead } from './config';

/**
 * IPC channel names. A const enum so that tsc inlines the values:
 * the sandboxed preload cannot require local modules at runtime.
 */
export const enum Channel {
  /** main -> renderer, once per flash cycle. Payload: FlashMessage. */
  Flash = 'overlay:flash',
  /** main -> renderer, every second during a break. Payload: remaining seconds. */
  Tick = 'overlay:tick',
  /** renderer -> main, after Esc has been held for 3 seconds. No payload. */
  Cancel = 'overlay:cancel',
  /** settings renderer -> main (invoke). No payload. Returns SettingsSnapshot. */
  SettingsGet = 'settings:get',
  /** settings renderer -> main (invoke). Payload: SettingsDraft. Returns SaveResult. */
  SettingsSave = 'settings:save',
  /** settings renderer -> main. No payload. Opens config.json in the default app. */
  SettingsOpenFile = 'settings:open-file',
}

export interface SettingsSnapshot extends SettingsRead {
  /** [min, max] of each numeric field. intervalMinutes also accepts 0 (disabled). */
  ranges: Readonly<Record<NumericKey, readonly [min: number, max: number]>>;
}

export interface FlashMessage {
  color: string;
  opacity: number;
  /** The renderer shows the color for the first half of periodMs. true: fade in/out with a CSS transition; false: switch instantly. */
  fade: boolean;
  periodMs: number;
}
