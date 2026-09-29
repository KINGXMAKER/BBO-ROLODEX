import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createHandler } from '../netlify/functions/gemini.mjs';
import { extractResult } from '../netlify/lib/gemini.mjs';

const TOKEN = 'test-access-token-0123456789abcdef';
const ENV = { GEMINI_API_KEY: 'server-test-key', ROLODEX_ACCESS_TOKEN: TOKEN, GEMINI_MODELS: 'model-a,model-b' };
const ORIGIN = 'https://kingxmaker.github.io';
const IMG = Buffer.from('synthetic-jpeg-bytes').toString('base64');

function memoryStore() {
  const m = new Map();
  return { get: async k => m.get(k) ?? null, set: async (k, v) => { m.set(k, v); } };
}

// Mock fetch that replays a queue of {status, body} and records the models it was asked for.
function mockFetch(responses) {
  const calls = [];
  const fn = async (url, init) => {
    calls.push({ model: url.match(/models\/([^:]+):/)[1], key: init.headers['x-goog-api-key'] });
    const r = responses[Math.min(calls.length - 1, responses.length - 1)];
    return new Response(JSON.stringify(r.body), { status: r.status, headers: { 'Content-Type': 'application/json' } });
  };
  fn.calls = calls;
  return fn;
}

function setup(responses, envOverrides = {}) {
  const fetchImpl = mockFetch(responses);
  const store = memoryStore();
  const handler = createHandler({ fetchImpl, getUsageStore: async () => store, sleep: async () => {}, envVars: { ...ENV, ...envOverrides } });
  return { handler, fetchImpl, store };
}

function parseRequest({ token = TOKEN, body } = {}) {
  return new Request('https://api.test/api/gemini', {
    method: 'POST',
    headers: { Origin: ORIGIN, 'Content-Type': 'application/json', Authorization: 'Bearer ' + token },
    body: JSON.stringify(body || { task: 'parse', image: { mimeType: 'image/jpeg', data: IMG }, notes: 'met at brunch' }),
  });
}

const okBody = text => ({ candidates: [{ content: { parts: [{ text }] }, finishReason: 'STOP' }] });

test('valid extraction: returns joined text from all non-thought parts', async () => {
  const contact = { name: 'Jamie Testcase', handle: 'test_contact_demo', phone: '555-0100' };
  const json = JSON.stringify(contact);
  const { handler, fetchImpl } = setup([{ status: 200, body: { candidates: [{ content: { parts: [
    { text: 'internal reasoning', thought: true }, { text: json.slice(0, 10) }, { text: json.slice(10) },
  ] }, finishReason: 'STOP' }] } }]);
  const res = await handler(parseRequest());
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('access-control-allow-origin'), ORIGIN);
  const out = await res.json();
  assert.deepEqual(JSON.parse(out.text), contact);
  assert.equal(out.model, 'model-a');
  assert.equal(fetchImpl.calls.length, 1);
  assert.equal(fetchImpl.calls[0].key, 'server-test-key');
});

test('2xx blocked by promptFeedback: 422 blocked with reason, no retry', async () => {
  const { handler, fetchImpl } = setup([{ status: 200, body: { promptFeedback: { blockReason: 'PROHIBITED_CONTENT' } } }]);
  const res = await handler(parseRequest());
  assert.equal(res.status, 422);
  assert.deepEqual(await res.json(), { code: 'blocked', reason: 'PROHIBITED_CONTENT', error: 'Gemini blocked this request' });
  assert.equal(fetchImpl.calls.length, 1);
});

test('2xx candidate stopped for SAFETY with no parts: reported as blocked', async () => {
  const { handler } = setup([{ status: 200, body: { candidates: [{ finishReason: 'IMAGE_SAFETY' }] } }]);
  const res = await handler(parseRequest());
  assert.equal(res.status, 422);
  assert.equal((await res.json()).reason, 'IMAGE_SAFETY');
});

test('2xx with empty text: 502 empty, distinct from blocked', async () => {
  const { handler, fetchImpl } = setup([{ status: 200, body: { candidates: [{ content: { parts: [{ text: '   ' }] }, finishReason: 'STOP' }] } }]);
  const res = await handler(parseRequest());
  assert.equal(res.status, 502);
  const out = await res.json();
  assert.equal(out.code, 'empty');
  assert.equal(out.reason, 'STOP');
  assert.equal(fetchImpl.calls.length, 1);
});

test('rejected server key (403 leaked): upstream_auth, not retried, no model fallback', async () => {
  const { handler, fetchImpl } = setup([{ status: 403, body: { error: { code: 403, status: 'PERMISSION_DENIED', message: 'Your API key was reported as leaked.' } } }]);
  const res = await handler(parseRequest());
  assert.equal(res.status, 502);
  assert.equal((await res.json()).code, 'upstream_auth');
  assert.equal(fetchImpl.calls.length, 1);
});

