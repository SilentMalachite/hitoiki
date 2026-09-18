import * as fs from 'node:fs';
import * as path from 'node:path';

export interface ClockTime {
  time: string;
  breakSeconds: number;
}

export interface Config {
  /** 0 disables interval mode. */
  intervalMinutes: number;
  /** Entries given as plain "HH:mm" strings are expanded with the top-level breakSeconds. */
  clockTimes: ClockTime[];
  flashCount: number;
  flashIntervalMs: number;
  flashOpacity: number;
  flashColor: string;
  fadeMode: boolean;
  breakSeconds: number;
}

export const DEFAULT_CONFIG: Readonly<Config> = Object.freeze({
  intervalMinutes: 50,
  clockTimes: [],
  flashCount: 3,
  flashIntervalMs: 400,
  flashOpacity: 0.85,
  flashColor: '#FFFFFF',
  fadeMode: false,
  breakSeconds: 180,
});

type NumericKey = 'intervalMinutes' | 'flashCount' | 'flashIntervalMs' | 'flashOpacity' | 'breakSeconds';

const RANGES: Readonly<Record<NumericKey, readonly [min: number, max: number]>> = {
  intervalMinutes: [1, 480],
  flashCount: [1, 10],
  flashIntervalMs: [334, 2000],
  flashOpacity: [0.1, 1.0],
  breakSeconds: [10, 3600],
};

const CLOCK_TIME = /^([01]\d|2[0-3]):[0-5]\d$/;

export interface NormalizeResult {
  config: Config;
  warnings: string[];
}

/** Validates a parsed config value. Invalid fields fall back to defaults; out-of-range numbers are clamped. */
export function normalizeConfig(raw: unknown): NormalizeResult {
  const config = cloneDefaults();
  const warnings: string[] = [];

  if (!isPlainObject(raw)) {
    warnings.push('config root must be a JSON object; using defaults');
    return { config, warnings };
  }

  for (const key of Object.keys(RANGES) as NumericKey[]) {
    const value = raw[key];
    if (value === undefined) continue;
    if (typeof value !== 'number' || !Number.isFinite(value)) {
      warnings.push(`${key}: expected a number; using default ${config[key]}`);
      continue;
    }
    const clamped = clamp(key, value);
    if (clamped !== value) {
      warnings.push(`${key}: ${value} is out of range ${describeRange(key)}; clamped to ${clamped}`);
    }
    config[key] = clamped;
  }

  // Must run after the numeric fields: plain entries inherit the top-level breakSeconds.
  if (raw.clockTimes !== undefined) {
    if (Array.isArray(raw.clockTimes)) {
      (raw.clockTimes as unknown[]).forEach((entry, index) => {
        const clockTime = normalizeClockTime(entry, `clockTimes[${index}]`, config.breakSeconds, warnings);
        if (clockTime) config.clockTimes.push(clockTime);
      });
    } else {
      warnings.push('clockTimes: expected an array; using default []');
    }
  }

  if (raw.flashColor !== undefined) {
    if (typeof raw.flashColor === 'string') {
      config.flashColor = raw.flashColor;
    } else {
      warnings.push(`flashColor: expected a string; using default ${config.flashColor}`);
    }
  }

  if (raw.fadeMode !== undefined) {
    if (typeof raw.fadeMode === 'boolean') {
      config.fadeMode = raw.fadeMode;
    } else {
      warnings.push(`fadeMode: expected a boolean; using default ${config.fadeMode}`);
    }
  }

  return { config, warnings };
}

function normalizeClockTime(
  entry: unknown,
  label: string,
  defaultBreakSeconds: number,
  warnings: string[],
): ClockTime | null {
  if (typeof entry === 'string') {
    if (CLOCK_TIME.test(entry)) return { time: entry, breakSeconds: defaultBreakSeconds };
    warnings.push(`${label}: ignored invalid time ${JSON.stringify(entry)} (expected "HH:mm")`);
    return null;
  }

  if (!isPlainObject(entry)) {
    warnings.push(`${label}: ignored ${JSON.stringify(entry)} (expected "HH:mm" or { time, breakSeconds })`);
    return null;
  }

  if (typeof entry.time !== 'string' || !CLOCK_TIME.test(entry.time)) {
    warnings.push(`${label}: ignored entry with invalid time ${JSON.stringify(entry.time)} (expected "HH:mm")`);
    return null;
  }

  const value = entry.breakSeconds;
  if (value === undefined) return { time: entry.time, breakSeconds: defaultBreakSeconds };
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    warnings.push(`${label}.breakSeconds: expected a number; using ${defaultBreakSeconds}`);
    return { time: entry.time, breakSeconds: defaultBreakSeconds };
  }
  const clamped = clamp('breakSeconds', value);
  if (clamped !== value) {
    warnings.push(`${label}.breakSeconds: ${value} is out of range ${describeRange('breakSeconds')}; clamped to ${clamped}`);
  }
  return { time: entry.time, breakSeconds: clamped };
}

