// POST /api/gemini — authenticated, rate-limited Gemini endpoint for the Rolodex (GitHub Pages frontend).
// Secrets (Netlify env, Functions scope only): GEMINI_API_KEY, ROLODEX_ACCESS_TOKEN.
// Never logs keys, tokens, images, prompts, notes or contact details.
import { createHash, timingSafeEqual } from 'node:crypto';
import { callGemini, DEFAULT_MODELS } from '../lib/gemini.mjs';
import { buildParsePrompt, buildPitchPrompt } from '../lib/prompts.mjs';

const MAX_BODY_BYTES = 3_000_000;       // compressed 1024px JPEG is ~100–400 KB base64
const MAX_IMAGE_B64_CHARS = 2_800_000;
const MAX_NOTES_CHARS = 2000;
const MAX_FIELD_CHARS = 1000;
const TOTAL_BUDGET_MS = 8000;           // headroom under Netlify's 10s synchronous function limit
const IMAGE_MIMES = new Set(['image/jpeg', 'image/png', 'image/webp']);

const env = (e, name, def) => { const v = e[name]; return v === undefined || String(v).trim() === '' ? def : String(v).trim(); };
const sha = s => createHash('sha256').update(String(s)).digest();

function tokenMatches(provided, expected) {
  if (!provided || !expected) return false;
  return timingSafeEqual(sha(provided), sha(expected));
}

function json(status, body, headers = {}) {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', ...headers } });
}

const cap = (v, n) => String(v == null ? '' : v).slice(0, n);

function validate(body) {
  if (!body || typeof body !== 'object') return { error: 'Body must be JSON' };
  if (body.task === 'parse') {
    const img = body.image || {};
    if (!IMAGE_MIMES.has(img.mimeType)) return { error: 'image.mimeType must be jpeg, png or webp' };
    if (typeof img.data === 'string' && img.data.length > MAX_IMAGE_B64_CHARS) return { status: 413, error: 'Image too large' };
    if (typeof img.data !== 'string' || !img.data || !/^[A-Za-z0-9+/]+=*$/.test(img.data)) {
      return { error: 'image.data must be base64' };
    }
    const notes = cap(body.notes, MAX_NOTES_CHARS).trim();
    return {
      parts: [{ text: buildParsePrompt(notes) }, { inline_data: { mime_type: img.mimeType, data: img.data } }],
      generationConfig: { responseMimeType: 'application/json' },
    };
  }
  if (body.task === 'pitch') {
    const c = body.contact || {};
    const labels = Array.isArray(c.labels) ? c.labels.slice(0, 20).map(l => cap(l, 40)) : [];
    const prompt = buildPitchPrompt({
      name: cap(c.name, 200), handle: cap(c.handle, 100), city: cap(c.city, 100),
      state: cap(c.state, 50), labels, context: cap(c.context, MAX_FIELD_CHARS),
    });
    return { parts: [{ text: prompt }], generationConfig: { responseMimeType: 'application/json' } };
  }
  return { error: 'task must be "parse" or "pitch"' };
}

const UTC_DAY = d => new Date(d).toISOString().slice(0, 10);

// Global daily cap across all instances: bounds spend even if the access token leaks. Read-then-write,
// so concurrent bursts can slightly undercount; the per-IP edge rateLimit below still applies.
async function withinDailyCap(store, limit, nowMs) {
  if (!store) return true;
  const key = 'count-' + UTC_DAY(nowMs);
  const current = Number(await store.get(key)) || 0;
  if (current >= limit) return false;
  await store.set(key, String(current + 1));
  return true;
}

async function defaultUsageStore() {
  const { getStore } = await import('@netlify/blobs');
  return getStore({ name: 'rolodex-gemini-usage', consistency: 'strong' });
}

