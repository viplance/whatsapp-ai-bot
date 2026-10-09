import test from 'node:test';
import assert from 'node:assert/strict';
import { MemoryFirestore } from './cloud-helpers.js';
import { validateSettings } from '../src/cloud/settings.js';
import { copyTree, freezeAccount, migrationAccountId, migrationTransforms, treeDigest } from '../scripts/lib/workspace-migration.js';
import { workspaceDeploymentPlan, workspaceResources } from '../scripts/lib/workspace-infrastructure.js';
import { workspaceCli } from '../scripts/workspace-gcp.js';
import { verifyWorkspaceIam, verifyWorkspaceIamWithRetry } from '../scripts/lib/workspace-verification.js';
import { guardLegacyDeployment } from '../scripts/guard-legacy-deployment.js';

test('migration preserves session keys, queue IDs and partially delivered reports', async () => {
  const source = new MemoryFirestore(), destination = new MemoryFirestore();
  const initial = validateSettings({ enabled: true, timezone: 'UTC', settings: { period: '1h', phones: ['15550000001'] } });
  const original = { ...initial, activeVersion: 3, scheduleRevision: 5, authStatus: 'linked', createdAt: '2026-10-01T00:00:00Z' };
  await source.doc('configs/legacy').set({ ...original, enabled: false, maintenance: true });
  await source.doc('configs/legacy/versions/3').set(initial);
  await source.doc('configs/legacy/operations/history').set({ owner: 'owner@example.com', status: 'succeeded', qr: 'expired-private-qr' });
  await source.doc('configs/legacy/operations/scheduled').set({ mode: 'summary', status: 'succeeded' });
  const transforms = migrationTransforms({ original, workspaceId: 'alice', deviceId: 'legacy', ownerSubject: 'accounts.google.com:alice', ownerEmail: 'owner@example.com', accountFingerprint: 'synthetic-fingerprint' });
  const control = await copyTree({ source: source.doc('configs/legacy'), destination, transform: transforms.control });
  assert.equal(control.documents, 4);
  const migrated = (await destination.doc('configs/legacy').get()).data();
  assert.equal(migrated.activeVersion, 4); assert.equal(migrated.configurations[0].id, 'default');
  assert.equal(migrated.configurations[0].settings.period, '1h'); assert.equal(migrated.configurations[0].deviceId, 'legacy');
  assert.equal(migrated.enabled, true); assert.equal(migrated.maintenance, false);
  assert.equal((await destination.doc('configs/legacy/operations/history').get()).data().qr, null);
  assert.equal(Object.hasOwn((await destination.doc('configs/legacy/operations/scheduled').get()).data(), 'owner'), false);
  assert.equal((await destination.doc('configs/legacy/versions/3').get()).data().workspaceId, 'alice');
  await source.doc('accounts/legacy').set({ activeGeneration: 'existing', historySince: '2026-10-01T00:00:00Z' });
  const records = {
    'accounts/legacy/sessions/existing': { creds: 'opaque-serialized-creds' },
    'accounts/legacy/sessions/existing/keys/key': { value: 'opaque-encryption-key' },
    'accounts/legacy/messages/message-id': { id: 'message-id', text: 'Synthetic private text' },
    'accounts/legacy/reports/report-id': { id: 'report-id', recipients: [{ jid: 'recipient', nextPart: 1 }], parts: ['one', 'two'] },
    'accounts/legacy/locks/active': { owner: 'migration-holder', token: 5, expiresAt: 1234567 },
  };
  for (const [path, data] of Object.entries(records)) await source.doc(path).set(data);
  const runtime = await copyTree({ source: source.doc('accounts/legacy'), destination, transform: transforms.runtime });
  assert.equal(runtime.documents, 6);
  for (const [path, data] of Object.entries(records)) if (!path.endsWith('/locks/active')) assert.deepEqual((await destination.doc(path).get()).data(), data);
  assert.equal((await destination.doc('accounts/legacy/locks/active').get()).data().expiresAt, 0);
  assert.equal((await destination.doc('accounts/legacy').get()).data().activeGeneration, 'existing');
  assert.equal((await source.doc('accounts/legacy').get()).data().workspaceId, undefined);
  assert.equal(treeDigest([{ path: 'b', data: 1 }, { path: 'a', data: 2 }]), treeDigest([{ path: 'a', data: 2 }, { path: 'b', data: 1 }]));
  assert.equal(treeDigest([{ path: 'a', data: { first: 1, second: 2 } }]), treeDigest([{ path: 'a', data: { second: 2, first: 1 } }]));
});

