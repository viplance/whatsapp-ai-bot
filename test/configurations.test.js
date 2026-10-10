import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { proto } from 'baileys';
import { MemoryFirestore } from './cloud-helpers.js';
import { createControl } from '../src/cloud/control.js';
import { createAdminServer } from '../src/cloud/admin.js';
import { configurationsOf, dueConfigurations, lastScheduleSlot } from '../src/cloud/configurations.js';
import { validateSettings } from '../src/cloud/settings.js';
import { runCloudWorker } from '../src/cloud/worker.js';
import { connectSession } from '../src/once.js';

const env = { configId: 'multi', projectId: 'test-project', region: 'europe-west4', summaryJob: 'summary', pairingJob: 'pair' };
const user = 'admin@example.com';
async function fixture(enabled = false) {
  const db = new MemoryFirestore(), runtimeDb = new MemoryFirestore(), calls = [];
  const value = validateSettings({ enabled, timezone: 'UTC', settings: { period: '1h', filters: ['veli'],
    phones: ['15550000001'], waitForNoActivity: '0', systemInstruction: 'first', model: 'synthetic-model' } });
  await db.doc('configs/multi').set({ ...value, activeVersion: 1, scheduleRevision: 1, appliedScheduleRevision: 1,
    scheduleStatus: 'applied', maintenance: false, authStatus: 'linked', activeOperation: null, queueCount: 0,
    createdAt: new Date().toISOString() });
  await db.doc('configs/multi/versions/1').set(value);
  await runtimeDb.doc('accounts/multi').set({ activeGeneration: 'existing' });
  const google = { reconcile: async (cfg) => { calls.push({ action: 'reconcile', cfg }); },
    start: async (mode, values) => { calls.push({ action: 'start', mode, values }); return { operation: 'synthetic-operation' }; },
    execution: async () => null, cancel: async () => true };
  const control = createControl({ db, env, google });
  const input = { ...value, enabled: false, name: 'Second configuration',
    settings: { ...value.settings, period: '4h', phones: ['15550000003'], systemInstruction: 'second' } };
  return { db, runtimeDb, control, google, calls, value, input };
}
function transport(sent, { failFirst = false, connected = () => {} } = {}) {
  return (options) => connectSession({ ...options, syncWaitMs: 5,
    getVersion: async () => ({ version: [2, 3000, 123] }), socketFactory: () => {
      connected();
      const socket = { ev: new EventEmitter(), user: { id: '15550000000@s.whatsapp.net' }, end() {},
        groupMetadata: async () => ({ subject: 'VELI GRUBU' }),
        groupFetchAllParticipating: async () => ({ one: { id: 'multi-flow@g.us', subject: 'VELI GRUBU' } }),
        sendMessage: async (jid, payload) => {
          assert.match(payload.text, /synthetic summary/);
          if (failFirst && jid === '15550000001@s.whatsapp.net') throw new Error('Synthetic send failure');
          sent.push(jid);
        } };
      setImmediate(() => {
        socket.ev.emit('connection.update', { connection: 'open' });
        socket.ev.emit('messaging-history.set', { contacts: [], chats: [{ id: 'multi-flow@g.us', name: 'VELI GRUBU' }],
          messages: [{ key: { id: 'shared-input', remoteJid: 'multi-flow@g.us', fromMe: false },
            messageTimestamp: Math.floor((Date.now() - 30 * 60000) / 1000), message: { conversation: 'Synthetic input' } }],
          syncType: proto.HistorySync.HistorySyncType.FULL, progress: 100 });
      });
      return socket;
    } });
}
async function run(f, selected, sent, options = {}) {
  const request = await f.control.start('summary', `unique-${Math.random().toString(36).slice(2)}`, user, selected);
  const cfg = await f.control.config();
  const op = (await f.control.opRef(request.id).get()).data();
  return runCloudWorker({ env, controlDb: f.db, runtimeDb: f.runtimeDb, log() {},
    variables: { REQUEST_ID: request.id, SCHEDULE_REVISION: String(cfg.scheduleRevision), CONFIGURATION_IDS: op.configurationIds.join(','), GEMINI_API_KEY: 'synthetic-key' },
    sessionFactory: transport(sent, options), summarizeFactory: ({ config }) => async () => `${config.systemInstruction} synthetic summary` });
}

