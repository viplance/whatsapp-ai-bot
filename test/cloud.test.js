import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { proto, DisconnectReason, generateLoginNode } from 'baileys';
import { MemoryFirestore } from './cloud-helpers.js';
import { message, waMessage, NOW } from './helpers.js';
import { acquireLease, LeaseLostError } from '../src/cloud/lease.js';
import { createFirestoreState } from '../src/cloud/firestore-state.js';
import { documentId } from '../src/cloud/firestore-state.js';
import { createFirestoreAuth } from '../src/cloud/firestore-auth.js';
import { createControl } from '../src/cloud/control.js';
import { createAdminAuthenticator, checkMutation } from '../src/cloud/admin-auth.js';
import { createAdminServer } from '../src/cloud/admin.js';
import { validateSettings, nextRunAt, scheduleFor, HttpError } from '../src/cloud/settings.js';
import { connectSession, NeedsPairingError } from '../src/once.js';
import { runCloudWorker } from '../src/cloud/worker.js';
import { silenceDependencyConsole } from '../src/cloud/logging.js';
import { createSessionLogger } from '../src/session-logger.js';
import { buildConfig } from '../src/config-values.js';

const env = { projectId: 'test-project', region: 'europe-west4', configId: 'test', summaryJob: 'summary', pairingJob: 'pair', adminEmails: ['admin@example.com'], iapAudience: 'audience' };

test('cloud mode suppresses dependency session dumps and restores console afterward', (t) => {
  const printed = [];
  t.mock.method(console, 'info', (...values) => printed.push(values));
  const restore = silenceDependencyConsole();
  try { console.info('Closing session:', { privateKey: 'synthetic-secret' }); }
  finally { restore(); }
  assert.equal(printed.length, 0);
  console.info('restored');
  assert.deepEqual(printed, [['restored']]);
});

test('session logger emits only allowlisted events without serializing provider data', () => {
  const events = [];
  const logger = createSessionLogger((event) => events.push(event));
  const secret = { toJSON() { throw new Error('Provider data must never be serialized'); } };
  logger.error(secret, 'failed to decrypt message');
  logger.child({ privateKey: 'synthetic-secret' }).info(secret, 'got history notification');
  logger.error(secret, 'untrusted message containing synthetic-secret');
  assert.deepEqual(events, [{ event: 'whatsapp_decryption_failed' }, { event: 'whatsapp_history_notification' }]);
});
async function fixture() {
  const db = new MemoryFirestore();
  const settings = validateSettings({ enabled: false, timezone: 'Europe/Istanbul', settings: { period: '4h' } });
  const cfg = { ...settings, activeVersion: 1, scheduleRevision: 1, appliedScheduleRevision: 1, scheduleStatus: 'applied', maintenance: false, authStatus: 'needsPairing', activeOperation: null };
  await db.doc('configs/test').set(cfg);
  await db.doc('configs/test/versions/1').set(settings);
  const calls = [];
  const google = { reconcile: async (value) => calls.push(['reconcile', value.enabled]), start: async (mode) => { calls.push(['start', mode]); return { operation: 'operation', execution: 'execution' }; }, execution: async () => null, cancel: async () => true };
  const control = createControl({ db, env, google });
  return { db, control, calls, google, cfg };
}
async function stateFixture() {
  const db = new MemoryFirestore();
  const lease = await acquireLease({ db, configId: 'test' });
  const load = () => createFirestoreState({ db, configId: 'test', lease, defaultLookbackMs: 86400000, now: () => NOW });
  return { db, lease, load, store: await load() };
}

test('expired lease fences old writes even when the execution ID is reused', async () => {
  const db = new MemoryFirestore(); let now = 100;
  const first = await acquireLease({ db, configId: 'test', owner: 'same', now: () => now, ttlMs: 10 });
  assert.equal(await acquireLease({ db, configId: 'test', now: () => now }), null);
  now = 111;
  const second = await acquireLease({ db, configId: 'test', owner: 'same', now: () => now });
  await assert.rejects(first.write((tx) => tx.set(db.doc('accounts/test'), { bad: true })), LeaseLostError);
  await first.release();
  await second.renew();
  assert.equal(second.token, 2);
});

