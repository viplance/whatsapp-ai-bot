import { MemoryFirestore } from './cloud-helpers.js';
import { createWorkspaceControl } from '../src/cloud/workspace-control.js';
import { subjectKey } from '../src/cloud/workspaces.js';

export async function workspaceFixture() {
  const registryDb = new MemoryFirestore(), databases = new Map(), launches = [];
  const env = { projectId: 'test-project', region: 'europe-west4', workspaceMode: true, registryDatabase: 'registry', adminEmails: [] };
  const scopes = [];
  for (const id of ['alice', 'bob']) {
    const workspace = { id, name: `${id}'s workspace`, status: 'active', controlDatabase: `${id}-control`, runtimeDatabase: `${id}-runtime`, summaryJob: `${id}-summary`, pairingJob: `${id}-pair` };
    const identity = { email: `${id}@example.com`, userId: `accounts.google.com:${id}`, csrf: 'a'.repeat(64) };
    const db = new MemoryFirestore(), runtimeDb = new MemoryFirestore();
    databases.set(workspace.controlDatabase, db); databases.set(workspace.runtimeDatabase, runtimeDb);
    await registryDb.doc(`workspaces/${id}`).set(workspace);
    await registryDb.doc(`members/${subjectKey(identity.userId)}`).set({ subject: identity.userId, workspaceId: id, status: 'active', role: 'owner' });
    await db.doc('workspace/meta').set({ id, status: 'active', deviceCount: 0 });
    const scopedEnv = { ...env, ...workspace, workspaceId: id };
    const google = { start: async (mode) => { launches.push({ workspaceId: id, mode }); return {}; }, execution: async () => null, cancel: async () => true };
    const control = createWorkspaceControl({ db, registryDb, env: scopedEnv, google });
    scopes.push({ workspace, identity, db, runtimeDb, env: scopedEnv, control, google });
  }
  return { env, registryDb, databases, launches, alice: scopes[0], bob: scopes[1] };
}

export const inputConfiguration = (deviceId, name = 'Private configuration') => ({ deviceId, name, enabled: false, timezone: 'UTC',
  settings: { period: '1h', filters: ['veli'], phones: ['15550000001'], waitForNoActivity: '0', model: 'synthetic-model', systemInstruction: '' } });

export async function addConfiguredDevice(scope, name = 'Personal WhatsApp') {
  const created = await scope.control.createDevice({ name, idempotencyKey: `device-${name.replace(/\W/g, '-')}` }, scope.identity.userId);
  await scope.db.doc(`configs/${created.id}`).update({ authStatus: 'linked' });
  await scope.runtimeDb.doc(`accounts/${created.id}`).set({ activeGeneration: 'existing', workspaceId: scope.workspace.id, deviceId: created.id });
  const configuration = await scope.control.createConfiguration(inputConfiguration(created.id), scope.identity.userId);
  return { deviceId: created.id, configurationId: configuration.id };
}