function clamp(key: NumericKey, value: number): number {
  const [min, max] = RANGES[key];
  // intervalMinutes also accepts 0 (disabled); snap values below 1 to the nearer of 0 and 1.
  if (key === 'intervalMinutes' && value < min) return value < min / 2 ? 0 : min;
  return Math.min(max, Math.max(min, value));
}

function describeRange(key: NumericKey): string {
  const [min, max] = RANGES[key];
  return key === 'intervalMinutes' ? `0 or [${min}, ${max}]` : `[${min}, ${max}]`;
}

/**
 * Loads the config file. Creates it with defaults when missing.
 * Never throws: on any failure it reports the reason to stderr and returns defaults.
 */
export function loadConfig(filePath: string): Config {
  let text: string;
  try {
    text = stripBom(fs.readFileSync(filePath, 'utf8'));
  } catch (err) {
    if (isErrnoCode(err, 'ENOENT')) {
      writeJson(filePath, DEFAULT_CONFIG);
    } else {
      console.error(`[config] cannot read ${filePath}: ${describe(err)}; using defaults`);
    }
    return cloneDefaults();
  }

  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (err) {
    console.error(`[config] ${filePath} is not valid JSON: ${describe(err)}; using defaults`);
    return cloneDefaults();
  }

  const { config, warnings } = normalizeConfig(raw);
  for (const warning of warnings) {
    console.error(`[config] ${warning}`);
  }
  return config;
}

/**
 * Rewrites only the top-level breakSeconds in the config file; every other key keeps its original form.
 * Creates the file from defaults when missing. Never throws: returns false and reports to stderr
 * when the file is broken (left untouched) or cannot be written.
 */
export function saveBreakSeconds(filePath: string, seconds: number): boolean {
  if (!Number.isFinite(seconds)) {
    console.error(`[config] breakSeconds must be a finite number (got ${seconds}); not saved`);
    return false;
  }

  let raw: Record<string, unknown>;
  try {
    const parsed: unknown = JSON.parse(stripBom(fs.readFileSync(filePath, 'utf8')));
    if (!isPlainObject(parsed)) {
      console.error(`[config] ${filePath} is not a JSON object; breakSeconds not saved`);
      return false;
    }
    raw = parsed;
  } catch (err) {
    if (!isErrnoCode(err, 'ENOENT')) {
      console.error(`[config] cannot update ${filePath}: ${describe(err)}; breakSeconds not saved`);
      return false;
    }
    raw = { ...DEFAULT_CONFIG };
  }

  raw.breakSeconds = clamp('breakSeconds', seconds);
  return writeJson(filePath, raw);
}

function writeJson(filePath: string, value: unknown): boolean {
  // Write a sibling temp file in full, then rename it over the target:
  // a failure midway (e.g. disk full) never leaves a truncated config.json behind.
  const tempPath = `${filePath}.tmp`;
  try {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(tempPath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
    fs.renameSync(tempPath, filePath);
    return true;
  } catch (err) {
    try {
      fs.rmSync(tempPath, { force: true });
    } catch {
      // Keep reporting the original error below.
    }
    console.error(`[config] cannot write ${filePath}: ${describe(err)}`);
    return false;
  }
}

/** Editors such as Windows Notepad may prepend a UTF-8 BOM, which JSON.parse rejects. */
function stripBom(text: string): string {
  return text.startsWith('\uFEFF') ? text.slice(1) : text;
}

function cloneDefaults(): Config {
  return { ...DEFAULT_CONFIG, clockTimes: DEFAULT_CONFIG.clockTimes.map((entry) => ({ ...entry })) };
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isErrnoCode(err: unknown, code: string): boolean {
  return typeof err === 'object' && err !== null && (err as { code?: unknown }).code === code;
}

function describe(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
