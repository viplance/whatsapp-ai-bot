// Display-name caches; the durable message queue lives in state.js.
const groupNamesCache = Object.create(null);
const contactNamesCache = Object.create(null);
const pendingGroups = new Map();

export function contactName(jid) {
  return contactNamesCache[jid];
}

export function rememberGroup(jid, subject) {
  if (subject) groupNamesCache[jid] = subject;
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
  if (!pendingGroups.has(jid)) {
    pendingGroups.set(jid, (async () => {
      try {
        const metadata = await sock.groupMetadata(jid);
        if (metadata?.subject) {
          groupNamesCache[jid] = metadata.subject;
          return metadata.subject;
        }
      } catch { /* try again on a later event */ }
      return null;
    })());
  }
  try {
    return await pendingGroups.get(jid);
  } finally {
    pendingGroups.delete(jid);
  }
}

export function extractText(msg) {
  let message = msg.message;
  for (let depth = 0; depth < 5 && message; depth++) {
    const inner = message.ephemeralMessage?.message
      || message.viewOnceMessage?.message || message.viewOnceMessageV2?.message
      || message.documentWithCaptionMessage?.message;
    if (!inner) break;
    message = inner;
  }
  return message?.conversation || message?.extendedTextMessage?.text
    || message?.imageMessage?.caption || message?.videoMessage?.caption
    || message?.documentMessage?.caption || null;
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
