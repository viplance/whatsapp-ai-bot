import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { proto } from 'baileys';
import { runCloudWorker } from '../src/cloud/worker.js';
import { connectSession } from '../src/once.js';
import { MemoryFirestore } from './cloud-helpers.js';

const env = { projectId: 'test-project', region: 'europe-west4', configId: 'flow',
  summaryJob: 'summary', pairingJob: 'pair' };
const own = '15550000000@s.whatsapp.net';
const recipient = '15550000001@s.whatsapp.net';
const titles = {
  'flow-one@g.us': 'VELI GRUBU',
  'flow-two@g.us': '8/A VELİ GRUBU',
  'flow-other@g.us': 'Unrelated group',
};
const history = (ageMinutes = 30) => Object.keys(titles).map((jid, i) => ({
  key: { id: `flow-${i}`, remoteJid: jid, participant: '15550000002@s.whatsapp.net', fromMe: false },
  messageTimestamp: Math.floor((Date.now() - ageMinutes * 60000) / 1000),
  message: { conversation: `Synthetic input ${i}` },
  pushName: 'Synthetic sender',
}));

async function fixture() {
  const controlDb = new MemoryFirestore(), runtimeDb = new MemoryFirestore();
  const settings = { period: '30min', waitForNoActivity: '15min', filters: ['veli'],
    phones: ['own', '15550000001'], model: 'synthetic-model' };
  await controlDb.doc('configs/flow').set({ settings, enabled: true, maintenance: false,
    authStatus: 'linked', activeVersion: 1, scheduleRevision: 1, activeOperation: null });
  await controlDb.doc('configs/flow/versions/1').set({ settings });
  await runtimeDb.doc('accounts/flow').set({ activeGeneration: 'existing' });
  return { controlDb, runtimeDb };
}

// Exercise the real session, ingestor, cloud queue, scanner, and worker. Only the
// external socket transport, Gemini, and database transport are replaced.
function sessionFactory({ deliverHistory, beforeSend, historyDelayMs = 0, eventType = 'history', ageMinutes = 30 }) {
  return (options) => connectSession({ ...options, syncWaitMs: 30,
    getVersion: async () => ({ version: [2, 3000, 123], isLatest: true }),
    socketFactory: () => {
      let closed = false;
      const sock = { user: { id: own }, ev: new EventEmitter(),
        groupMetadata: async (jid) => ({ subject: titles[jid] }),
        groupFetchAllParticipating: async () => Object.fromEntries(Object.entries(titles).map(([id, subject]) => [id, { id, subject }])),
        sendMessage: beforeSend,
        end() { closed = true; },
      };
      setImmediate(() => {
        if (closed) return;
        sock.ev.emit('connection.update', { connection: 'open' });
        if (!deliverHistory) return;
        const deliver = () => {
          if (closed) return;
          if (eventType !== 'history') sock.ev.emit('messages.upsert', { type: eventType, messages: history(ageMinutes) });
          else sock.ev.emit('messaging-history.set', {
            messages: history(ageMinutes), chats: Object.entries(titles).map(([id, name]) => ({ id, name })),
            contacts: [], syncType: proto.HistorySync.HistorySyncType.FULL, progress: 100,
          });
        };
        if (historyDelayMs) setTimeout(deliver, historyDelayMs);
        else deliver();
      });
      return sock;
    },
  });
}

function dryRun(db, attempts) {
  return async (jid, payload) => {
    const reports = (await db.collection('accounts/flow/reports').get()).docs.map((doc) => doc.data());
    assert.equal(reports.length, 1, 'report must be durable before the send boundary');
    assert.ok(reports[0].recipients.every((r) => r.nextPart === 0));
    assert.match(payload.text, /Synthetic summary/);
    attempts.push(jid);
    // Refuse to acknowledge a send that never happened, preserving queued work.
    throw new Error('LOCAL_DRY_RUN_SEND_BOUNDARY');
  };
}

