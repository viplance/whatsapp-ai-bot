import { randomUUID } from 'node:crypto';

export class LeaseLostError extends Error { constructor() { super('Account lease lost'); } }

export async function acquireLease({ db, configId, owner = randomUUID(), ttlMs = 60000, now = Date.now }) {
  const ref = db.doc(`accounts/${configId}/locks/active`);
  const token = await db.runTransaction(async (tx) => {
    const current = (await tx.get(ref)).data();
    if (current?.expiresAt > now()) return null;
    const token = (current?.token || 0) + 1;
    tx.set(ref, { owner, token, expiresAt: now() + ttlMs });
    return token;
  });
  if (token === null) return null;
  let released = false;
  async function assert(tx) {
    const current = (await tx.get(ref)).data();
    if (released || !current || current.owner !== owner || current.token !== token || current.expiresAt <= now()) throw new LeaseLostError();
  }
  return { owner, token, ref, assert,
    write: (action) => db.runTransaction(async (tx) => { await assert(tx); return action(tx); }),
    renew: () => db.runTransaction(async (tx) => { await assert(tx); tx.update(ref, { expiresAt: now() + ttlMs }); }),
    async release() {
      await db.runTransaction(async (tx) => {
        const current = (await tx.get(ref)).data();
        if (current?.owner === owner && current.token === token) tx.update(ref, { expiresAt: 0 });
      });
      released = true;
    },
  };
}
