import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { createHmac } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { proto } from 'baileys';
import { workspaceFixture, inputConfiguration, addConfiguredDevice } from './workspace-fixture.js';
import { resolveWorkspace, publishDueIndex } from '../src/cloud/workspaces.js';
import { createAdminServer } from '../src/cloud/admin.js';
import { createGoogleApi } from '../src/cloud/google.js';
import { createRegistryService } from '../src/cloud/registry-service.js';
import { runWorkspaceWorker } from '../src/cloud/workspace-worker.js';
import { runCloudWorker } from '../src/cloud/worker.js';
import { createControl } from '../src/cloud/control.js';
import { configurationSnapshot } from '../src/cloud/configurations.js';
import { subjectKey } from '../src/cloud/workspaces.js';
import { dispatchWorkspaces } from '../src/cloud/dispatcher.js';
import { connectSession } from '../src/once.js';

test('workspace worker CLI loads its modules without a circular import deadlock', () => {
  const result = spawnSync(process.execPath, ['src/cloud/worker.js'], {
    cwd: new URL('..', import.meta.url), encoding: 'utf8', timeout: 10000,
    env: { PATH: process.env.PATH, GOOGLE_CLOUD_PROJECT: 'test-project', GCP_REGION: 'europe-west4',
      WORKSPACE_ID: 'test-workspace', REGISTRY_SERVICE_URL: 'https://registry.invalid',
      GOOGLE_APPLICATION_CREDENTIALS: new URL('missing-test-credentials.json', import.meta.url).pathname },
  });
  assert.ifError(result.error);
  assert.equal(result.status, 1); // Missing credentials fail after the worker loads.
  assert.match(result.stderr, /workspace_worker_failed/);
  assert.doesNotMatch(result.stderr, /unsettled top-level await/);
});

test('workspace access is bound to verified subjects, not emails or supplied workspace IDs', async () => {
  const f = await workspaceFixture();
  assert.equal((await resolveWorkspace({ ...f, identity: f.alice.identity })).workspace.id, 'alice');
  await assert.rejects(resolveWorkspace({ ...f, identity: { ...f.alice.identity, userId: 'outsider' } }), (e) => e.status === 404);
  await assert.rejects(resolveWorkspace({ ...f, identity: { email: f.alice.identity.email } }), (e) => e.status === 403);
  await assert.rejects(resolveWorkspace({ ...f, identity: f.alice.identity, requestedId: 'bob' }), (e) => e.status === 404);
  await f.registryDb.doc('workspaces/alice').set(f.bob.workspace);
  await assert.rejects(resolveWorkspace({ ...f, identity: f.alice.identity }), (e) => e.status === 503);
});

test('configurations, runs, device IDs and pending input cannot cross workspaces or devices', async () => {
  const f = await workspaceFixture(), alice = await addConfiguredDevice(f.alice), bob = await addConfiguredDevice(f.bob);
  const other = await f.alice.control.createDevice({ name: 'Second device', idempotencyKey: 'another-device-key' }, f.alice.identity.userId);
  assert.equal((await f.alice.control.overview()).configurations.length, 1);
  assert.equal((await f.bob.control.overview()).configurations.length, 1);
  for (const action of [
    f.alice.control.updateConfiguration(bob.configurationId, { ...inputConfiguration(bob.deviceId), baseVersion: 1 }, f.alice.identity.userId),
    f.alice.control.removeConfiguration(bob.configurationId, { baseVersion: 1 }, f.alice.identity.userId),
    f.alice.control.start('summary', 'foreign-run-key', f.alice.identity.userId, bob.configurationId),
    f.alice.control.createConfiguration(inputConfiguration(bob.deviceId), f.alice.identity.userId),
    f.alice.control.updateConfiguration(alice.configurationId, { ...inputConfiguration(other.id), baseVersion: 1 }, f.alice.identity.userId),
    f.alice.control.start('pair', 'foreign-pair-key', f.alice.identity.userId, undefined, bob.deviceId),
    f.alice.control.pairing(f.alice.identity.userId, bob.deviceId),
  ]) await assert.rejects(action, (e) => e.status === 404);
  const run = await f.alice.control.start('summary', 'own-run-now-key', f.alice.identity.userId, alice.configurationId);
  assert.equal((await f.alice.db.doc(`requests/${run.id}`).get()).data().deviceId, alice.deviceId);
  assert.equal((await f.bob.db.collection('requests').get()).docs.length, 0);
  assert.deepEqual(f.launches.at(-1), { workspaceId: 'alice', mode: 'summary' });
});

