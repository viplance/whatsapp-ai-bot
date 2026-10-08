import { createHash } from 'node:crypto';

export const documentId = (id) => createHash('sha256').update(id).digest('hex');
const copy = (value) => structuredClone(value);
const dateValid = (value) => typeof value === 'string' && Number.isFinite(Date.parse(value));

export async function createFirestoreState({ db, configId, lease, defaultLookbackMs, now = Date.now }) {
  const root = db.doc(`accounts/${configId}`);
  const [meta, messages, reports, seen] = await Promise.all([
    root.get(), root.collection('messages').get(), root.collection('reports').get(), root.collection('seen').get(),
  ]);
  const fallback = new Date(now() - defaultLookbackMs).toISOString();
  let state = { lastScanTime: fallback, historySince: fallback, ...meta.data(),
    messages: messages.docs.map((d) => d.data()), reports: reports.docs.map((d) => d.data()),
    seen: Object.fromEntries(seen.docs.map((d) => [d.data().id, d.data().time])) };
  if (![state.lastScanTime, state.historySince].every(dateValid)
    || state.messages.some((m) => !m.id || !m.jid || typeof m.text !== 'string' || !dateValid(m.time) || !state.seen[m.id])
    || state.reports.some((r) => !r.id || !r.messageIds?.length || !r.parts?.length || !r.recipients?.length
      || r.recipients.some((p) => !p.jid || !Number.isInteger(p.nextPart) || p.nextPart < 0 || p.nextPart > r.parts.length))
    || !Object.values(state.seen).every(dateValid)) throw new Error('Invalid cloud state; refusing to discard pending work');
  const pending = new Set(state.messages.map((m) => m.id));
  const reserved = state.reports.flatMap((r) => r.messageIds);
  if (new Set(reserved).size !== reserved.length || reserved.some((id) => !pending.has(id))) throw new Error('Inconsistent cloud report IDs');
  const replayFloor = Date.parse(state.historySince);
  let tail = Promise.resolve();
  function update(change) {
    const operation = tail.then(async () => {
      const next = copy(state);
      const result = change(next);
      const writes = [];
      for (const field of ['messages', 'reports', 'seen']) {
        const entries = (s) => field === 'seen' ? Object.entries(s.seen).map(([id, time]) => ({ id, time })) : s[field];
        const previous = new Map(entries(state).map((record) => [record.id, record]));
        const current = new Map(entries(next).map((record) => [record.id, record]));
        for (const [id, record] of current) {
          if (JSON.stringify(record) === JSON.stringify(previous.get(id))) continue;
          if (Buffer.byteLength(JSON.stringify(record)) > 750000) throw new Error('Cloud record exceeds safe document size');
          writes.push(['set', root.collection(field).doc(documentId(id)), record]);
        }
        for (const id of previous.keys()) if (!current.has(id)) writes.push(['delete', root.collection(field).doc(documentId(id))]);
      }
      writes.push(['set', root, { lastScanTime: next.lastScanTime, historySince: next.historySince }]);
      if (writes.length > 450) throw new Error('State update exceeds safe transaction size');
      await lease.write((tx) => { for (const [method, ref, value] of writes) method === 'set' ? tx.set(ref, value, { merge: true }) : tx.delete(ref); });
      state = next;
      return result;
    });
    tail = operation.catch(() => {});
    return operation;
  }
  return {
    getLastScanTime: () => new Date(state.lastScanTime), getHistorySince: () => new Date(state.historySince),
    messages: () => state.messages.map((m) => ({ ...m, time: new Date(m.time) })), reports: () => copy(state.reports),
    flush: () => tail,
    async addMessages(entries) {
      let count = 0;
      for (let i = 0; i < entries.length; i += 50) count += await update((next) => {
        let added = 0;
        for (const message of entries.slice(i, i + 50)) {
          if (next.seen[message.id]) continue;
          if (!message.id || !message.jid || typeof message.text !== 'string' || !message.text
            || typeof message.sender !== 'string' || !(message.time instanceof Date) || !Number.isFinite(message.time.getTime())) continue;
          next.messages.push({ ...message, time: message.time.toISOString() });
          next.seen[message.id] = message.time.toISOString();
          added++;
        }
        return added;
      });
      return count;
    },
    enqueueReport(report) { return update((next) => {
      if (next.reports.some((r) => r.id === report.id || r.messageIds.some((id) => report.messageIds.includes(id)))
        || report.messageIds.some((id) => !next.messages.some((m) => m.id === id))) throw new Error('Invalid report reservation');
      next.reports.push(copy(report));
    }); },
    recordDelivery(id, jid, part) { return update((next) => {
      const report = next.reports.find((r) => r.id === id);
      const recipient = report?.recipients.find((r) => r.jid === jid);
      if (!recipient || part !== recipient.nextPart + 1 || part > report.parts.length) throw new Error('Invalid delivery acknowledgement');
      recipient.nextPart = part;
    }); },
    acknowledgeReport(id) { return update((next) => {
      const report = next.reports.find((r) => r.id === id);
      if (!report || report.recipients.some((r) => r.nextPart !== report.parts.length)) throw new Error('Report has undelivered parts');
      const ids = new Set(report.messageIds);
      next.messages = next.messages.filter((m) => !ids.has(m.id));
      next.reports = next.reports.filter((r) => r.id !== id);
    }); },
    completeHistory(date) { return update((next) => { if (date > new Date(next.historySince)) next.historySince = date.toISOString(); }); },
    async finishScan(date) {
      await update((next) => { next.lastScanTime = date.toISOString(); });
      const cutoff = Math.min(now() - 30 * 24 * 3600000, replayFloor);
      const pending = new Set(state.messages.map((m) => m.id));
      const expired = Object.entries(state.seen).filter(([id, time]) => !pending.has(id) && Date.parse(time) < cutoff).map(([id]) => id);
      for (let i = 0; i < expired.length; i += 200) await update((next) => { for (const id of expired.slice(i, i + 200)) delete next.seen[id]; });
    },
  };
}