test('cloud queue resumes a partially delivered report after a crash and deduplicates replay', async () => {
  const { store, load } = await stateFixture();
  const entries = [message('a'), message('b'), message('c')];
  await store.addMessages(entries);
  await store.enqueueReport({ id: 'report', messageIds: entries.slice(0, 2).map((m) => m.id), parts: ['first', 'second'], recipients: [{ jid: 'own', nextPart: 0 }] });
  await store.recordDelivery('report', 'own', 1);
  const resumed = await load();
  assert.equal(resumed.reports()[0].recipients[0].nextPart, 1);
  await assert.rejects(resumed.acknowledgeReport('report'), /undelivered/);
  await resumed.recordDelivery('report', 'own', 2);
  await resumed.acknowledgeReport('report');
  assert.deepEqual(resumed.messages().map((m) => m.id), [entries[2].id]);
  assert.equal(await resumed.addMessages(entries), 0);
  assert.equal((await load()).messages().length, 1);
});

test('failed cloud persistence never acknowledges queued work', async () => {
  const { store, lease, load } = await stateFixture();
  await store.addMessages([message('a')]);
  await lease.release();
  await assert.rejects(store.enqueueReport({ id: 'r', messageIds: [message('a').id], parts: ['text'], recipients: [{ jid: 'own', nextPart: 0 }] }), LeaseLostError);
  assert.equal(store.reports().length, 0);
  assert.equal((await load()).messages().length, 1);
});

test('Firestore auth round-trips encryption buffers, app-state keys and deletion', async () => {
  const { db, lease } = await stateFixture();
  const options = { db, lease, configId: 'test', generation: 'new-session' };
  const auth = await createFirestoreAuth(options);
  const expected = Buffer.from(auth.state.creds.noiseKey.private);
  await auth.saveCreds();
  await auth.state.keys.set({ session: { first: { key: Buffer.from([1, 2]) } }, 'app-state-sync-key': { app: { keyData: Buffer.from([3]) } } });
  const restored = await createFirestoreAuth(options);
  assert.deepEqual(restored.state.creds.noiseKey.private, expected);
  assert.deepEqual((await restored.state.keys.get('session', ['first'])).first.key, Buffer.from([1, 2]));
  assert.deepEqual((await restored.state.keys.get('app-state-sync-key', ['app'])).app.keyData, Buffer.from([3]));
  await restored.state.keys.set({ session: { first: null } });
  assert.deepEqual(await auth.state.keys.get('session', ['first']), {});
});

test('imported filename-normalized keys resolve original IDs and cannot reappear after deletion', async () => {
  const { db, lease } = await stateFixture();
  const options = { db, lease, configId: 'test', generation: 'legacy' };
  const auth = await createFirestoreAuth(options);
  await auth.saveCreds();
  const root = db.doc('accounts/test/sessions/legacy');
  await root.update({ legacyKeys: true });
  await root.collection('keys').doc(documentId('file:session-123-4__5.json')).set({ value: JSON.stringify({ test: 'imported' }) });
  const imported = await createFirestoreAuth(options);
  assert.deepEqual((await imported.state.keys.get('session', ['123:4/5']))['123:4/5'], { test: 'imported' });
  await imported.saveCreds();
  assert.equal((await root.get()).data().legacyKeys, true);
  await imported.state.keys.set({ session: { '123:4/5': null } });
  assert.deepEqual(await imported.state.keys.get('session', ['123:4/5']), {});
});

test('settings reject unsupported schedules and stale versions', async () => {
  const { control, cfg } = await fixture();
  assert.equal(scheduleFor('240min'), '0 */4 * * *');
  assert.throws(() => scheduleFor('90min'), /support/);
  await assert.rejects(control.update({ ...cfg, baseVersion: 0 }, 'admin'), (e) => e.status === 409);
  await assert.rejects(control.update({ ...cfg, enabled: true, baseVersion: 1 }, 'admin'), /Link WhatsApp/);
  assert.equal(nextRunAt({ ...cfg, enabled: true }, new Date('2026-10-08T00:01:00Z')), '2026-10-08T01:00:00.000Z');
});

