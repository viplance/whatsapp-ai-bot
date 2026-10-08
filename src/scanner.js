import { randomUUID } from 'node:crypto';
import { splitText } from './text.js';

export const REPORT_HEADER = '📝 *ОТЧЁТ ПО ЧАТАМ*';
const MAX_REPORT_CHARS = 3500;
const MAX_BATCH_CHARS = 24_000;

export function createScanner({ config, store, summarizeChat, chatLabel, normalizeJid, now = () => new Date(), logger = console }) {
  let inFlight, activeSocket;
  const check = (signal) => signal?.throwIfAborted();

  async function deliver(sock, signal, reportId) {
    const result = { deliveredParts: 0, completedReports: 0 };
    for (const report of store.reports()) {
      if (reportId && report.id !== reportId) continue;
      for (const recipient of report.recipients) {
        for (let part = recipient.nextPart; part < report.parts.length; part++) {
          check(signal);
          try {
            await sock.sendMessage(recipient.jid, { text: report.parts[part] });
          } catch (err) {
            check(signal);
            logger.error(`❌ Ошибка отправки отчёта (${recipient.jid}):`, err.message);
            break;
          }
          // Persist even if a disconnect occurred while sendMessage completed.
          await store.recordDelivery(report.id, recipient.jid, part + 1);
          result.deliveredParts++;
          recipient.nextPart = part + 1;
          if (config.showScanLogs) logger.log(`✅ Отчёт отправлен: ${recipient.jid} (${part + 1}/${report.parts.length})`);
        }
      }
      if (report.recipients.every((r) => r.nextPart === report.parts.length)) {
        await store.acknowledgeReport(report.id);
        result.completedReports++;
      }
    }
    return result;
  }

  async function scan(sock, { signal } = {}) {
    check(signal);
    if (!sock?.user) throw new Error('Cannot scan without a connected WhatsApp user');
    const recipients = [...new Set(config.phones.map((phone) => phone === 'own'
      ? normalizeJid(sock.user.id) : `${phone}@s.whatsapp.net`))];
    if (!recipients.length || recipients.some((jid) => !jid)) throw new Error('No valid report recipients');
    const scanStart = now();
    const delivery = await deliver(sock, signal);
    const reserved = new Set(store.reports().flatMap((r) => r.messageIds));
    const chats = new Map();
    for (const msg of store.messages()) {
      if (!chats.has(msg.jid)) chats.set(msg.jid, []);
      chats.get(msg.jid).push(msg);
    }
    const batches = [];
    for (const [jid, messages] of chats) {
      messages.sort((a, b) => a.time - b.time || a.id.localeCompare(b.id));
      const latest = messages[messages.length - 1].time;
      if (config.waitForNoActivityMs > 0 && scanStart - latest < config.waitForNoActivityMs) continue;
      let size = 0;
      const batch = [];
      for (const msg of messages) {
        if (reserved.has(msg.id) || msg.time > scanStart) continue;
        if (batch.length && size + msg.text.length > MAX_BATCH_CHARS) break;
        batch.push(msg);
        size += msg.text.length;
        if (batch.length >= (config.maxMessagesPerBatch ?? Infinity)) break;
      }
      if (batch.length) batches.push({ jid, messages: batch });
      if (batches.length >= (config.maxChatsPerScan ?? Infinity)) break;
    }
    const results = new Array(batches.length);
    let next = 0;
    async function worker() {
      while (next < batches.length) {
        check(signal);
        const index = next++;
        const batch = batches[index];
        try {
          const label = await chatLabel(batch.jid, sock);
          check(signal);
          const summary = await summarizeChat(batch.messages, label, { signal });
          if (summary) results[index] = { ...batch, label, summary };
        } catch (err) {
          check(signal);
          logger.error(`❌ Ошибка резюме (${batch.jid}):`, err.message);
        }
      }
    }
    // Settle all workers before releasing the lock, including on cancellation.
    const workers = await Promise.allSettled(Array.from({ length: Math.min(config.summaryConcurrency ?? 2, batches.length) }, worker));
    const failure = workers.find((result) => result.status === 'rejected');
    if (failure) throw failure.reason;
    check(signal);
    const successful = results.filter(Boolean);
    if (successful.length) {
      const firstTime = successful.reduce((oldest, batch) => Math.min(oldest, batch.messages[0].time.getTime()), scanStart.getTime());
      const header = `${REPORT_HEADER}\n_${new Date(firstTime).toLocaleString('ru-RU')} — ${scanStart.toLocaleString('ru-RU')}_\n\n`;
      const body = successful.map(({ label, messages, summary }) => `📌 *${label}* (${messages.length})\n${summary}`).join('\n\n');
      const reportId = randomUUID();
      await store.enqueueReport({
        id: reportId, messageIds: successful.flatMap((batch) => batch.messages.map((m) => m.id)),
        ...(config.configVersion ? { configVersion: config.configVersion } : {}),
        parts: splitText(body, MAX_REPORT_CHARS - header.length).map((part) => header + part),
        recipients: recipients.map((jid) => ({ jid, nextPart: 0 })),
      });
      if (config.showScanLogs) successful.forEach(({ label, summary }) => logger.log(`📌 ${label}\n${summary}`));
      const sent = await deliver(sock, signal, reportId);
      delivery.deliveredParts += sent.deliveredParts;
      delivery.completedReports += sent.completedReports;
    }
    check(signal);
    await store.finishScan(scanStart);
    return { processed: successful.reduce((count, batch) => count + batch.messages.length, 0),
      failed: batches.length - successful.length, pendingReports: store.reports().length, ...delivery };
  }

  function runScan(sock, options) {
    if (inFlight) {
      if (activeSocket === sock) return inFlight;
      return inFlight.catch(() => {}).then(() => runScan(sock, options));
    }
    activeSocket = sock;
    inFlight = scan(sock, options).finally(() => { inFlight = undefined; activeSocket = undefined; });
    return inFlight;
  }

  return { getLastScanTime: store.getLastScanTime, overrideLastScanTime: store.overrideLastScanTime, runScan };
}