test('Run all groups only the caller’s saved configurations and isolates a busy device', async () => {
  const f = await workspaceFixture(), first = await addConfiguredDevice(f.alice), second = await addConfiguredDevice(f.alice, 'School WhatsApp');
  await addConfiguredDevice(f.bob);
  await f.alice.control.start('summary', 'busy-device-key', f.alice.identity.userId, first.configurationId);
  const result = await f.alice.control.start('summary', 'workspace-run-all', f.alice.identity.userId, 'all');
  assert.equal(result.devices.find((item) => item.deviceId === first.deviceId).status, 'rejected');
  assert.equal(result.devices.find((item) => item.deviceId === second.deviceId).status, 'queued');
  assert.equal((await f.bob.db.collection('requests').get()).docs.length, 0);
});

test('device creation is bounded and idempotent; only unused devices may be removed', async () => {
  const f = await workspaceFixture();
  const input = { name: 'Unused', idempotencyKey: 'stable-device-key' };
  const first = await f.alice.control.createDevice(input, f.alice.identity.userId);
  assert.equal((await f.alice.control.createDevice(input, f.alice.identity.userId)).id, first.id);
  await f.alice.control.removeDevice(first.id, { baseVersion: 1 });
  const used = await addConfiguredDevice(f.alice);
  await assert.rejects(f.alice.control.removeDevice(used.deviceId, { baseVersion: 1 }), /unused devices/);
  for (let i = 0; i < 4; i++) await f.alice.control.createDevice({ name: `Device ${i}`, idempotencyKey: `device-limit-${i}` }, f.alice.identity.userId);
  await assert.rejects(f.alice.control.createDevice({ name: 'Overflow', idempotencyKey: 'device-limit-overflow' }, f.alice.identity.userId), /At most 5/);
});

test('fixed launch uses no overrides and cannot inspect/cancel another Job execution', async () => {
  const calls = [];
  const api = createGoogleApi({ env: { projectId: 'test', region: 'region', summaryJob: 'alice-summary', pairingJob: 'alice-pair' }, fixed: true,
    auth: { getClient: async () => ({ request: async (value) => { calls.push(value); return { data: { name: 'launch' } }; } }) } });
  await api.start('summary', { CONFIG_ID: 'bob', REQUEST_ID: 'untrusted' });
  assert.deepEqual(calls[0].data, {});
  await assert.rejects(api.cancel({ mode: 'summary', execution: 'projects/test/locations/region/jobs/bob-summary/executions/one' }), /outside/);
  assert.equal(calls.length, 1);
  await assert.rejects(api.reconcile({}), /do not manage Scheduler/);
});

test('workspace HTTP endpoints reject substituted IDs, ownership fields and missing CSRF', async (t) => {
  const f = await workspaceFixture(), alice = await addConfiguredDevice(f.alice), bob = await addConfiguredDevice(f.bob);
  const server = createAdminServer({ env: f.env, authenticate: async (request) => request.headers.authorization === 'bob' ? f.bob.identity : f.alice.identity,
    resolveControl: async (identity, request) => {
      const resolved = await resolveWorkspace({ ...f, identity, requestedId: request.headers['x-workspace-id'] });
      return { ...resolved, control: f[resolved.workspace.id].control };
    } });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve)); t.after(() => server.close());
  const url = `http://127.0.0.1:${server.address().port}`;
  const headers = { origin: `https://127.0.0.1:${server.address().port}`, 'x-csrf-token': f.alice.identity.csrf, 'content-type': 'application/json' };
  const post = (path, body, extra = {}) => fetch(url + path, { method: 'POST', headers: { ...headers, ...extra }, body: JSON.stringify(body) });
  assert.equal((await fetch(url + '/api/overview', { headers: { 'x-workspace-id': 'bob' } })).status, 404);
  assert.equal((await fetch(url + `/api/pairing?deviceId=${bob.deviceId}`)).status, 404);
  assert.equal((await post(`/api/configurations/${bob.configurationId}/run`, { idempotencyKey: 'foreign-run-key' })).status, 404);
  assert.equal((await post('/api/pairing', { idempotencyKey: 'foreign-qr-key', deviceId: bob.deviceId })).status, 404);
  assert.equal((await post('/api/pairing', { idempotencyKey: 'forged-owner-key', deviceId: alice.deviceId, owner: f.bob.identity.userId })).status, 400);
  assert.equal((await post('/api/configurations/run-all', { idempotencyKey: 'foreign-workspace', workspaceId: 'bob' })).status, 404);
  assert.equal((await fetch(url + '/api/pairing', { method: 'POST', body: '{}' })).status, 403);
  const own = await post('/api/pairing', { idempotencyKey: 'own-pairing-key', deviceId: alice.deviceId });
  assert.equal(own.status, 202);
  const record = await own.json();
  await f.alice.db.doc(`configs/${alice.deviceId}/operations/${record.id}`).update({ status: 'running', qr: 'private-alice-qr', qrExpiresAt: Date.now() + 10000 });
  const pairing = await fetch(url + `/api/pairing?deviceId=${alice.deviceId}`).then((r) => r.json());
  assert.match(pairing.qrDataUrl, /^data:image\/png/);
  const bobView = await fetch(url + '/api/overview', { headers: { authorization: 'bob' } }).then((r) => r.json());
  assert.equal(JSON.stringify(bobView).includes('private-alice-qr'), false);
  assert.deepEqual(bobView.devices.map((item) => item.id), [bob.deviceId]);
});

