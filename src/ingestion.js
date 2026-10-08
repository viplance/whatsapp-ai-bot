import { extractText, contactName, rememberContactName, resolveGroupName } from './store.js';
import { REPORT_HEADER } from './scanner.js';

export function createIngestor({ store, filters, now = () => new Date(), onResult = () => {} }) {
  return async function ingest(messages, { sock, historySince, signal } = {}) {
    const entries = [];
    const result = { received: 0, withoutText: 0, ownReports: 0, outsideWindow: 0,
      filtered: 0, unresolvedGroups: 0, matched: 0, added: 0, duplicates: 0 };
    for (const msg of messages || []) {
      result.received++;
      signal?.throwIfAborted();
      const text = extractText(msg);
      const jid = msg.key?.remoteJid;
      const key = msg.key?.id;
      if (!text || !jid || !key || jid === 'status@broadcast') { result.withoutText++; continue; }
      // Reports can return through history sync even though live own events use append.
      if (msg.key.fromMe && text.startsWith(REPORT_HEADER)) { result.ownReports++; continue; }
      const time = msg.messageTimestamp != null
        ? new Date(Number(msg.messageTimestamp) * 1000) : (historySince ? null : now());
      if (!time || !Number.isFinite(time.getTime()) || (historySince && time <= historySince)) { result.outsideWindow++; continue; }
      const isGroup = jid.endsWith('@g.us');
      const senderJid = isGroup ? msg.key.participant : jid;
      if (!msg.key.fromMe && msg.pushName && senderJid) rememberContactName(senderJid, msg.pushName);
      const sender = msg.key.fromMe ? 'Я' : (contactName(senderJid) || msg.pushName || senderJid?.split('@')[0] || 'Unknown');
      const groupName = isGroup && filters.active ? await resolveGroupName(jid, sock) : null;
      if (isGroup && filters.active && !groupName) result.unresolvedGroups++;
      if (!filters.matches(groupName, sender, isGroup ? null : contactName(jid))) { result.filtered++; continue; }
      entries.push({ id: `${jid}:${key}`, jid, sender, text, time });
    }
    signal?.throwIfAborted();
    result.matched = entries.length;
    result.added = await store.addMessages(entries);
    result.duplicates = result.matched - result.added;
    onResult(result);
    return result.added;
  };
}