test('rejected server key (400 API_KEY_INVALID) is auth, not bad_request', async () => {
  const { handler } = setup([{ status: 400, body: { error: { code: 400, details: [{ reason: 'API_KEY_INVALID' }] } } }]);
  const res = await handler(parseRequest());
  assert.equal((await res.json()).code, 'upstream_auth');
});

test('wrong access code: 401 before any Gemini call', async () => {
  const { handler, fetchImpl } = setup([{ status: 200, body: okBody('{}') }]);
  const res = await handler(parseRequest({ token: 'wrong-token-wrong-token-wrong' }));
  assert.equal(res.status, 401);
  assert.equal((await res.json()).code, 'unauthorized');
  assert.equal(fetchImpl.calls.length, 0);
});

test('Gemini 429: retried once per model, then 429 rate_limited with Retry-After', async () => {
  const rl = { status: 429, body: { error: { code: 429, status: 'RESOURCE_EXHAUSTED', details: [{ '@type': 'type.googleapis.com/google.rpc.RetryInfo', retryDelay: '1.4s' }] } } };
  const { handler, fetchImpl } = setup([rl]);
  const res = await handler(parseRequest());
  assert.equal(res.status, 429);
  const out = await res.json();
  assert.equal(out.code, 'rate_limited');
  assert.equal(res.headers.get('retry-after'), '2');
  assert.deepEqual(fetchImpl.calls.map(c => c.model), ['model-a', 'model-a', 'model-b', 'model-b']);
});

test('Gemini 429 then success on retry returns the text', async () => {
  const { handler, fetchImpl } = setup([{ status: 429, body: { error: { code: 429 } } }, { status: 200, body: okBody('{"name":"x"}') }]);
  const res = await handler(parseRequest());
  assert.equal(res.status, 200);
  assert.equal(fetchImpl.calls.length, 2);
});

test('Gemini 503 on first model falls back to second model', async () => {
  const { handler, fetchImpl } = setup([{ status: 503, body: {} }, { status: 503, body: {} }, { status: 200, body: okBody('{}') }]);
  const res = await handler(parseRequest());
  assert.equal(res.status, 200);
  assert.equal((await res.json()).model, 'model-b');
  assert.equal(fetchImpl.calls.length, 3);
});

test('daily cap: request over DAILY_REQUEST_LIMIT gets 429 daily_limit without calling Gemini', async () => {
  const { handler, fetchImpl } = setup([{ status: 200, body: okBody('{}') }], { DAILY_REQUEST_LIMIT: '1' });
  assert.equal((await handler(parseRequest())).status, 200);
  const res = await handler(parseRequest());
  assert.equal(res.status, 429);
  assert.equal((await res.json()).code, 'daily_limit');
  assert.equal(fetchImpl.calls.length, 1);
});

test('request limits: oversized image, bad task and foreign origin are rejected', async () => {
  const { handler, fetchImpl } = setup([{ status: 200, body: okBody('{}') }]);
  const big = await handler(parseRequest({ body: { task: 'parse', image: { mimeType: 'image/jpeg', data: 'A'.repeat(2_900_000) } } }));
  assert.equal(big.status, 413);
  const badTask = await handler(parseRequest({ body: { task: 'freeform', prompt: 'anything' } }));
  assert.equal(badTask.status, 400);
  const foreign = await handler(new Request('https://api.test/api/gemini', { method: 'POST', headers: { Origin: 'https://evil.example' }, body: '{}' }));
  assert.equal(foreign.status, 403);
  assert.equal(fetchImpl.calls.length, 0);
});

test('missing secrets: 500 server_misconfigured', async () => {
  const { handler } = setup([], { GEMINI_API_KEY: '' });
  assert.equal((await handler(parseRequest())).status, 500);
});

test('extractResult: no candidates is empty, not blocked', () => {
  assert.deepEqual(extractResult({}), { ok: false, kind: 'empty', reason: 'NO_CANDIDATES' });
});

test('frontend ships no Gemini key and never calls Gemini directly', () => {
  const html = readFileSync(new URL('../index.html', import.meta.url), 'utf8');
  assert.ok(!html.includes('DEFAULT_GEMINI_KEY'));
  assert.ok(!html.includes('generativelanguage.googleapis.com'));
  assert.ok(!/x-goog-api-key/i.test(html));
  // The only AIza-style key allowed is the Firebase web config key (public by design).
  const keys = html.match(/AIza[0-9A-Za-z_-]{30,}/g) || [];
  assert.ok(keys.length <= 1, 'unexpected extra API keys in index.html');
  assert.ok(/apiKey:\s*"AIza/.test(html) || keys.length === 0);
});
