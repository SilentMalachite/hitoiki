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

export type NumericKey = 'intervalMinutes' | 'flashCount' | 'flashIntervalMs' | 'flashOpacity' | 'breakSeconds';

/** Valid range of each numeric field. The settings window builds its form limits from these. */
export const RANGES: Readonly<Record<NumericKey, readonly [min: number, max: number]>> = {
  intervalMinutes: [1, 480],
  flashCount: [1, 10],
  flashIntervalMs: [334, 2000],
  flashOpacity: [0.1, 1.0],
  breakSeconds: [10, 3600],
};

const CLOCK_TIME = /^([01]\d|2[0-3]):[0-5]\d$/;

/** The config as the settings window edits it. */
export interface SettingsDraft extends Omit<Config, 'clockTimes'> {
  /** breakSeconds null: written as a plain "HH:mm" string, which follows the top-level breakSeconds. */
  clockTimes: { time: string; breakSeconds: number | null }[];
}

export interface SettingsRead {
  draft: SettingsDraft;
  /** Why the file cannot be used or updated; the settings window then refuses to save. */
  error: string | null;
}

/** On success, `draft` is the file as read back after the write. */
export type SaveResult = { ok: true; draft: SettingsDraft } | { ok: false; reason: string };

/** The keys the settings window owns, in the order a new file lists them. */
const SETTINGS_KEYS = Object.keys(DEFAULT_CONFIG) as (keyof Config)[];

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
 * `onError` also gets a short reason for the tray whenever the file exists but defaults are used instead,
 * and `onWarning` gets each per-field warning.
 */
export function loadConfig(
  filePath: string,
  onError: (reason: string) => void = () => {},
  onWarning: (warning: string) => void = () => {},
): Config {
  let text: string;
  try {
    text = stripBom(fs.readFileSync(filePath, 'utf8'));
  } catch (err) {
    if (isErrnoCode(err, 'ENOENT')) {
      writeJson(filePath, DEFAULT_CONFIG);
    } else {
      console.error(`[config] cannot read ${filePath}: ${describe(err)}; using defaults`);
      onError(`読み込めません: ${describe(err)}`);
    }
    return cloneDefaults();
  }

  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (err) {
    console.error(`[config] ${filePath} is not valid JSON: ${describe(err)}; using defaults`);
    onError(`JSON として不正です: ${describe(err)}`);
    return cloneDefaults();
  }
  const { config, warnings } = normalizeConfig(raw);
  for (const warning of warnings) {
    console.error(`[config] ${warning}`);
  }
  // normalizeConfig has used defaults; this is an error for the tray, not a per-field warning.
  if (!isPlainObject(raw)) {
    onError('ルートが JSON オブジェクトではありません');
  } else {
    for (const warning of warnings) onWarning(warning);
  }
  return config;
}

/**
 * Rewrites only the top-level breakSeconds in the config file; every other key keeps its original form.
 * Creates the file from defaults when missing. Never throws: returns false and reports to stderr
 * when the file is broken (left untouched) or cannot be written. `onError` also gets a short reason for the tray
 * whenever it returns false.
 */
export function saveBreakSeconds(
  filePath: string,
  seconds: number,
  onError: (reason: string) => void = () => {},
): boolean {
  const fail = (detail: string): void => onError(`休憩時間を保存できません: ${detail}`);

  if (!Number.isFinite(seconds)) {
    console.error(`[config] breakSeconds must be a finite number (got ${seconds}); not saved`);
    fail(`${seconds} は有限の数値ではありません`);
    return false;
  }

  const raw = readForUpdate(filePath, 'breakSeconds', fail);
  if (raw === null) return false;
  raw.breakSeconds = clamp('breakSeconds', seconds);
  return writeJson(filePath, raw, fail);
}

/**
 * Reads the config file for the settings window. Values are normalized as loadConfig does,
 * but each clockTimes entry keeps whether it has its own breakSeconds. Never throws:
 * returns defaults with an `error` when the file exists but cannot be updated.
 */
