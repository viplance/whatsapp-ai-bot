import { jidNormalizedUser } from 'baileys';
import { config } from './config.js';
import { messages, chatLabel } from './store.js';
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

  // Collect messages received since last scan, splitting chats into:
  //  - quiet: last message older than waitForNoActivity → ready to report
  //  - active: a message arrived within waitForNoActivity → skip, keep for later
  const quietGate = config.waitForNoActivityMs;
  const quietCutoff = scanStart.getTime() - quietGate;

  const chatsToSummarize = {};
  const skippedJids = [];
  for (const [jid, msgs] of Object.entries(messages)) {
    const slice = msgs.filter((m) => m.time > since && m.time <= scanStart);
    if (slice.length === 0) continue;

    const lastMsgTime = slice[slice.length - 1].time.getTime();
    const isActive = quietGate > 0 && lastMsgTime > quietCutoff;

    if (isActive) {
      skippedJids.push(jid);
    } else {
      chatsToSummarize[jid] = slice;
    }
  }

  if (skippedJids.length > 0 && showScanLogs) {
    console.log(
      `  ⏸ Пропущено активных чатов (нет тишины ${config.waitForNoActivity}): ${skippedJids.length}`,
    );
  }

  if (Object.keys(chatsToSummarize).length === 0) {
    if (showScanLogs) console.log('  Нет чатов, готовых к отчёту за этот период.');
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
    let sent = false;
    if (count > 0) {
      sent = true;
      for (const recipient of recipients) {
        try {
          await sock.sendMessage(recipient, { text: fullReport.trim() });
          if (showScanLogs) console.log(`✅ Отчёт отправлен в WhatsApp: ${recipient}`);
        } catch (err) {
          console.error(`❌ Ошибка отправки отчёта (${recipient}):`, err);
          sent = false;
        }
      }
    }

    // Drop the messages we successfully reported so they aren't reported again.
    // Skipped (active) chats are left untouched and roll into a later report.
    if (sent) {
      for (const jid of Object.keys(chatsToSummarize)) {
        dropReported(jid, scanStart, since);
      }
    }
  }

  if (showScanLogs) console.log(`\n${'═'.repeat(60)}\n`);

  // Advance the cursor to the oldest message still held (skipped/unsent chats),
  // so next tick's `since` filter re-includes them; empty store → scanStart.
  lastScanTime = oldestRemaining(since) ?? scanStart;
  saveLastScanTime(lastScanTime);
}

/** Remove messages in (since, scanStart] for a reported chat; clean up empties. */
function dropReported(jid, scanStart, since) {
  if (!messages[jid]) return;
  messages[jid] = messages[jid].filter(
    (m) => !(m.time > since && m.time <= scanStart),
  );
  if (messages[jid].length === 0) delete messages[jid];
}

/**
 * The oldest remaining message time across all chats, minus 1ms so it stays
 * strictly greater than the cursor on the next `since` filter. Null if empty.
 */
function oldestRemaining(since) {
  let oldest = null;
  for (const msgs of Object.values(messages)) {
    for (const m of msgs) {
      if (m.time > since && (oldest === null || m.time < oldest)) oldest = m.time;
    }
  }
  return oldest ? new Date(oldest.getTime() - 1) : null;
}
