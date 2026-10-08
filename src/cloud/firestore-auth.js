import { BufferJSON, initAuthCreds, proto } from 'baileys';
import { documentId } from './firestore-state.js';

export async function createFirestoreAuth({ db, configId, generation, lease }) {
  const root = db.doc(`accounts/${configId}/sessions/${generation}`);
  const decode = (value) => JSON.parse(value, BufferJSON.reviver);
  const encode = (value) => JSON.stringify(value, BufferJSON.replacer);
  const doc = await root.get();
  const creds = doc.exists ? decode(doc.data().creds) : initAuthCreds();
  const legacyKeys = Boolean(doc.data()?.legacyKeys);
  // Preserve Baileys' original filename normalization for imported local keys.
  // It cannot be reversed reliably (both ':' and '-' become '-').
  const legacyRef = (type, id) => root.collection('keys').doc(documentId(`file:${`${type}-${id}.json`.replace(/\//g, '__').replace(/:/g, '-')}`));
  let tail = Promise.resolve(), failure;
  function write(action) {
    const operation = tail.then(() => lease.write(action));
    tail = operation.catch((error) => { failure = error; });
    return operation;
  }
  return {
    state: { creds, keys: {
      async get(type, ids) {
        await tail;
        if (failure) throw failure;
        if (!ids.length) return {};
        const docs = await db.getAll(...ids.flatMap((id) => [root.collection('keys').doc(documentId(`${type}:${id}`)), ...(legacyKeys ? [legacyRef(type, id)] : [])]));
        return Object.fromEntries(ids.flatMap((id, index) => {
          const candidates = docs.slice(index * (legacyKeys ? 2 : 1), (index + 1) * (legacyKeys ? 2 : 1));
          const record = candidates.find((d) => d.exists)?.data();
          if (!record) return [];
          const value = decode(record.value);
          return [[id, type === 'app-state-sync-key' ? proto.Message.AppStateSyncKeyData.fromObject(value) : value]];
        }));
      },
      async set(data) {
        const records = Object.entries(data).flatMap(([type, values]) => Object.entries(values).map(([id, value]) => ({
          ref: root.collection('keys').doc(documentId(`${type}:${id}`)), id, value: value == null ? null : encode(value),
          legacy: legacyKeys ? legacyRef(type, id) : null,
        })));
        for (let i = 0; i < records.length; i += 200) await write((tx) => {
          for (const { ref, id, value, legacy } of records.slice(i, i + 200)) {
            if (legacy) tx.delete(legacy);
            value === null ? tx.delete(ref) : tx.set(ref, { id, value });
          }
        });
      },
    } },
    saveCreds() {
      const value = encode(creds);
      return write((tx) => tx.set(root, { creds: value, updatedAt: new Date().toISOString() }, { merge: true }));
    },
    async flush() { await tail; if (failure) throw failure; },
  };
}