test('failed scheduler reconciliation retains the new immutable settings and can be retried', async () => {
  const { control, google, cfg, db } = await fixture();
  google.reconcile = async () => { throw new Error('API unavailable'); };
  await assert.rejects(control.update({ ...cfg, baseVersion: 1, settings: { ...cfg.settings, period: '1h' } }, 'admin'), /Settings are saved/);
  assert.equal((await control.config()).scheduleStatus, 'error');
  assert.equal((await db.doc('configs/test/versions/1').get()).data().settings.period, '4h');
  assert.equal((await control.config()).settings.period, '1h');
  google.reconcile = async () => {};
  await control.reconcile();
  assert.equal((await control.config()).appliedScheduleRevision, 2);
});

test('pair launch pauses scheduling, is idempotent and reveals QR only to its owner', async () => {
  const { control, calls } = await fixture();
  const first = await control.start('pair', 'unique-key', 'admin');
  assert.equal((await control.start('pair', 'unique-key', 'admin')).id, first.id);
  assert.equal(calls.filter(([action]) => action === 'start').length, 1);
  assert.equal((await control.config()).maintenance, true);
  await control.opRef(first.id).update({ status: 'running', qr: 'sensitive', qrExpiresAt: Date.now() + 10000 });
  assert.equal((await control.pairing('admin')).qr, 'sensitive');
  assert.equal((await control.pairing('another')).qr, null);
  assert.equal(JSON.stringify(await control.overview()).includes('sensitive'), false);
  await control.opRef(first.id).update({ qrExpiresAt: 0 });
  assert.equal((await control.pairing('admin')).qr, null);
  await assert.rejects(control.cancelPairing('another'), (e) => e.status === 403);
  await control.cancelPairing('admin');
  assert.equal((await control.config()).enabled, false);
  assert.equal((await control.config()).maintenance, false);
});

test('completed execution repairs stale pairing state after an ungraceful worker termination', async () => {
  const { control, google } = await fixture();
  const { id } = await control.start('pair', 'unique-key', 'admin');
  await control.opRef(id).update({ updatedAt: new Date(Date.now() - 30000).toISOString(), qr: 'challenge' });
  google.execution = async () => ({ completionTime: new Date().toISOString() });
  await control.overview();
  assert.equal((await control.config()).maintenance, false);
  assert.equal((await control.opRef(id).get()).data().qr, null);
  assert.equal((await control.opRef(id).get()).data().status, 'failed');
});

test('IAP authentication verifies signed audience and ignores unsigned identity headers', async () => {
  let seen;
  const client = { getIapPublicKeys: async () => ({ pubkeys: {} }), verifySignedJwtWithCertsAsync: async (...args) => { seen = args; return { getPayload: () => ({ email: 'Admin@example.com', sub: 'id' }) }; } };
  const authenticate = createAdminAuthenticator({ env, client });
  await assert.rejects(authenticate({ headers: { 'x-goog-authenticated-user-email': 'admin@example.com' } }), (e) => e.status === 401);
  const identity = await authenticate({ headers: { 'x-goog-iap-jwt-assertion': 'signed-token' } });
  assert.equal(identity.email, 'admin@example.com');
  assert.equal(seen[2], env.iapAudience);
  assert.deepEqual(seen[3], ['https://cloud.google.com/iap']);
  const rotated = await authenticate({ headers: { 'x-goog-iap-jwt-assertion': 'rotated-token', cookie: `__Host-whatsapp-csrf=${identity.csrf}` } });
  assert.equal(rotated.csrf, identity.csrf);
  assert.equal(rotated.newCookie, false);
  client.verifySignedJwtWithCertsAsync = async () => ({ getPayload: () => ({ email: 'other@example.com', sub: 'id' }) });
  await assert.rejects(authenticate({ headers: { 'x-goog-iap-jwt-assertion': 'signed-token' } }), (e) => e.status === 403);
});

