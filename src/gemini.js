import { GoogleGenAI } from '@google/genai';
import { setTimeout as sleep } from 'node:timers/promises';
import { splitText } from './text.js';

const MAX_PROMPT_CHARS = 24_000;
const retryable = (err) => {
  const status = Number(err.status ?? err.statusCode ?? err.cause?.status);
  return [408, 429, 500, 502, 503, 504].includes(status)
    // The SDK's internal request timeout raises AbortError too. Caller-initiated
    // cancellation is checked separately before entering this retry decision.
    || err.name === 'TimeoutError' || err.name === 'AbortError' || err.name === 'TypeError'
    || /timeout|timed out|fetch failed|ECONNRESET|ETIMEDOUT|ENOTFOUND/i.test(err.message);
};

export function createSummarizer({ config, client, wait = sleep, random = Math.random, logger = console }) {
  client ??= new GoogleGenAI({ apiKey: config.geminiApiKey, httpOptions: { apiVersion: 'v1beta', timeout: 60_000 } });

  async function generate(contents, signal) {
    for (let attempt = 0; attempt < 3; attempt++) {
      signal?.throwIfAborted();
      try {
        const response = await client.models.generateContent({
          model: config.model, contents,
          config: { systemInstruction: config.systemInstruction, maxOutputTokens: 2048, abortSignal: signal },
        });
        signal?.throwIfAborted();
        const text = response.text?.trim();
        if (!text) throw new Error('Gemini returned an empty or blocked response');
        return text;
      } catch (err) {
        signal?.throwIfAborted();
        if (!retryable(err) || attempt === 2) throw err;
        await wait(1000 * 2 ** attempt + Math.floor(random() * 1000), undefined, { signal });
      }
    }
  }

  return async function summarizeChat(messages, label, { signal } = {}) {
    const prefix = `Чат: ${label.slice(0, 500)}\n\nСообщения:\n`;
    const lines = messages.map((m) => `[${m.time.toLocaleString('ru-RU')}] ${m.sender}: ${m.text}`).join('\n');
    try {
      const chunks = splitText(lines, MAX_PROMPT_CHARS - prefix.length);
      let summaries = [];
      for (const chunk of chunks) summaries.push(await generate(prefix + chunk, signal));
      // Reduce large inputs in bounded prompts instead of truncating messages.
      for (let depth = 0; summaries.length > 1 && depth < 8; depth++) {
        const reduction = `Чат: ${label.slice(0, 500)}\nОбъедини частичные резюме в одно краткое резюме, сохраняя важные факты:\n`;
        const batches = splitText(summaries.join('\n\n'), MAX_PROMPT_CHARS - reduction.length);
        const reduced = [];
        for (const batch of batches) reduced.push(await generate(reduction + batch, signal));
        summaries = reduced;
      }
      if (summaries.length !== 1) throw new Error('Could not reduce the chat within the prompt budget');
      return summaries[0];
    } catch (err) {
      signal?.throwIfAborted();
      logger.error(`❌ Ошибка Gemini (${label}):`, err.message);
      return null;
    }
  };
}