test('legacy settings become the default configuration without altering the account', async () => {
  const f = await fixture();
  const overview = await f.control.overview();
  assert.equal(overview.configurations.length, 1);
  assert.equal(overview.configurations[0].id, 'default');
  assert.deepEqual(overview.configurations[0].settings, f.value.settings);
  assert.equal((await f.control.config()).configurations, undefined);
  await f.db.doc('configs/multi').update({ settings: { ...f.value.settings, period: '60min' } });
  assert.equal((await f.control.overview()).configurations[0].settings.period, '1h');
  const added = await f.control.createConfiguration({ ...f.input, settings: { ...f.input.settings, period: 240 } }, user);
  assert.equal(added.configurations[1].settings.period, '4h');
});

test('configuration CRUD preserves sibling settings and checks individual versions', async () => {
  const f = await fixture(true);
  const added = await f.control.createConfiguration(f.input, user);
  const cfg = await f.control.config();
  assert.equal(cfg.settings.period, '15min');
  assert.equal(cfg.timezone, 'UTC');
  assert.equal(added.configurations[0].settings.period, '1h');
  assert.equal(added.configurations[1].settings.period, '4h');
  assert.equal(added.configurations[0].enabled, true);
  assert.equal(added.configurations[1].enabled, false);
  await f.control.updateConfiguration('default', { ...f.value, name: 'Renamed', baseVersion: 1 }, user);
  // A sibling update must not invalidate this configuration's edit token.
  await f.control.updateConfiguration(added.id, { ...f.input, baseVersion: 1, name: 'Other' }, user);
  await assert.rejects(f.control.updateConfiguration(added.id, { ...f.input, baseVersion: 1 }, user), (error) => error.status === 409);
  const current = configurationsOf(await f.control.config());
  assert.deepEqual(current.map((item) => item.name), ['Renamed', 'Other']);
  await f.control.removeConfiguration(added.id, { baseVersion: 2 }, user);
  assert.equal(configurationsOf(await f.control.config()).length, 1);
  await f.control.removeConfiguration('default', { baseVersion: 2 }, user);
  assert.equal((await f.control.overview()).configurations.length, 0);
  assert.equal((await f.control.config()).enabled, false);
});

test('failed reconciliation retains a saved configuration and can be retried', async () => {
  const f = await fixture();
  f.google.reconcile = async () => { throw new Error('Synthetic API failure'); };
  const input = { ...f.input, idempotencyKey: 'stable-create-key' };
  await assert.rejects(f.control.createConfiguration(input, user), (error) => error.status === 503);
  assert.equal(configurationsOf(await f.control.config()).length, 2);
  assert.equal((await f.control.config()).scheduleStatus, 'error');
  f.google.reconcile = async () => {};
  await f.control.createConfiguration(input, user);
  assert.equal((await f.control.config()).scheduleStatus, 'applied');
  assert.equal(configurationsOf(await f.control.config()).length, 2, 'retrying a saved create must not duplicate it');
});

test('Run all selects paused configurations in one idempotent Job with a fixed snapshot', async () => {
  const f = await fixture();
  const added = await f.control.createConfiguration(f.input, user);
  const request = await f.control.start('summary', 'all-idempotent', user, 'all');
  const repeat = await f.control.start('summary', 'all-idempotent', user, 'all');
  assert.equal(repeat.id, request.id);
  const calls = f.calls.filter((call) => call.action === 'start');
  assert.equal(calls.length, 1);
  assert.equal(calls[0].values.CONFIGURATION_IDS, `default,${added.id}`);
  const record = (await f.control.opRef(request.id).get()).data();
  await f.control.updateConfiguration(added.id, { ...f.input, baseVersion: 1, settings: { ...f.input.settings, phones: ['15550000009'] } }, user);
  const sent = [];
  await runCloudWorker({ env, controlDb: f.db, runtimeDb: f.runtimeDb, log() {},
    variables: { REQUEST_ID: request.id, SCHEDULE_REVISION: calls[0].values.SCHEDULE_REVISION,
      CONFIGURATION_IDS: record.configurationIds.join(','), GEMINI_API_KEY: 'synthetic-key' },
    sessionFactory: transport(sent), summarizeFactory: () => async () => 'synthetic summary' });
  assert.deepEqual(sent, ['15550000001@s.whatsapp.net', '15550000003@s.whatsapp.net']);
  const completed = (await f.control.opRef(request.id).get()).data();
  assert.equal(completed.configurationResults.length, 2);
  assert.ok(completed.configurationResults.every((item) => item.status === 'succeeded'));
});

