import makeWASocket, {
  DisconnectReason,
  useMultiFileAuthState,
  Browsers,
  fetchLatestWaWebVersion,
} from 'baileys';
import qrcode from 'qrcode-terminal';
import pino from 'pino';
import { config, AUTH_FOLDER } from './config.js';
import {
  storeMessage,
  rememberContactName,
  extractText,
} from './store.js';
import { runScan, getLastScanTime } from './scanner.js';

let hourlyTimer = null;
let fallbackTimer = null;

function scheduleHourlyCheck(sock) {
  if (hourlyTimer) return; // guard against stacking on reconnect
  hourlyTimer = setInterval(() => runScan(sock), config.scanIntervalMs);
}

function clearTimers() {
  if (hourlyTimer) {
    clearInterval(hourlyTimer);
    hourlyTimer = null;
  }
  if (fallbackTimer) {
    clearTimeout(fallbackTimer);
    fallbackTimer = null;
  }
}

/** Derive sender name for a message, caching contact names along the way. */
function resolveSender(msg, jid, isGroup) {
  const sender = isGroup
    ? msg.key.participant || msg.pushName || 'Unknown'
    : msg.pushName || jid.split('@')[0];

  if (!isGroup && !msg.key.fromMe && msg.pushName) {
    rememberContactName(jid, msg.pushName);
  }
  return sender;
}

export async function startWhatsApp() {
  const logger = pino({ level: 'warn' });
  const { state, saveCreds } = await useMultiFileAuthState(AUTH_FOLDER);
  const { version } = await fetchLatestWaWebVersion();

  const sock = makeWASocket({
    version,
    auth: state,
    logger,
    browser: Browsers.macOS('Desktop'),
    syncFullHistory: true,
    connectTimeoutMs: 60_000,
    defaultQueryTimeoutMs: 60_000,
    keepAliveIntervalMs: 30_000,
    getMessage: async () => undefined,
  });

  sock.ev.on('creds.update', saveCreds);

  sock.ev.on('connection.update', (update) => {
    const { connection, lastDisconnect, qr } = update;

    if (qr) {
      console.log('\n📱 Отсканируйте QR-код в WhatsApp → Связанные устройства\n');
      qrcode.generate(qr, { small: true });
    }

    if (connection === 'open') {
      console.log('✅ WhatsApp подключён.');
      console.log(
        `   Последнее сканирование: ${getLastScanTime().toLocaleString('ru-RU')}`,
      );
      console.log(`   Интервал отчётов: ${config.period}`);
      console.log(`   Ожидаю синхронизацию истории...\n`);

      // Fallback: if WA sends no history notification within 75s, scan whatever we have.
      fallbackTimer = setTimeout(async () => {
        if (!hourlyTimer) {
          if (config.showScanLogs) {
            console.log('⏱ История не пришла, запускаю сканирование по таймауту...\n');
          }
          await runScan(sock);
          scheduleHourlyCheck(sock);
        }
      }, 75_000);
    }

    if (connection === 'close') {
      clearTimers();

      const err = lastDisconnect?.error;
      const shouldReconnect =
        err?.output?.statusCode !== DisconnectReason.loggedOut;

      console.log(
        `⚠️  Соединение закрыто: ${err?.message} | statusCode=${err?.output?.statusCode}`,
      );

      if (shouldReconnect) {
        console.log('🔄 Переподключение через 5 секунд...');
        setTimeout(startWhatsApp, 5000);
      } else {
        console.log(
          '🚪 Выход из системы. Удалите папку auth_info_baileys и запустите снова.',
        );
      }
    }
  });

  // History sync — fires one or more times after connect; isLatest=true on the final batch.
  sock.ev.on('messaging-history.set', async ({ messages: histMsgs, isLatest }) => {
    let stored = 0;

    for (const msg of histMsgs || []) {
      const text = extractText(msg);
      if (!text) continue;

      const time = msg.messageTimestamp
        ? new Date(Number(msg.messageTimestamp) * 1000)
        : null;

      // Only keep messages within the scan window.
      if (!time || time <= getLastScanTime()) continue;

      const jid = msg.key?.remoteJid;
      if (!jid) continue;

      const isGroup = jid.endsWith('@g.us');
      const sender = resolveSender(msg, jid, isGroup);

      storeMessage(jid, sender, text, time);
      stored++;
    }

    if (stored > 0 && config.showScanLogs) {
      console.log(`📥 История: получено ${stored} сообщений`);
    }

    if (isLatest) {
      if (config.showScanLogs) {
        console.log('✅ Синхронизация истории завершена. Запускаю сканирование...\n');
      }
      await runScan(sock);
      scheduleHourlyCheck(sock);
    }
  });

  sock.ev.on('messages.upsert', (m) => {
    if (m.type !== 'notify') return;

    for (const msg of m.messages) {
      const text = extractText(msg);
      if (!text) continue;

      const jid = msg.key.remoteJid;
      const isGroup = jid.endsWith('@g.us');
      const sender = resolveSender(msg, jid, isGroup);

      // Use message timestamp from WA if available, else now.
      const time = msg.messageTimestamp
        ? new Date(Number(msg.messageTimestamp) * 1000)
        : new Date();

      storeMessage(jid, sender, text, time);

      const label = isGroup ? `[Группа] ${jid.split('@')[0]}` : `[ЛС] ${sender}`;

      if (config.showScanLogs) {
        console.log(
          `💬 ${label}: ${text.slice(0, 80)}${text.length > 80 ? '…' : ''}`,
        );
      }
    }
  });
}