test('admin serves real assets, protects mutations, and encodes private QR responses without caching', async (t) => {
  const identity = { email: 'admin', csrf: 'a'.repeat(64) };
  const { control } = await fixture();
  const pair = await control.start('pair', 'unique-key', 'admin');
  await control.opRef(pair.id).update({ status: 'running', qr: 'private-challenge', qrExpiresAt: Date.now() + 10000 });
  const server = createAdminServer({ env, control, authenticate: async (request) => { if (!request.headers.authorization) throw new HttpError(401, 'Sign in'); return identity; } });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => server.close());
  const url = `http://127.0.0.1:${server.address().port}`;
  assert.equal((await fetch(url)).status, 401);
  const headers = { Authorization: 'test' };
  for (const path of ['/', '/admin.css', '/admin.js']) assert.equal((await fetch(url + path, { headers })).status, 200);
  const response = await fetch(url + '/api/pairing', { headers });
  assert.equal(response.headers.get('cache-control'), 'no-store');
  const value = await response.json();
  assert.equal(value.qr, undefined);
  assert.match(value.qrDataUrl, /^data:image\/png;base64,/);
  assert.equal((await fetch(url + '/api/run', { method: 'POST', headers, body: '{}' })).status, 403);
  assert.throws(() => checkMutation({ headers: { host: 'admin', origin: 'https://admin', 'x-csrf-token': 'é'.repeat(64) } }, identity), (e) => e.status === 403);
  checkMutation({ headers: { host: 'admin', origin: 'https://admin', 'x-csrf-token': identity.csrf, 'content-type': 'application/json' } }, identity);
});

async function fakeSession(options = {}) {
  const sockets = [];
  const auth = { state: { creds: {} }, saveCreds: async () => {}, flush: async () => {} };
  const session = connectSession({ auth, config: buildConfig({}, 'test'), syncWaitMs: 1,
    getVersion: async () => ({ version: [2, 3000, 123] }), ...options,
    socketFactory: (config) => { const sock = { config, ev: new EventEmitter(), end() {} }; sockets.push(sock); return sock; } });
  await new Promise(setImmediate);
  return { session, sockets, auth };
}

test('summary connection refuses a new QR instead of waiting for interactive login', async () => {
  const { session, sockets } = await fakeSession();
  sockets[0].ev.emit('connection.update', { qr: 'secret' });
  await assert.rejects(session.ready(), NeedsPairingError);
  await assert.rejects(session.stop(), NeedsPairingError);
});

test('pairing and history collection both advertise the supported web platform', async () => {
  for (const pairing of [true, false]) {
    const { session, sockets } = await fakeSession({ pairing });
    const config = sockets[0].config;
    const payload = generateLoginNode('15550000000:1@s.whatsapp.net', config);
    assert.equal(payload.webInfo.webSubPlatform, proto.ClientPayload.WebInfo.WebSubPlatform.WEB_BROWSER);
    assert.equal(config.syncFullHistory, true);
    sockets[0].ev.emit('connection.update', { connection: 'open' });
    await session.ready();
    await session.stop();
  }
});

test('finite session persists append messages and advances history only on FULL 100%', async () => {
  const { store } = await stateFixture();
  const before = store.getHistorySince();
  const { session, sockets } = await fakeSession({ store });
  sockets[0].ev.emit('connection.update', { connection: 'open' });
  await session.ready();
  sockets[0].ev.emit('messages.upsert', { type: 'append', messages: [waMessage('offline')] });
  sockets[0].ev.emit('messaging-history.set', { messages: [], isLatest: true, syncType: proto.HistorySync.HistorySyncType.FULL, progress: 50 });
  await session.collect();
  assert.equal(store.messages().length, 1);
  assert.deepEqual(store.getHistorySince(), before);
  sockets[0].ev.emit('messaging-history.set', { messages: [], syncType: proto.HistorySync.HistorySyncType.FULL, progress: 100 });
  await session.collect();
  assert.ok(store.getHistorySince() > before);
  await session.stop();
});

