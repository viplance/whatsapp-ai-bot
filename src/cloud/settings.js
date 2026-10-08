import { buildConfig, parsePeriodMs } from '../config-values.js';

export class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

export const SETTINGS_KEYS = ['period', 'waitForNoActivity', 'filters', 'phones', 'model',
  'systemInstruction', 'summaryConcurrency', 'defaultLookbackHours', 'showScanLogs'];

export function scheduleFor(period) {
  const cron = { 1800000: '*/30 * * * *', 3600000: '0 * * * *', 14400000: '0 */4 * * *' }[parsePeriodMs(period)];
  if (!cron) throw new HttpError(400, 'Cloud schedules support 30min, 1h, or 4h.');
  return cron;
}

export function validateSettings(input) {
  try {
    if (!input || typeof input !== 'object' || Array.isArray(input)
      || typeof input.enabled !== 'boolean' || typeof input.timezone !== 'string'
      || !input.settings || Object.keys(input.settings).some((key) => !SETTINGS_KEYS.includes(key))) {
      throw new Error('Expected enabled, timezone, and supported bot settings.');
    }
    new Intl.DateTimeFormat('en', { timeZone: input.timezone }).format();
    const config = buildConfig(input.settings, 'validation-only');
    scheduleFor(config.period);
    if (config.systemInstruction.length > 16000 || config.filters.length > 100 || config.phones.length > 20) {
      throw new Error('Settings exceed the supported size.');
    }
    return { enabled: input.enabled, timezone: input.timezone,
      settings: Object.fromEntries(SETTINGS_KEYS.map((key) => [key, config[key]])) };
  } catch (error) { throw new HttpError(400, error.message); }
}

export function nextRunAt(settings, now = new Date()) {
  if (!settings?.enabled || settings.maintenance || settings.scheduleStatus !== 'applied') return null;
  const ms = parsePeriodMs(settings.settings.period);
  const format = new Intl.DateTimeFormat('en-GB', { timeZone: settings.timezone, hourCycle: 'h23', hour: '2-digit', minute: '2-digit' });
  for (let time = Math.floor(now.getTime() / 60000) * 60000 + 60000; time <= now.getTime() + 48 * 3600000; time += 60000) {
    const parts = format.formatToParts(time);
    const hour = Number(parts.find((p) => p.type === 'hour').value);
    const minute = Number(parts.find((p) => p.type === 'minute').value);
    if ((ms === 1800000 && minute % 30 === 0) || (ms === 3600000 && minute === 0)
      || (ms === 14400000 && minute === 0 && hour % 4 === 0)) return new Date(time).toISOString();
  }
  return null;
}
