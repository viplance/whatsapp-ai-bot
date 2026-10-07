import test from 'node:test';
import assert from 'node:assert/strict';
import { createSummarizer } from '../src/gemini.js';
import { buildConfig } from '../src/config-values.js';
import { message, logger, deferred } from './helpers.js';

const config = buildConfig({ systemInstruction: 'Summarize briefly' }, 'test-key');
function summarizer(generateContent, overrides = {}) {
  return createSummarizer({ config, client: { models: { generateContent } }, logger, wait: async () => {}, random: () => 0, ...overrides });
}

test('the maintained SDK sends the configured model and instruction without live requests', async (t) => {
  let request;
  t.mock.method(globalThis, 'fetch', async (url, init) => {
    request = { url: String(url), body: JSON.parse(init.body) };
    return new Response(JSON.stringify({ candidates: [{ content: { role: 'model', parts: [{ text: 'SDK summary' }] } }] }), { status: 200, headers: { 'content-type': 'application/json' } });
  });
  const summarize = createSummarizer({ config, logger });
  assert.equal(await summarize([message('one')], 'Test chat'), 'SDK summary');
  assert.match(request.url, /gemini-2\.5-flash:generateContent/);
  assert.deepEqual(request.body.systemInstruction.parts, [{ text: 'Summarize briefly' }]);
  assert.match(request.body.contents[0].parts[0].text, /Test chat/);
});

test('transient errors retry with exponential backoff and then return the summary', async () => {
  let calls = 0;
  const delays = [];
  const summarize = summarizer(async () => {
    if (++calls < 3) throw Object.assign(new Error('busy'), { status: 429 });
    return { text: ' summary ' };
  }, { wait: async (ms) => delays.push(ms) });
  assert.equal(await summarize([message('one')], 'chat'), 'summary');
  assert.deepEqual(delays, [1000, 2000]);
});

test('invalid API requests and empty responses are not retried', async () => {
  for (const result of [Object.assign(new Error('invalid key'), { status: 403 }), { text: '' }]) {
    let calls = 0;
    const summarize = summarizer(async () => { calls++; if (result instanceof Error) throw result; return result; });
    assert.equal(await summarize([message('one')], 'chat'), null);
    assert.equal(calls, 1);
  }
});

test('exhausted transient retries leave the chat pending', async () => {
  let calls = 0;
  const summarize = summarizer(async () => { calls++; throw Object.assign(new Error('busy'), { status: 503 }); });
  assert.equal(await summarize([message('one')], 'chat'), null);
  assert.equal(calls, 3);
});

test('SDK timeout aborts retry while caller cancellation still stops immediately', async () => {
  let calls = 0;
  const summarize = summarizer(async () => {
    if (++calls === 1) throw new DOMException('This operation was aborted', 'AbortError');
    return { text: 'recovered after timeout' };
  });
  assert.equal(await summarize([message('one')], 'chat'), 'recovered after timeout');
  assert.equal(calls, 2);
});

test('large messages use bounded prompts and combine their partial summaries', async () => {
  const prompts = [];
  const summarize = summarizer(async ({ contents }) => { prompts.push(contents); return { text: 'partial summary' }; });
  assert.equal(await summarize([message('one', { text: '😀'.repeat(30_000) })], 'chat'), 'partial summary');
  assert.ok(prompts.length >= 4);
  assert.ok(prompts.every((p) => p.length <= 24_000 && p.isWellFormed()));
  assert.match(prompts.at(-1), /Объедини/);
});

test('disconnect cancellation reaches the SDK and prevents retries', async () => {
  const started = deferred();
  const controller = new AbortController();
  let calls = 0;
  const summarize = summarizer(async ({ config: requestConfig }) => {
    calls++;
    assert.equal(requestConfig.abortSignal, controller.signal);
    started.resolve();
    await new Promise((_, reject) => requestConfig.abortSignal.addEventListener('abort', () => reject(requestConfig.abortSignal.reason), { once: true }));
  });
  const task = summarize([message('one')], 'chat', { signal: controller.signal });
  await started.promise;
  controller.abort();
  await assert.rejects(task, { name: 'AbortError' });
  assert.equal(calls, 1);
});
