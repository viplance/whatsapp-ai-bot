import test from 'node:test';
import assert from 'node:assert/strict';
import { buildConfig, parsePeriodMs } from '../src/config-values.js';

test('duration units and defaults remain compatible', () => {
  for (const [value, ms] of [['2h', 7200000], ['1.5min', 90000], ['30s', 30000], ['500ms', 500], [2, 120000], ['0', 0]]) assert.equal(parsePeriodMs(value), ms);
  assert.equal(buildConfig({}, 'key').scanIntervalMs, 3_600_000);
  assert.equal(buildConfig({}, 'key').waitForNoActivityMs, 0);
});

test('invalid intervals, recipients and config types fail before starting', () => {
  for (const period of [0, -1, '0', '0.1ms', 'garbage', Infinity, '1000000h']) assert.throws(() => buildConfig({ period }, 'key'));
  for (const phones of [[], null, [''], ['abc'], ['123'], [true]]) assert.throws(() => buildConfig({ phones }, 'key'), /phones|recipient/);
  for (const file of [null, [], { filters: 'x' }, { defaultLookbackHours: -1 }, { defaultLookbackHours: 1e300 }, { model: '' }, { systemInstruction: null }, { summaryConcurrency: 0 }]) assert.throws(() => buildConfig(file, 'key'));
  assert.throws(() => buildConfig({}, ''), /GEMINI_API_KEY/);
});

test('phone formatting, duplicate recipients and filter whitespace are normalized', () => {
  const config = buildConfig({ phones: ['+1 (234) 567-8901', '12345678901', 'own'], filters: [' School ', ''] }, 'key');
  assert.deepEqual(config.phones, ['12345678901', 'own']);
  assert.deepEqual(config.filters, ['School']);
});
