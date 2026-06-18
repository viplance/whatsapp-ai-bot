// In-memory message store + chat-label resolution.
//
// messages[jid] = [ { time: Date, sender: string, text: string } ]
export const messages = {};

const groupNamesCache = {};
const contactNamesCache = {};

export function storeMessage(jid, sender, text, time) {
  if (!text) return;
  if (!messages[jid]) messages[jid] = [];
  messages[jid].push({ time, sender: sender || 'Unknown', text });
}

export function rememberContactName(jid, name) {
  if (name) contactNamesCache[jid] = name;
}

/**
 * Cache the display name for a contact from the WA contacts list. Prefers the
 * name saved in your address book, then the contact's own pushName/notify.
 * Indexes under both the primary id and any phone-number JID so lookups by
 * either form resolve.
 */
export function rememberContact(contact) {
  if (!contact) return;
  const name = contact.name || contact.notify || contact.verifiedName;
  if (!name) return;

  for (const id of [contact.id, contact.phoneNumber]) {
    if (id) contactNamesCache[id] = name;
  }
}

/**
 * Return a group's subject, resolving via the socket and caching it. Groups
 * whose metadata can't be fetched fall back to null (caller decides what to do).
 */
export async function resolveGroupName(jid, sock) {
  if (groupNamesCache[jid]) return groupNamesCache[jid];
  if (!sock) return null;

  try {
    const metadata = await sock.groupMetadata(jid);
    if (metadata?.subject) {
      groupNamesCache[jid] = metadata.subject;
      return metadata.subject;
    }
  } catch {
    // ignore — name stays unresolved
  }
  return null;
}

export function extractText(msg) {
  return (
    msg.message?.conversation ||
    msg.message?.extendedTextMessage?.text ||
    msg.message?.imageMessage?.caption ||
    msg.message?.videoMessage?.caption ||
    null
  );
}

export async function chatLabel(jid, sock) {
  if (jid.endsWith('@g.us')) {
    const name = await resolveGroupName(jid, sock);
    return name ? `Группа "${name}"` : `Группа ${jid.split('@')[0]}`;
  }

  if (contactNamesCache[jid]) {
    return `Личный чат "${contactNamesCache[jid]}"`;
  }

  return `Личный чат ${jid.split('@')[0]}`;
}
