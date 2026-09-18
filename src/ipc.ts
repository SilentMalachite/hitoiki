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
}

export interface FlashMessage {
  color: string;
  opacity: number;
  /** The renderer shows the color for the first half of periodMs. true: fade in/out with a CSS transition; false: switch instantly. */
  fade: boolean;
  periodMs: number;
}