export function createHandler({ fetchImpl = fetch, getUsageStore = defaultUsageStore, sleep, now = Date.now, envVars = process.env } = {}) {
  return async function handler(req) {
    const allowed = env(envVars, 'ALLOWED_ORIGINS', 'https://kingxmaker.github.io').split(',').map(s => s.trim());
    const origin = req.headers.get('origin');
    const cors = origin && allowed.includes(origin)
      ? { 'Access-Control-Allow-Origin': origin, 'Access-Control-Allow-Headers': 'Authorization, Content-Type', 'Access-Control-Allow-Methods': 'POST, OPTIONS', 'Access-Control-Max-Age': '600', Vary: 'Origin' }
      : { Vary: 'Origin' };

    if (origin && !allowed.includes(origin)) return json(403, { code: 'origin_forbidden', error: 'Origin not allowed' }, cors);
    if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });
    if (req.method !== 'POST') return json(405, { code: 'method_not_allowed', error: 'POST only' }, { ...cors, Allow: 'POST, OPTIONS' });

    const apiKey = env(envVars, 'GEMINI_API_KEY');
    const accessToken = env(envVars, 'ROLODEX_ACCESS_TOKEN');
    if (!apiKey || !accessToken || accessToken.length < 24) {
      console.error('[gemini] misconfigured: GEMINI_API_KEY or ROLODEX_ACCESS_TOKEN (>=24 chars) missing');
      return json(500, { code: 'server_misconfigured', error: 'Server is missing its secrets' }, cors);
    }

    const auth = req.headers.get('authorization') || '';
    const provided = auth.startsWith('Bearer ') ? auth.slice(7).trim() : '';
    if (!tokenMatches(provided, accessToken)) return json(401, { code: 'unauthorized', error: 'Access code rejected' }, cors);

    const declared = Number(req.headers.get('content-length'));
    if (Number.isFinite(declared) && declared > MAX_BODY_BYTES) return json(413, { code: 'too_large', error: 'Request too large' }, cors);
    const raw = await req.text();
    if (raw.length > MAX_BODY_BYTES) return json(413, { code: 'too_large', error: 'Request too large' }, cors);

    let body;
    try { body = JSON.parse(raw); } catch { return json(400, { code: 'invalid_request', error: 'Body must be JSON' }, cors); }
    const v = validate(body);
    if (v.error) return json(v.status || 400, { code: v.status === 413 ? 'too_large' : 'invalid_request', error: v.error }, cors);

    const dailyLimit = parseInt(env(envVars, 'DAILY_REQUEST_LIMIT', '300'), 10) || 300;
    try {
      if (!(await withinDailyCap(await getUsageStore(), dailyLimit, now()))) {
        return json(429, { code: 'daily_limit', error: 'Daily Gemini limit reached' }, { ...cors, 'Retry-After': '3600' });
      }
    } catch (err) {
      console.warn('[gemini] usage store unavailable, continuing:', err && err.name); // edge rate limit still applies
    }

    const models = env(envVars, 'GEMINI_MODELS', DEFAULT_MODELS.join(',')).split(',').map(s => s.trim()).filter(Boolean);
    const started = now();
    const result = await callGemini({ apiKey, models, parts: v.parts, generationConfig: v.generationConfig,
      fetchImpl, deadline: started + TOTAL_BUDGET_MS, sleep, now });

    console.log(JSON.stringify({ fn: 'gemini', task: body.task, ok: result.ok, kind: result.kind || null,
      reason: result.reason || null, upstreamStatus: result.upstreamStatus || null, model: result.model || null, ms: now() - started }));

    if (result.ok) return json(200, { text: result.text, model: result.model }, cors);
    switch (result.kind) {
      case 'blocked': return json(422, { code: 'blocked', reason: result.reason, error: 'Gemini blocked this request' }, cors);
      case 'empty': return json(502, { code: 'empty', reason: result.reason, error: 'Gemini returned no text' }, cors);
      case 'auth': return json(502, { code: 'upstream_auth', error: 'Server Gemini key was rejected' }, cors);
      case 'bad_request': return json(400, { code: 'upstream_bad_request', error: 'Gemini rejected the request' }, cors);
      case 'rate_limited': {
        const secs = String(Math.max(1, Math.ceil((result.retryAfterMs || 30000) / 1000)));
        return json(429, { code: 'rate_limited', retryAfter: Number(secs), error: 'Gemini rate limit hit' }, { ...cors, 'Retry-After': secs });
      }
      default: return json(503, { code: 'unavailable', error: 'Gemini is unavailable — try again' }, cors);
    }
  };
}

export default createHandler();

export const config = {
  path: '/api/gemini',
  // Enforced by Netlify's edge before the function runs (per IP). Covers brute-forcing the access code.
  rateLimit: { windowLimit: 20, windowSize: 60, aggregateBy: ['ip', 'domain'] },
};
