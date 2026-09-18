import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_CONFIG, loadConfig, saveBreakSeconds } from '../src/config';

const writeFailure = vi.hoisted(() => ({ enabled: false }));

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  return {
    ...actual,
    // When enabled, simulates a disk filling up mid-write: part of the data lands, then the write throws.
    writeFileSync: (...args: Parameters<typeof actual.writeFileSync>) => {
      if (!writeFailure.enabled) return actual.writeFileSync(...args);
      const [file, data, options] = args;
      actual.writeFileSync(file, String(data).slice(0, 10), options);
      throw Object.assign(new Error('ENOSPC: no space left on device, write'), { code: 'ENOSPC' });
    },
  };
});

let dir: string;
let errorSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hitoiki-config-'));
  errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  writeFailure.enabled = false;
  errorSpy.mockRestore();
  fs.rmSync(dir, { recursive: true, force: true });
});

function writeConfig(content: string): string {
  const file = path.join(dir, 'config.json');
  fs.writeFileSync(file, content, 'utf8');
  return file;
}

describe('loadConfig', () => {
  it('creates the file with defaults when it does not exist', () => {
    const file = path.join(dir, 'nested', 'config.json');

    const config = loadConfig(file);

    expect(config).toEqual(DEFAULT_CONFIG);
    expect(JSON.parse(fs.readFileSync(file, 'utf8'))).toEqual(DEFAULT_CONFIG);
    expect(errorSpy).not.toHaveBeenCalled();
  });

  it('uses an empty clockTimes by default', () => {
    expect(DEFAULT_CONFIG.clockTimes).toEqual([]);
  });

  it('falls back to defaults on broken JSON without overwriting the file', () => {
    const file = writeConfig('{ "intervalMinutes": 30,');

    const config = loadConfig(file);

    expect(config).toEqual(DEFAULT_CONFIG);
    expect(fs.readFileSync(file, 'utf8')).toBe('{ "intervalMinutes": 30,');
    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('not valid JSON'));
  });

  it('falls back to defaults when the root is not an object', () => {
    const file = writeConfig('[1, 2, 3]');

    expect(loadConfig(file)).toEqual(DEFAULT_CONFIG);
    expect(errorSpy).toHaveBeenCalled();
  });

  it('fills missing keys with defaults', () => {
    const file = writeConfig(JSON.stringify({ breakSeconds: 60, clockTimes: ['12:00'] }));

    const config = loadConfig(file);

    expect(config).toEqual({ ...DEFAULT_CONFIG, breakSeconds: 60, clockTimes: [{ time: '12:00', breakSeconds: 60 }] });
    expect(errorSpy).not.toHaveBeenCalled();
  });

  it('reads a file that starts with a UTF-8 BOM', () => {
    const file = writeConfig(`\uFEFF${JSON.stringify({ breakSeconds: 60 })}`);

    expect(loadConfig(file)).toEqual({ ...DEFAULT_CONFIG, breakSeconds: 60 });
    expect(errorSpy).not.toHaveBeenCalled();
  });

  it('clamps flashIntervalMs below 334 up to 334', () => {
    const file = writeConfig(JSON.stringify({ flashIntervalMs: 100 }));

    expect(loadConfig(file).flashIntervalMs).toBe(334);
    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('flashIntervalMs'));
  });

  it('clamps out-of-range numbers to the nearest bound', () => {
    const low = loadConfig(
      writeConfig(JSON.stringify({ flashCount: 0, flashIntervalMs: -5, flashOpacity: 0, breakSeconds: 1 })),
    );
    expect(low).toMatchObject({ flashCount: 1, flashIntervalMs: 334, flashOpacity: 0.1, breakSeconds: 10 });

    const high = loadConfig(
      writeConfig(
        JSON.stringify({ intervalMinutes: 1000, flashCount: 20, flashIntervalMs: 5000, flashOpacity: 1.5, breakSeconds: 99999 }),
      ),
    );
    expect(high).toMatchObject({ intervalMinutes: 480, flashCount: 10, flashIntervalMs: 2000, flashOpacity: 1.0, breakSeconds: 3600 });
  });

  it('accepts intervalMinutes 0 as "interval mode disabled"', () => {
    expect(loadConfig(writeConfig(JSON.stringify({ intervalMinutes: 0 }))).intervalMinutes).toBe(0);
    expect(errorSpy).not.toHaveBeenCalled();
  });

  it('snaps intervalMinutes below 1 to the nearer of 0 and 1', () => {
    expect(loadConfig(writeConfig(JSON.stringify({ intervalMinutes: -5 }))).intervalMinutes).toBe(0);
    expect(loadConfig(writeConfig(JSON.stringify({ intervalMinutes: 0.2 }))).intervalMinutes).toBe(0);
    expect(loadConfig(writeConfig(JSON.stringify({ intervalMinutes: 0.7 }))).intervalMinutes).toBe(1);
    expect(errorSpy).toHaveBeenCalledTimes(3);
  });

  it('keeps in-range values as they are', () => {
    const custom = {
      intervalMinutes: 25,
      clockTimes: [
        { time: '09:30', breakSeconds: 300 },
        { time: '23:59', breakSeconds: 60 },
      ],
      flashCount: 5,
      flashIntervalMs: 500,
      flashOpacity: 0.5,
      flashColor: '#FF0000',
      fadeMode: true,
      breakSeconds: 300,
    };

    expect(loadConfig(writeConfig(JSON.stringify(custom)))).toEqual(custom);
    expect(errorSpy).not.toHaveBeenCalled();
  });

  it('expands plain clockTimes strings with the top-level breakSeconds', () => {
    const file = writeConfig(
      JSON.stringify({ breakSeconds: 300, clockTimes: ['15:00', { time: '12:00', breakSeconds: 3600 }, { time: '17:30' }] }),
    );

    expect(loadConfig(file).clockTimes).toEqual([
      { time: '15:00', breakSeconds: 300 },
      { time: '12:00', breakSeconds: 3600 },
      { time: '17:30', breakSeconds: 300 },
    ]);
    expect(errorSpy).not.toHaveBeenCalled();
  });

  it('clamps per-entry breakSeconds to [10, 3600]', () => {
    const file = writeConfig(
      JSON.stringify({ clockTimes: [{ time: '12:00', breakSeconds: 5000 }, { time: '15:00', breakSeconds: 5 }] }),
    );

    expect(loadConfig(file).clockTimes).toEqual([
      { time: '12:00', breakSeconds: 3600 },
      { time: '15:00', breakSeconds: 10 },
    ]);
    expect(errorSpy).toHaveBeenCalledTimes(2);
  });

  it('uses the top-level breakSeconds when an entry breakSeconds is not a number', () => {
    const file = writeConfig(JSON.stringify({ breakSeconds: 120, clockTimes: [{ time: '12:00', breakSeconds: 'long' }] }));

    expect(loadConfig(file).clockTimes).toEqual([{ time: '12:00', breakSeconds: 120 }]);
    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('clockTimes[0].breakSeconds'));
  });

  it('drops object entries without a valid time', () => {
    const file = writeConfig(
      JSON.stringify({
        clockTimes: [{ time: '25:00', breakSeconds: 60 }, { breakSeconds: 60 }, null, [], { time: '08:00', breakSeconds: 60 }],
      }),
    );

    expect(loadConfig(file).clockTimes).toEqual([{ time: '08:00', breakSeconds: 60 }]);
    expect(errorSpy).toHaveBeenCalledTimes(4);
  });

  it('falls back per field when a value has the wrong type', () => {
    const file = writeConfig(
      JSON.stringify({ intervalMinutes: '30', flashColor: 123, fadeMode: 'yes', clockTimes: '12:00', breakSeconds: 60 }),
    );

    const config = loadConfig(file);

    expect(config).toEqual({ ...DEFAULT_CONFIG, breakSeconds: 60 });
    expect(errorSpy).toHaveBeenCalledTimes(4);
  });

  it('drops clockTimes entries that are not "HH:mm"', () => {
    const file = writeConfig(JSON.stringify({ clockTimes: ['12:00', '25:00', '9:00', 5, '12:60', '23:59'] }));

    expect(loadConfig(file).clockTimes).toEqual([
      { time: '12:00', breakSeconds: 180 },
      { time: '23:59', breakSeconds: 180 },
    ]);
    expect(errorSpy).toHaveBeenCalledTimes(4);
  });

  it('returns a fresh object that does not share clockTimes with the defaults', () => {
    const config = loadConfig(path.join(dir, 'config.json'));
    config.clockTimes.push({ time: '12:00', breakSeconds: 180 });

    expect(DEFAULT_CONFIG.clockTimes).toEqual([]);
  });
});

