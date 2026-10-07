import test from 'node:test';
import assert from 'node:assert/strict';
import { fixture, message, deferred } from './helpers.js';

test('failed summaries remain queued while successful chats are acknowledged', async (t) => {
  const f = fixture(t, { summarizeChat: async (_, label) => label === 'failed' ? null : 'summary' });
  f.store.addMessages([message('1', { jid: 'good' }), message('2', { jid: 'failed' })]);
  await f.scanner.runScan(f.sock);
  assert.deepEqual(f.store.messages().map((m) => m.jid), ['failed']);
  assert.equal(f.sent.length, 1);
  assert.doesNotMatch(f.sent[0].text, /failed/);
});

test('late messages inside the scan window survive exact acknowledgment', async (t) => {
  const f = fixture(t);
  f.store.addMessages([message('first')]);
  const scan = f.makeScanner({ summarizeChat: async (messages) => {
    assert.equal(messages.length, 1);
    f.store.addMessages([message('late', { age: 30_000 })]);
    return 'summary';
  } });
  await scan.runScan(f.sock);
  assert.deepEqual(f.store.messages().map((m) => m.id), [message('late').id]);
});

test('overlapping triggers share one scan and one delivery', async (t) => {
  const gate = deferred();
  let calls = 0;
  const f = fixture(t, { summarizeChat: async () => { calls++; await gate.promise; return 'summary'; } });
  f.store.addMessages([message('one')]);
  const first = f.scanner.runScan(f.sock);
  const second = f.scanner.runScan(f.sock);
  assert.equal(first, second);
  gate.resolve();
  await Promise.all([first, second]);
  assert.equal(calls, 1);
  assert.equal(f.sent.length, 1);
});

test('inactivity uses the newest timestamp, independently of arrival order', async (t) => {
  const f = fixture(t, { config: { waitForNoActivity: '1min' } });
  f.store.addMessages([message('recent', { age: 1000 }), message('old', { age: 120_000 })]);
  await f.scanner.runScan(f.sock);
  assert.equal(f.sent.length, 0);
  assert.equal(f.store.messages().length, 2);
  f.clock.value += 60_000;
  let order;
  await f.makeScanner({ summarizeChat: async (messages) => { order = messages.map((m) => m.id); return 'summary'; } }).runScan(f.sock);
  assert.deepEqual(order, [message('old').id, message('recent').id]);
  assert.equal(f.store.messages().length, 0);
});

test('partial delivery persists across restart and retries only missing recipients', async (t) => {
  let calls = 0;
  const f = fixture(t, { config: { phones: ['11111111111', '22222222222'] }, summarizeChat: async () => { calls++; return 'stable summary'; } });
  f.store.addMessages([message('one')]);
  let failed = true;
  f.sock.sendMessage = async (jid, payload) => {
    if (jid.startsWith('222') && failed) throw new Error('offline');
    f.sent.push({ jid, text: payload.text });
  };
  await f.scanner.runScan(f.sock);
  assert.equal(f.store.messages().length, 1);
  assert.equal(f.store.reports()[0].recipients[0].nextPart, 1);
  failed = false;
  const restored = f.loadStore();
  await f.makeScanner({ store: restored }).runScan(f.sock);
  assert.deepEqual(f.sent.map((m) => m.jid), ['11111111111@s.whatsapp.net', '22222222222@s.whatsapp.net']);
  assert.equal(f.sent[0].text, f.sent[1].text);
  assert.equal(calls, 1);
  assert.equal(restored.messages().length, 0);
  assert.equal(restored.reports().length, 0);
});

test('multipart reports resume after the last successful part', async (t) => {
  const f = fixture(t, { summarizeChat: async () => '😀 Important detail. '.repeat(500) });
  f.store.addMessages([message('one')]);
  let attempts = 0;
  f.sock.sendMessage = async (jid, payload) => {
    if (++attempts === 2) throw new Error('offline');
    f.sent.push({ jid, text: payload.text });
  };
  await f.scanner.runScan(f.sock);
  const report = f.store.reports()[0];
  assert.ok(report.parts.length > 2);
  assert.equal(report.recipients[0].nextPart, 1);
  await f.scanner.runScan(f.sock);
  assert.deepEqual(f.sent.map((m) => m.text), report.parts);
  assert.ok(f.sent.every((m) => m.text.length <= 3500 && m.text.isWellFormed()));
  assert.equal(f.store.messages().length, 0);
});

test('messages older than the scan cursor are processed rather than stranded', async (t) => {
  const f = fixture(t);
  await f.scanner.runScan(f.sock);
  f.store.addMessages([message('delayed', { age: 2 * 24 * 3_600_000 })]);
  await f.scanner.runScan(f.sock);
  assert.equal(f.sent.length, 1);
  assert.equal(f.store.messages().length, 0);
});

test('no recipients and disconnected sockets preserve messages', async (t) => {
  const f = fixture(t);
  f.store.addMessages([message('one')]);
  await assert.rejects(f.makeScanner({ config: { ...f.config, phones: [] } }).runScan(f.sock), /recipient/);
  await assert.rejects(f.scanner.runScan({}), /connected/);
  assert.equal(f.store.messages().length, 1);
});

