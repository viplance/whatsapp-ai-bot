import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { proto } from 'baileys';
import { createWhatsAppService } from '../src/whatsapp.js';
import { createIngestor } from '../src/ingestion.js';
import { createFilters } from '../src/filters.js';
import { fixture, waMessage, NOW, FakeTimers, logger, deferred } from './helpers.js';

async function emitAsync(sock, name, data) {
  await Promise.all(sock.ev.listeners(name).map((listener) => listener(data)));
}
function serviceFixture(t, options = {}) {
  const f = fixture(t, options);
  const timers = new FakeTimers(), sockets = [];
  const service = createWhatsAppService({
    config: f.config, authFolder: 'unused-test-auth', store: f.store, scanner: f.scanner,
    timers, logger, now: () => new Date(f.clock.value),
    loadAuth: async () => ({ state: {}, saveCreds: async () => {} }),
    getVersion: async () => ({ version: [1, 2, 3] }),
    makeSocket: () => { const sock = { ...f.sock, ev: new EventEmitter(), end() {} }; sockets.push(sock); return sock; },
    ...options.service,
  });
  t.after(() => service.stop());
  return { ...f, timers, sockets, service };
}

test('history arriving after fallback is still ingested and reported', async (t) => {
  const f = serviceFixture(t);
  await f.service.start();
  const sock = f.sockets[0];
  const floor = f.store.getHistorySince().getTime();
  await emitAsync(sock, 'connection.update', { connection: 'open' });
  await f.timers.fire(75_000);
  await f.scanner.runScan(sock);
  assert.equal(f.store.getLastScanTime().getTime(), NOW);
  assert.equal(f.loadStore().getHistorySince().getTime(), floor);
  await emitAsync(sock, 'messaging-history.set', { messages: [waMessage('history')], progress: 100, syncType: proto.HistorySync.HistorySyncType.FULL });
  await f.scanner.runScan(sock);
  assert.equal(f.sent.length, 1);
  assert.equal(f.store.messages().length, 0);
  assert.equal(f.loadStore().getHistorySince().getTime(), NOW);
});

test('history batches are serialized before final history completion', async (t) => {
  const metadata = deferred();
  const f = serviceFixture(t, { config: { filters: ['school'] } });
  await f.service.start();
  const sock = f.sockets[0];
  sock.groupMetadata = async () => metadata.promise;
  await emitAsync(sock, 'connection.update', { connection: 'open' });
  const jid = 'serialized-history-test@g.us';
  const first = emitAsync(sock, 'messaging-history.set', { messages: [waMessage('one', { jid })], isLatest: false });
  const final = emitAsync(sock, 'messaging-history.set', { messages: [waMessage('two', { jid })], progress: 100, syncType: proto.HistorySync.HistorySyncType.FULL });
  await Promise.resolve();
  assert.equal(f.store.messages().length, 0);
  assert.ok(f.store.getHistorySince().getTime() < NOW);
  metadata.resolve({ subject: 'School' });
  await Promise.all([first, final]);
  await f.scanner.runScan(sock);
  assert.equal(f.sent.length, 1);
  assert.match(f.sent[0].text, /\(2\)/);
});

test('disconnect cancels scans and timers, and reconnect does not stack sockets', async (t) => {
  const signals = [], scans = [];
  const f = serviceFixture(t, { service: { scanner: { runScan: async (sock, { signal }) => { signals.push(signal); scans.push(sock); } } } });
  await f.service.start();
  await f.service.start();
  assert.equal(f.sockets.length, 1);
  const old = f.sockets[0];
  await emitAsync(old, 'connection.update', { connection: 'open' });
  await f.timers.fire(75_000);
  await emitAsync(old, 'connection.update', { connection: 'close', lastDisconnect: { error: new Error('offline') } });
  assert.equal(signals[0].aborted, true);
  assert.equal([...f.timers.tasks.values()].filter((task) => task.repeat).length, 0);
  await f.timers.fire(5000);
  await f.service.start();
  // Auth/version setup resumes in microtasks after the reconnect timer.
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(f.sockets.length, 2);
  const current = f.sockets[1];
  await emitAsync(current, 'connection.update', { connection: 'open' });
  await f.timers.fire(75_000);
  const count = scans.length;
  await emitAsync(old, 'messaging-history.set', { messages: [waMessage('obsolete')], isLatest: true });
  assert.equal(scans.length, count);
  assert.equal(f.store.messages().length, 0);
  assert.equal([...f.timers.tasks.values()].filter((task) => task.repeat).length, 1);
});

test('failed startup is retried and stopping cancels the retry', async (t) => {
  let calls = 0;
  const f = serviceFixture(t, { service: { getVersion: async () => { calls++; throw new Error('offline'); } } });
  await f.service.start();
  assert.equal(calls, 1);
  await f.timers.fire(5000);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(calls, 2);
  f.service.stop();
  await f.timers.fire(5000);
  assert.equal(calls, 2);
});

test('isLatest and partial history progress do not advance the replay checkpoint', async (t) => {
  const f = serviceFixture(t);
  await f.service.start();
  const sock = f.sockets[0];
  const floor = f.store.getHistorySince().getTime();
  await emitAsync(sock, 'connection.update', { connection: 'open' });
  for (const event of [
    { isLatest: true, syncType: proto.HistorySync.HistorySyncType.INITIAL_BOOTSTRAP },
    { progress: 100, syncType: proto.HistorySync.HistorySyncType.RECENT },
    { progress: 50, syncType: proto.HistorySync.HistorySyncType.FULL },
  ]) {
    await emitAsync(sock, 'messaging-history.set', { messages: [], ...event });
    assert.equal(f.loadStore().getHistorySince().getTime(), floor);
  }
  assert.equal([...f.timers.tasks.values()].filter((task) => task.ms === 75_000).length, 1);
});

test('ingestion deduplicates live/history overlap and rejects invalid messages and own reports', async (t) => {
  const f = fixture(t);
  const ingest = createIngestor({ store: f.store, filters: createFilters([]) });
  const regular = waMessage('regular');
  assert.equal(await ingest([regular, { ...regular, key: {} }, waMessage('bad-date', { age: NaN }), waMessage('report', { fromMe: true, text: '📝 *ОТЧЁТ ПО ЧАТАМ*\nsummary' })]), 1);
  assert.equal(await ingest([regular], { historySince: f.store.getHistorySince() }), 0);
  const wrapped = waMessage('wrapped');
  wrapped.message = { ephemeralMessage: { message: { extendedTextMessage: { text: 'wrapped text' } } } };
  assert.equal(await ingest([wrapped]), 1);
  assert.equal(f.store.messages().at(-1).text, 'wrapped text');
});
