import makeWASocket, { DisconnectReason, useMultiFileAuthState, Browsers, fetchLatestWaWebVersion, proto } from 'baileys';
import qrcode from 'qrcode-terminal';
import pino from 'pino';
import { rememberContact, rememberGroup } from './store.js';
import { createFilters } from './filters.js';
import { createIngestor } from './ingestion.js';

export function createWhatsAppService({ config, authFolder, store, scanner,
  makeSocket = makeWASocket, loadAuth = useMultiFileAuthState,
  getVersion = fetchLatestWaWebVersion, printQr = (qr) => qrcode.generate(qr, { small: true }),
  timers = globalThis, now = () => new Date(), logger = console,
}) {
  const ingest = createIngestor({ store, filters: createFilters(config.filters), now });
  let session, reconnectTimer, starting = false, stopped = false, historySince;

  function reconnect() {
    if (stopped || reconnectTimer) return;
    reconnectTimer = timers.setTimeout(() => { reconnectTimer = undefined; void start(); }, 5000);
  }
  function current(record) { return !stopped && session === record && !record.controller.signal.aborted; }
  function requestScan(record) {
    if (!current(record) || !record.open) return;
    void scanner.runScan(record.sock, { signal: record.controller.signal }).catch((err) => {
      if (!record.controller.signal.aborted) logger.error('❌ Ошибка сканирования:', err.message);
    });
  }
  function schedule(record) {
    if (!current(record) || !record.open || record.interval) return;
    record.interval = timers.setInterval(() => requestScan(record), config.scanIntervalMs);
  }
  function clear(record) {
    record.controller.abort();
    if (record.interval) timers.clearInterval(record.interval);
    if (record.fallback) timers.clearTimeout(record.fallback);
  }
  function enqueue(record, action) {
    record.ingestion = record.ingestion.then(async () => {
      if (current(record)) await action();
    }).catch((err) => {
      if (current(record)) {
        record.ingestionFailed = true;
        logger.error('❌ Ошибка обработки сообщений:', err.message);
      }
    });
    return record.ingestion;
  }

  async function start() {
    if (starting || session || stopped) return;
    starting = true;
    // This replay floor stays fixed for the service lifetime, including reconnects.
    // Only completed history sync advances the persisted floor for the next process.
    historySince ??= store.getHistorySince();
    try {
      const { state, saveCreds } = await loadAuth(authFolder);
      const { version } = await getVersion();
      if (stopped) return;
      const sock = makeSocket({
        version, auth: state, logger: pino({ level: 'warn' }),
        browser: Browsers.macOS('Desktop'), syncFullHistory: true,
        connectTimeoutMs: 60_000, defaultQueryTimeoutMs: 60_000, keepAliveIntervalMs: 30_000,
        getMessage: async () => undefined,
      });
      const record = { sock, controller: new AbortController(), ingestion: Promise.resolve(), historyStarted: now() };
      session = record;
      sock.ev.on('creds.update', () => {
        if (current(record)) void Promise.resolve().then(saveCreds).catch((err) => logger.error('❌ Ошибка сохранения авторизации:', err.message));
      });
      sock.ev.on('contacts.upsert', (contacts) => { if (current(record)) contacts.forEach(rememberContact); });
      sock.ev.on('contacts.update', (contacts) => { if (current(record)) contacts.forEach(rememberContact); });
      sock.ev.on('groups.update', (groups) => { if (current(record)) groups.forEach((g) => rememberGroup(g.id, g.subject)); });
      sock.ev.on('connection.update', (update) => {
        if (!current(record)) return;
        if (update.qr) { logger.log('📱 Отсканируйте QR-код в WhatsApp → Связанные устройства'); printQr(update.qr); }
        if (update.connection === 'open' && !record.open) {
          record.open = true;
          logger.log('✅ WhatsApp подключён.');
          if (record.historyReady) { schedule(record); requestScan(record); }
          else record.fallback = timers.setTimeout(() => {
            if (!current(record)) return;
            schedule(record);
            requestScan(record);
          }, 75_000);
        }
        if (update.connection === 'close') {
          clear(record);
          session = undefined;
          const error = update.lastDisconnect?.error;
          if (error?.output?.statusCode === DisconnectReason.loggedOut) {
            stopped = true;
            logger.log('🚪 Выход из системы. Удалите папку auth_info_baileys и запустите снова.');
          } else {
            logger.error('⚠️ Соединение закрыто; повтор через 5 секунд:', error?.message);
            reconnect();
          }
        }
      });
      sock.ev.on('messaging-history.set', (event) => enqueue(record, async () => {
        for (const contact of event.contacts || []) rememberContact(contact);
        for (const chat of event.chats || []) if (chat.name) rememberGroup(chat.id, chat.name);
        const stored = await ingest(event.messages, { sock, historySince, signal: record.controller.signal });
        if (stored && config.showScanLogs) logger.log(`📥 История: получено ${stored} сообщений`);
        // In Baileys, isLatest marks the first history notification. It does
        // not mean all batches have arrived. Only FULL at 100% is a checkpoint.
        if (event.syncType === proto.HistorySync.HistorySyncType.FULL && event.progress === 100) {
          record.historyReady = true;
          if (!record.ingestionFailed) store.completeHistory(record.historyStarted);
          if (record.fallback) timers.clearTimeout(record.fallback);
          schedule(record);
          requestScan(record);
        } else if (record.interval) requestScan(record);
      }));
      sock.ev.on('messages.upsert', (event) => {
        if (event.type !== 'notify') return;
        return enqueue(record, async () => {
          const stored = await ingest(event.messages, { sock, signal: record.controller.signal });
          if (stored && config.showScanLogs) logger.log(`💬 Получено ${stored} сообщений`);
        });
      });
    } catch (err) {
      logger.error('❌ Ошибка подключения WhatsApp:', err.message);
      reconnect();
    } finally { starting = false; }
  }

  return {
    start,
    stop() {
      stopped = true;
      if (reconnectTimer) timers.clearTimeout(reconnectTimer);
      const old = session;
      session = undefined;
      if (old) { clear(old); old.sock.end?.(new Error('Bot stopped')); }
    },
  };
}
