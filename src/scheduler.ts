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
 * - clock: next local occurrence of each "HH:mm", rolling over to the next day.
 * Fires within the same minute are merged into one. Its breakSeconds comes from the clock entries
 * in that minute (the longest wins) and falls back to the top-level value for an interval-only fire.
 */
export function nextFireTime(after: Date, anchor: Date, config: ScheduleConfig): Fire | null {
  const candidates: Candidate[] = [];
  if (config.intervalMinutes > 0) {
    candidates.push({
      at: nextIntervalTick(after, anchor, config.intervalMinutes),
      breakSeconds: config.breakSeconds,
      fromClock: false,
    });
  }
  for (const clockTime of config.clockTimes) {
    candidates.push({
      at: nextClockOccurrence(after, clockTime.time),
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

  /** The next fire time, or null when stopped or nothing is scheduled. */
  get next(): Date | null {
    return this.pending?.at ?? null;
  }

  private arm(after: Date): void {
    if (this.config === null || this.anchor === null) return;
    this.pending = nextFireTime(after, this.anchor, this.config);
    if (this.pending === null) return;
    const delay = Math.max(0, this.pending.at.getTime() - this.deps.now().getTime());
    this.timer = setTimeout(() => this.handleTimeout(), delay);
  }

  private handleTimeout(): void {
    const fire = this.pending;
    this.timer = null;
    if (fire === null) return;

    // Search from the end of the fired minute so that other fires in the same minute are merged.
    const endOfMinute = startOfMinute(fire.at.getTime()) + MINUTE_MS - 1;
    this.arm(new Date(Math.max(this.deps.now().getTime(), endOfMinute)));

    if (!this.deps.isBreaking()) this.deps.onFire(fire.breakSeconds);
  }
}

function nextIntervalTick(after: Date, anchor: Date, intervalMinutes: number): number {
  const step = intervalMinutes * MINUTE_MS;
  const elapsed = after.getTime() - anchor.getTime();
  const k = Math.max(1, Math.floor(elapsed / step) + 1);
  return anchor.getTime() + k * step;
}

function nextClockOccurrence(after: Date, time: string): number {
  const hours = Number(time.slice(0, 2));
  const minutes = Number(time.slice(3, 5));
  const candidate = new Date(after.getTime());
  candidate.setHours(hours, minutes, 0, 0);
  if (candidate.getTime() <= after.getTime()) {
    candidate.setDate(candidate.getDate() + 1);
    candidate.setHours(hours, minutes, 0, 0);
  }
  return candidate.getTime();
}

function startOfMinute(ms: number): number {
  return Math.floor(ms / MINUTE_MS) * MINUTE_MS;
}