test('finite collection distinguishes filtered messages from accepted input and receive errors', async () => {
  const { store } = await stateFixture();
  const { session, sockets } = await fakeSession({ store, config: buildConfig({ filters: ['School'] }, 'test') });
  const sock = sockets[0];
  sock.groupFetchAllParticipating = async () => ({
    one: { id: 'metrics-school@g.us', subject: 'School group' },
    two: { id: 'metrics-other@g.us', subject: 'Other group' },
  });
  sock.ev.emit('connection.update', { connection: 'open' });
  await session.ready();
  await session.collect();
  sock.ev.emit('messages.upsert', { type: 'append', messages: [
    waMessage('accepted', { jid: 'metrics-school@g.us' }),
    waMessage('filtered', { jid: 'metrics-other@g.us' }),
    { key: {}, message: {} },
  ] });
  sock.config.logger.error({ key: 'synthetic-secret' }, 'failed to decrypt message');
  const result = await session.collect();
  assert.equal(result.received, 3);
  assert.equal(result.added, 1);
  assert.equal(result.filtered, 1);
  assert.equal(result.withoutText, 1);
  assert.equal(result.decryptionErrors, 1);
  assert.equal(result.groups, 2);
  assert.equal(result.matchingGroups, 1);
  assert.equal(JSON.stringify(result).includes('synthetic-secret'), false);
  await session.stop();
});

test('pairing handles restartRequired and persists auth before reporting readiness', async () => {
  let lookups = 0;
  const version = [2, 3000, 1049711438];
  const { session, sockets } = await fakeSession({ pairing: true,
    getVersion: async () => { lookups++; return { version }; } });
  assert.deepEqual(sockets[0].config.version, version);
  // The first socket is expected to restart after scanning the QR.
  sockets[0].ev.emit('connection.update', { connection: 'close', lastDisconnect: { error: { output: { statusCode: DisconnectReason.restartRequired } } } });
  await new Promise((resolve) => setTimeout(resolve, 1100));
  assert.equal(sockets.length, 2);
  assert.deepEqual(sockets[1].config.version, version);
  assert.equal(lookups, 1);
  // A restart must resolve readiness with the replacement socket.
  sockets[1].ev.emit('creds.update', { registered: true });
  sockets[1].ev.emit('connection.update', { connection: 'open' });
  assert.equal(await session.ready(), sockets[1]);
  await session.stop();
});

test('connection diagnostics expose status codes without provider secrets', async () => {
  const events = [];
  const { session, sockets } = await fakeSession({ onDiagnostic: (event) => events.push(event) });
  sockets[0].ev.emit('connection.update', { connection: 'close', lastDisconnect: {
    error: { message: 'synthetic-secret', output: { statusCode: DisconnectReason.loggedOut }, data: { qr: 'synthetic-secret' } },
  } });
  await assert.rejects(session.ready(), NeedsPairingError);
  await assert.rejects(session.stop(), NeedsPairingError);
  assert.deepEqual(events, [
    { event: 'whatsapp_version_resolved', version: [2, 3000, 123], latest: false },
    { event: 'whatsapp_connection_closed', statusCode: 401, opened: false, attempt: 1 },
  ]);
  assert.equal(JSON.stringify(events).includes('synthetic-secret'), false);
});

test('version lookup failure rejects readiness without opening a socket', async () => {
  const error = new Error('Version service unavailable');
  const { session, sockets } = await fakeSession({ getVersion: async () => { throw error; } });
  assert.equal(sockets.length, 0);
  await assert.rejects(session.ready(), error);
  await assert.rejects(session.stop(), error);
});

