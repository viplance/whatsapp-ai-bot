import { createHash, randomUUID } from 'node:crypto';
import { Firestore } from '@google-cloud/firestore';
import { createRegistryClient } from './registry-client.js';
import { assertWorkspace, devicesOf, MAX_DEVICES, MAX_WORKSPACE_CONCURRENCY, validId } from './workspaces.js';
import { dueConfigurations } from './configurations.js';
import { silenceDependencyConsole, logWorkerEvent } from './logging.js';

const iso = () => new Date().toISOString();
export async function enqueueScheduled({ controlDb, env, now = new Date(), skipDevices = new Set() }) {
  for (const device of await devicesOf(controlDb, env.workspaceId)) {
    if (skipDevices.has(device.id) || device.activeOperation || device.maintenance || device.authStatus !== 'linked') continue;
    await controlDb.runTransaction(async (tx) => {
      const ref = controlDb.doc(`configs/${device.id}`), cfg = (await tx.get(ref)).data();
      if (cfg.activeOperation || cfg.maintenance || cfg.authStatus !== 'linked') return;
      const due = dueConfigurations(cfg, now);
      if (!due.length) return;
      const id = createHash('sha256').update(`${env.workspaceId}:${device.id}:${cfg.activeVersion}:${JSON.stringify(due.map((item) => [item.id, item.scheduledSlot]))}`).digest('hex');
      const requestRef = controlDb.doc(`requests/${id}`), old = (await tx.get(requestRef)).data();
      if (old) return;
      const scope = { workspaceId: env.workspaceId, deviceId: device.id, mode: 'summary', status: 'queued', createdAt: iso(), updatedAt: iso(), id };
      tx.create(requestRef, { ...scope, scheduled: true, attempts: 0 });
      tx.create(ref.collection('operations').doc(id), { ...scope, owner: 'scheduler', qr: null,
        configurationIds: due.map((item) => item.id), configVersion: cfg.activeVersion, scheduleRevision: cfg.scheduleRevision,
        scheduledSlots: Object.fromEntries(due.map((item) => [item.id, item.scheduledSlot])) });
      tx.update(ref, { activeOperation: id });
    });
  }
}