describe('saveBreakSeconds', () => {
  it('rewrites only breakSeconds and keeps other keys as written', () => {
    const original = {
      intervalMinutes: 25,
      clockTimes: ['15:00', { time: '12:00', breakSeconds: 3600 }],
      breakSeconds: 180,
      fadeMode: true,
    };
    const file = writeConfig(JSON.stringify(original));

    expect(saveBreakSeconds(file, 600)).toBe(true);

    expect(JSON.parse(fs.readFileSync(file, 'utf8'))).toEqual({ ...original, breakSeconds: 600 });
    expect(loadConfig(file).clockTimes).toEqual([
      { time: '15:00', breakSeconds: 600 },
      { time: '12:00', breakSeconds: 3600 },
    ]);
    expect(errorSpy).not.toHaveBeenCalled();
  });

  it('saves into a file with a BOM, keeping other keys and dropping the BOM', () => {
    const file = writeConfig(`\uFEFF${JSON.stringify({ intervalMinutes: 30, breakSeconds: 180 })}`);

    expect(saveBreakSeconds(file, 300)).toBe(true);

    const text = fs.readFileSync(file, 'utf8');
    expect(text.startsWith('\uFEFF')).toBe(false);
    expect(JSON.parse(text)).toEqual({ intervalMinutes: 30, breakSeconds: 300 });
  });

  it('adds breakSeconds when the file does not have it', () => {
    const file = writeConfig(JSON.stringify({ intervalMinutes: 30 }));

    expect(saveBreakSeconds(file, 300)).toBe(true);
    expect(JSON.parse(fs.readFileSync(file, 'utf8'))).toEqual({ intervalMinutes: 30, breakSeconds: 300 });
  });

  it('creates the file from defaults when it does not exist', () => {
    const file = path.join(dir, 'nested', 'config.json');

    expect(saveBreakSeconds(file, 60)).toBe(true);
    expect(JSON.parse(fs.readFileSync(file, 'utf8'))).toEqual({ ...DEFAULT_CONFIG, breakSeconds: 60 });
  });

  it('clamps the value to [10, 3600] before saving', () => {
    const file = writeConfig('{}');

    saveBreakSeconds(file, 5);
    expect(JSON.parse(fs.readFileSync(file, 'utf8'))).toEqual({ breakSeconds: 10 });

    saveBreakSeconds(file, 99999);
    expect(JSON.parse(fs.readFileSync(file, 'utf8'))).toEqual({ breakSeconds: 3600 });
  });

  it('keeps the original file when the write fails midway', () => {
    const original = JSON.stringify({ intervalMinutes: 30, breakSeconds: 180 });
    const file = writeConfig(original);

    writeFailure.enabled = true;
    expect(saveBreakSeconds(file, 600)).toBe(false);
    writeFailure.enabled = false;

    expect(fs.readFileSync(file, 'utf8')).toBe(original);
    expect(fs.readdirSync(dir)).toEqual(['config.json']);
    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('ENOSPC'));
  });

  it('leaves no temporary file after a successful save', () => {
    const file = writeConfig('{}');

    expect(saveBreakSeconds(file, 600)).toBe(true);
    expect(fs.readdirSync(dir)).toEqual(['config.json']);
  });

  it('leaves a broken file untouched', () => {
    const file = writeConfig('{ "breakSeconds": 180,');

    expect(saveBreakSeconds(file, 600)).toBe(false);
    expect(fs.readFileSync(file, 'utf8')).toBe('{ "breakSeconds": 180,');
    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('not saved'));
  });

  it('leaves a file whose root is not an object untouched', () => {
    const file = writeConfig('[1, 2, 3]');

    expect(saveBreakSeconds(file, 600)).toBe(false);
    expect(fs.readFileSync(file, 'utf8')).toBe('[1, 2, 3]');
  });

  it('returns false instead of throwing when the file cannot be accessed', () => {
    const blocker = writeConfig('{}');

    expect(saveBreakSeconds(path.join(blocker, 'config.json'), 600)).toBe(false);
    expect(errorSpy).toHaveBeenCalled();
  });

  it('rejects a non-finite value without touching the file', () => {
    const file = writeConfig('{"breakSeconds": 180}');

    expect(saveBreakSeconds(file, Number.NaN)).toBe(false);
    expect(fs.readFileSync(file, 'utf8')).toBe('{"breakSeconds": 180}');
  });
});
