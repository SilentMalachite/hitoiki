import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
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

  it('does not fire again in the same minute after start() is called again', () => {
    vi.setSystemTime(at(11, 50));
    const scheduler = createScheduler();
    // Interval ticks land on 12:00:30; the clock fires at 12:00:00 with a 10-second break.
    const config = schedule({ clockTimes: [{ time: '12:00', breakSeconds: 10 }] });
    scheduler.start(config, at(11, 10, 30));

    vi.advanceTimersByTime(10 * MINUTE + 20_000); // 12:00:20
    expect(onFire).toHaveBeenCalledOnce();

    scheduler.start(config, at(11, 10, 30)); // e.g. a config reload, which keeps the anchor
    vi.advanceTimersByTime(40_000); // past 12:00:30

    expect(onFire).toHaveBeenCalledOnce();
    expect(scheduler.next).toEqual(at(12, 50, 30));
  });

  it('does not fire early when the wall clock is set back', () => {
    vi.setSystemTime(at(11, 59));
    const scheduler = createScheduler();
    scheduler.start(schedule({ intervalMinutes: 0, clockTimes: [{ time: '12:00', breakSeconds: 180 }] }), at(11, 59));

    vi.setSystemTime(at(11, 0)); // the pending timer keeps its 1-minute delay
    vi.advanceTimersByTime(MINUTE);

    expect(onFire).not.toHaveBeenCalled();
    expect(scheduler.next).toEqual(at(12, 0));

    vi.advanceTimersByTime(59 * MINUTE);
    expect(onFire).toHaveBeenCalledOnce();
  });

  it('drops a fire that fell due during a break when refreshed at the break end', () => {
    const scheduler = createScheduler();
    scheduler.start(schedule(), at(9, 0)); // due at 09:50

    vi.advanceTimersByTime(49 * MINUTE); // 09:49, a break starts
    breaking = true;
    // The main process stalls: the wall clock reaches 09:53 before the 09:50 timer callback runs,
    // and the countdown callback runs first and ends the break.
    vi.setSystemTime(at(9, 53));
    breaking = false;
    scheduler.refresh();
    vi.advanceTimersByTime(2 * MINUTE);

    expect(onFire).not.toHaveBeenCalled();
    expect(scheduler.next).toEqual(at(10, 40));
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

describe('nextFireTime across DST (America/New_York)', () => {
  const originalTz = process.env.TZ;
  const utc = (iso: string): Date => new Date(iso);
  const clockOnly = (time: string): ScheduleConfig =>
    schedule({ intervalMinutes: 0, clockTimes: [{ time, breakSeconds: 180 }] });

  beforeAll(() => {
    process.env.TZ = 'America/New_York';
  });

  afterAll(() => {
    if (originalTz === undefined) delete process.env.TZ;
    else process.env.TZ = originalTz;
  });

  it('runs in a zone with DST', () => {
    expect(utc('2026-07-01T12:00:00Z').getTimezoneOffset()).toBe(240);
    expect(utc('2026-12-01T12:00:00Z').getTimezoneOffset()).toBe(300);
  });

  // 2026-11-01: 02:00 EDT falls back to 01:00 EST, so 01:30 happens at 05:30Z and again at 06:30Z.
  it('fires at the first 01:30 on the day DST ends', () => {
    const after = utc('2026-11-01T04:00:00Z');

    expect(nextFireTime(after, after, clockOnly('01:30'))?.at).toEqual(utc('2026-11-01T05:30:00Z'));
  });

  it('fires at the repeated 01:30 when started between the two', () => {
    const after = utc('2026-11-01T06:15:00Z');

    expect(nextFireTime(after, after, clockOnly('01:30'))?.at).toEqual(utc('2026-11-01T06:30:00Z'));
  });

  it('fires a repeated time only once that day', () => {
    const fired = utc('2026-11-01T05:30:00Z');
    const endOfFiredMinute = new Date(fired.getTime() + MINUTE - 1);

    expect(nextFireTime(endOfFiredMinute, fired, clockOnly('01:30'), fired)?.at).toEqual(utc('2026-11-02T06:30:00Z'));
  });

  // 2026-03-08: 02:00 EST springs forward to 03:00 EDT, so 02:30 does not exist.
  it('shifts a skipped time forward on the day DST starts', () => {
    const after = utc('2026-03-08T05:00:00Z');

    expect(nextFireTime(after, after, clockOnly('02:30'))?.at).toEqual(utc('2026-03-08T07:30:00Z'));
  });
});