test('local cloud flow reaches both recipients without submitting or acknowledging any send', async () => {
  const { controlDb, runtimeDb } = await fixture();
  const attempts = [], summarized = [];
  await assert.rejects(runCloudWorker({ env, controlDb, runtimeDb, log() {},
    variables: { REQUEST_ID: 'summary-flow', SCHEDULE_REVISION: '1', GEMINI_API_KEY: 'synthetic-key' },
    sessionFactory: sessionFactory({ deliverHistory: true, beforeSend: dryRun(runtimeDb, attempts) }),
    summarizeFactory: () => async (messages) => { summarized.push(...messages); return 'Synthetic summary'; },
  }), /Summary or delivery failed/);
  assert.equal(summarized.length, 2);
  assert.deepEqual(attempts, [own, recipient]);
  assert.equal((await runtimeDb.collection('accounts/flow/messages').get()).docs.length, 2);
  const operation = (await controlDb.doc('configs/flow/operations/summary-flow').get()).data();
  assert.equal(operation.collection.added, 2);
  assert.equal(operation.collection.filtered, 1);
  assert.equal(operation.summary.deliveredParts, 0);
  assert.equal(operation.summary.pendingReports, 1);
});

for (const eventType of ['notify', 'append']) {
  test(`local ${eventType} messages reach the send boundary after filtering`, async () => {
    const { controlDb, runtimeDb } = await fixture();
    const attempts = [];
    await assert.rejects(runCloudWorker({ env, controlDb, runtimeDb, log() {},
      variables: { REQUEST_ID: eventType, SCHEDULE_REVISION: '1', GEMINI_API_KEY: 'synthetic-key' },
      sessionFactory: sessionFactory({ deliverHistory: true, eventType, historyDelayMs: 5, beforeSend: dryRun(runtimeDb, attempts) }),
      summarizeFactory: () => async () => 'Synthetic summary',
    }), /Summary or delivery failed/);
    assert.deepEqual(attempts, [own, recipient]);
  });
}

test('history received during pairing survives until the next summary run', async () => {
  const { controlDb, runtimeDb } = await fixture();
  const ref = controlDb.doc('configs/flow');
  await ref.update({ enabled: false, maintenance: true, latestPairing: 'pair-flow' });
  await runCloudWorker({ mode: 'pair', env, controlDb, runtimeDb, log() {},
    variables: { REQUEST_ID: 'pair-flow' },
    sessionFactory: sessionFactory({ deliverHistory: true, historyDelayMs: 5,
      beforeSend: async () => { throw new Error('Pairing must never send'); } }),
    summarizeFactory: () => { throw new Error('Pairing must never call Gemini'); },
  });
  assert.equal((await runtimeDb.collection('accounts/flow/messages').get()).docs.length, 2,
    'matching pairing history must be saved even if WhatsApp never replays it');
  assert.equal((await ref.get()).data().lastSuccessfulRunAt, undefined, 'pairing is not a successful summary run');
  await ref.update({ enabled: true });
  const attempts = [];
  await assert.rejects(runCloudWorker({ env, controlDb, runtimeDb, log() {},
    variables: { REQUEST_ID: 'after-pairing', SCHEDULE_REVISION: '1', GEMINI_API_KEY: 'synthetic-key' },
    sessionFactory: sessionFactory({ deliverHistory: false, beforeSend: dryRun(runtimeDb, attempts) }),
    summarizeFactory: () => async () => 'Synthetic summary',
  }), /Summary or delivery failed/);
  assert.deepEqual(attempts, [own, recipient]);
});

test('quiet chats remain queued and reach the send boundary on a later run', async (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: Date.now() });
  const { controlDb, runtimeDb } = await fixture();
  await runCloudWorker({ env, controlDb, runtimeDb, log() {},
    variables: { REQUEST_ID: 'still-active', SCHEDULE_REVISION: '1', GEMINI_API_KEY: 'synthetic-key' },
    sessionFactory: sessionFactory({ deliverHistory: true, ageMinutes: 5,
      beforeSend: async () => { throw new Error('Active chats must not send'); } }),
    summarizeFactory: () => async () => { throw new Error('Active chats must not be summarized'); },
  });
  const first = (await controlDb.doc('configs/flow/operations/still-active').get()).data();
  assert.equal(first.outcome, 'waiting_for_inactivity');
  assert.equal(first.summary.pendingMessages, 2);
  t.mock.timers.tick(20 * 60000);
  const attempts = [];
  await assert.rejects(runCloudWorker({ env, controlDb, runtimeDb, log() {},
    variables: { REQUEST_ID: 'now-quiet', SCHEDULE_REVISION: '1', GEMINI_API_KEY: 'synthetic-key' },
    sessionFactory: sessionFactory({ deliverHistory: false, beforeSend: dryRun(runtimeDb, attempts) }),
    summarizeFactory: () => async () => 'Synthetic summary',
  }), /Summary or delivery failed/);
  assert.deepEqual(attempts, [own, recipient]);
});