test('registry restricts workload identity and rejects duplicate accounts and account replacement', async (t) => {
  const f = await workspaceFixture(), alice = await addConfiguredDevice(f.alice), bob = await addConfiguredDevice(f.bob);
  const key = 'synthetic-registry-key'.repeat(3);
  for (const scope of [f.alice, f.bob]) {
    const email = `${scope.workspace.id}-pair@test-project.iam.gserviceaccount.com`;
    await f.registryDb.doc(`workloads/${createHmac('sha256', key).update(email).digest('hex')}`).set({ email, workspaceId: scope.workspace.id, mode: 'pair' });
  }
  const server = createRegistryService({ env: f.env, registryDb: f.registryDb, database: (id) => f.databases.get(id), accountKey: key,
    verifyToken: async (email) => ({ email, email_verified: true }) });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve)); t.after(() => server.close());
  const endpoint = `http://127.0.0.1:${server.address().port}`;
  const pair = async (scope, deviceId) => {
    const request = await scope.control.start('pair', `pair-key-${deviceId}`, scope.identity.userId, undefined, deviceId);
    await scope.db.doc(`configs/${deviceId}/operations/${request.id}`).update({ status: 'running' });
    await scope.db.doc(`requests/${request.id}`).update({ status: 'running' });
    return request;
  };
  const a = await pair(f.alice, alice.deviceId), b = await pair(f.bob, bob.deviceId);
  const claim = (who, deviceId, operationId, accountId) => fetch(endpoint + '/claim', { method: 'POST',
    headers: { authorization: `Bearer ${who}-pair@test-project.iam.gserviceaccount.com` }, body: JSON.stringify({ deviceId, operationId, accountId }) });
  assert.equal((await claim('alice', alice.deviceId, a.id, '15550000000:3@s.whatsapp.net')).status, 200);
  assert.equal((await claim('bob', bob.deviceId, b.id, '15550000000@s.whatsapp.net')).status, 409);
  assert.equal((await claim('alice', alice.deviceId, a.id, '15550000009@s.whatsapp.net')).status, 409);
  assert.equal((await claim('bob', alice.deviceId, a.id, '15550000000@s.whatsapp.net')).status, 404);
  assert.equal((await claim('outsider', alice.deviceId, a.id, '15550000000@s.whatsapp.net')).status, 403);
  await f.registryDb.doc(`members/${subjectKey(f.alice.identity.userId)}`).update({ status: 'revoked' });
  assert.equal((await claim('alice', alice.deviceId, a.id, '15550000000@s.whatsapp.net')).status, 403);
});

function sessionTransport(sent, rejected = false) {
  return (options) => connectSession({ ...options, syncWaitMs: 1, getVersion: async () => ({ version: [2, 3000, 1] }), socketFactory: () => {
    const socket = { ev: new EventEmitter(), user: { id: '15550000000@s.whatsapp.net' }, end() {},
      groupFetchAllParticipating: async () => ({}), groupMetadata: async () => ({ subject: 'VELI GRUBU' }),
      sendMessage: async (jid) => {
        if (typeof rejected === 'function') await rejected(jid);
        else if (rejected) throw new Error('Synthetic send failure');
        sent.push(jid);
      } };
    setImmediate(() => {
      socket.ev.emit('messaging-history.set', { chats: [{ id: 'private@g.us', name: 'VELI GRUBU' }], contacts: [],
        messages: [{ key: { id: 'private-message', remoteJid: 'private@g.us', fromMe: false }, messageTimestamp: Math.floor((Date.now() - 100000) / 1000), message: { conversation: 'Private synthetic input' } }],
        syncType: proto.HistorySync.HistorySyncType.FULL, progress: 100 });
      socket.ev.emit('connection.update', { connection: 'open' });
    });
    return socket;
  } });
}

