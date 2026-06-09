import { GoogleGenerativeAI } from '@google/generative-ai';
import { config } from './config.js';

const genAI = new GoogleGenerativeAI(config.geminiApiKey);
const geminiModel = genAI.getGenerativeModel(
  {
    model: config.model,
    systemInstruction: config.systemInstruction,
  },
  { apiVersion: 'v1beta' },
);

/**
 * Summarize one chat's messages. Returns the summary text, or null after all
 * retries fail.
 */
export async function summarizeChat(msgs, label, retries = 3) {
  const lines = msgs.map((m) => {
    const hhmm = m.time.toLocaleTimeString('ru-RU', {
      hour: '2-digit',
      minute: '2-digit',
    });
    return `[${hhmm}] ${m.sender}: ${m.text}`;
  });

  const prompt = `Чат: ${label}\n\nСообщения:\n${lines.join('\n')}`;

  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      const result = await geminiModel.generateContent(prompt);
      return result.response.text().trim();
    } catch (err) {
      console.error(
        `❌ Ошибка Gemini для чата ${label} (попытка ${attempt}/${retries}):`,
        err.message,
      );

      if (attempt < retries) {
        await new Promise((resolve) => setTimeout(resolve, attempt * 5000));
      }
    }
  }
  return null;
}