test('running one configuration collects for both but consumes only its own queue', async () => {
  const f = await fixture();
  const added = await f.control.createConfiguration(f.input, user);
  const sent = [];
  await run(f, 'default', sent);
  assert.deepEqual(sent, ['15550000001@s.whatsapp.net']);
  assert.equal((await f.runtimeDb.collection('accounts/multi/messages').get()).docs.length, 0);
  assert.equal((await f.runtimeDb.collection(`accounts/multi/configurations/${added.id}/messages`).get()).docs.length, 1);
  assert.equal(configurationsOf(await f.control.config())[1].queueCount, 1);
  await run(f, added.id, sent);
  assert.deepEqual(sent, ['15550000001@s.whatsapp.net', '15550000003@s.whatsapp.net']);
  assert.equal((await f.control.config()).queueCount, 0);
  await run(f, 'all', sent);
  assert.equal(sent.length, 2, 'replayed input must not produce duplicate reports');
});

test('one configuration failure preserves pending delivery and allows siblings to finish', async () => {
  const f = await fixture();
  await f.control.createConfiguration(f.input, user);
  const sent = [];
  await assert.rejects(run(f, 'all', sent, { failFirst: true }), /Summary or delivery failed/);
  assert.deepEqual(sent, ['15550000003@s.whatsapp.net']);
  const items = configurationsOf(await f.control.config());
  assert.equal(items[0].queueCount, 1);
  assert.equal(items[0].pendingReportCount, 1);
  assert.equal(items[1].queueCount, 0);
  await assert.rejects(f.control.removeConfiguration('default', { baseVersion: 1 }, user), /pending work/);
  await run(f, 'all', sent);
  assert.deepEqual(sent, ['15550000003@s.whatsapp.net', '15550000001@s.whatsapp.net']);
});

test('configuration selection and removal cannot bypass shared-device exclusivity', async () => {
  const f = await fixture();
  const added = await f.control.createConfiguration(f.input, user);
  await assert.rejects(f.control.start('summary', 'missing-item', user, 'does-not-exist'), (error) => error.status === 404);
  await f.control.start('summary', 'first-selection', user, 'default');
  await assert.rejects(f.control.start('summary', 'second-selection', user, added.id), (error) => error.status === 409);
  await assert.rejects(f.control.removeConfiguration(added.id, { baseVersion: 1 }, user), /active operation/);
});

test('pairing pauses all schedules and preserves configuration settings in a new version', async () => {
  const f = await fixture(true);
  await f.control.createConfiguration({ ...f.input, enabled: true }, user);
  const before = await f.control.config();
  await f.control.start('pair', 'pair-everything', user);
  const after = await f.control.config();
  assert.equal(after.enabled, false);
  assert.equal(after.activeVersion, before.activeVersion + 1);
  assert.ok(after.configurations.every((item) => !item.enabled));
  const snapshot = (await f.db.doc(`configs/multi/versions/${after.activeVersion}`).get()).data();
  assert.ok(snapshot.configurations.every((item) => !item.enabled));
  assert.deepEqual(after.configurations.map((item) => item.settings), before.configurations.map((item) => item.settings));
});

test('dispatch respects each local schedule, delayed starts, and already completed slots', () => {
  const now = new Date('2026-10-09T01:02:00Z');
  const profile = (id, period, timezone) => ({ id, enabled: true, timezone, settings: { period }, scheduleStartedAt: '2026-10-09T00:30:00Z' });
  const hourly = profile('hourly', '1h', 'UTC');
  const fourHourly = profile('four', '4h', 'UTC');
  const istanbul = profile('istanbul', '4h', 'Europe/Istanbul');
  assert.equal(lastScheduleSlot(istanbul, now), '2026-10-09T01:00:00.000Z');
  const account = { configurations: [hourly, fourHourly, istanbul] };
  assert.deepEqual(dueConfigurations(account, now).map((item) => item.id), ['hourly', 'istanbul']);
  hourly.lastScheduledSlot = '2026-10-09T01:00:00Z';
  istanbul.lastScheduledSlot = '2026-10-09T01:00:00Z';
  assert.deepEqual(dueConfigurations(account, new Date('2026-10-09T01:32:00Z')), []);
  assert.equal(lastScheduleSlot(profile('quarter-offset', '1h', 'Asia/Kathmandu'), now), '2026-10-09T00:15:00.000Z');
});

