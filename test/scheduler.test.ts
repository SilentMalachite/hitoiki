import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { nextFireTime, Scheduler, type ScheduleConfig } from '../src/scheduler';

const MINUTE = 60_000;

/** Local time on 2026-09-21 (or another day of the same month). */
function at(hours: number, minutes: number, seconds = 0, day = 21): Date {
  return new Date(2026, 8, day, hours, minutes, seconds);
}

function schedule(overrides: Partial<ScheduleConfig> = {}): ScheduleConfig {
  return { intervalMinutes: 50, clockTimes: [], breakSeconds: 180, ...overrides };
}

describe('nextFireTime', () => {
  describe('interval mode', () => {
    it('fires every intervalMinutes counted from the anchor', () => {
      const anchor = at(9, 0);

      expect(nextFireTime(at(9, 0), anchor, schedule())).toEqual({ at: at(9, 50), breakSeconds: 180 });
      expect(nextFireTime(at(9, 49, 59), anchor, schedule())?.at).toEqual(at(9, 50));
      expect(nextFireTime(at(9, 50), anchor, schedule())?.at).toEqual(at(10, 40));
    });

    it('uses the first tick when asked for a time before the anchor', () => {
      expect(nextFireTime(at(8, 0), at(9, 0), schedule())?.at).toEqual(at(9, 50));
    });

    it('is disabled by intervalMinutes 0', () => {
      expect(nextFireTime(at(9, 0), at(9, 0), schedule({ intervalMinutes: 0 }))).toBeNull();
    });
  });

  describe('clock mode', () => {
    const noInterval = { intervalMinutes: 0 };

    it('fires at the next occurrence today', () => {
      const config = schedule({ ...noInterval, clockTimes: [{ time: '12:00', breakSeconds: 3600 }] });

      expect(nextFireTime(at(11, 0), at(9, 0), config)).toEqual({ at: at(12, 0), breakSeconds: 3600 });
    });

    it('rolls over to tomorrow once the time has passed', () => {
      const config = schedule({ ...noInterval, clockTimes: [{ time: '12:00', breakSeconds: 180 }] });

      expect(nextFireTime(at(12, 0), at(9, 0), config)?.at).toEqual(at(12, 0, 0, 22));
      expect(nextFireTime(at(23, 30), at(9, 0), config)?.at).toEqual(at(12, 0, 0, 22));
    });

    it('picks the earliest of several times regardless of order', () => {
      const config = schedule({
        ...noInterval,
        clockTimes: [
          { time: '17:30', breakSeconds: 300 },
          { time: '08:00', breakSeconds: 60 },
          { time: '15:00', breakSeconds: 120 },
        ],
      });

      expect(nextFireTime(at(12, 0), at(9, 0), config)).toEqual({ at: at(15, 0), breakSeconds: 120 });
      expect(nextFireTime(at(18, 0), at(9, 0), config)).toEqual({ at: at(8, 0, 0, 22), breakSeconds: 60 });
    });
  });

  describe('both modes', () => {
    it('returns whichever mode comes first', () => {
      const config = schedule({ clockTimes: [{ time: '09:30', breakSeconds: 600 }] });

      expect(nextFireTime(at(9, 0), at(9, 0), config)).toEqual({ at: at(9, 30), breakSeconds: 600 });
      expect(nextFireTime(at(9, 30), at(9, 0), config)).toEqual({ at: at(9, 50), breakSeconds: 180 });
    });

    it('merges fires in the same minute, preferring the clock breakSeconds', () => {
      // Interval ticks land on 12:00:30; the clock fires at 12:00:00.
      const config = schedule({ clockTimes: [{ time: '12:00', breakSeconds: 60 }] });

      expect(nextFireTime(at(11, 50), at(11, 10, 30), config)).toEqual({ at: at(12, 0), breakSeconds: 60 });
    });

    it('takes the longest breakSeconds among clock entries in the same minute', () => {
      const config = schedule({
        intervalMinutes: 0,
        clockTimes: [
          { time: '12:00', breakSeconds: 300 },
          { time: '12:00', breakSeconds: 3600 },
        ],
      });

      expect(nextFireTime(at(11, 0), at(9, 0), config)?.breakSeconds).toBe(3600);
    });
  });
});

