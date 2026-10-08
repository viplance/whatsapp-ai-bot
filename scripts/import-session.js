import { readFile, readdir } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { BufferJSON } from 'baileys';
import { cliDatabase } from './cloud-client.js';
import { cloudEnvironment } from '../src/cloud/env.js';
import { acquireLease } from '../src/cloud/lease.js';
import { documentId } from '../src/cloud/firestore-state.js';
import { createFirestoreAuth } from '../src/cloud/firestore-auth.js';
import { createStateStore } from '../src/state.js';
import { buildConfig } from '../src/config-values.js';
import { connectSession, NeedsPairingError } from '../src/once.js';
import { silenceDependencyConsole, logWorkerEvent } from '../src/cloud/logging.js';

// This is an explicit migration command, never part of deployment. Verification
// connects to WhatsApp but sends no summaries. Source files remain untouched.
if (!process.argv.includes('--local-bot-stopped')) throw new Error('Stop the local bot, then pass --local-bot-stopped.');
const env = cloudEnvironment();
const id = `import-${randomUUID()}`;
const controlDb = cliDatabase(env.projectId, env.controlDatabase);
const runtimeDb = cliDatabase(env.projectId, env.runtimeDatabase);
const ref = controlDb.doc(`configs/${env.configId}`);
const opRef = ref.collection('operations').doc(id);
const account = runtimeDb.doc(`accounts/${env.configId}`);
const root = account.collection('sessions').doc(id);
const owner = execFileSync('gcloud', ['auth', 'list', '--filter=status:ACTIVE', '--format=value(account)'], { encoding: 'utf8' }).trim();
const controller = new AbortController();
const timer = setTimeout(() => controller.abort(new Error('Import verification timed out')), 120000);
const stop = () => controller.abort(new Error('Import interrupted'));
process.once('SIGINT', stop); process.once('SIGTERM', stop);
let lease, session, renewal, renewing, reserved = false, activated = false;
silenceDependencyConsole();
const staged = [];
try {
  const config = (await ref.get()).data();
  if (!config || config.enabled || config.maintenance || config.activeOperation) throw new Error('Pause scheduling and finish active operations before importing.');
  const local = createStateStore({ file: 'scan-state.json', defaultLookbackMs: buildConfig(config.settings, 'import').defaultLookbackMs });
  const raw = JSON.parse(await readFile('scan-state.json', 'utf8'));
  const creds = JSON.parse(await readFile('auth_info_baileys/creds.json', 'utf8'), BufferJSON.reviver);
  if (!creds.registered) throw new Error('The local session is not registered. Pair through the admin UI instead.');
  // Validate local queues before writing any runtime data.
  const messages = local.messages().map((m) => ({ ...m, time: m.time.toISOString() }));
  const reports = local.reports();
  if (reports.some((report) => report.messageIds.length > 200 || Buffer.byteLength(JSON.stringify(report)) > 750000)) throw new Error('Finish oversized local reports before importing; cloud reports support at most 200 input messages.');
  const seen = Object.entries(raw.seen || {}).map(([id, time]) => ({ id, time }));
  lease = await acquireLease({ db: runtimeDb, configId: env.configId, owner: id });
  if (!lease) throw new Error('Another execution holds the account lease.');
  renewal = setInterval(() => { if (!renewing) renewing = lease.renew().catch((error) => controller.abort(error)).finally(() => { renewing = undefined; }); }, 15000);
  const existing = await Promise.all(['messages', 'reports', 'seen'].map((name) => account.collection(name).limit(1).get()));
  if ((await account.get()).data()?.activeGeneration || existing.some((s) => s.docs.length)) throw new Error('Import requires an empty runtime account; existing cloud work will not be overwritten.');
  await controlDb.runTransaction(async (tx) => {
    const latest = (await tx.get(ref)).data();
    if (latest.enabled || latest.maintenance || latest.activeOperation) throw new Error('Account state changed; retry after pausing.');
    tx.create(opRef, { id, mode: 'pair', owner, status: 'running', createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), source: 'local-import', qr: null });
    tx.update(ref, { maintenance: true, activeOperation: id, latestPairing: id });
  });
  reserved = true;
  staged.push(root);
  await lease.write((tx) => tx.set(root, { creds: JSON.stringify(creds, BufferJSON.replacer), legacyKeys: true }));
  const files = (await readdir('auth_info_baileys')).filter((file) => file.endsWith('.json') && file !== 'creds.json');
  for (let offset = 0; offset < files.length; offset += 100) {
    controller.signal.throwIfAborted();
    const keys = await Promise.all(files.slice(offset, offset + 100).map(async (file) => {
      const value = await readFile(`auth_info_baileys/${file}`, 'utf8');
      JSON.parse(value, BufferJSON.reviver);
      return { file, value };
    }));
    const records = keys.map(({ file, value }) => ({ ref: root.collection('keys').doc(documentId(`file:${file}`)), value }));
    staged.push(...records.map((record) => record.ref));
    await lease.write((tx) => { for (const record of records) tx.set(record.ref, { value: record.value }); });
  }
  const auth = await createFirestoreAuth({ db: runtimeDb, configId: env.configId, generation: id, lease });
  session = connectSession({ auth, config: buildConfig(config.settings, 'import'), pairing: true,
    signal: controller.signal, onQr: async () => { throw new NeedsPairingError(); } });
  await session.ready();
  await session.stop(); session = undefined;
  if ((await opRef.get()).data().status !== 'running') throw new Error('Import cancelled');
  // Stage the validated local queue. On interruption the CLI deletes this staged
  // data; on a hard kill the account stays paused for operator recovery.
  for (const [name, records] of [['messages', messages], ['reports', reports], ['seen', seen]]) {
    for (let offset = 0; offset < records.length; offset += 100) {
      controller.signal.throwIfAborted();
      const batch = records.slice(offset, offset + 100).map((record) => ({ ref: account.collection(name).doc(documentId(record.id)), record }));
      staged.push(...batch.map((record) => record.ref));
      await lease.write((tx) => { for (const entry of batch) tx.set(entry.ref, entry.record); });
    }
  }
  controller.signal.throwIfAborted();
  if ((await opRef.get()).data().status !== 'running') throw new Error('Import cancelled');
  await lease.write((tx) => tx.set(account, { activeGeneration: id, lastScanTime: local.getLastScanTime().toISOString(), historySince: local.getHistorySince().toISOString() }, { merge: true }));
  activated = true;
  await ref.update({ authStatus: 'linked', lastVerifiedAt: new Date().toISOString(), queueCount: messages.length });
  process.stdout.write('Session verified and queue imported. Scheduling remains paused; do not restart the local bot.\n');
} catch (error) {
  logWorkerEvent({ event: 'import_failed', type: error.name, activated });
  process.exitCode = 1;
} finally {
  clearTimeout(timer); clearInterval(renewal);
  try { await session?.stop(); } catch { /* Keep the original failure. */ }
  await renewing;
  try {
    // A lost commit response must not trigger deletion of an activated session.
    if (reserved && !activated) activated = (await account.get()).data()?.activeGeneration === id;
    if (reserved && !activated) {
      // Include canonical keys written during verification, not only imported files.
      const keys = await root.collection('keys').get();
      staged.push(...keys.docs.map((doc) => doc.ref));
      for (let offset = 0; offset < staged.length; offset += 200) await lease.write((tx) => { for (const doc of staged.slice(offset, offset + 200)) tx.delete(doc); });
    }
    if (reserved) await controlDb.runTransaction(async (tx) => {
      const cfg = (await tx.get(ref)).data();
      const operation = (await tx.get(opRef)).data();
      tx.update(opRef, { status: ['cancelling', 'cancelled'].includes(operation.status) ? 'cancelled' : activated ? 'succeeded' : 'failed', qr: null, updatedAt: new Date().toISOString() });
      if (cfg.activeOperation === id) tx.update(ref, { maintenance: false, activeOperation: null, enabled: false,
        ...(activated ? { authStatus: 'linked', lastVerifiedAt: new Date().toISOString() } : {}) });
    });
  } finally {
    await lease?.release();
    await Promise.all([controlDb.terminate(), runtimeDb.terminate()]);
    process.removeListener('SIGINT', stop); process.removeListener('SIGTERM', stop);
  }
}
