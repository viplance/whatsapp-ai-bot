import 'dotenv/config';
import makeWASocket, {
  DisconnectReason,
  useMultiFileAuthState,
  Browsers,
  fetchLatestWaWebVersion,
  jidNormalizedUser,
} from 'baileys';
import qrcode from 'qrcode-terminal';
import { GoogleGenerativeAI } from '@google/generative-ai';
import pino from 'pino';
import { readFileSync, writeFileSync, existsSync } from 'fs';

// ── Config ────────────────────────────────────────────────────────────────────

const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const GEMINI_MODEL = process.env.GEMINI_MODEL || 'gemini-2.0-flash';

if (!GEMINI_API_KEY) {
  console.error('Missing GEMINI_API_KEY in .env');
  process.exit(1);
}

const SCAN_INTERVAL_MS =
  (parseInt(process.env.REPORT_INTERVAL_MINUTES, 10) || 60) * 60 * 1000;
const AUTH_FOLDER = 'auth_info_baileys';
const STATE_FILE = 'scan-state.json';
const SHOW_SCAN_LOGS = process.env.SHOW_SCAN_LOGS !== 'false';

// ── Persist last scan time ────────────────────────────────────────────────────

function loadLastScanTime() {
  if (existsSync(STATE_FILE)) {
    try {
      const { lastScanTime } = JSON.parse(readFileSync(STATE_FILE, 'utf8'));
      return new Date(lastScanTime);
    } catch {
      // fall through to default
    }
  }
  // Default: 24 hours ago
  return new Date(Date.now() - 24 * 60 * 60 * 1000);
}

function saveLastScanTime(date) {
  writeFileSync(
    STATE_FILE,
    JSON.stringify({ lastScanTime: date.toISOString() }),
    'utf8',
  );
}

let lastScanTime = loadLastScanTime();

// ── Gemini ────────────────────────────────────────────────────────────────────

const genAI = new GoogleGenerativeAI(GEMINI_API_KEY);
const geminiModel = genAI.getGenerativeModel(
  {
    model: GEMINI_MODEL,
    systemInstruction: `Ты — помощник, который делает краткое резюме переписки в WhatsApp для одного чата.
Получишь список сообщений в формате:
[HH:MM] ОТПРАВИТЕЛЬ: текст

Твоя задача:
1. Кратко изложить главные темы и события на русском языке.
2. Перевести иностранные фразы на русский.
3. Вернуть читаемый короткий отчёт на русском языке (3–7 предложений).`,
  },
  { apiVersion: 'v1beta' },
);

// ── In-memory message store ───────────────────────────────────────────────────

// messages[jid] = [ { time: Date, sender: string, text: string } ]
const messages = {};

function storeMessage(jid, sender, text, time) {
  if (!text) return;
  if (!messages[jid]) messages[jid] = [];
  messages[jid].push({ time, sender: sender || 'Unknown', text });
}

function extractText(msg) {
  return (
    msg.message?.conversation ||
    msg.message?.extendedTextMessage?.text ||
    msg.message?.imageMessage?.caption ||
    msg.message?.videoMessage?.caption ||
    null
  );
}

function chatLabel(jid) {
  return jid.endsWith('@g.us')
    ? `Группа ${jid.split('@')[0]}`
    : `Личный чат ${jid.split('@')[0]}`;
}

// ── Per-chat summary ──────────────────────────────────────────────────────────

async function summarizeChat(jid, msgs) {
  const lines = msgs.map((m) => {
    const hhmm = m.time.toLocaleTimeString('ru-RU', {
      hour: '2-digit',
      minute: '2-digit',
    });
    return `[${hhmm}] ${m.sender}: ${m.text}`;
  });

  const prompt = `Чат: ${chatLabel(jid)}\n\nСообщения:\n${lines.join('\n')}`;

  try {
    const result = await geminiModel.generateContent(prompt);
    return result.response.text().trim();
  } catch (err) {
    return `[Ошибка Gemini: ${err.message}]`;
  }
}

