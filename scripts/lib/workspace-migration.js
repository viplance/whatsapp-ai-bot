import { createHash } from 'node:crypto';
import { jidNormalizedUser } from 'baileys';
import { configurationsOf, configurationSnapshot } from '../../src/cloud/configurations.js';

// Copy documents without decoding or printing WhatsApp credentials/message content.
export async function readTree(ref, checkpoint = async () => {}) {
  await checkpoint();
  const records = [], root = await ref.get();
  if (root.exists) records.push({ path: ref.path, data: root.data() });
  for (const collection of await ref.listCollections()) {
    await checkpoint();
    for (const document of (await collection.get()).docs) records.push(...await readTree(document.ref, checkpoint));
  }
  return records;
}
const canonical = (value) => Array.isArray(value) ? value.map(canonical)
  : value?.toJSON ? canonical(value.toJSON()) : value && typeof value === 'object'
    ? Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])])) : value;
export const treeDigest = (records) => createHash('sha256').update(JSON.stringify(canonical(records.slice().sort((a, b) => a.path.localeCompare(b.path))))).digest('hex');

export function migrationAccountId({ original, account, creds, hasPendingWork }) {
  const id = creds ? jidNormalizedUser(JSON.parse(creds).me?.id || '') : null;
  if (/^\d{7,15}@s\.whatsapp\.net$/.test(id || '')) return id;
  if (original.authStatus === 'linked' || account?.activeGeneration || hasPendingWork) throw new Error('Existing account identity is missing; migration stopped to protect its pending work');
  return null;
}

export async function freezeAccount({ sourceDb, deviceId, workspaceId, ownerSubject }) {
  const ref = sourceDb.doc(`configs/${deviceId}`), checkpoint = sourceDb.doc(`migrationCheckpoints/${workspaceId}`);
  return sourceDb.runTransaction(async (tx) => {
    const current = (await tx.get(ref)).data(), saved = (await tx.get(checkpoint)).data();
    if (!current || current.activeOperation || (current.maintenance && !saved)
      || (current.migrationWorkspace && current.migrationWorkspace !== workspaceId)) throw new Error('Finish active operations/maintenance before migration');
    if (saved && (saved.ownerSubject !== ownerSubject || saved.deviceId !== deviceId)) throw new Error('Migration ownership mismatch');
    const original = saved?.config || current;
    if (!saved) tx.create(checkpoint, { config: original, ownerSubject, deviceId, workspaceId });
    tx.update(ref, { enabled: false, maintenance: true, scheduleStatus: 'pending', migrationWorkspace: workspaceId });
    return original;
  });
}

export async function copyTree({ source, destination, transform = (record) => record, checkpoint = async () => {} }) {
  const sourceRecords = await readTree(source, checkpoint);
  const expected = sourceRecords.map(transform);
  for (const record of expected) { await destination.doc(record.path).set(record.data); await checkpoint(); }
  const actual = [];
  for (const record of expected) {
    await checkpoint();
    const saved = await destination.doc(record.path).get();
    if (!saved.exists) throw new Error('Copied document is missing');
    actual.push({ path: record.path, data: saved.data() });
  }
  if (treeDigest(expected) !== treeDigest(actual)) throw new Error('Migration verification failed');
  return { documents: expected.length, digest: treeDigest(expected) };
}

export function migrationTransforms({ original, workspaceId, deviceId, ownerSubject, ownerEmail, accountFingerprint }) {
  const scope = { workspaceId, deviceId };
  const annotate = (item) => ({ ...item, ...scope });
  const versionTransform = (value) => ({ ...value, ...scope,
    ...(value.configurations ? { configurations: value.configurations.map(annotate) } : {}) });
  const profiles = configurationsOf(original).map(annotate);
  const device = { ...original, ...scope, name: 'WhatsApp', version: 1, configurations: profiles,
    enabled: profiles.some((item) => item.enabled), settings: { ...original.settings, period: '30min' }, timezone: 'UTC',
    activeVersion: original.activeVersion + 1, scheduleRevision: original.scheduleRevision + 1,
    appliedScheduleRevision: original.scheduleRevision + 1, scheduleStatus: 'applied', maintenance: false, activeOperation: null,
    ...(accountFingerprint ? { accountFingerprint } : {}) };
  return { device, snapshot: configurationSnapshot(device),
    control: ({ path, data }) => ({ path, data: path === `configs/${deviceId}` ? device
      : path.includes('/versions/') ? versionTransform(data)
        : path.includes('/operations/') ? { ...data, ...scope, qr: null,
          ...(data.owner !== undefined ? { owner: data.owner === ownerEmail ? ownerSubject : data.owner } : {}),
          status: ['queued', 'running', 'cancelling'].includes(data.status) ? 'cancelled' : data.status } : data }),
    runtime: ({ path, data }) => ({ path, data: path === `accounts/${deviceId}` ? { ...data, ...scope }
      : path === `accounts/${deviceId}/locks/active` ? { owner: 'migration', token: (data.token || 0) + 1, expiresAt: 0 } : data }),
  };
}