test('workspace worker ignores invocation overrides, claims once, and sends only its pinned request', async () => {
  const f = await workspaceFixture(), alice = await addConfiguredDevice(f.alice), bob = await addConfiguredDevice(f.bob);
  const run = await f.alice.control.start('summary', 'pinned-workspace-run', f.alice.identity.userId, alice.configurationId);
  const sent = [], verified = [];
  const execute = () => runWorkspaceWorker({ mode: 'summary', ...f.alice, controlDb: f.alice.db,
    variables: { REQUEST_ID: 'bob-request', CONFIGURATION_IDS: bob.configurationId, CONFIG_ID: bob.deviceId, GEMINI_API_KEY: 'synthetic-key', CLOUD_RUN_EXECUTION: 'alice-execution' },
    registry: { sync: async () => {}, verifyAccount: async (...args) => verified.push(args) },
    sessionFactory: sessionTransport(sent), summarizeFactory: () => async () => 'Synthetic private summary', log() {} });
  assert.deepEqual(await execute(), { completed: true });
  assert.deepEqual(sent, ['15550000001@s.whatsapp.net']);
  assert.equal(verified[0][0], alice.deviceId);
  assert.equal(verified[0][1], run.id);
  assert.equal((await f.alice.db.doc(`requests/${run.id}`).get()).data().status, 'succeeded');
  assert.deepEqual(await execute(), { skipped: true });
  assert.equal((await f.bob.db.collection('requests').get()).docs.length, 0);
});

test('rejected WhatsApp identity cannot contaminate existing queues before collection', async () => {
  const f = await workspaceFixture(), device = await addConfiguredDevice(f.alice);
  await f.alice.control.start('pair', 'identity-rejection-key', f.alice.identity.userId, undefined, device.deviceId);
  await assert.rejects(runWorkspaceWorker({ mode: 'pair', ...f.alice, controlDb: f.alice.db, variables: { CLOUD_RUN_EXECUTION: 'pair-execution' },
    registry: { sync: async () => {}, verifyAccount: async () => { throw new Error('Different account'); } },
    sessionFactory: sessionTransport([]), log() {} }), /Different account/);
  assert.equal((await f.alice.runtimeDb.collection(`accounts/${device.deviceId}/messages`).get()).docs.length, 0);
  assert.equal((await f.alice.runtimeDb.doc(`accounts/${device.deviceId}`).get()).data().activeGeneration, 'existing');
});

test('dispatcher keeps workspaces independent and periodically repairs missed hints', async () => {
  const f = await workspaceFixture(), alice = await addConfiguredDevice(f.alice);
  await addConfiguredDevice(f.bob);
  await f.alice.control.start('summary', 'dispatch-alice-key', f.alice.identity.userId, alice.configurationId);
  await publishDueIndex({ ...f, controlDb: f.bob.db, workspaceId: 'bob' });
  const calls = [];
  const now = new Date('2026-10-09T10:00:00Z');
  await f.registryDb.doc('dispatch/bob').set({ lastProbeAt: now.toISOString() }, { merge: true });
  await dispatchWorkspaces({ ...f, now, googleFactory: (env) => ({ start: async (mode) => calls.push([env.workspaceId, mode]) }), log() {} });
  assert.deepEqual(calls, [['alice', 'summary']]);
  await dispatchWorkspaces({ ...f, now: new Date('2026-10-09T11:01:00Z'), googleFactory: (env) => ({ start: async (mode) => calls.push([env.workspaceId, mode]) }), log() {} });
  assert.ok(calls.some(([workspace]) => workspace === 'bob'));
});

async function makeDue(scope, deviceId) {
  const ref = scope.db.doc(`configs/${deviceId}`), device = (await ref.get()).data();
  const old = new Date(Date.now() - 7200000).toISOString();
  device.configurations = device.configurations.map((item) => ({ ...item, enabled: true, scheduleStartedAt: old, lastScheduledSlot: null }));
  device.enabled = true;
  await ref.set(device);
  await ref.collection('versions').doc(String(device.activeVersion)).set(configurationSnapshot(device));
}