export function readSettings(filePath: string): SettingsRead {
  const defaults = toDraft(cloneDefaults(), []);
  let text: string;
  try {
    text = stripBom(fs.readFileSync(filePath, 'utf8'));
  } catch (err) {
    if (isErrnoCode(err, 'ENOENT')) return { draft: defaults, error: null };
    console.error(`[config] settings window cannot read ${filePath}: ${describe(err)}`);
    return { draft: defaults, error: `読み込めません: ${describe(err)}` };
  }
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (err) {
    console.error(`[config] settings window: ${filePath} is not valid JSON: ${describe(err)}`);
    return { draft: defaults, error: `JSON として不正です: ${describe(err)}` };
  }
  if (!isPlainObject(raw)) return { draft: defaults, error: 'ルートが JSON オブジェクトではありません' };
  const { config } = normalizeConfig(raw);
  const rawClockTimes = Array.isArray(raw.clockTimes) ? (raw.clockTimes as unknown[]) : [];
  // Same filter as normalizeConfig, so the flags line up with config.clockTimes.
  const ownBreak = rawClockTimes
    .filter((entry) => normalizeClockTime(entry, '', config.breakSeconds, []) !== null)
    .map((entry) => isPlainObject(entry) && typeof entry.breakSeconds === 'number' && Number.isFinite(entry.breakSeconds));
  return { draft: toDraft(config, ownBreak), error: null };
}

/**
 * Writes the settings window's draft into the config file. Only the keys whose value differs from `base`
 * (the draft the window loaded) are written, so a value changed elsewhere since then (the tray, an editor)
 * is kept unless the window changed it too. Any other key in the file is kept as well.
 * The draft comes from a renderer, so its shape and every value are checked again; nothing is written
 * unless all of them are valid. Creates the file when missing; leaves a broken file untouched. Never throws.
 */
export function saveConfig(
  filePath: string,
  draft: unknown,
  base: SettingsDraft,
  onError: (reason: string) => void = () => {},
): SaveResult {
  const failed = (detail: string): SaveResult => {
    const reason = `設定を保存できません: ${detail}`;
    onError(reason);
    return { ok: false, reason };
  };

  const next = draftToRaw(draft);
  if (next === null) {
    console.error('[config] settings draft has an unexpected shape; not saved');
    return failed('値の形式が不正です');
  }
  const { warnings } = normalizeConfig(next);
  if (warnings.length > 0) {
    console.error(`[config] settings not saved: ${warnings.join('; ')}`);
    return failed(warnings.join('; '));
  }

  let detail = '';
  const remember = (message: string): void => {
    detail = message;
  };
  const raw = readForUpdate(filePath, 'settings', remember);
  if (raw === null) return failed(detail);
  const loaded = draftToRaw(base) ?? {};
  for (const key of SETTINGS_KEYS) {
    if (JSON.stringify(next[key]) !== JSON.stringify(loaded[key])) raw[key] = next[key];
  }
  if (!writeJson(filePath, raw, remember)) return failed(detail);
  return { ok: true, draft: readSettings(filePath).draft };
}

function toDraft(config: Config, ownBreak: boolean[]): SettingsDraft {
  return {
    ...config,
    clockTimes: config.clockTimes.map((entry, index) => ({
      time: entry.time,
      breakSeconds: ownBreak[index] === true ? entry.breakSeconds : null,
    })),
  };
}

/** Converts a draft into the form written to the file. Returns null when it is not shaped like a SettingsDraft. */
function draftToRaw(draft: unknown): Record<string, unknown> | null {
  if (!isPlainObject(draft) || !Array.isArray(draft.clockTimes)) return null;
  const raw: Record<string, unknown> = {};
  for (const key of SETTINGS_KEYS) {
    if (draft[key] === undefined) return null;
    raw[key] = draft[key];
  }
  const clockTimes: unknown[] = [];
  for (const entry of draft.clockTimes as unknown[]) {
    if (!isPlainObject(entry)) return null;
    clockTimes.push(entry.breakSeconds === null ? entry.time : { time: entry.time, breakSeconds: entry.breakSeconds });
  }
  raw.clockTimes = clockTimes;
  return raw;
}

/**
 * Reads the config file to update some keys in place. A missing file reads as the defaults.
 * Returns null and reports to stderr and `fail` when the file is broken, so that it is never overwritten.
 */
function readForUpdate(filePath: string, what: string, fail: (detail: string) => void): Record<string, unknown> | null {
  try {
    const parsed: unknown = JSON.parse(stripBom(fs.readFileSync(filePath, 'utf8')));
    if (!isPlainObject(parsed)) {
      console.error(`[config] ${filePath} is not a JSON object; ${what} not saved`);
      fail('ルートが JSON オブジェクトではありません');
      return null;
    }
    return parsed;
  } catch (err) {
    if (!isErrnoCode(err, 'ENOENT')) {
      console.error(`[config] cannot update ${filePath}: ${describe(err)}; ${what} not saved`);
      fail(describe(err));
      return null;
    }
    return { ...DEFAULT_CONFIG };
  }
}

function writeJson(filePath: string, value: unknown, onError: (detail: string) => void = () => {}): boolean {
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
    onError(describe(err));
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
