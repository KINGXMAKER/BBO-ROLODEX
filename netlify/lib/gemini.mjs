// Server-side Gemini caller for the Rolodex. The API key only ever lives in the function's env.
// Classifies failures by HTTP status and structured response fields, never by scanning message text.

export const DEFAULT_MODELS = ['gemini-3.5-flash-lite', 'gemini-3.6-flash'];

// finishReasons that mean "the model produced nothing because of a policy/safety filter".
const BLOCK_FINISH_REASONS = new Set([
  'SAFETY', 'RECITATION', 'BLOCKLIST', 'PROHIBITED_CONTENT', 'SPII',
  'IMAGE_SAFETY', 'IMAGE_PROHIBITED_CONTENT', 'IMAGE_RECITATION',
]);

const TRANSIENT_RETRY_MS = 1200;
const MAX_RETRY_DELAY_MS = 4000;

// Turn a 2xx generateContent body into text, or a distinct blocked/empty result.
export function extractResult(json) {
  const blockReason = json && json.promptFeedback && json.promptFeedback.blockReason;
  if (blockReason) return { ok: false, kind: 'blocked', reason: blockReason };

  const cand = json && Array.isArray(json.candidates) ? json.candidates[0] : null;
  if (!cand) return { ok: false, kind: 'empty', reason: 'NO_CANDIDATES' };

  const parts = (cand.content && Array.isArray(cand.content.parts)) ? cand.content.parts : [];
  const text = parts
    .filter(p => p && typeof p.text === 'string' && !p.thought)
    .map(p => p.text)
    .join('');
  if (text.trim()) return { ok: true, text, finishReason: cand.finishReason || null };

  const finish = cand.finishReason || 'NO_TEXT';
  if (BLOCK_FINISH_REASONS.has(finish)) return { ok: false, kind: 'blocked', reason: finish };
  return { ok: false, kind: 'empty', reason: finish };
}

function thinkingConfigFor(model) {
  if (/^gemini-3/.test(model)) return { thinkingLevel: 'low' };
  if (/2\.5/.test(model)) return { thinkingBudget: 0 };
  return null;
}

function retryDelayMs(errJson) {
  const details = (errJson && errJson.error && errJson.error.details) || [];
  const info = details.find(d => d && typeof d.retryDelay === 'string');
  const secs = info ? parseFloat(info.retryDelay) : NaN;
  return Number.isFinite(secs) ? Math.ceil(secs * 1000) : null;
}

// Status → failure kind. 400 is only "auth" when Google says the key itself is invalid.
function classifyHttp(status, errJson) {
  const reasons = ((errJson && errJson.error && errJson.error.details) || []).map(d => d && d.reason);
  if (status === 401 || status === 403) return 'auth';
  if (status === 400 && reasons.includes('API_KEY_INVALID')) return 'auth';
  if (status === 400) return 'bad_request';
  if (status === 404) return 'model_unavailable';
  if (status === 429) return 'rate_limited';
  if (status >= 500) return 'unavailable';
  return 'bad_request';
}

/**
 * Call Gemini with model fallback. Retries only transient failures (429 / 5xx / timeout / network),
 * once per model, inside one shared wall-clock deadline.
 * Returns { ok:true, text, model } or { ok:false, kind, reason?, upstreamStatus?, retryAfterMs? }.
 */
export async function callGemini({ apiKey, models = DEFAULT_MODELS, parts, generationConfig = {},
  fetchImpl = fetch, deadline, sleep = ms => new Promise(r => setTimeout(r, ms)), now = Date.now }) {
  let last = { ok: false, kind: 'unavailable', reason: 'NO_ATTEMPT' };

  for (const model of models) {
    for (let attempt = 0; attempt < 2; attempt++) {
      const remaining = deadline - now();
      if (remaining < 1500) return last.kind === 'rate_limited' ? last : { ok: false, kind: 'timeout', reason: 'BUDGET_EXHAUSTED' };

      const cfg = { ...generationConfig };
      const thinking = thinkingConfigFor(model);
      if (thinking) cfg.thinkingConfig = thinking;

      let resp;
      try {
        resp = await fetchImpl(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'x-goog-api-key': apiKey },
          body: JSON.stringify({ contents: [{ role: 'user', parts }], generationConfig: cfg }),
          signal: AbortSignal.timeout(remaining - 500),
        });
      } catch (err) {
        last = { ok: false, kind: 'unavailable', reason: err && err.name === 'TimeoutError' ? 'TIMEOUT' : 'NETWORK' };
        if (attempt === 0) { await sleep(TRANSIENT_RETRY_MS); continue; }
        break;
      }

      if (resp.ok) {
        const json = await resp.json().catch(() => null);
        const result = extractResult(json);
        return result.ok ? { ...result, model } : { ...result, model, upstreamStatus: resp.status };
      }

      const errJson = await resp.json().catch(() => null);
      const kind = classifyHttp(resp.status, errJson);
      last = { ok: false, kind, upstreamStatus: resp.status, model };

      if (kind === 'auth' || kind === 'bad_request') return last; // a retry cannot fix these
      if (kind === 'model_unavailable') break;                     // try the next model
      if (kind === 'rate_limited') last.retryAfterMs = retryDelayMs(errJson);
      if (attempt === 0) {
        const wait = Math.min(last.retryAfterMs || TRANSIENT_RETRY_MS, MAX_RETRY_DELAY_MS);
        if (deadline - now() - wait < 2500) break; // not enough budget to wait; move to next model
        await sleep(wait);
      }
    }
  }
  if (last.kind === 'model_unavailable') return { ...last, kind: 'unavailable' };
  return last;
}