// ── Hourly scan ───────────────────────────────────────────────────────────────

async function runScan() {
  const scanStart = new Date();
  const since = lastScanTime;

  if (SHOW_SCAN_LOGS) {
    console.log(`\n${'═'.repeat(60)}`);
    console.log(
      `🔍 Сканирование: ${since.toLocaleString('ru-RU')} → ${scanStart.toLocaleString('ru-RU')}`,
    );
    console.log(`${'═'.repeat(60)}`);
  }

  // Collect messages received since last scan
  const chatsToSummarize = {};
  for (const [jid, msgs] of Object.entries(messages)) {
    const slice = msgs.filter((m) => m.time > since && m.time <= scanStart);
    if (slice.length > 0) chatsToSummarize[jid] = slice;
  }

  if (Object.keys(chatsToSummarize).length === 0) {
    if (SHOW_SCAN_LOGS) console.log('  Нет новых сообщений за этот период.');
  } else {
    let fullReport = `📝 *ОТЧЁТ ПО ЧАТАМ*\n_${since.toLocaleTimeString('ru-RU')} — ${scanStart.toLocaleTimeString('ru-RU')}_\n\n`;
    let count = 0;

    for (const [jid, msgs] of Object.entries(chatsToSummarize)) {
      const summary = await summarizeChat(jid, msgs);
      const label = chatLabel(jid);

      fullReport += `📌 *${label}* (${msgs.length})\n${summary}\n\n`;
      count++;

      if (SHOW_SCAN_LOGS) {
        console.log(`\n📌 ${label} (${msgs.length} сообщ.)`);
        console.log('─'.repeat(50));
        console.log(summary);
      }
    }

    if (currentSock?.user) {
      try {
        const selfJid = jidNormalizedUser(currentSock.user.id);
        await currentSock.sendMessage(selfJid, { text: fullReport.trim() });
        if (SHOW_SCAN_LOGS) console.log('✅ Отчёт отправлен в ваш WhatsApp');
      } catch (err) {
        console.error('❌ Ошибка отправки отчёта в WhatsApp:', err);
      }
    }
  }

  if (SHOW_SCAN_LOGS) {
    console.log(`\n${'═'.repeat(60)}\n`);
  }

  // Advance the scan window and persist
  lastScanTime = scanStart;
  saveLastScanTime(lastScanTime);

  // Drop messages older than the new lastScanTime to keep memory bounded
  for (const jid of Object.keys(messages)) {
    messages[jid] = messages[jid].filter((m) => m.time > lastScanTime);
    if (messages[jid].length === 0) delete messages[jid];
  }
}

// ── Hourly timer ──────────────────────────────────────────────────────────────

let hourlyTimer = null;
let fallbackTimer = null;
let currentSock = null;

function scheduleHourlyCheck() {
  if (hourlyTimer) return; // guard against stacking on reconnect
  hourlyTimer = setInterval(() => runScan(), SCAN_INTERVAL_MS);
}

// ── WhatsApp connection ───────────────────────────────────────────────────────