test('migration freeze preserves original settings atomically and can resume after interruption', async () => {
  const sourceDb = new MemoryFirestore(), original = { enabled: true, settings: { phones: ['own'] }, activeOperation: null, maintenance: false };
  await sourceDb.doc('configs/legacy').set(original);
  const options = { sourceDb, deviceId: 'legacy', workspaceId: 'alice', ownerSubject: 'accounts.google.com:alice' };
  assert.deepEqual(await freezeAccount(options), original);
  assert.equal((await sourceDb.doc('configs/legacy').get()).data().enabled, false);
  assert.deepEqual(await freezeAccount(options), original);
  await assert.rejects(freezeAccount({ ...options, workspaceId: 'bob' }), /before migration/);
  await assert.rejects(freezeAccount({ ...options, ownerSubject: 'accounts.google.com:bob' }), /ownership mismatch/);
});

test('migration refuses to attach unidentified pending work to a newly linked account', () => {
  const empty = { original: { authStatus: 'needsPairing' }, hasPendingWork: false };
  assert.equal(migrationAccountId(empty), null);
  assert.throws(() => migrationAccountId({ ...empty, hasPendingWork: true }), /identity is missing/);
  assert.throws(() => migrationAccountId({ ...empty, account: { activeGeneration: 'existing' } }), /identity is missing/);
  assert.throws(() => migrationAccountId({ ...empty, original: { authStatus: 'linked' } }), /identity is missing/);
  assert.equal(migrationAccountId({ ...empty, hasPendingWork: true, creds: JSON.stringify({ me: { id: '15550000000:3@s.whatsapp.net' } }) }), '15550000000@s.whatsapp.net');
});

test('provisioning uses separate identities, database conditions, fixed Jobs and summary-only secrets', () => {
  const env = { projectId: 'test-project', region: 'europe-west4', registryDatabase: 'registry' };
  const first = workspaceResources({ ...env, ownerSubject: 'accounts.google.com:alice' });
  const second = workspaceResources({ ...env, ownerSubject: 'accounts.google.com:bob' });
  assert.notEqual(first.controlDatabase, second.controlDatabase); assert.notEqual(first.summaryAccount, second.summaryAccount);
  const commands = workspaceDeploymentPlan({ env, workspace: first, image: 'image@sha256:synthetic', registryUrl: 'https://registry.run.app' }).map((item) => item.args);
  const summary = commands.find((args) => args.includes(first.summaryJob) && args.includes('deploy'));
  const pair = commands.find((args) => args.includes(first.pairingJob) && args.includes('deploy'));
  assert.ok(summary.some((arg) => arg.startsWith('--set-secrets=GEMINI_API_KEY=')));
  assert.ok(pair.includes('--clear-secrets'));
  assert.ok(summary.some((arg) => arg.startsWith('--set-env-vars=') && arg.includes(`WORKSPACE_ID=${first.id}`)));
  assert.equal(commands.some((args) => args.some((arg) => /WithOverrides|serviceAccountUser|serviceAccountTokenCreator/.test(arg))), false);
  const adminGrant = commands.find((args) => args.includes('--role=roles/datastore.user') && args.some((arg) => arg.includes('whatsapp-admin@')));
  assert.ok(adminGrant.some((arg) => arg.includes(first.controlDatabase)));
  assert.equal(adminGrant.some((arg) => arg.includes(first.runtimeDatabase)), false);
});

