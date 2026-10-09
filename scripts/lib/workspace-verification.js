import assert from 'node:assert/strict';
import { setTimeout as sleep } from 'node:timers/promises';
import { cliAuth } from '../cloud-client.js';

export async function verifyWorkspaceIamWithRetry({ pause = sleep, ...options }) {
  for (let attempt = 0; ; attempt++) {
    try { return await verifyWorkspaceIam(options); }
    catch (error) {
      // Newly created grants can take time to reach Firestore/Secret Manager.
      // Unexpected allowed access is an assertion failure and must stop immediately.
      const denied = Number(error.code) === 7 || error.response?.status === 403 || /PERMISSION_DENIED/.test(error.message);
      if (error.name === 'AssertionError' || !denied || attempt >= 5) throw error;
      await pause(5000);
    }
  }
}

// Read-only checks exercise effective IAM, including inherited/project-level grants.
export async function verifyWorkspaceIam({ env, workspace, registryDb, database, authFactory = cliAuth }) {
  const admin = authFactory(`whatsapp-admin@${env.projectId}.iam.gserviceaccount.com`);
  const dispatcher = authFactory(`whatsapp-dispatcher@${env.projectId}.iam.gserviceaccount.com`);
  const summary = authFactory(workspace.summaryAccount), pairing = authFactory(workspace.pairingAccount);
  const read = (id, auth) => database(id, auth).doc('workspace/meta').get();
  const denied = (action) => assert.rejects(action, (error) => Number(error.code) === 7 || error.response?.status === 403);
  await read(workspace.controlDatabase, admin);
  await denied(read(workspace.runtimeDatabase, admin));
  await denied(read(workspace.runtimeDatabase, dispatcher));
  for (const auth of [summary, pairing]) {
    await read(workspace.controlDatabase, auth); await read(workspace.runtimeDatabase, auth);
    await denied(read(env.registryDatabase, auth));
  }
  const others = (await registryDb.collection('workspaces').get()).docs.map((doc) => doc.data()).filter((item) => item.id !== workspace.id);
  const foreign = new Set([env.controlDatabase, env.runtimeDatabase, ...others.flatMap((item) => [item.controlDatabase, item.runtimeDatabase])]);
  foreign.delete(workspace.controlDatabase); foreign.delete(workspace.runtimeDatabase);
  for (const id of foreign) if (id) for (const auth of [summary, pairing]) await denied(read(id, auth));
  const secret = async (name, auth) => (await auth.getClient()).request({
    url: `https://secretmanager.googleapis.com/v1/projects/${env.projectId}/secrets/${name}/versions/latest:access`, timeout: 30000, retry: false });
  await secret(workspace.geminiSecret, summary);
  for (const auth of [admin, pairing, dispatcher]) await denied(secret(workspace.geminiSecret, auth));
  for (const other of others) for (const auth of [summary, pairing]) await denied(secret(other.geminiSecret, auth));
  for (const auth of [admin, summary, pairing, dispatcher]) await denied(secret('whatsapp-account-registry-key', auth));
  for (const job of [workspace.summaryJob, workspace.pairingJob]) for (const auth of [admin, dispatcher]) {
    const permissions = ['run.jobs.run', 'run.jobs.runWithOverrides', 'run.jobs.update', 'run.jobs.setIamPolicy'];
    const result = (await (await auth.getClient()).request({
      url: `https://run.googleapis.com/v2/projects/${env.projectId}/locations/${env.region}/jobs/${job}:testIamPermissions`,
      method: 'POST', data: { permissions }, timeout: 30000, retry: false })).data.permissions || [];
    assert.ok(result.includes('run.jobs.run'), 'Launcher cannot start its registered Job');
    assert.ok(!result.some((permission) => permission !== 'run.jobs.run'), 'Launcher has override or Job modification permissions');
  }
  for (const target of [workspace.summaryAccount, workspace.pairingAccount]) for (const auth of [admin, dispatcher]) {
    const result = (await (await auth.getClient()).request({
      url: `https://iam.googleapis.com/v1/projects/${env.projectId}/serviceAccounts/${target}:testIamPermissions`, method: 'POST',
      data: { permissions: ['iam.serviceAccounts.actAs', 'iam.serviceAccounts.getAccessToken', 'iam.serviceAccounts.getOpenIdToken', 'iam.serviceAccounts.signBlob', 'iam.serviceAccounts.signJwt'] },
      timeout: 30000, retry: false })).data.permissions || [];
    assert.equal(result.length, 0, 'Launcher can impersonate a workspace worker');
  }
}
