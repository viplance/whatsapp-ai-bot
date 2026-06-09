import 'dotenv/config';
import { readFileSync, existsSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const CONFIG_FILE = join(ROOT, 'config.json');

// Filesystem paths (not user-tunable, kept here so every module agrees).
export const AUTH_FOLDER = join(ROOT, 'auth_info_baileys');
export const STATE_FILE = join(ROOT, 'scan-state.json');

// Defaults applied when config.json omits a field.
const DEFAULTS = {
  period: '60min',
  waitForNoActivity: '0',
  filters: [],
  phones: ['own'],
  model: 'gemini-2.0-flash',
  showScanLogs: true,
  defaultLookbackHours: 24,
  systemInstruction: '',
};

/**
 * Parse a human period like "10min", "2h", "30s", "500ms" into milliseconds.
 * A bare number is treated as minutes for backwards-friendliness.
 */
export function parsePeriodMs(period) {
  if (typeof period === 'number') return period * 60 * 1000;

  const match = String(period).trim().match(/^(\d+(?:\.\d+)?)\s*(ms|s|min|m|h)?$/i);
  if (!match) {
    throw new Error(`Invalid period "${period}" in config.json (e.g. "10min", "2h", "30s")`);
  }

  const value = parseFloat(match[1]);
  const unit = (match[2] || 'min').toLowerCase();
  const factor = { ms: 1, s: 1000, min: 60_000, m: 60_000, h: 3_600_000 }[unit];
  return Math.round(value * factor);
}

function loadConfigFile() {
  if (!existsSync(CONFIG_FILE)) {
    console.error(
      'Missing config.json. Copy config.json.example to config.json and adjust it.',
    );
    process.exit(1);
  }

  try {
    return JSON.parse(readFileSync(CONFIG_FILE, 'utf8'));
  } catch (err) {
    console.error(`Failed to parse config.json: ${err.message}`);
    process.exit(1);
  }
}

function buildConfig() {
  const file = loadConfigFile();
  const merged = { ...DEFAULTS, ...file };

  const geminiApiKey = process.env.GEMINI_API_KEY;
  if (!geminiApiKey) {
    console.error('Missing GEMINI_API_KEY in .env');
    process.exit(1);
  }

  return {
    geminiApiKey,
    model: merged.model,
    systemInstruction: merged.systemInstruction,
    period: merged.period,
    scanIntervalMs: parsePeriodMs(merged.period),
    waitForNoActivity: merged.waitForNoActivity,
    waitForNoActivityMs: parsePeriodMs(merged.waitForNoActivity),
    filters: Array.isArray(merged.filters) ? merged.filters : [],
    phones: Array.isArray(merged.phones) ? merged.phones : [merged.phones],
    showScanLogs: merged.showScanLogs !== false,
    defaultLookbackMs: merged.defaultLookbackHours * 60 * 60 * 1000,
  };
}

export const config = buildConfig();
