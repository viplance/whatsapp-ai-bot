import { jidNormalizedUser } from 'baileys';
import { config, STATE_FILE, AUTH_FOLDER } from './config.js';
import { createStateStore } from './state.js';
import { chatLabel } from './store.js';
import { createSummarizer } from './gemini.js';
import { createScanner } from './scanner.js';
import { createWhatsAppService } from './whatsapp.js';

export const store = createStateStore({ file: STATE_FILE, defaultLookbackMs: config.defaultLookbackMs });
export const scanner = createScanner({ config, store, chatLabel, summarizeChat: createSummarizer({ config }), normalizeJid: jidNormalizedUser });
export const whatsapp = createWhatsAppService({ config, authFolder: AUTH_FOLDER, store, scanner });
