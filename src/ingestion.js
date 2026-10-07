import { extractText, contactName, rememberContactName, resolveGroupName } from './store.js';
import { REPORT_HEADER } from './scanner.js';

export function createIngestor({ store, filters, now = () => new Date() }) {
  return async function ingest(messages, { sock, historySince, signal } = {}) {
    const entries = [];
    for (const msg of messages || []) {
      signal?.throwIfAborted();
      const text = extractText(msg);
      const jid = msg.key?.remoteJid;
      const key = msg.key?.id;
      if (!text || !jid || !key || jid === 'status@broadcast') continue;
      // Reports can return through history sync even though live own events use append.
      if (msg.key.fromMe && text.startsWith(REPORT_HEADER)) continue;
      const time = msg.messageTimestamp != null
        ? new Date(Number(msg.messageTimestamp) * 1000) : (historySince ? null : now());
      if (!time || !Number.isFinite(time.getTime()) || (historySince && time <= historySince)) continue;
      const isGroup = jid.endsWith('@g.us');
      const senderJid = isGroup ? msg.key.participant : jid;
      if (!msg.key.fromMe && msg.pushName && senderJid) rememberContactName(senderJid, msg.pushName);
      const sender = msg.key.fromMe ? 'Я' : (contactName(senderJid) || msg.pushName || senderJid?.split('@')[0] || 'Unknown');
      const groupName = isGroup && filters.active ? await resolveGroupName(jid, sock) : null;
      if (!filters.matches(groupName, sender, isGroup ? null : contactName(jid))) continue;
      entries.push({ id: `${jid}:${key}`, jid, sender, text, time });
    }
    signal?.throwIfAborted();
    return store.addMessages(entries);
  };
}
