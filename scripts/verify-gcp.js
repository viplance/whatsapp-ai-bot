import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { cliAuth, cliDatabase } from './cloud-client.js';
import { cloudEnvironment } from '../src/cloud/env.js';
import { acquireLease, LeaseLostError } from '../src/cloud/lease.js';
import { createFirestoreState } from '../src/cloud/firestore-state.js';
import { createFirestoreAuth } from '../src/cloud/firestore-auth.js';

const env = cloudEnvironment();
const configId = `verification-${randomUUID()}`;
const databases = [];
const database = (name, auth) => { const db = cliDatabase(env.projectId, name, auth); databases.push(db); return db; };
async function denied(action) {
  await assert.rejects(action, (error) => Number(error.code) === 7 || error.response?.status === 403);
}
const administrator = cliAuth(`whatsapp-admin@${env.projectId}.iam.gserviceaccount.com`);
const pairing = cliAuth(`whatsapp-pairing@${env.projectId}.iam.gserviceaccount.com`);
const worker = cliAuth(`whatsapp-worker@${env.projectId}.iam.gserviceaccount.com`);
const runtime = database(env.runtimeDatabase, worker);
try {
  await database(env.controlDatabase, administrator).doc(`configs/${configId}`).get();
  await denied(database(env.runtimeDatabase, administrator).doc(`accounts/${configId}`).get());
  console.log('PASS: admin can read control data and cannot read runtime credentials.');
  await database(env.controlDatabase, pairing).doc(`configs/${configId}`).get();
  await database(env.runtimeDatabase, pairing).doc(`accounts/${configId}`).get();
  await database(env.controlDatabase, worker).doc(`configs/${configId}`).get();
  const secretUrl = `https://secretmanager.googleapis.com/v1/projects/${env.projectId}/secrets/${process.env.GEMINI_SECRET || 'whatsapp-gemini-api-key'}/versions/latest:access`;
  for (const auth of [administrator, pairing]) await denied((await auth.getClient()).request({ url: secretUrl }));
  assert.equal((await (await worker.getClient()).request({ url: secretUrl })).status, 200);
  console.log('PASS: only the summary worker can access the Gemini secret.');
  const lease = await acquireLease({ db: runtime, configId });
  assert.equal(await acquireLease({ db: runtime, configId }), null);
  const options = { db: runtime, configId, lease, defaultLookbackMs: 86400000 };
  const store = await createFirestoreState(options);
  await store.addMessages([{ id: 'synthetic-message', jid: 'test', sender: 'test', text: 'synthetic test', time: new Date() }]);
  await store.enqueueReport({ id: 'synthetic-report', messageIds: ['synthetic-message'], parts: ['one', 'two'], recipients: [{ jid: 'test', nextPart: 0 }] });
  await store.recordDelivery('synthetic-report', 'test', 1);
  const resumed = await createFirestoreState(options);
  assert.equal(resumed.reports()[0].recipients[0].nextPart, 1);
  await resumed.recordDelivery('synthetic-report', 'test', 2);
  await resumed.acknowledgeReport('synthetic-report');
  assert.equal((await createFirestoreState(options)).messages().length, 0);
  const auth = await createFirestoreAuth({ db: runtime, configId, lease, generation: 'synthetic' });
  await auth.saveCreds();
  await auth.state.keys.set({ session: { synthetic: { value: Buffer.from([1, 2, 3]) } } });
  const restored = await createFirestoreAuth({ db: runtime, configId, lease, generation: 'synthetic' });
  assert.deepEqual((await restored.state.keys.get('session', ['synthetic'])).synthetic.value, Buffer.from([1, 2, 3]));
  await lease.release();
  await assert.rejects(lease.renew(), LeaseLostError);
  console.log('PASS: real Firestore transactions, exclusive leases, auth buffers, and delivery recovery.');
} finally {
  // Remove only this script's random synthetic account, including all subcollections.
  await runtime.recursiveDelete(runtime.doc(`accounts/${configId}`));
  await Promise.all(databases.map((db) => db.terminate()));
}