export async function runWorkspaceWorker({ mode, env, variables = process.env,
  controlDb = new Firestore({ projectId: env.projectId, databaseId: env.controlDatabase }),
  runtimeDb = new Firestore({ projectId: env.projectId, databaseId: env.runtimeDatabase }),
  registry = createRegistryClient({ env }), worker = async (options) => (await import('./worker.js')).runCloudWorker(options), now = Date.now, log = logWorkerEvent, ...workerOptions } = {}) {
  const restoreConsole = silenceDependencyConsole();
  let request, renewal, renewing, claimed = false, done = false;
  const execution = variables.CLOUD_RUN_EXECUTION
    ? `projects/${env.projectId}/locations/${env.region}/jobs/${mode === 'pair' ? env.pairingJob : env.summaryJob}/executions/${variables.CLOUD_RUN_EXECUTION}` : `local-${randomUUID()}`;
  const claimsRef = controlDb.doc('workspace/claims');
  try {
    if (!env.workspaceId || !['summary', 'pair'].includes(mode)) throw new Error('Workspace worker scope is required');
    await assertWorkspace(controlDb, env.workspaceId);
    const retrying = Number(variables.CLOUD_RUN_TASK_ATTEMPT) > 0;
    const retries = retrying ? await controlDb.collection('requests').where('execution', '==', execution).limit(MAX_DEVICES + 1).get() : { docs: [] };
    // A task retry resumes its pinned snapshot before newer schedule slots.
    if (mode === 'summary') await enqueueScheduled({ controlDb, env, now: new Date(now()),
      skipDevices: new Set(retries.docs.filter((doc) => doc.data().status === 'failed').map((doc) => doc.data().deviceId)) });
    const statuses = ['queued', 'running'];
    const batches = await Promise.all(statuses.map((status) => controlDb.collection('requests').where('status', '==', status).limit(MAX_DEVICES + 1).get()));
    batches.push(retries);
    const candidates = [...new Map(batches.flatMap((batch) => batch.docs.map((doc) => [doc.id, doc.data()]))).values()]
      .filter((item) => item.mode === mode && (item.status === 'queued' || item.claimUntil <= now()
        || (item.execution === execution && Number(variables.CLOUD_RUN_TASK_ATTEMPT) > 0 && item.status === 'failed')))
      .sort((a, b) => Number(b.execution === execution && retrying) - Number(a.execution === execution && retrying)
        || a.createdAt.localeCompare(b.createdAt));
    for (const candidate of candidates) {
      if (!/^[a-f0-9]{64}$/.test(candidate.id || '') || !validId(candidate.deviceId) || candidate.workspaceId !== env.workspaceId) throw new Error('Invalid request ownership');
      const ref = controlDb.doc(`requests/${candidate.id}`), deviceRef = controlDb.doc(`configs/${candidate.deviceId}`);
      request = await controlDb.runTransaction(async (tx) => {
        const latest = (await tx.get(ref)).data(), device = (await tx.get(deviceRef)).data();
        const operation = (await tx.get(deviceRef.collection('operations').doc(candidate.id))).data();
        const oldClaims = (await tx.get(claimsRef)).data()?.running || {};
        const running = Object.fromEntries(Object.entries(oldClaims).filter(([, value]) => value.until > now()));
        if (!latest || latest.workspaceId !== env.workspaceId || latest.deviceId !== candidate.deviceId || latest.mode !== mode
          || !device || device.workspaceId !== env.workspaceId || device.deviceId !== candidate.deviceId
          || operation?.workspaceId !== env.workspaceId || operation.deviceId !== candidate.deviceId || operation.mode !== mode) throw new Error('Invalid request ownership');
        const retry = latest.status === 'failed' && latest.execution === execution && Number(variables.CLOUD_RUN_TASK_ATTEMPT) > 0;
        if (latest.status !== 'queued' && !retry && !(latest.status === 'running' && latest.claimUntil <= now())) return null;
        if (latest.attempts >= 3 || ['cancelled', 'cancelling', 'succeeded'].includes(operation.status)
          || (device.activeOperation && device.activeOperation !== candidate.id)) {
          tx.update(ref, { status: 'cancelled', updatedAt: iso() });
          if (device.activeOperation === candidate.id) {
            tx.update(deviceRef.collection('operations').doc(candidate.id), { status: 'cancelled', qr: null, updatedAt: iso() });
            tx.update(deviceRef, { activeOperation: null, maintenance: false });
          }
          return null;
        }
        if (Object.keys(running).length >= MAX_WORKSPACE_CONCURRENCY && !running[candidate.id]) return null;
        if (Object.entries(running).some(([id, value]) => id !== candidate.id && value.deviceId === candidate.deviceId)) return null;
        const value = { ...latest, status: 'running', execution, claimUntil: now() + 660000, attempts: latest.attempts + 1, updatedAt: iso() };
        tx.set(ref, value);
        tx.update(deviceRef.collection('operations').doc(candidate.id), { execution });
        tx.set(claimsRef, { running: { ...running, [candidate.id]: { execution, deviceId: candidate.deviceId, until: value.claimUntil } } });
        return value;
      });
      if (request) break;
    }
    if (!request) { await registry.sync(); return { skipped: true }; }
    claimed = true;
    renewal = setInterval(() => {
      if (renewing) return;
      renewing = controlDb.runTransaction(async (tx) => {
        const current = (await tx.get(controlDb.doc(`requests/${request.id}`))).data();
        const claims = (await tx.get(claimsRef)).data()?.running || {};
        if (current.status !== 'running' || current.execution !== execution) return;
        const until = now() + 660000;
        tx.update(controlDb.doc(`requests/${request.id}`), { claimUntil: until });
        tx.set(claimsRef, { running: { ...claims, [request.id]: { execution, deviceId: request.deviceId, until } } });
      }).finally(() => { renewing = undefined; });
      renewing.catch(() => {}); // The runtime lease still fences all session/queue writes.
    }, 30000);
    const operation = (await controlDb.doc(`configs/${request.deviceId}/operations/${request.id}`).get()).data();
    let verifiedAccount;
    const verifyAccount = async (accountId) => {
      if (verifiedAccount === accountId && verifiedAccount) return;
      await registry.verifyAccount(request.deviceId, request.id, accountId, mode === 'pair');
      verifiedAccount = accountId;
    };
    const result = await worker({ ...workerOptions, mode, env: { ...env, configId: request.deviceId }, controlDb, runtimeDb, log, verifyAccount,
      variables: { GEMINI_API_KEY: variables.GEMINI_API_KEY, CLOUD_RUN_EXECUTION: variables.CLOUD_RUN_EXECUTION,
        CLOUD_RUN_TASK_ATTEMPT: variables.CLOUD_RUN_TASK_ATTEMPT, REQUEST_ID: request.id,
        SCHEDULE_REVISION: String(operation.scheduleRevision ?? (await controlDb.doc(`configs/${request.deviceId}`).get()).data().scheduleRevision),
        SCHEDULED_REQUEST: request.scheduled ? 'true' : 'false', CONFIGURATION_IDS: operation.configurationIds?.join(',') || '' } });
    if (result.busy) {
      await controlDb.doc(`requests/${request.id}`).update({ status: 'queued', attempts: request.attempts - 1, claimUntil: 0, updatedAt: iso() });
      return result;
    }
    await controlDb.runTransaction(async (tx) => {
      const opRef = controlDb.doc(`configs/${request.deviceId}/operations/${request.id}`), deviceRef = controlDb.doc(`configs/${request.deviceId}`);
      const op = (await tx.get(opRef)).data(), device = (await tx.get(deviceRef)).data();
      if (op.status === 'queued' && result.skipped) {
        tx.update(opRef, { status: 'cancelled', qr: null, updatedAt: iso() });
        if (device.activeOperation === request.id) tx.update(deviceRef, { activeOperation: null, maintenance: false });
      }
      tx.update(controlDb.doc(`requests/${request.id}`), { status: result.completed ? 'succeeded' : 'cancelled', claimUntil: 0, updatedAt: iso() });
    });
    done = true;
    return result;
  } catch (error) {
    if (claimed && !done) await controlDb.runTransaction(async (tx) => {
      const opRef = controlDb.doc(`configs/${request.deviceId}/operations/${request.id}`), deviceRef = controlDb.doc(`configs/${request.deviceId}`);
      const operation = (await tx.get(opRef)).data(), device = (await tx.get(deviceRef)).data();
      tx.update(controlDb.doc(`requests/${request.id}`), { status: 'failed', claimUntil: 0, updatedAt: iso() });
      if (['queued', 'running'].includes(operation.status)) tx.update(opRef, { status: 'failed', qr: null, updatedAt: iso(), error: 'Worker failed. Pending work is preserved.' });
      if (device.activeOperation === request.id) tx.update(deviceRef, { activeOperation: null, maintenance: false });
    });
    log({ event: 'workspace_worker_failed', workspaceId: env.workspaceId, mode });
    throw error;
  } finally {
    clearInterval(renewal);
    try {
      await renewing?.catch(() => {});
      if (claimed) await controlDb.runTransaction(async (tx) => {
        const claims = (await tx.get(claimsRef)).data()?.running || {};
        if (claims[request.id]?.execution === execution) { delete claims[request.id]; tx.set(claimsRef, { running: claims }); }
      });
      if (claimed) await registry.sync();
    } finally { restoreConsole(); }
  }
}