async function startWhatsApp() {
  const logger = pino({ level: 'warn' });
  const { state, saveCreds } = await useMultiFileAuthState(AUTH_FOLDER);
  const { version } = await fetchLatestWaWebVersion();

  const sock = makeWASocket({
    version,
    auth: state,
    logger,
    browser: Browsers.macOS('Desktop'),
    getMessage: async () => undefined,
  });

  currentSock = sock;

  sock.ev.on('creds.update', saveCreds);

  sock.ev.on('connection.update', (update) => {
    const { connection, lastDisconnect, qr } = update;

    if (qr) {
      console.log(
        '\n📱 Отсканируйте QR-код в WhatsApp → Связанные устройства\n',
      );
      qrcode.generate(qr, { small: true });
    }

    if (connection === 'open') {
      console.log('✅ WhatsApp подключён.');
      console.log(
        `   Последнее сканирование: ${lastScanTime.toLocaleString('ru-RU')}`,
      );
      console.log(
        `   Интервал отчётов: ${parseInt(process.env.REPORT_INTERVAL_MINUTES, 10) || 60} мин.`,
      );
      console.log(`   Ожидаю синхронизацию истории...\n`);

      // Fallback: if WA sends no history notification within 35s, scan whatever we have
      // (Baileys AwaitingInitialSync timeout is ~20s, so we wait past it)
      fallbackTimer = setTimeout(async () => {
        if (!hourlyTimer) {
          if (SHOW_SCAN_LOGS) {
            console.log(
              '⏱ История не пришла, запускаю сканирование по таймауту...\n',
            );
          }

          await runScan();
          scheduleHourlyCheck();
        }
      }, 35_000);
    }

    if (connection === 'close') {
      if (hourlyTimer) {
        clearInterval(hourlyTimer);
        hourlyTimer = null;
      }
      if (fallbackTimer) {
        clearTimeout(fallbackTimer);
        fallbackTimer = null;
      }
      
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

  // History sync — fires one or more times after connect; isLatest=true on the final batch
  sock.ev.on(
    'messaging-history.set',
    async ({ messages: histMsgs, isLatest }) => {
      let stored = 0;

      for (const msg of histMsgs || []) {
        const text = extractText(msg);
        if (!text) continue;

        const time = msg.messageTimestamp
          ? new Date(Number(msg.messageTimestamp) * 1000)
          : null;

        // Only keep messages within the scan window
        if (!time || time <= lastScanTime) continue;

        const jid = msg.key?.remoteJid;

        if (!jid) continue;

        const isGroup = jid.endsWith('@g.us');
        const sender = isGroup
          ? msg.key.participant || msg.pushName || 'Unknown'
          : msg.pushName || jid.split('@')[0];

        storeMessage(jid, sender, text, time);
        stored++;
      }

      if (stored > 0 && SHOW_SCAN_LOGS) {
        console.log(`📥 История: получено ${stored} сообщений`);
      }

      if (isLatest) {
        if (SHOW_SCAN_LOGS) {
          console.log(
            '✅ Синхронизация истории завершена. Запускаю сканирование...\n',
          );
        }

        await runScan();
        scheduleHourlyCheck();
      }
    },
  );

  sock.ev.on('messages.upsert', (m) => {
    if (m.type !== 'notify') return;

    for (const msg of m.messages) {
      const text = extractText(msg);
      if (!text) continue;

      const jid = msg.key.remoteJid;
      const isGroup = jid.endsWith('@g.us');
      const sender = isGroup
        ? msg.key.participant || msg.pushName || 'Unknown'
        : msg.pushName || jid.split('@')[0];

      // Use message timestamp from WA if available, else now
      const time = msg.messageTimestamp
        ? new Date(Number(msg.messageTimestamp) * 1000)
        : new Date();

      storeMessage(jid, sender, text, time);

      const label = isGroup
        ? `[Группа] ${jid.split('@')[0]}`
        : `[ЛС] ${sender}`;

      if (SHOW_SCAN_LOGS) {
        console.log(
          `💬 ${label}: ${text.slice(0, 80)}${text.length > 80 ? '…' : ''}`,
        );
      }
    }
  });
}

// ── Entry point ───────────────────────────────────────────────────────────────

console.log('🚀 WhatsApp Summary Bot');
console.log(`   Модель:    ${GEMINI_MODEL}`);
console.log(
  `   Интервал:  ${parseInt(process.env.REPORT_INTERVAL_MINUTES, 10) || 60} мин.`,
);
console.log(
  `   Последнее сканирование: ${lastScanTime.toLocaleString('ru-RU')}\n`,
);

startWhatsApp();
