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
    if (groupNamesCache[jid]) return `Группа "${groupNamesCache[jid]}"`;

    if (sock) {
      try {
        const metadata = await sock.groupMetadata(jid);
        if (metadata?.subject) {
          groupNamesCache[jid] = metadata.subject;
          return `Группа "${metadata.subject}"`;
        }
      } catch {
        // Fallback on error
      }
    }
    return `Группа ${jid.split('@')[0]}`;
  }

  if (contactNamesCache[jid]) {
    return `Личный чат "${contactNamesCache[jid]}"`;
  }

  return `Личный чат ${jid.split('@')[0]}`;
}
