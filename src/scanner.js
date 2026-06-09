import { jidNormalizedUser } from 'baileys';
import { config } from './config.js';
import { messages, chatLabel, pruneMessages } from './store.js';
import { summarizeChat } from './gemini.js';
import { loadLastScanTime, saveLastScanTime } from './state.js';

let lastScanTime = loadLastScanTime();

export function getLastScanTime() {
  return lastScanTime;
}

/** Resolve the JIDs reports are sent to, based on config.phones. */
function reportRecipientJids(sock) {
  if (!sock?.user) return [];

  return config.phones.map((phone) => {
    if (phone === 'own' || !phone) {
      return jidNormalizedUser(sock.user.id);
    }
    // A phone number: strip non-digits and build a WhatsApp JID.
    const digits = String(phone).replace(/\D/g, '');
    return `${digits}@s.whatsapp.net`;
  });
}

export async function runScan(sock) {
  const { showScanLogs } = config;
  const scanStart = new Date();
  const since = lastScanTime;

  if (showScanLogs) {
    console.log(`\n${'═'.repeat(60)}`);
    console.log(
      `🔍 Сканирование: ${since.toLocaleString('ru-RU')} → ${scanStart.toLocaleString('ru-RU')}`,
    );
    console.log(`${'═'.repeat(60)}`);
  }

  // Collect messages received since last scan.
  const chatsToSummarize = {};
  for (const [jid, msgs] of Object.entries(messages)) {
    const slice = msgs.filter((m) => m.time > since && m.time <= scanStart);
    if (slice.length > 0) chatsToSummarize[jid] = slice;
  }

  if (Object.keys(chatsToSummarize).length === 0) {
    if (showScanLogs) console.log('  Нет новых сообщений за этот период.');
  } else {
    let fullReport = `📝 *ОТЧЁТ ПО ЧАТАМ*\n_${since.toLocaleTimeString('ru-RU')} — ${scanStart.toLocaleTimeString('ru-RU')}_\n\n`;
    let count = 0;

    for (const [jid, msgs] of Object.entries(chatsToSummarize)) {
      const label = await chatLabel(jid, sock);
      const summary = await summarizeChat(msgs, label);

      if (summary) {
        fullReport += `📌 *${label}* (${msgs.length})\n${summary}\n\n`;
        count++;

        if (showScanLogs) {
          console.log(`\n📌 ${label} (${msgs.length} сообщ.)`);
          console.log('─'.repeat(50));
          console.log(summary);
        }
      }
    }

    const recipients = reportRecipientJids(sock);
    if (count > 0) {
      for (const recipient of recipients) {
        try {
          await sock.sendMessage(recipient, { text: fullReport.trim() });
          if (showScanLogs) console.log(`✅ Отчёт отправлен в WhatsApp: ${recipient}`);
        } catch (err) {
          console.error(`❌ Ошибка отправки отчёта (${recipient}):`, err);
        }
      }
    }
  }

  if (showScanLogs) console.log(`\n${'═'.repeat(60)}\n`);

  // Advance the scan window, persist, and drop now-stale messages.
  lastScanTime = scanStart;
  saveLastScanTime(lastScanTime);
  pruneMessages(lastScanTime);
}
