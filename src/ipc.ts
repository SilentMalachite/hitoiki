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
  /** true: the renderer fades 0 -> opacity -> 0 over periodMs. false: main blinks by showing/hiding the window. */
  fade: boolean;
  periodMs: number;
}