test('stopping during version lookup prevents a late socket connection', async () => {
  let resolveVersion, lookupSignal;
  const { session, sockets } = await fakeSession({ getVersion: ({ signal }) => {
    lookupSignal = signal;
    return new Promise((resolve) => { resolveVersion = resolve; });
  } });
  await session.stop();
  assert.equal(lookupSignal.aborted, true);
  resolveVersion({ version: [2, 3000, 123] });
  await new Promise(setImmediate);
  assert.equal(sockets.length, 0);
  await assert.rejects(session.ready(), /Finite run completed/);
});

test('worker never opens WhatsApp for paused or stale scheduled configuration', async () => {
  const { db } = await fixture();
  const runtimeDb = new MemoryFirestore();
  const sessionFactory = () => { throw new Error('Must not connect'); };
  assert.deepEqual(await runCloudWorker({ env, controlDb: db, runtimeDb, variables: {}, sessionFactory }), { skipped: true });
  await db.doc('configs/test').update({ enabled: true, authStatus: 'linked' });
  assert.deepEqual(await runCloudWorker({ env, controlDb: db, runtimeDb, variables: { SCHEDULE_REVISION: 0 }, sessionFactory }), { skipped: true });
});

test('worker retry recovers the same failed execution and preserves pending work', async () => {
  const { db } = await fixture();
  const runtimeDb = new MemoryFirestore();
  await db.doc('configs/test').update({ enabled: true, authStatus: 'linked' });
  await runtimeDb.doc('accounts/test').set({ activeGeneration: 'existing' });
  const initialLease = await acquireLease({ db: runtimeDb, configId: 'test' });
  const initialStore = await createFirestoreState({ db: runtimeDb, configId: 'test', lease: initialLease, defaultLookbackMs: 86400000 });
  await initialStore.addMessages([message('saved')]);
  await initialStore.enqueueReport({ id: 'saved-report', messageIds: [message('saved').id], parts: ['first', 'second'], recipients: [{ jid: 'self@s.whatsapp.net', nextPart: 0 }] });
  await initialStore.recordDelivery('saved-report', 'self@s.whatsapp.net', 1);
  await initialLease.release();
  const variables = { CLOUD_RUN_EXECUTION: 'summary-test', CLOUD_RUN_TASK_ATTEMPT: '1', SCHEDULE_REVISION: '1', GEMINI_API_KEY: 'test' };
  await db.doc('configs/test/operations/execution-summary-test').set({ status: 'failed', execution: 'projects/test-project/locations/europe-west4/jobs/summary/executions/summary-test' });
  let connected = 0;
  const sent = [];
  const result = await runCloudWorker({ env, controlDb: db, runtimeDb, variables,
    sessionFactory: ({ signal }) => { connected++; return { signal,
      ready: async () => ({ user: { id: 'self@s.whatsapp.net' }, sendMessage: async (jid, payload) => sent.push(payload.text) }),
      collect: async () => { await db.doc('configs/test').update({ enabled: false, scheduleRevision: 2 }); }, stop: async () => {} }; },
    summarizeFactory: () => async () => { throw new Error('Must not regenerate the saved summary'); },
  });
  assert.deepEqual(result, { completed: true });
  assert.equal(connected, 1);
  assert.deepEqual(sent, ['second']);
  const operation = (await db.doc('configs/test/operations/execution-summary-test').get()).data();
  assert.equal(operation.outcome, 'sent');
  assert.equal(operation.summary.deliveredParts, 1);
  assert.equal(operation.summary.completedReports, 1);
  assert.equal((await db.doc('configs/test').get()).data().activeOperation, null);
  assert.equal((await runtimeDb.doc('accounts/test/locks/active').get()).data().expiresAt, 0);
});