test('scheduled workspace execution commits completed slots and duplicate dispatch cannot resend', async () => {
  const f = await workspaceFixture(), device = await addConfiguredDevice(f.alice);
  await addConfiguredDevice(f.bob); await makeDue(f.alice, device.deviceId);
  const sent = [];
  const options = { mode: 'summary', ...f.alice, controlDb: f.alice.db, variables: { GEMINI_API_KEY: 'synthetic-key' },
    registry: { sync: async () => {}, verifyAccount: async () => {} }, sessionFactory: sessionTransport(sent),
    summarizeFactory: () => async () => 'Synthetic report', log() {} };
  assert.deepEqual(await runWorkspaceWorker(options), { completed: true });
  const stored = (await f.alice.db.doc(`configs/${device.deviceId}`).get()).data();
  assert.ok(stored.configurations[0].lastScheduledSlot);
  assert.deepEqual(await runWorkspaceWorker(options), { skipped: true });
  assert.equal(sent.length, 1);
  assert.equal((await f.bob.db.collection('requests').get()).docs.length, 0);
});

test('Cloud Run retry resumes its pinned report and unsent recipient before newer work', async () => {
  const f = await workspaceFixture(), first = await addConfiguredDevice(f.alice), second = await addConfiguredDevice(f.alice, 'Second');
  const profile = (await f.alice.control.overview()).configurations.find((item) => item.id === first.configurationId);
  await f.alice.control.updateConfiguration(profile.id, { ...inputConfiguration(first.deviceId), baseVersion: profile.version,
    settings: { ...profile.settings, phones: ['15550000001', '15550000002'] } }, f.alice.identity.userId);
  await makeDue(f.alice, first.deviceId);
  const initial = await f.alice.control.start('summary', 'partial-report-key', f.alice.identity.userId, first.configurationId);
  const sent = []; let summaries = 0, failed = false;
  const options = { mode: 'summary', ...f.alice, controlDb: f.alice.db,
    registry: { sync: async () => {}, verifyAccount: async () => {} },
    sessionFactory: sessionTransport(sent, async (jid) => {
      if (jid === '15550000002@s.whatsapp.net' && !failed) { failed = true; throw new Error('Temporary delivery failure'); }
    }), summarizeFactory: () => async () => { summaries++; return 'Stored private report'; }, log() {} };
  const variables = { CLOUD_RUN_EXECUTION: 'retry-execution', GEMINI_API_KEY: 'synthetic-key' };
  await assert.rejects(runWorkspaceWorker({ ...options, variables }), /preserved/);
  const other = await f.alice.control.start('summary', 'other-device-request', f.alice.identity.userId, second.configurationId);
  await f.alice.db.doc(`requests/${other.id}`).update({ createdAt: '2020-01-01T00:00:00Z' });
  assert.deepEqual(await runWorkspaceWorker({ ...options, variables: { ...variables, CLOUD_RUN_TASK_ATTEMPT: '1' } }), { completed: true });
  assert.deepEqual(sent, ['15550000001@s.whatsapp.net', '15550000002@s.whatsapp.net']);
  assert.equal(summaries, 1);
  assert.equal((await f.alice.db.doc(`requests/${initial.id}`).get()).data().attempts, 2);
  assert.equal((await f.alice.db.doc(`requests/${other.id}`).get()).data().status, 'queued');
  assert.equal((await f.alice.db.collection('requests').get()).docs.length, 2);
});

test('workspace claims cap simultaneous devices and leave excess requests durable', async () => {
  const f = await workspaceFixture(), devices = [];
  for (const name of ['First', 'Second', 'Third']) {
    const device = await addConfiguredDevice(f.alice, name);
    devices.push(device);
    await f.alice.control.start('summary', `concurrency-${name}`, f.alice.identity.userId, device.configurationId);
  }
  const releases = [], entered = [];
  const options = { mode: 'summary', ...f.alice, controlDb: f.alice.db, registry: { sync: async () => {} }, log() {},
    worker: async ({ env }) => { entered.push(env.configId); await new Promise((resolve) => releases.push(resolve)); return { skipped: true }; } };
  const executions = [runWorkspaceWorker(options), runWorkspaceWorker(options)];
  for (let i = 0; i < 100 && entered.length !== 2; i++) await new Promise((resolve) => setTimeout(resolve, 1));
  try {
    assert.equal(entered.length, 2); assert.equal(new Set(entered).size, 2);
    assert.deepEqual(await runWorkspaceWorker(options), { skipped: true });
    assert.equal((await f.alice.db.collection('requests').where('status', '==', 'queued').get()).docs.length, 1);
  } finally { releases.forEach((resolve) => resolve()); await Promise.all(executions); }
  assert.equal(Object.keys((await f.alice.db.doc('workspace/claims').get()).data().running).length, 0);
});

