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
import { silenceDependencyConsole, logWorkerEvent } from './logging.js';

const iso = () => new Date().toISOString();
const silent = { log() {}, error() {} };

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
  const controller = new AbortController();
  const stop = () => controller.abort(new Error('Shutdown requested'));
  process.once('SIGINT', stop); process.once('SIGTERM', stop);
  const deadline = setTimeout(() => controller.abort(new Error('Worker deadline exceeded')), pairing ? 270000 : 570000);
  let lease, renew, renewal, session, config, started = false, completed = false;
  const executionName = variables.CLOUD_RUN_EXECUTION ? `projects/${env.projectId}/locations/${env.region}/jobs/${pairing ? env.pairingJob : env.summaryJob}/executions/${variables.CLOUD_RUN_EXECUTION}` : null;
  const runnable = (operation) => !operation || ['queued', 'running'].includes(operation.status)
    || (!pairing && Number(variables.CLOUD_RUN_TASK_ATTEMPT) > 0 && operation.status === 'failed' && operation.execution === executionName);
  const eligible = (cfg) => cfg && (pairing
    ? cfg.maintenance && cfg.latestPairing === id
    : cfg.enabled && !cfg.maintenance && cfg.authStatus === 'linked'
      && String(cfg.scheduleRevision) === String(variables.SCHEDULE_REVISION)
      && (!cfg.activeOperation || cfg.activeOperation === id));
  try {
    let cfg = (await ref.get()).data();
    if (!eligible(cfg)) return { skipped: true };
    const previous = (await opRef.get()).data();
    if (!runnable(previous)) return { skipped: true };
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
      const operation = (await tx.get(opRef)).data();
      if (!eligible(latest) || !runnable(operation)) throw new Error('Operation no longer eligible');
      tx.set(opRef, { id, mode: pairing ? 'pair' : 'summary', status: 'running',
        createdAt: operation?.createdAt || iso(), updatedAt: iso(), configVersion: latest.activeVersion,
        execution: executionName }, { merge: true });
      tx.update(ref, { activeOperation: id });
      cfg = latest;
    });
    started = true;
    const version = (await ref.collection('versions').doc(String(cfg.activeVersion)).get()).data();
    if (!version) throw new Error('Active configuration version is missing');
    config = { ...buildConfig(version.settings, pairing ? 'pairing-does-not-use-gemini' : variables.GEMINI_API_KEY),
      showScanLogs: false, maxChatsPerScan: 2, maxMessagesPerBatch: 100, configVersion: cfg.activeVersion };
    const account = runtimeDb.doc(`accounts/${env.configId}`);
    phase = 'restore';
    const current = (await account.get()).data();
    const generation = pairing ? id : current?.activeGeneration;
    if (!generation) throw new NeedsPairingError();
    const auth = await createFirestoreAuth({ db: runtimeDb, configId: env.configId, generation, lease });
    const store = pairing ? undefined : await createFirestoreState({ db: runtimeDb, configId: env.configId, lease, defaultLookbackMs: config.defaultLookbackMs });
    phase = 'connect';
    session = sessionFactory({ auth, config, store, signal: controller.signal, pairing,
      onDiagnostic: (event) => log({ ...event, id, phase }),
      onQr: async (qr) => {
        const operation = (await opRef.get()).data();
        if (operation.status !== 'running') throw new Error('Pairing cancelled');
        await opRef.update({ qr, qrExpiresAt: Date.now() + 45000, updatedAt: iso() });
      },
    });
    const socket = await session.ready();
    controller.signal.throwIfAborted();
    if (pairing) {
      phase = 'pair-commit';
      if ((await opRef.get()).data().status !== 'running') throw new Error('Pairing cancelled');
      await auth.flush();
      await lease.write((tx) => tx.set(account, { activeGeneration: generation }, { merge: true }));
      await ref.update({ authStatus: 'linked', lastVerifiedAt: iso() });
    } else {
      phase = 'synchronize';
      await ref.update({ lastVerifiedAt: iso() });
      await session.collect();
      phase = 'summary-delivery';
      const scanner = createScanner({ config, store, chatLabel, summarizeChat: summarizeFactory({ config, logger: silent }), normalizeJid: jidNormalizedUser, logger: silent });
      for (;;) {
        session.signal.throwIfAborted();
        const latest = (await ref.get()).data();
        // Pausing or editing settings affects future runs. This execution keeps
        // its immutable configuration until it finishes or is cancelled.
        if (latest.maintenance || latest.authStatus !== 'linked'
          || (latest.activeOperation && latest.activeOperation !== id)) throw new Error('Run superseded');
        const result = await scanner.runScan(socket, { signal: session.signal });
        if (result.failed || result.pendingReports) throw new Error('Summary or delivery failed; queued work is preserved');
        if (!result.processed) break;
      }
    }
    phase = 'shutdown';
    await session.stop(); session = undefined;
    if (store) {
      const queued = store.messages();
      await ref.update({ queueCount: queued.length, queueOldestAt: queued.length ? new Date(Math.min(...queued.map((m) => m.time.getTime()))).toISOString() : null, lastSuccessfulRunAt: iso() });
    }
    completed = true;
    return { completed: true };
  } catch (error) {
    if (error instanceof NeedsPairingError) await controlDb.runTransaction(async (tx) => {
      const current = (await tx.get(ref)).data();
      tx.update(ref, { authStatus: 'needsPairing', enabled: false,
        scheduleRevision: current.scheduleRevision + 1, scheduleStatus: 'pending' });
    });
    if (started) await opRef.set({ error: error instanceof NeedsPairingError ? error.message
      : phase === 'summary-delivery' ? 'Summary or delivery failed. Check Gemini key/model/quotas and recipients. Pending work is preserved.'
        : 'Worker failed. Pending work is preserved; inspect Cloud Logging.', failurePhase: phase, updatedAt: iso() }, { merge: true });
    // Provider exceptions can contain chat text, credentials, or QR payloads.
    log({ event: 'worker_failed', id, phase, type: /^[A-Za-z][A-Za-z0-9]{0,40}$/.test(error.name) ? error.name : 'Error' });
    throw error;
  } finally {
    if (session) { try { await session.stop(); } catch { completed = false; } }
    clearTimeout(deadline); clearInterval(renew);
    try { if (started) await controlDb.runTransaction(async (tx) => {
      const cfg = (await tx.get(ref)).data();
      const operation = (await tx.get(opRef)).data();
      tx.set(opRef, { status: operation?.status === 'cancelling' || operation?.status === 'cancelled' ? 'cancelled' : completed ? 'succeeded' : 'failed', qr: null, updatedAt: iso(), finishedAt: iso() }, { merge: true });
      if (cfg.activeOperation === id) tx.update(ref, { activeOperation: null, ...(pairing ? { enabled: false, maintenance: false } : {}) });
    }); } finally {
      await renewal;
      await lease?.release().catch(() => {});
      process.removeListener('SIGINT', stop); process.removeListener('SIGTERM', stop);
      restoreConsole();
      log({ event: 'worker_finished', id, mode, started, completed, durationMs: Date.now() - beganAt });
    }
  }
}

if (process.argv[1]?.endsWith('/cloud/worker.js')) {
  // Keep late dependency callbacks quiet until this dedicated process exits.
  silenceDependencyConsole();
  const mode = process.argv.includes('--pair') ? 'pair' : 'summary';
  try { await runCloudWorker({ mode }); }
  catch { process.exitCode = 1; }
}