describe('Scheduler', () => {
  let breaking: boolean;
  let onFire: ReturnType<typeof vi.fn<(breakSeconds: number) => void>>;

  function createScheduler(): Scheduler {
    return new Scheduler({ now: () => new Date(), isBreaking: () => breaking, onFire });
  }

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(at(9, 0));
    breaking = false;
    onFire = vi.fn<(breakSeconds: number) => void>();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('fires on every interval tick and exposes the next fire time', () => {
    const scheduler = createScheduler();
    scheduler.start(schedule(), at(9, 0));
    expect(scheduler.next).toEqual(at(9, 50));

    vi.advanceTimersByTime(50 * MINUTE);
    expect(onFire).toHaveBeenCalledTimes(1);
    expect(onFire).toHaveBeenLastCalledWith(180);
    expect(scheduler.next).toEqual(at(10, 40));

    vi.advanceTimersByTime(50 * MINUTE);
    expect(onFire).toHaveBeenCalledTimes(2);
  });

  it('fires at a clock time with its breakSeconds and then waits for the next day', () => {
    const scheduler = createScheduler();
    scheduler.start(schedule({ intervalMinutes: 0, clockTimes: [{ time: '12:00', breakSeconds: 3600 }] }), at(9, 0));

    vi.advanceTimersByTime(3 * 60 * MINUTE);

    expect(onFire).toHaveBeenCalledOnce();
    expect(onFire).toHaveBeenCalledWith(3600);
    expect(scheduler.next).toEqual(at(12, 0, 0, 22));
  });

  it('fires only once when interval and clock land in the same minute', () => {
    const scheduler = createScheduler();
    vi.setSystemTime(at(11, 10, 30));
    scheduler.start(schedule({ clockTimes: [{ time: '12:00', breakSeconds: 60 }] }), at(11, 10, 30));

    vi.advanceTimersByTime(51 * MINUTE);

    expect(onFire).toHaveBeenCalledOnce();
    expect(onFire).toHaveBeenCalledWith(60);
    expect(scheduler.next).toEqual(at(12, 50, 30));
  });

  it('drops fires that arrive during a break and keeps scheduling', () => {
    const scheduler = createScheduler();
    scheduler.start(schedule(), at(9, 0));

    breaking = true;
    vi.advanceTimersByTime(50 * MINUTE);
    expect(onFire).not.toHaveBeenCalled();
    expect(scheduler.next).toEqual(at(10, 40));

    breaking = false;
    vi.advanceTimersByTime(50 * MINUTE);
    expect(onFire).toHaveBeenCalledOnce();
  });

  it('never fires after stop', () => {
    const scheduler = createScheduler();
    scheduler.start(schedule(), at(9, 0));

    scheduler.stop();
    vi.advanceTimersByTime(24 * 60 * MINUTE);

    expect(onFire).not.toHaveBeenCalled();
    expect(scheduler.next).toBeNull();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('keeps a single timer when restarted, counting from the new anchor', () => {
    const scheduler = createScheduler();
    scheduler.start(schedule(), at(9, 0));

    vi.advanceTimersByTime(30 * MINUTE);
    scheduler.start(schedule(), at(9, 30));

    expect(vi.getTimerCount()).toBe(1);
    expect(scheduler.next).toEqual(at(10, 20));
  });

  it('arms no timer when nothing is scheduled', () => {
    const scheduler = createScheduler();
    scheduler.start(schedule({ intervalMinutes: 0 }), at(9, 0));

    expect(scheduler.next).toBeNull();
    expect(vi.getTimerCount()).toBe(0);
  });
});