test('expired claims are recoverable and cancelled pairing cannot open a session', async () => {
  const f = await workspaceFixture(), device = await addConfiguredDevice(f.alice);
  const run = await f.alice.control.start('summary', 'expired-claim-key', f.alice.identity.userId, device.configurationId);
  await f.alice.db.doc(`requests/${run.id}`).update({ status: 'running', claimUntil: 0, attempts: 1, execution: 'old-execution' });
  await f.alice.db.doc('workspace/claims').set({ running: { [run.id]: { deviceId: device.deviceId, until: 0 } } });
  let claims = 0;
  const options = { ...f.alice, controlDb: f.alice.db, registry: { sync: async () => {} }, log() {}, worker: async () => { claims++; return { skipped: true }; } };
  await runWorkspaceWorker({ ...options, mode: 'summary' });
  assert.equal(claims, 1);
  const pair = await f.alice.control.start('pair', 'cancel-before-claim', f.alice.identity.userId, undefined, device.deviceId);
  await f.alice.control.cancelPairing(f.alice.identity.userId, device.deviceId);
  await runWorkspaceWorker({ ...options, mode: 'pair' });
  assert.equal(claims, 1);
  assert.equal((await f.alice.db.doc(`requests/${pair.id}`).get()).data().status, 'cancelled');
});

test('configuration creation keys are scoped by device and migration freezes legacy launch paths', async () => {
  const f = await workspaceFixture(), first = await addConfiguredDevice(f.alice), second = await addConfiguredDevice(f.alice, 'Second');
  const input = { ...inputConfiguration(first.deviceId), idempotencyKey: 'same-creation-key' };
  const a = await f.alice.control.createConfiguration(input, f.alice.identity.userId);
  const b = await f.alice.control.createConfiguration({ ...input, deviceId: second.deviceId }, f.alice.identity.userId);
  assert.notEqual(a.id, b.id);
  await f.alice.db.doc(`configs/${first.deviceId}`).update({ migrationWorkspace: 'migrating' });
  const env = { ...f.alice.env, workspaceId: undefined, configId: first.deviceId };
  const legacy = createControl({ db: f.alice.db, env, google: f.alice.google });
  await assert.rejects(legacy.start('summary', 'frozen-launch-key', 'owner@example.com', first.configurationId), /migrated/);
  assert.deepEqual(await runCloudWorker({ env, mode: 'summary', controlDb: f.alice.db, runtimeDb: f.alice.runtimeDb, log() {},
    sessionFactory: () => { throw new Error('Must not connect'); } }), { skipped: true });
});

test('pairing requests survive index failure and reconciliation repairs saved schedule state', async () => {
  const f = await workspaceFixture(), device = await addConfiguredDevice(f.alice);
  const runTransaction = f.registryDb.runTransaction.bind(f.registryDb);
  f.registryDb.runTransaction = async () => { throw new Error('Temporary index failure'); };
  await assert.rejects(f.alice.control.start('pair', 'durable-before-index', f.alice.identity.userId, undefined, device.deviceId), /Settings are saved/);
  const requests = (await f.alice.db.collection('requests').get()).docs;
  assert.equal(requests.length, 1); assert.equal(requests[0].data().status, 'queued');
  const failed = (await f.alice.db.doc(`configs/${device.deviceId}`).get()).data();
  assert.equal(failed.scheduleStatus, 'error');
  f.registryDb.runTransaction = runTransaction;
  await f.alice.control.reconcile();
  const repaired = (await f.alice.db.doc(`configs/${device.deviceId}`).get()).data();
  assert.equal(repaired.scheduleStatus, 'applied'); assert.equal(repaired.appliedScheduleRevision, repaired.scheduleRevision);
  assert.equal((await f.registryDb.doc('dispatch/alice').get()).data().pairPending, true);
});
