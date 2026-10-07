import test from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, readFileSync, mkdirSync, readdirSync } from 'node:fs';
import { createStateStore } from '../src/state.js';
import { fixture, message, NOW } from './helpers.js';

test('pending messages survive restarts and repeated events are deduplicated', (t) => {
  const f = fixture(t);
  assert.equal(f.store.addMessages([message('one'), message('one')]), 1);
  const restored = f.loadStore();
  assert.equal(restored.addMessages([message('one')]), 0);
  assert.deepEqual(restored.messages(), [message('one')]);
});

test('completed messages stay deduplicated after delivery and restart', async (t) => {
  const f = fixture(t);
  f.store.addMessages([message('one')]);
  await f.scanner.runScan(f.sock);
  const restored = f.loadStore();
  assert.equal(restored.addMessages([message('one')]), 0);
});

test('legacy state migration keeps the scan cursor and initializes history progress', (t) => {
  const f = fixture(t);
  const time = new Date(NOW - 1000).toISOString();
  writeFileSync(f.file, JSON.stringify({ lastScanTime: time }));
  const restored = f.loadStore();
  assert.equal(restored.getLastScanTime().toISOString(), time);
  assert.equal(restored.getHistorySince().toISOString(), time);
  restored.addMessages([message('one')]);
  assert.equal(JSON.parse(readFileSync(f.file, 'utf8')).version, 1);
});

test('invalid legacy dates use the configured lookback', (t) => {
  const f = fixture(t);
  writeFileSync(f.file, JSON.stringify({ lastScanTime: 'invalid' }));
  assert.equal(f.loadStore().getLastScanTime().getTime(), NOW - f.config.defaultLookbackMs);
});

test('corrupted and incompatible state is preserved and rejected', (t) => {
  const f = fixture(t);
  for (const content of ['{', JSON.stringify({ version: 99 }), JSON.stringify({ messages: {} }), JSON.stringify({ messages: null }), JSON.stringify({ reports: [null] }), JSON.stringify({ version: 1 })]) {
    writeFileSync(f.file, content);
    assert.throws(f.loadStore, /state|queue/);
    assert.equal(readFileSync(f.file, 'utf8'), content);
  }
});

test('failed checkpoint writes do not mutate memory or leave temporary files', (t) => {
  const f = fixture(t);
  mkdirSync(f.file);
  assert.throws(() => f.store.addMessages([message('one')]));
  assert.equal(f.store.messages().length, 0);
  assert.deepEqual(readdirSync(f.dir), ['state.json']);
});

test('fallback scans do not advance history replay progress, including after restart', async (t) => {
  const f = fixture(t);
  const floor = f.store.getHistorySince().getTime();
  await f.scanner.runScan(f.sock);
  assert.equal(f.loadStore().getHistorySince().getTime(), floor);
  f.store.completeHistory(new Date(NOW));
  assert.equal(f.loadStore().getHistorySince().getTime(), NOW);
});

test('explicit replay clears completed IDs while preserving pending delivery work', async (t) => {
  const f = fixture(t);
  f.store.addMessages([message('done')]);
  await f.scanner.runScan(f.sock);
  f.store.addMessages([message('pending')]);
  f.store.overrideLastScanTime(new Date(NOW - 3_600_000));
  assert.equal(f.store.addMessages([message('done'), message('pending')]), 1);
  assert.equal(f.store.messages().length, 2);
  assert.throws(() => f.store.overrideLastScanTime(new Date('invalid')), /Invalid/);
});

test('retention keeps IDs still replayable by a long-running connection', async (t) => {
  const f = fixture(t);
  f.store.addMessages([message('one')]);
  await f.scanner.runScan(f.sock);
  f.store.completeHistory(new Date(NOW));
  f.clock.value += 60 * 24 * 3_600_000;
  f.store.finishScan(new Date(f.clock.value));
  assert.equal(f.store.addMessages([message('one')]), 0);
  // A new process uses the newer persisted history floor and can prune old IDs.
  const restored = f.loadStore();
  restored.finishScan(new Date(f.clock.value));
  assert.equal(Object.keys(JSON.parse(readFileSync(f.file, 'utf8')).seen).length, 0);
});
