import 'dotenv/config';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { buildConfig } from './config-values.js';

export const AUTH_FOLDER = fileURLToPath(new URL('../auth_info_baileys', import.meta.url));
export const STATE_FILE = fileURLToPath(new URL('../scan-state.json', import.meta.url));

function loadConfig() {
  let file;
  try {
    file = JSON.parse(readFileSync(new URL('../config.json', import.meta.url), 'utf8'));
  } catch (err) {
    throw new Error('Cannot read config.json. Copy config.json.example and check its JSON syntax.', { cause: err });
  }
  return buildConfig(file, process.env.GEMINI_API_KEY);
}

export const config = loadConfig();