test('successful workers distinguish an empty run from messages waiting for quiet time', async () => {
  for (const queued of [false, true]) {
    const { db } = await fixture();
    const runtimeDb = new MemoryFirestore();
    await db.doc('configs/test').update({ enabled: true, authStatus: 'linked' });
    await db.doc('configs/test/versions/1').set({ settings: { period: '4h', waitForNoActivity: '15min' } });
    await runtimeDb.doc('accounts/test').set({ activeGeneration: 'existing' });
    const lease = await acquireLease({ db: runtimeDb, configId: 'test' });
    const store = await createFirestoreState({ db: runtimeDb, configId: 'test', lease, defaultLookbackMs: 86400000 });
    if (queued) await store.addMessages([{ ...message('recent'), time: new Date() }]);
    await lease.release();
    await runCloudWorker({ env, controlDb: db, runtimeDb,
      variables: { REQUEST_ID: 'outcome', SCHEDULE_REVISION: '1', GEMINI_API_KEY: 'test' },
      sessionFactory: ({ signal }) => ({ signal,
        ready: async () => ({ user: { id: 'self@s.whatsapp.net' }, sendMessage: async () => { throw new Error('No report should be sent'); } }),
        collect: async () => ({ received: 0, filtered: 0, added: 0 }), stop: async () => {},
      }),
      summarizeFactory: () => async () => { throw new Error('No eligible messages should be summarized'); },
    });
    const operation = (await db.doc('configs/test/operations/outcome').get()).data();
    assert.equal(operation.status, 'succeeded');
    assert.equal(operation.outcome, queued ? 'waiting_for_inactivity' : 'no_messages');
    assert.equal(operation.summary.pendingMessages, queued ? 1 : 0);
    assert.equal(operation.summary.deliveredParts, 0);
    assert.equal(operation.collection.received, 0);
  }
});

test('failed re-pairing preserves the previous session and queue and leaves scheduling paused', async (t) => {
  t.mock.method(console, 'error', () => {});
  const { db } = await fixture();
  const runtimeDb = new MemoryFirestore();
  await runtimeDb.doc('accounts/test').set({ activeGeneration: 'previous-session' });
  const initialLease = await acquireLease({ db: runtimeDb, configId: 'test' });
  const initialStore = await createFirestoreState({ db: runtimeDb, configId: 'test', lease: initialLease, defaultLookbackMs: 86400000 });
  await initialStore.addMessages([message('existing')]);
  await initialLease.release();
  await db.doc('configs/test').update({ maintenance: true, latestPairing: 'pair-id', activeOperation: 'pair-id', authStatus: 'linked' });
  await db.doc('configs/test/operations/pair-id').set({ id: 'pair-id', status: 'queued' });
  await assert.rejects(runCloudWorker({ mode: 'pair', env, controlDb: db, runtimeDb, variables: { REQUEST_ID: 'pair-id' },
    sessionFactory: () => ({ ready: async () => { throw new Error('Pairing failed'); }, stop: async () => {} }),
  }), /Pairing failed/);
  assert.equal((await runtimeDb.doc('accounts/test').get()).data().activeGeneration, 'previous-session');
  assert.equal((await runtimeDb.doc(`accounts/test/messages/${documentId(message('existing').id)}`).get()).exists, true);
  assert.equal((await db.doc('configs/test').get()).data().maintenance, false);
  assert.equal((await db.doc('configs/test').get()).data().enabled, false);
  assert.equal((await db.doc('configs/test/operations/pair-id').get()).data().status, 'failed');
});

test('logout disables future runs and exposes a pending Scheduler pause', async (t) => {
  t.mock.method(console, 'error', () => {});
  const { db } = await fixture();
  const runtimeDb = new MemoryFirestore();
  await db.doc('configs/test').update({ enabled: true, authStatus: 'linked' });
  await assert.rejects(runCloudWorker({ env, controlDb: db, runtimeDb, variables: { REQUEST_ID: 'logout-test', SCHEDULE_REVISION: 1, GEMINI_API_KEY: 'test' } }), NeedsPairingError);
  const cfg = (await db.doc('configs/test').get()).data();
  assert.equal(cfg.authStatus, 'needsPairing');
  assert.equal(cfg.enabled, false);
  assert.equal(cfg.scheduleRevision, 2);
  assert.equal(cfg.scheduleStatus, 'pending');
  assert.equal(cfg.activeOperation, null);
});
