import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createStateStore } from '../src/state.js';
import { createScanner } from '../src/scanner.js';
import { buildConfig } from '../src/config-values.js';

export const NOW = Date.UTC(2026, 9, 7, 12);
export const logger = { log() {}, error() {} };
export function deferred() {
  let resolve, reject;
  const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}
export function message(id, { age = 60_000, jid = 'chat@s.whatsapp.net', text = 'hello' } = {}) {
  return { id: `${jid}:${id}`, jid, text, sender: 'Test', time: new Date(NOW - age) };
}
export function fixture(t, options = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'wa-bot-test-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const file = join(dir, 'state.json');
  const clock = { value: NOW };
  const config = buildConfig({ ...options.config }, 'test-key');
  const loadStore = () => createStateStore({ file, defaultLookbackMs: config.defaultLookbackMs, now: () => clock.value });
  const store = loadStore();
  const sent = [];
  const sock = { user: { id: 'self@s.whatsapp.net' }, sendMessage: async (jid, payload) => { sent.push({ jid, text: payload.text }); } };
  const makeScanner = (overrides = {}) => createScanner({
    ...options,
    config, store, summarizeChat: async () => 'summary', chatLabel: async (jid) => jid,
    normalizeJid: (jid) => jid, now: () => new Date(clock.value), logger,
    ...(options.summarizeChat ? { summarizeChat: options.summarizeChat } : {}), ...overrides,
  });
  return { dir, file, config, store, sent, sock, clock, loadStore, makeScanner, scanner: makeScanner() };
}

export function waMessage(id, { age = 60_000, jid = 'chat@s.whatsapp.net', text = 'hello', fromMe = false } = {}) {
  return { key: { id, remoteJid: jid, fromMe }, messageTimestamp: (NOW - age) / 1000, pushName: 'Test', message: { conversation: text } };
}

export class FakeTimers {
  tasks = new Map();
  next = 1;
  setTimeout(fn, ms) { const id = this.next++; this.tasks.set(id, { fn, ms, repeat: false }); return id; }
  setInterval(fn, ms) { const id = this.next++; this.tasks.set(id, { fn, ms, repeat: true }); return id; }
  clearTimeout(id) { this.tasks.delete(id); }
  clearInterval(id) { this.tasks.delete(id); }
  async fire(ms) {
    for (const [id, task] of [...this.tasks]) {
      if (task.ms === ms) {
        if (!task.repeat) this.tasks.delete(id);
        await task.fn();
      }
    }
  }
}
