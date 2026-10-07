const DEFAULTS = {
  period: '60min',
  waitForNoActivity: '0',
  filters: [],
  phones: ['own'],
  model: 'gemini-2.5-flash',
  showScanLogs: true,
  defaultLookbackHours: 24,
  systemInstruction: '',
  summaryConcurrency: 2,
};

export function parsePeriodMs(period) {
  let ms;
  if (typeof period === 'number') ms = period * 60_000;
  else {
    const match = typeof period === 'string'
      && period.trim().match(/^(\d+(?:\.\d+)?)\s*(ms|s|min|m|h)?$/i);
    if (!match) throw new Error(`Invalid period "${period}"`);
    ms = Number(match[1]) * { ms: 1, s: 1000, min: 60_000, m: 60_000, h: 3_600_000 }[(match[2] || 'min').toLowerCase()];
  }
  if (!Number.isFinite(ms) || ms < 0 || ms > 2_147_483_647) {
    throw new Error(`Period is outside the supported timer range: "${period}"`);
  }
  return Math.round(ms);
}

export function buildConfig(file, geminiApiKey) {
  if (!file || typeof file !== 'object' || Array.isArray(file)) throw new Error('config.json must contain an object');
  const merged = { ...DEFAULTS, ...file };
  if (typeof geminiApiKey !== 'string' || !geminiApiKey.trim()) throw new Error('Missing GEMINI_API_KEY in .env');
  const scanIntervalMs = parsePeriodMs(merged.period);
  if (scanIntervalMs < 1000) throw new Error('period must be at least 1 second');
  const waitForNoActivityMs = parsePeriodMs(merged.waitForNoActivity);
  const defaultLookbackMs = merged.defaultLookbackHours * 3_600_000;
  if (typeof merged.defaultLookbackHours !== 'number' || !Number.isFinite(defaultLookbackMs)
    || defaultLookbackMs <= 0 || defaultLookbackMs > 8_000_000_000_000_000) {
    throw new Error('defaultLookbackHours must be a positive number within the supported date range');
  }
  if (!Array.isArray(merged.filters) || merged.filters.some((f) => typeof f !== 'string')) {
    throw new Error('filters must be an array of strings');
  }
  const phones = Array.isArray(merged.phones) ? merged.phones : [merged.phones];
  if (!phones.length) throw new Error('phones must contain at least one recipient');
  const normalizedPhones = phones.map((phone) => {
    if (phone === 'own') return phone;
    if (!['string', 'number'].includes(typeof phone) || !/^\+?[\d\s().-]+$/.test(String(phone))) {
      throw new Error(`Invalid recipient: "${phone}"`);
    }
    const digits = String(phone).replace(/\D/g, '');
    if (!/^\d{7,15}$/.test(digits)) throw new Error(`Invalid recipient: "${phone}" (use an international phone number)`);
    return digits;
  });
  if (typeof merged.model !== 'string' || !merged.model.trim()) throw new Error('model must be a nonempty string');
  if (typeof merged.systemInstruction !== 'string') throw new Error('systemInstruction must be a string');
  if (typeof merged.showScanLogs !== 'boolean') throw new Error('showScanLogs must be a boolean');
  if (!Number.isInteger(merged.summaryConcurrency) || merged.summaryConcurrency < 1 || merged.summaryConcurrency > 10) {
    throw new Error('summaryConcurrency must be between 1 and 10');
  }
  return {
    ...merged, geminiApiKey: geminiApiKey.trim(), model: merged.model.trim(),
    filters: merged.filters.map((f) => f.trim()).filter(Boolean),
    phones: [...new Set(normalizedPhones)], scanIntervalMs, waitForNoActivityMs,
    defaultLookbackMs,
  };
}
