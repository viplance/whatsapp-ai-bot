import { readFileSync } from 'node:fs';
import { cloudEnvironment } from '../src/cloud/env.js';
import { validateSettings } from '../src/cloud/settings.js';
import { createGoogleApi } from '../src/cloud/google.js';
import { createControl } from '../src/cloud/control.js';
import { cliAuth, cliDatabase } from './cloud-client.js';

const env = cloudEnvironment();
const auth = cliAuth();
const db = cliDatabase(env.projectId, env.controlDatabase, auth);
const ref = db.doc(`configs/${env.configId}`);
const initial = validateSettings({ enabled: false, timezone: 'Europe/Istanbul', settings: {
  ...JSON.parse(readFileSync(new URL('../config.json', import.meta.url), 'utf8')),
  period: '4h', showScanLogs: false,
} });
await db.runTransaction(async (tx) => {
  if ((await tx.get(ref)).exists) return;
  tx.create(ref, { ...initial, activeVersion: 1, scheduleRevision: 1, appliedScheduleRevision: 0,
    scheduleStatus: 'pending', maintenance: false, authStatus: 'needsPairing', activeOperation: null,
    queueCount: 0, createdAt: new Date().toISOString() });
  tx.create(ref.collection('versions').doc('1'), { ...initial, createdAt: new Date().toISOString(), createdBy: 'deployment' });
});
const control = createControl({ db, env, google: createGoogleApi({ env, auth }) });
await control.reconcile();
console.log(`Configuration initialized/preserved; scheduling is ${(await control.config()).enabled ? 'enabled' : 'paused'}.`);
await db.terminate();
