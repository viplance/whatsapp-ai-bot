import { createHash } from 'node:crypto';
import { HttpError, nextRunAt } from './settings.js';
import { configurationsOf, dueConfigurations } from './configurations.js';

export const MAX_DEVICES = 5;
export const MAX_WORKSPACE_CONCURRENCY = 2;
export const subjectKey = (subject) => createHash('sha256').update(subject).digest('hex');
export const validId = (value) => typeof value === 'string' && /^[a-z][a-z0-9-]{0,59}$/.test(value);
export function workspaceEnvironment(env, workspace) {
  if (!workspace || !validId(workspace.id) || !['active', 'provisioning', 'migrating'].includes(workspace.status)
    || ![workspace.controlDatabase, workspace.runtimeDatabase, workspace.summaryJob, workspace.pairingJob].every(validId)
    || workspace.controlDatabase === workspace.runtimeDatabase || workspace.controlDatabase === env.registryDatabase
    || workspace.runtimeDatabase === env.registryDatabase) throw new HttpError(503, 'Invalid workspace registration.');
  return { ...env, workspaceId: workspace.id, controlDatabase: workspace.controlDatabase,
    runtimeDatabase: workspace.runtimeDatabase, summaryJob: workspace.summaryJob, pairingJob: workspace.pairingJob };
}

export async function resolveWorkspace({ registryDb, env, identity, requestedId }) {
  if (typeof identity.userId !== 'string' || !identity.userId || identity.userId.length > 500) throw new HttpError(403, 'Workspace access is required.');
  const membership = (await registryDb.doc(`members/${subjectKey(identity.userId)}`).get()).data();
  if (!membership || membership.subject !== identity.userId || membership.status !== 'active'
    || !['owner', 'editor'].includes(membership.role) || (requestedId && requestedId !== membership.workspaceId)) throw new HttpError(404, 'Workspace not found.');
  const workspace = (await registryDb.doc(`workspaces/${membership.workspaceId}`).get()).data();
  if (workspace?.id !== membership.workspaceId) throw new HttpError(503, 'Invalid workspace registration.');
  const scopedEnv = workspaceEnvironment(env, workspace);
  if (workspace.status !== 'active') throw new HttpError(503, 'Workspace is being prepared. Try again later.');
  return { workspace, env: scopedEnv, membership };
}

export async function assertWorkspace(db, workspaceId) {
  const value = (await db.doc('workspace/meta').get()).data();
  if (value?.id !== workspaceId || value.status !== 'active') throw new HttpError(503, 'Workspace is unavailable.');
}

export async function devicesOf(db, workspaceId) {
  const result = await db.collection('configs').limit(MAX_DEVICES + 1).get();
  if (result.docs.length > MAX_DEVICES) throw new HttpError(503, 'Workspace device limit exceeded.');
  return result.docs.map((doc) => {
    const value = doc.data();
    if (value.workspaceId !== workspaceId || value.deviceId !== doc.id || !validId(doc.id)) throw new HttpError(503, 'Invalid device ownership.');
    return { ...value, id: doc.id };
  });
}

// The shared index is a dispatch hint. Workers independently check their saved schedules.
export async function publishDueIndex({ registryDb, controlDb, workspaceId, now = new Date() }) {
  await assertWorkspace(controlDb, workspaceId);
  const [devices, queued] = await Promise.all([devicesOf(controlDb, workspaceId),
    controlDb.collection('requests').where('status', 'in', ['queued', 'running']).limit(MAX_DEVICES + 1).get()]);
  const requests = queued.docs.map((doc) => doc.data()).filter((item) => item.status === 'queued' || item.claimUntil <= now.getTime());
  let nextSummaryAt = requests.some((item) => item.mode === 'summary') ? now.toISOString() : null;
  let dueDevices = 0;
  for (const device of devices) {
    if (device.maintenance || device.authStatus !== 'linked' || device.activeOperation) continue;
    if (dueConfigurations(device, now).length) { nextSummaryAt = now.toISOString(); dueDevices++; continue; }
    for (const item of configurationsOf(device)) {
      const next = nextRunAt({ ...item, scheduleStatus: 'applied' }, now);
      if (next && (!nextSummaryAt || next < nextSummaryAt)) nextSummaryAt = next;
    }
  }
  await registryDb.doc(`dispatch/${workspaceId}`).set({ workspaceId, nextSummaryAt,
    summaryLaunches: Math.min(MAX_WORKSPACE_CONCURRENCY, Math.max(1, dueDevices + requests.filter((item) => item.mode === 'summary').length)),
    pairPending: requests.some((item) => item.mode === 'pair'), updatedAt: now.toISOString() }, { merge: true });
}
