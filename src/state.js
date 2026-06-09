import { readFileSync, writeFileSync, existsSync } from 'fs';
import { config, STATE_FILE } from './config.js';

export function loadLastScanTime() {
  if (existsSync(STATE_FILE)) {
    try {
      const { lastScanTime } = JSON.parse(readFileSync(STATE_FILE, 'utf8'));
      return new Date(lastScanTime);
    } catch {
      // fall through to default
    }
  }
  return new Date(Date.now() - config.defaultLookbackMs);
}

export function saveLastScanTime(date) {
  writeFileSync(
    STATE_FILE,
    JSON.stringify({ lastScanTime: date.toISOString() }),
    'utf8',
  );
}