test('new intervals dispatch at local boundaries and do not repeat completed slots', () => {
  const now = new Date('2026-10-09T21:17:00Z');
  for (const period of ['15min', '8h', '24h']) {
    const profile = { id: period, enabled: true, timezone: 'Europe/Istanbul', settings: { period },
      scheduleStartedAt: '2026-10-09T20:00:00Z' };
    const slot = period === '15min' ? '2026-10-09T21:15:00.000Z' : '2026-10-09T21:00:00.000Z';
    assert.equal(lastScheduleSlot(profile, now), slot);
    assert.equal(dueConfigurations({ configurations: [profile] }, now).length, 1);
    profile.lastScheduledSlot = slot;
    assert.deepEqual(dueConfigurations({ configurations: [profile] }, now), []);
  }
});

test('scheduled workers run only due configurations and remember completed slots', async (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: Date.parse('2026-10-09T00:30:00Z') });
  const f = await fixture(true);
  const added = await f.control.createConfiguration({ ...f.input, enabled: true }, user);
  t.mock.timers.tick(32 * 60000);
  const sent = [];
  let connections = 0;
  const variables = { REQUEST_ID: 'scheduled-first', SCHEDULE_REVISION: String((await f.control.config()).scheduleRevision), GEMINI_API_KEY: 'synthetic-key' };
  const execute = (id) => runCloudWorker({ env, controlDb: f.db, runtimeDb: f.runtimeDb, log() {},
    variables: { ...variables, REQUEST_ID: id }, sessionFactory: transport(sent, { connected: () => { connections++; } }),
    summarizeFactory: () => async () => 'synthetic summary' });
  await execute('scheduled-first');
  assert.deepEqual(sent, ['15550000001@s.whatsapp.net']);
  const items = configurationsOf(await f.control.config());
  assert.equal(items[0].lastScheduledSlot, '2026-10-09T01:00:00.000Z');
  assert.equal(items[1].queueCount, 1, 'collect input for a configuration that is not due yet');
  assert.deepEqual(await execute('scheduled-same-slot'), { skipped: true });
  assert.equal(connections, 1);
  t.mock.timers.tick(180 * 60000);
  await execute('scheduled-next-slot');
  assert.deepEqual(sent, ['15550000001@s.whatsapp.net', '15550000003@s.whatsapp.net']);
  assert.equal(configurationsOf(await f.control.config()).find((item) => item.id === added.id).lastScheduledSlot, '2026-10-09T04:00:00.000Z');
});

test('HTTP configuration mutations require CSRF and dispatch item-specific runs', async (t) => {
  const f = await fixture();
  const identity = { email: user, csrf: 'a'.repeat(64) };
  const server = createAdminServer({ env, control: f.control, authenticate: async () => identity });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => server.close());
  const url = `http://127.0.0.1:${server.address().port}`;
  const headers = { origin: `https://127.0.0.1:${server.address().port}`, 'x-csrf-token': identity.csrf, 'content-type': 'application/json' };
  assert.equal((await fetch(url + '/api/configurations/default', { method: 'DELETE', body: '{}' })).status, 403);
  const response = await fetch(url + '/api/configurations', { method: 'POST', headers, body: JSON.stringify(f.input) });
  assert.equal(response.status, 201);
  const added = await response.json();
  assert.equal((await fetch(url + `/api/configurations/${added.id}`, { method: 'DELETE', headers, body: JSON.stringify({ baseVersion: 1 }) })).status, 200);
  const started = await fetch(url + '/api/configurations/default/run', { method: 'POST', headers, body: JSON.stringify({ idempotencyKey: 'http-run-item' }) });
  assert.equal(started.status, 202);
  assert.equal(f.calls.findLast((call) => call.action === 'start').values.CONFIGURATION_IDS, 'default');
});