test('CLI defaults to a dry run without contacting GCP or exposing owner identity', async () => {
  const messages = [], saved = console.log;
  console.log = (value) => messages.push(value);
  try {
    await workspaceCli(['provision', '--owner-sub=accounts.google.com:alice', '--owner-email=alice@example.com'], {
      GOOGLE_CLOUD_PROJECT: 'test-project', GCP_REGION: 'europe-west4', IMAGE: 'synthetic-image' });
  } finally { console.log = saved; }
  const plan = JSON.parse(messages[0]);
  assert.equal(plan.dryRun, true); assert.ok(plan.commands.length > 0);
  assert.equal(messages[0].includes('accounts.google.com:alice'), false); assert.equal(messages[0].includes('alice@example.com'), false);
});

test('effective IAM verification refuses inherited database, override and impersonation grants', async () => {
  const env = { projectId: 'test-project', region: 'europe-west4', registryDatabase: 'registry', controlDatabase: 'legacy-control', runtimeDatabase: 'legacy-runtime' };
  const workspace = workspaceResources({ ...env, ownerSubject: 'accounts.google.com:alice' });
  const other = workspaceResources({ ...env, ownerSubject: 'accounts.google.com:bob' });
  const registryDb = new MemoryFirestore();
  await registryDb.doc(`workspaces/${workspace.id}`).set(workspace);
  await registryDb.doc(`workspaces/${other.id}`).set(other);
  let broadDatabase = false, overrides = false, impersonation = false, transientReads = 0;
  const forbidden = () => { throw Object.assign(new Error('Permission denied'), { code: 7 }); };
  const authFactory = (identity) => ({ identity, getClient: async () => ({ request: async ({ url }) => {
    if (url.startsWith('https://secretmanager.googleapis.com/')) {
      if (identity !== workspace.summaryAccount || !url.includes(`/secrets/${workspace.geminiSecret}/`)) forbidden();
      return { data: {} };
    }
    if (url.startsWith('https://run.googleapis.com/')) return { data: { permissions: ['run.jobs.run', ...(overrides ? ['run.jobs.runWithOverrides'] : [])] } };
    return { data: { permissions: impersonation ? ['iam.serviceAccounts.getAccessToken'] : [] } };
  } }) });
  const database = (id, auth) => ({ doc: () => ({ get: async () => {
    const worker = [workspace.summaryAccount, workspace.pairingAccount].includes(auth.identity);
    if (worker && (broadDatabase || [workspace.controlDatabase, workspace.runtimeDatabase].includes(id))) return {};
    if (auth.identity.startsWith('whatsapp-admin@') && id === workspace.controlDatabase) {
      if (transientReads > 0) { transientReads--; forbidden(); }
      return {};
    }
    forbidden();
  } }) });
  const check = () => verifyWorkspaceIam({ env, workspace, registryDb, database, authFactory });
  await check();
  transientReads = 1; let pauses = 0;
  const eventually = () => verifyWorkspaceIamWithRetry({ env, workspace, registryDb, database, authFactory, pause: async () => { pauses++; } });
  await eventually(); assert.equal(pauses, 1);
  broadDatabase = true; await assert.rejects(check()); broadDatabase = false;
  overrides = true; await assert.rejects(check(), /override/); overrides = false;
  overrides = true; await assert.rejects(eventually(), /override/); assert.equal(pauses, 1); overrides = false;
  impersonation = true; await assert.rejects(check(), /impersonate/);
});

test('legacy deployment fails closed once the admin uses private workspaces', () => {
  const describe = (mode) => () => JSON.stringify({ spec: { template: { spec: { containers: [{ env: [{ name: 'WORKSPACE_MODE', value: mode }] }] } } } });
  guardLegacyDeployment({ describe: describe('false'), variables: {} });
  assert.throws(() => guardLegacyDeployment({ describe: describe('true'), variables: {} }), /Workspace mode/);
  assert.throws(() => guardLegacyDeployment({ describe: () => { throw new Error('Access denied'); }, variables: {} }), /Cannot verify/);
  guardLegacyDeployment({ describe: () => { throw Object.assign(new Error(), { stderr: 'NOT_FOUND' }); }, variables: {} });
});
