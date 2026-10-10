import { HttpError, validateSettings } from './settings.js';
import { parsePeriodMs } from '../config-values.js';

export const DEFAULT_CONFIGURATION_ID = 'default';
export const MAX_CONFIGURATIONS = 20;
const canonicalPeriod = (period) => ({ 900000: '15min', 1800000: '30min', 3600000: '1h', 14400000: '4h', 28800000: '8h', 86400000: '24h' }[parsePeriodMs(period)] || period);
export function configurationId(id) {
  if (typeof id !== 'string' || !/^[a-z0-9-]{1,60}$/.test(id)) throw new HttpError(400, 'Invalid configuration ID.');
  return id;
}

// Existing accounts retain their settings, queue, report progress and history.
export function configurationsOf(account) {
  if (Array.isArray(account.configurations)) return account.configurations;
  return [Object.fromEntries(Object.entries({ id: DEFAULT_CONFIGURATION_ID, name: 'Default configuration', version: account.activeVersion,
    enabled: account.enabled, timezone: account.timezone, settings: { ...account.settings, period: canonicalPeriod(account.settings.period) },
    ...(account.workspaceId ? { workspaceId: account.workspaceId, deviceId: account.deviceId } : {}),
    createdAt: account.createdAt, queueCount: account.queueCount, queueOldestAt: account.queueOldestAt,
    lastSuccessfulRunAt: account.lastSuccessfulRunAt }).filter(([, value]) => value !== undefined))];
}

export function validateConfiguration(input) {
  if (typeof input?.name !== 'string' || !input.name.trim() || input.name.trim().length > 100) {
    throw new HttpError(400, 'A configuration name of 1–100 characters is required.');
  }
  const value = { ...validateSettings(input), name: input.name.trim() };
  value.settings.period = canonicalPeriod(value.settings.period);
  if (Buffer.byteLength(JSON.stringify(value)) > 40000) throw new HttpError(400, 'Configuration exceeds the supported size.');
  return value;
}

export function withConfigurations(account, configurations) {
  return { ...account, configurations, enabled: configurations.some((item) => item.enabled),
    // One shared Scheduler dispatches configurations using their own local times.
    settings: { ...account.settings, period: '15min' }, timezone: 'UTC',
    activeVersion: account.activeVersion + 1, scheduleRevision: account.scheduleRevision + 1,
    scheduleStatus: 'pending' };
}

export function configurationSnapshot(account) {
  return { enabled: account.enabled, timezone: account.timezone, settings: account.settings,
    ...(account.workspaceId ? { workspaceId: account.workspaceId, deviceId: account.deviceId } : {}),
    ...(account.configurations ? { configurations: account.configurations } : {}) };
}

export function lastScheduleSlot(configuration, now = new Date()) {
  // Locate a local wall-clock boundary even when the shared Job starts late.
  const period = parsePeriodMs(configuration.settings.period) / 60000;
  if (![15, 30, 60, 240, 480, 1440].includes(period)) return null;
  const format = new Intl.DateTimeFormat('en-GB', { timeZone: configuration.timezone,
    hourCycle: 'h23', hour: '2-digit', minute: '2-digit' });
  for (let time = Math.floor(now.getTime() / 60000) * 60000; time >= now.getTime() - 48 * 3600000; time -= 60000) {
    const parts = format.formatToParts(time);
    const hour = Number(parts.find((part) => part.type === 'hour').value);
    const minute = Number(parts.find((part) => part.type === 'minute').value);
    if ((period < 60 && minute % period === 0)
      || (period >= 60 && minute === 0 && hour % (period / 60) === 0)) return new Date(time).toISOString();
  }
  return null;
}

export function dueConfigurations(account, now = new Date()) {
  return configurationsOf(account).flatMap((item) => {
    if (!item.enabled) return [];
    const slot = lastScheduleSlot(item, now);
    const after = item.lastScheduledSlot || item.scheduleStartedAt || item.createdAt || account.createdAt;
    return slot && (!after || Date.parse(slot) > Date.parse(after)) ? [{ ...item, scheduledSlot: slot }] : [];
  });
}
