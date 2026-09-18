import type { Config } from './config';

export type ScheduleConfig = Pick<Config, 'intervalMinutes' | 'clockTimes' | 'breakSeconds'>;

export interface Fire {
  at: Date;
  breakSeconds: number;
}

interface Candidate {
  at: number;
  breakSeconds: number;
  fromClock: boolean;
}

const MINUTE_MS = 60_000;

/**
 * Returns the earliest fire strictly after `after`, or null when neither mode is active.
 * - interval: anchor + k * intervalMinutes (k >= 1). 0 disables it.
 * - clock: next local occurrence of each "HH:mm", rolling over to the next day. On a DST-end day a
 *   repeated time has two occurrences and either can be next; a time skipped by DST start fires at the
 *   instant it is shifted to (e.g. 02:30 -> 03:30). Occurrences showing the same local date and time as
 *   `lastFiredAt` are excluded, so each clock time fires at most once per day.
 * Fires within the same minute are merged into one. Its breakSeconds comes from the clock entries
 * in that minute (the longest wins) and falls back to the top-level value for an interval-only fire.
 */
export function nextFireTime(
  after: Date,
  anchor: Date,
  config: ScheduleConfig,
  lastFiredAt: Date | null = null,
): Fire | null {
  const candidates: Candidate[] = [];
  if (config.intervalMinutes > 0) {
    candidates.push({
      at: nextIntervalTick(after, anchor, config.intervalMinutes),
      breakSeconds: config.breakSeconds,
      fromClock: false,
    });
  }
  const skipLabel = lastFiredAt === null ? null : localMinuteLabel(lastFiredAt);
  for (const clockTime of config.clockTimes) {
    candidates.push({
      at: nextClockOccurrence(after, clockTime.time, skipLabel),
      breakSeconds: clockTime.breakSeconds,
      fromClock: true,
    });
  }
  if (candidates.length === 0) return null;

  const earliest = Math.min(...candidates.map((candidate) => candidate.at));
  const minute = startOfMinute(earliest);
  const clockBreaks = candidates
    .filter((candidate) => candidate.fromClock && startOfMinute(candidate.at) === minute)
    .map((candidate) => candidate.breakSeconds);
  const breakSeconds = clockBreaks.length > 0 ? Math.max(...clockBreaks) : config.breakSeconds;
  return { at: new Date(earliest), breakSeconds };
}

export interface SchedulerDeps {
  now: () => Date;
  /** Fires arriving while this returns true are dropped. */
  isBreaking: () => boolean;
  onFire: (breakSeconds: number) => void;
}

/** Keeps exactly one setTimeout pointing at the next fire. */
export class Scheduler {
  private timer: ReturnType<typeof setTimeout> | null = null;
  private config: ScheduleConfig | null = null;
  private anchor: Date | null = null;
  private pending: Fire | null = null;
  /** When the last fire was due (fired or dropped). Kept across start() so a minute never fires twice. */
  private lastFiredAt: Date | null = null;

  constructor(private readonly deps: SchedulerDeps) {}

  /** Starts or restarts scheduling. Interval fires are counted from `anchor`. */
  start(config: ScheduleConfig, anchor: Date): void {
    this.stop();
    this.config = config;
    this.anchor = anchor;
    this.arm(this.deps.now());
  }

  stop(): void {
    if (this.timer !== null) clearTimeout(this.timer);
    this.timer = null;
    this.config = null;
    this.anchor = null;
    this.pending = null;
  }

  /**
   * Re-arms from now, keeping config and anchor. Call when a break ends: a fire that fell due during the
   * break is dropped even if its timer callback would otherwise run after the break-end callback.
   */
  refresh(): void {
    if (this.config === null || this.anchor === null) return;
    if (this.timer !== null) clearTimeout(this.timer);
    this.timer = null;
    this.arm(this.deps.now());
  }

  /** The next fire time, or null when stopped or nothing is scheduled. */
  get next(): Date | null {
    return this.pending?.at ?? null;
  }

  private arm(after: Date): void {
    if (this.config === null || this.anchor === null) return;
    // Search from the end of the last fired minute, so other fires in that minute are merged into it.
    const lastMinuteEnd = this.lastFiredAt === null ? 0 : startOfMinute(this.lastFiredAt.getTime()) + MINUTE_MS - 1;
    const from = new Date(Math.max(after.getTime(), lastMinuteEnd));
    this.pending = nextFireTime(from, this.anchor, this.config, this.lastFiredAt);
    if (this.pending === null) return;
    const delay = Math.max(0, this.pending.at.getTime() - this.deps.now().getTime());
    this.timer = setTimeout(() => this.handleTimeout(), delay);
  }

  private handleTimeout(): void {
    const fire = this.pending;
    this.timer = null;
    if (fire === null) return;

    const now = this.deps.now();
    // The timer runs on monotonic time. If the wall clock was set back, it is not time yet: recompute instead.
    if (now.getTime() < fire.at.getTime()) {
      this.arm(now);
      return;
    }

    this.lastFiredAt = fire.at;
    this.arm(now);

    if (!this.deps.isBreaking()) this.deps.onFire(fire.breakSeconds);
  }
}

function nextIntervalTick(after: Date, anchor: Date, intervalMinutes: number): number {
  const step = intervalMinutes * MINUTE_MS;
  const elapsed = after.getTime() - anchor.getTime();
  const k = Math.max(1, Math.floor(elapsed / step) + 1);
  return anchor.getTime() + k * step;
}

function nextClockOccurrence(after: Date, time: string, skipLabel: string | null): number {
  const hours = Number(time.slice(0, 2));
  const minutes = Number(time.slice(3, 5));
  const instants: number[] = [];
  for (const dayOffset of [0, 1, 2]) {
    const day = new Date(after.getTime());
    day.setDate(day.getDate() + dayOffset);
    instants.push(...clockInstantsOn(day, hours, minutes));
  }
  const upcoming = instants.filter(
    (instant) => instant > after.getTime() && localMinuteLabel(new Date(instant)) !== skipLabel,
  );
  return Math.min(...upcoming);
}

/**
 * Every instant on the local date of `day` whose wall clock reads hours:minutes.
 * Normally one; two when DST ends and the time repeats. When DST start skips the time,
 * the single instant JS shifts it to (one gap later).
 */
function clockInstantsOn(day: Date, hours: number, minutes: number): number[] {
  const base = new Date(day.getTime());
  base.setHours(hours, minutes, 0, 0);
  if (!showsTime(base, hours, minutes)) return [base.getTime()];
  // DST shifts are 30 or 60 minutes; look on both sides since engines may resolve a repeated time either way.
  return [-60, -30, 0, 30, 60]
    .map((shift) => base.getTime() + shift * MINUTE_MS)
    .filter((instant) => {
      const date = new Date(instant);
      return showsTime(date, hours, minutes) && date.toDateString() === base.toDateString();
    });
}

function showsTime(date: Date, hours: number, minutes: number): boolean {
  return date.getHours() === hours && date.getMinutes() === minutes;
}

/** Local "Y-M-D H:m", identifying a wall-clock minute (both occurrences of a repeated time share it). */
function localMinuteLabel(date: Date): string {
  return `${date.getFullYear()}-${date.getMonth() + 1}-${date.getDate()} ${date.getHours()}:${date.getMinutes()}`;
}

function startOfMinute(ms: number): number {
  return Math.floor(ms / MINUTE_MS) * MINUTE_MS;
}
