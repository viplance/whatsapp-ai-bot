import makeWASocket, { Browsers, DisconnectReason, fetchLatestWaWebVersion, proto } from 'baileys';
import pino from 'pino';
import { setTimeout as sleep } from 'node:timers/promises';
import { createIngestor } from './ingestion.js';
import { createFilters } from './filters.js';
import { rememberContact, rememberGroup } from './store.js';

export class NeedsPairingError extends Error { constructor() { super('WhatsApp authorization needs pairing'); } }

// No scan interval or background reconnect loop: the caller owns the deadline.
export function connectSession({ auth, config, store, signal, pairing = false,
  onQr = async () => {}, socketFactory = makeWASocket,
  getVersion = fetchLatestWaWebVersion, syncWaitMs = 75000, onDiagnostic = () => {} }) {
  const controller = new AbortController();
  const combined = signal ? AbortSignal.any([signal, controller.signal]) : controller.signal;
  let socket, version, closed = false, opened = false, retries = 0, tail = Promise.resolve(), failure;
  const historyStart = new Date();
  const historySince = store?.getHistorySince();
  const ingest = store && createIngestor({ store, filters: createFilters(config.filters) });
  let readyResolve, readyReject, historyResolve;
  const ready = new Promise((resolve, reject) => { readyResolve = resolve; readyReject = reject; });
  ready.catch(() => {});
  const history = new Promise((resolve) => { historyResolve = resolve; });
  function fail(error) {
    failure ||= error;
    readyReject(error);
    controller.abort(error);
  }
  function enqueue(action) {
    const operation = tail.then(action);
    tail = operation.catch(fail);
    return operation;
  }
  combined.addEventListener('abort', () => {
    readyReject(combined.reason);
    socket?.end?.(new Error('Session stopped'));
  }, { once: true });
  function connect() {
    if (closed) return;
    combined.throwIfAborted();
    const sock = socketFactory({ version, auth: auth.state, logger: pino({ level: 'silent' }),
      // Desktop + full history advertises DARWIN, which WhatsApp can reject
      // before login. Keep the same WEB_BROWSER platform during pairing and runs.
      browser: Browsers.macOS('Chrome'), syncFullHistory: !pairing, markOnlineOnConnect: false,
      connectTimeoutMs: 45000, defaultQueryTimeoutMs: 30000, getMessage: async () => undefined });
    socket = sock;
    const current = () => !closed && socket === sock && !combined.aborted;
    sock.ev.on('creds.update', (update) => {
      if (!current()) return;
      Object.assign(auth.state.creds, update);
      void enqueue(() => auth.saveCreds());
    });
    sock.ev.on('connection.update', (event) => {
      if (!current()) return;
      if (event.qr) {
        if (!pairing && !onQr.allowLocal) { fail(new NeedsPairingError()); return; }
        void enqueue(() => onQr(event.qr));
      }
      if (event.connection === 'open') {
        onDiagnostic({ event: 'whatsapp_connected' });
        opened = true;
        void enqueue(async () => { await auth.saveCreds(); await auth.flush?.(); readyResolve(sock); });
      }
      if (event.connection === 'close') {
        const status = event.lastDisconnect?.error?.output?.statusCode;
        // Never forward the provider error: it may contain credentials or QR data.
        onDiagnostic({ event: 'whatsapp_connection_closed',
          statusCode: Number.isInteger(status) && status >= 100 && status <= 599 ? status : null,
          opened, attempt: retries + 1 });
        if (status === DisconnectReason.loggedOut) { fail(new NeedsPairingError()); return; }
        if (opened || retries++ >= 3) { fail(new Error('WhatsApp connection closed')); return; }
        void sleep(1000, undefined, { signal: combined }).then(connect).catch((error) => { if (!closed) fail(error); });
      }
    });
    if (!store) return;
    sock.ev.on('contacts.upsert', (contacts) => { if (current()) contacts.forEach(rememberContact); });
    sock.ev.on('contacts.update', (contacts) => { if (current()) contacts.forEach(rememberContact); });
    sock.ev.on('groups.update', (groups) => { if (current()) groups.forEach((g) => rememberGroup(g.id, g.subject)); });
    sock.ev.on('messages.upsert', (event) => {
      if (!current() || !['notify', 'append'].includes(event.type)) return;
      void enqueue(() => ingest(event.messages, { sock, signal: combined,
        ...(event.type === 'append' ? { historySince } : {}) }));
    });
    sock.ev.on('messaging-history.set', (event) => {
      if (!current()) return;
      void enqueue(async () => {
        for (const contact of event.contacts || []) rememberContact(contact);
        for (const chat of event.chats || []) if (chat.name) rememberGroup(chat.id, chat.name);
        await ingest(event.messages, { sock, historySince, signal: combined });
        if (event.syncType === proto.HistorySync.HistorySyncType.FULL && event.progress === 100 && !failure) {
          await store.completeHistory(historyStart);
          historyResolve();
        }
      });
    });
  }
  // The bundled Web revision can be rejected before WhatsApp issues a QR.
  // Resolve the current revision once per finite run and reuse it on reconnect.
  void Promise.resolve().then(async () => {
    combined.throwIfAborted();
    const result = await getVersion({ signal: AbortSignal.any([combined, AbortSignal.timeout(12000)]) });
    ({ version } = result);
    if (!Array.isArray(version) || version.length !== 3 || !version.every(Number.isInteger)) throw new Error('Invalid WhatsApp Web version');
    onDiagnostic({ event: 'whatsapp_version_resolved', version,
      latest: result.isLatest === true });
    if (!closed) connect();
  }).catch((error) => { if (!closed) fail(error); });
  return {
    signal: combined,
    async ready() { const sock = await ready; combined.throwIfAborted(); return sock; },
    async collect() {
      const timeout = new AbortController();
      try {
        await Promise.race([history, sleep(syncWaitMs, undefined, { signal: AbortSignal.any([combined, timeout.signal]) })]);
        await tail;
        combined.throwIfAborted();
      } finally { timeout.abort(); }
    },
    async stop() {
      closed = true;
      socket?.end?.(new Error('Finite run completed'));
      await tail;
      await auth.flush?.();
      await store?.flush?.();
      controller.abort(new Error('Finite run completed'));
      if (failure) throw failure;
    },
  };
}
