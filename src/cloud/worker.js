import { randomUUID } from 'node:crypto';
import { Firestore } from '@google-cloud/firestore';
import { jidNormalizedUser } from 'baileys';
import { buildConfig } from '../config-values.js';
import { createSummarizer } from '../gemini.js';
import { createScanner } from '../scanner.js';
import { chatLabel } from '../store.js';
import { connectSession, NeedsPairingError } from '../once.js';
import { cloudEnvironment } from './env.js';
import { acquireLease } from './lease.js';
import { createFirestoreAuth } from './firestore-auth.js';
import { createFirestoreState } from './firestore-state.js';
import { configurationsOf, configurationSnapshot, dueConfigurations } from './configurations.js';
import { silenceDependencyConsole, logWorkerEvent } from './logging.js';

const iso = () => new Date().toISOString();
const silent = { log() {}, error() {} };
const summaryTotals = (results) => results.reduce((total, item) => {
  for (const key of ['processedMessages', 'deliveredParts', 'completedReports', 'pendingMessages', 'pendingReports']) total[key] += item.summary[key] || 0;
  return total;
}, { processedMessages: 0, deliveredParts: 0, completedReports: 0, pendingMessages: 0, pendingReports: 0 });

export async function runCloudWorker({ mode, env = cloudEnvironment(), variables = process.env,
  controlDb = new Firestore({ projectId: env.projectId, databaseId: env.controlDatabase }),
  runtimeDb = new Firestore({ projectId: env.projectId, databaseId: env.runtimeDatabase }),
  sessionFactory = connectSession, summarizeFactory = createSummarizer, log = logWorkerEvent } = {}) {
  const restoreConsole = silenceDependencyConsole();
  const beganAt = Date.now();
  let phase = 'configuration';
  const ref = controlDb.doc(`configs/${env.configId}`);
  const id = variables.REQUEST_ID || (variables.CLOUD_RUN_EXECUTION ? `execution-${variables.CLOUD_RUN_EXECUTION}` : randomUUID());
  const opRef = ref.collection('operations').doc(id);
  const pairing = mode === 'pair';
  const requested = (variables.CONFIGURATION_IDS || '').split(',').filter(Boolean);
  const manual = requested.length > 0;
  const controller = new AbortController();
  const stop = () => controller.abort(new Error('Shutdown requested'));
  process.once('SIGINT', stop); process.once('SIGTERM', stop);
  const deadline = setTimeout(() => controller.abort(new Error('Worker deadline exceeded')), pairing ? 270000 : 570000);
  let lease, renew, renewal, session, started = false, completed = false, queuesUpdated = false;
  let stores = [], results = [], operation;
  const executionName = variables.CLOUD_RUN_EXECUTION ? `projects/${env.projectId}/locations/${env.region}/jobs/${pairing ? env.pairingJob : env.summaryJob}/executions/${variables.CLOUD_RUN_EXECUTION}` : null;
  const runnable = (record) => !record || ['queued', 'running'].includes(record.status)
    || (!pairing && Number(variables.CLOUD_RUN_TASK_ATTEMPT) > 0 && record.status === 'failed' && record.execution === executionName);
  const eligible = (cfg) => cfg && (pairing ? cfg.maintenance && cfg.latestPairing === id
    : (cfg.enabled || manual) && !cfg.maintenance && cfg.authStatus === 'linked'
      && (manual || String(cfg.scheduleRevision) === String(variables.SCHEDULE_REVISION))
      && (!cfg.activeOperation || cfg.activeOperation === id));

  async function updateQueues() {
    if (!stores.length || queuesUpdated) return;
    await controlDb.runTransaction(async (tx) => {
      const current = (await tx.get(ref)).data();
      if (current.activeOperation !== id) return;
      const metadata = (item) => {
        const target = stores.find((entry) => entry.profile.id === item.id);
        if (!target) return item;
        const queued = target.store.messages();
        const result = results.find((entry) => entry.configurationId === item.id);
        const successful = result?.status === 'succeeded' && item.version === target.profile.version;
        return { ...item, queueCount: queued.length, pendingReportCount: target.store.reports().length,
          queueOldestAt: queued.length ? new Date(Math.min(...queued.map((message) => message.time.getTime()))).toISOString() : null,
          ...(successful ? { lastSuccessfulRunAt: iso(),
            ...(operation.scheduledSlots?.[item.id] ? { lastScheduledSlot: operation.scheduledSlots[item.id] } : {}) } : {}) };
      };
      const items = configurationsOf(current).map(metadata);
      const count = items.reduce((total, item) => total + (item.queueCount || 0), 0);
      const oldest = items.map((item) => item.queueOldestAt).filter(Boolean).sort()[0] || null;
      tx.update(ref, { queueCount: count, queueOldestAt: oldest,
        ...(current.configurations ? { configurations: items } : {}),
        ...(!pairing && results.length && results.every((item) => item.status === 'succeeded') ? { lastSuccessfulRunAt: iso() } : {}) });
    });
    queuesUpdated = true;
  }

  try {
    let cfg = (await ref.get()).data();
    if (!eligible(cfg)) return { skipped: true };
    const previous = (await opRef.get()).data();
    if (!runnable(previous)) return { skipped: true };
    if (!pairing && !manual && cfg.configurations && !previous?.configurationIds && !dueConfigurations(cfg).length) return { skipped: true };
    lease = await acquireLease({ db: runtimeDb, configId: env.configId, owner: id });
    if (!lease) return { skipped: true, busy: true };
    let renewing = false;
    renew = setInterval(() => {
      if (renewing) return;
      renewing = true;
      renewal = lease.renew().catch((error) => controller.abort(error)).finally(() => { renewing = false; });
    }, 15000);
    cfg = (await ref.get()).data();
    if (!eligible(cfg)) return { skipped: true };
    await controlDb.runTransaction(async (tx) => {
      const latest = (await tx.get(ref)).data();
      const record = (await tx.get(opRef)).data();
      if (!eligible(latest) || !runnable(record)) throw new Error('Operation no longer eligible');
      if (manual && (!record?.configurationIds || record.configurationIds.join(',') !== requested.join(','))) throw new Error('Run selection is not authorized');
      const due = !pairing && !manual && latest.configurations ? dueConfigurations(latest) : configurationsOf(latest);
      const configurationIds = record?.configurationIds || due.map((item) => item.id);
      if (!pairing && !configurationIds.length) throw new Error('No configurations are due');
      operation = { ...record, id, mode: pairing ? 'pair' : 'summary', status: 'running',
        createdAt: record?.createdAt || iso(), updatedAt: iso(), configVersion: record?.configVersion || latest.activeVersion,
        configurationIds, scheduledSlots: record?.scheduledSlots || (!manual && latest.configurations
          ? Object.fromEntries(due.filter((item) => item.scheduledSlot).map((item) => [item.id, item.scheduledSlot])) : {}),
        execution: executionName };
      tx.set(opRef, operation, { merge: true });
      tx.update(ref, { activeOperation: id });
      cfg = latest;
    });
    started = true;
    const version = (await ref.collection('versions').doc(String(operation.configVersion)).get()).data();
    if (!version) throw new Error('Active configuration version is missing');
    const snapshotProfiles = configurationsOf({ ...version, activeVersion: operation.configVersion });
    const profiles = [...snapshotProfiles, ...configurationsOf(cfg).filter((item) => !snapshotProfiles.some((snapshot) => snapshot.id === item.id))];
    const selected = pairing ? [] : operation.configurationIds.map((configurationId) => {
      const profile = profiles.find((item) => item.id === configurationId);
      if (!profile) throw new Error('Run configuration is missing');
      return profile;
    });
    const build = (profile) => ({ ...buildConfig(profile.settings, pairing ? 'pairing-does-not-use-gemini' : variables.GEMINI_API_KEY),
      showScanLogs: false, maxChatsPerScan: 2, maxMessagesPerBatch: 100, configVersion: profile.version });
    const config = build(profiles[0] || { settings: version.settings, version: operation.configVersion });
    const account = runtimeDb.doc(`accounts/${env.configId}`);
    phase = 'restore';
    const current = (await account.get()).data();
    const generation = pairing ? id : current?.activeGeneration;
    if (!generation) throw new NeedsPairingError();
    const auth = await createFirestoreAuth({ db: runtimeDb, configId: env.configId, generation, lease });
    stores = await Promise.all(profiles.map(async (profile) => ({ profile, config: build(profile),
      store: await createFirestoreState({ db: runtimeDb, configId: env.configId, configurationId: profile.id,
        lease, defaultLookbackMs: build(profile).defaultLookbackMs }) })));
    phase = 'connect';
    session = sessionFactory({ auth, config, store: stores[0]?.store,
      ...(cfg.configurations ? { collectionTargets: stores.map((entry) => ({ id: entry.profile.id, config: entry.config, store: entry.store })) } : {}),
      signal: controller.signal, pairing, onDiagnostic: (event) => log({ ...event, id, phase }),
      onQr: async (qr) => {
        if ((await opRef.get()).data().status !== 'running') throw new Error('Pairing cancelled');
        await opRef.update({ qr, qrExpiresAt: Date.now() + 45000, updatedAt: iso() });
      },
    });
    const socket = await session.ready();
    controller.signal.throwIfAborted();
    phase = 'synchronize';
    if (pairing) {
      if ((await opRef.get()).data().status !== 'running') throw new Error('Pairing cancelled');
      await opRef.update({ qr: null, stage: 'synchronize', updatedAt: iso() });
    } else await ref.update({ lastVerifiedAt: iso() });
    const collection = await session.collect();
    if (collection) await opRef.set({ collection }, { merge: true });
    if (pairing) {
      phase = 'pair-commit';
      if ((await opRef.get()).data().status !== 'running') throw new Error('Pairing cancelled');
      await auth.flush();
      await lease.write((tx) => tx.set(account, { activeGeneration: generation }, { merge: true }));
      await ref.update({ authStatus: 'linked', lastVerifiedAt: iso() });
    } else {
      phase = 'summary-delivery';
      for (const profile of selected) {
        const target = stores.find((entry) => entry.profile.id === profile.id);
        const result = { configurationId: profile.id, name: profile.name, version: profile.version, status: 'running',
          summary: { processedMessages: 0, deliveredParts: 0, completedReports: 0 },
          ...(collection?.configurations?.[profile.id] ? { collection: collection.configurations[profile.id] } : {}) };
        results.push(result);
        try {
          const scanner = createScanner({ config: target.config, store: target.store, chatLabel,
            summarizeChat: summarizeFactory({ config: target.config, logger: silent }), normalizeJid: jidNormalizedUser, logger: silent });
          for (;;) {
            session.signal.throwIfAborted();
            const latest = (await ref.get()).data();
            if (latest.maintenance || latest.authStatus !== 'linked' || (latest.activeOperation && latest.activeOperation !== id)) throw new Error('Run superseded');
            const scan = await scanner.runScan(socket, { signal: session.signal });
            result.summary.processedMessages += scan.processed;
            result.summary.deliveredParts += scan.deliveredParts;
            result.summary.completedReports += scan.completedReports;
            result.summary.pendingMessages = target.store.messages().length;
            result.summary.pendingReports = scan.pendingReports;
            await opRef.set({ configurationResults: results, summary: summaryTotals(results) }, { merge: true });
            if (scan.failed || scan.pendingReports) throw new Error('Summary or delivery failed; queued work is preserved');
            if (!scan.processed) break;
          }
          result.status = 'succeeded';
          result.outcome = result.summary.deliveredParts ? 'sent' : result.summary.pendingMessages ? 'waiting_for_inactivity' : 'no_messages';
        } catch {
          session.signal.throwIfAborted();
          result.status = 'failed';
          result.error = 'Summary or delivery failed. Pending work is preserved.';
        }
        await opRef.set({ configurationResults: results, summary: summaryTotals(results) }, { merge: true });
      }
      if (results.some((item) => item.status === 'failed')) throw new Error('Summary or delivery failed; queued work is preserved');
      const summary = summaryTotals(results);
      const outcome = summary.deliveredParts ? 'sent' : summary.pendingMessages ? 'waiting_for_inactivity' : 'no_messages';
      await opRef.set({ outcome }, { merge: true });
      log({ event: 'worker_summary_finished', id, outcome, ...summary });
    }
    phase = 'shutdown';
    await session.stop(); session = undefined;
    await updateQueues();
    completed = true;
    return { completed: true };
  } catch (error) {
    if (error instanceof NeedsPairingError) await controlDb.runTransaction(async (tx) => {
      const current = (await tx.get(ref)).data();
      const changes = { authStatus: 'needsPairing', enabled: false, scheduleRevision: current.scheduleRevision + 1, scheduleStatus: 'pending' };
      if (current.configurations) {
        changes.configurations = current.configurations.map((item) => ({ ...item, enabled: false, version: item.version + 1 }));
        changes.activeVersion = current.activeVersion + 1;
        tx.create(ref.collection('versions').doc(String(changes.activeVersion)), configurationSnapshot({ ...current, ...changes }));
      }
      tx.update(ref, changes);
    });
    if (started) await opRef.set({ error: error instanceof NeedsPairingError ? error.message
      : phase === 'summary-delivery' ? 'Summary or delivery failed. Check Gemini key/model/quotas and recipients. Pending work is preserved.'
        : 'Worker failed. Pending work is preserved; inspect Cloud Logging.', failurePhase: phase, updatedAt: iso() }, { merge: true });
    log({ event: 'worker_failed', id, phase, type: /^[A-Za-z][A-Za-z0-9]{0,40}$/.test(error.name) ? error.name : 'Error' });
    throw error;
  } finally {
    if (session) { try { await session.stop(); } catch { completed = false; } }
    clearTimeout(deadline); clearInterval(renew);
    try {
      if (started) {
        await updateQueues();
        await controlDb.runTransaction(async (tx) => {
          const cfg = (await tx.get(ref)).data();
          const record = (await tx.get(opRef)).data();
          tx.set(opRef, { status: record?.status === 'cancelling' || record?.status === 'cancelled' ? 'cancelled' : completed ? 'succeeded' : 'failed', qr: null, updatedAt: iso(), finishedAt: iso() }, { merge: true });
          if (cfg.activeOperation === id) tx.update(ref, { activeOperation: null, ...(pairing ? { enabled: false, maintenance: false } : {}) });
        });
      }
    } finally {
      await renewal;
      await lease?.release().catch(() => {});
      process.removeListener('SIGINT', stop); process.removeListener('SIGTERM', stop);
      restoreConsole();
      log({ event: 'worker_finished', id, mode, started, completed, durationMs: Date.now() - beganAt });
    }
  }
}

if (process.argv[1]?.endsWith('/cloud/worker.js')) {
  silenceDependencyConsole();
  const mode = process.argv.includes('--pair') ? 'pair' : 'summary';
  try { await runCloudWorker({ mode }); }
  catch { process.exitCode = 1; }
}