test('one thrown summarization error does not discard either chat', async (t) => {
  const f = fixture(t, { summarizeChat: async (_, label) => { if (label === 'failed') throw new Error('bad'); return 'summary'; } });
  f.store.addMessages([message('one', { jid: 'good' }), message('two', { jid: 'failed' })]);
  await f.scanner.runScan(f.sock);
  assert.deepEqual(f.store.messages().map((m) => m.jid), ['failed']);
  assert.equal(f.sent.length, 1);
});

test('cancellation preserves input and a new socket waits for all workers', async (t) => {
  const entered = deferred(), gate = deferred();
  let calls = 0;
  const f = fixture(t, { summarizeChat: async () => { if (++calls === 1) { entered.resolve(); await gate.promise; } return 'summary'; } });
  f.store.addMessages([message('one')]);
  const controller = new AbortController();
  const oldScan = f.scanner.runScan(f.sock, { signal: controller.signal });
  const rejection = assert.rejects(oldScan, { name: 'AbortError' });
  await entered.promise;
  controller.abort();
  const newSocket = { ...f.sock };
  const newScan = f.scanner.runScan(newSocket);
  await Promise.resolve();
  assert.equal(calls, 1);
  gate.resolve();
  await rejection;
  await newScan;
  assert.equal(calls, 2);
  assert.equal(f.sent.length, 1);
});

test('chat concurrency stays within the configured bound', async (t) => {
  const gate = deferred(), entered = deferred();
  let active = 0, maximum = 0;
  const f = fixture(t, { config: { summaryConcurrency: 2 }, summarizeChat: async () => {
    active++; maximum = Math.max(maximum, active);
    if (active === 2) entered.resolve();
    await gate.promise;
    active--;
    return 'summary';
  } });
  f.store.addMessages(Array.from({ length: 6 }, (_, i) => message(String(i), { jid: `chat${i}` })));
  const scan = f.scanner.runScan(f.sock);
  await entered.promise;
  assert.equal(maximum, 2);
  gate.resolve();
  await scan;
  assert.equal(maximum, 2);
  assert.equal(f.store.messages().length, 0);
});

test('large chat batches leave the remainder for the next scan', async (t) => {
  const sizes = [];
  const f = fixture(t, { summarizeChat: async (messages) => { sizes.push(messages.length); return 'summary'; } });
  f.store.addMessages(Array.from({ length: 3 }, (_, i) => message(String(i), { text: 'x'.repeat(12000) })));
  await f.scanner.runScan(f.sock);
  assert.equal(f.store.messages().length, 1);
  await f.scanner.runScan(f.sock);
  assert.deepEqual(sizes, [2, 1]);
  assert.equal(f.store.messages().length, 0);
});

test('disconnect after a confirmed send preserves recipient progress before aborting', async (t) => {
  const f = fixture(t, { config: { phones: ['11111111111', '22222222222'] } });
  const controller = new AbortController();
  f.store.addMessages([message('one')]);
  f.sock.sendMessage = async (jid, payload) => {
    f.sent.push({ jid, text: payload.text });
    controller.abort();
  };
  await assert.rejects(f.scanner.runScan(f.sock, { signal: controller.signal }), { name: 'AbortError' });
  const restored = f.loadStore();
  assert.equal(restored.reports()[0].recipients[0].nextPart, 1);
  const newSocket = { user: f.sock.user, sendMessage: async (jid, payload) => f.sent.push({ jid, text: payload.text }) };
  await f.makeScanner({ store: restored }).runScan(newSocket);
  assert.deepEqual(f.sent.map((m) => m.jid), ['11111111111@s.whatsapp.net', '22222222222@s.whatsapp.net']);
  assert.equal(restored.messages().length, 0);
});

test('failed final acknowledgment retries cleanup without resending delivered text', async (t) => {
  const f = fixture(t);
  f.store.addMessages([message('one')]);
  const original = f.store.acknowledgeReport;
  f.store.acknowledgeReport = () => { throw new Error('checkpoint failed'); };
  await assert.rejects(f.scanner.runScan(f.sock), /checkpoint failed/);
  assert.equal(f.store.reports()[0].recipients[0].nextPart, 1);
  assert.equal(f.store.messages().length, 1);
  f.store.acknowledgeReport = original;
  await f.scanner.runScan(f.sock);
  assert.equal(f.sent.length, 1);
  assert.equal(f.store.messages().length, 0);
});

test('report checkpoint failure prevents sending and preserves input for retry', async (t) => {
  const f = fixture(t);
  f.store.addMessages([message('one')]);
  const original = f.store.enqueueReport;
  f.store.enqueueReport = () => { throw new Error('checkpoint failed'); };
  await assert.rejects(f.scanner.runScan(f.sock), /checkpoint failed/);
  assert.equal(f.sent.length, 0);
  assert.equal(f.store.messages().length, 1);
  f.store.enqueueReport = original;
  await f.scanner.runScan(f.sock);
  assert.equal(f.sent.length, 1);
  assert.equal(f.store.messages().length, 0);
});
