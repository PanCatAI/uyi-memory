// The only place that talks to a model (PLAN §4.6): OpenAI-compatible /chat/completions over fetch, or the mock.
// The API key is read from env only; it is never logged, stored or returned.
import { newId } from './ids.mjs';
import { realNow } from './clock.mjs';
import { estimate } from './tokens.mjs';
import { createMock } from './llm-mock.mjs';
import { CHECKS } from './llm-checks.mjs';

export class LlmError extends Error {
  constructor(code, message) { super(message); this.code = code; }
}
const BACKGROUND = ['facts', 'observe', 'reflect', 'catchup', 'forget_resolve', 'judge', 'card_draft', 'idle', 'diary', 'digest', 'sim_user', 'self_check'];
const sleep = ms => new Promise(r => setTimeout(r, ms));
export const MAX_TOKENS_CAP = 2000;

export function llmSettings(env = {}) {
  let extraBody = {};
  if (env.LLM_EXTRA_BODY) { try { extraBody = JSON.parse(env.LLM_EXTRA_BODY); } catch { extraBody = {}; } }
  const num = v => (v === undefined || v === '' ? null : Number(v));
  const model = env.LLM_MODEL || 'deepseek-flash';
  return {
    provider: env.LLM_PROVIDER === 'mock' ? 'mock' : 'openai_compat',
    baseUrl: (env.LLM_BASE_URL || 'https://api.deepseek.com').replace(/\/+$/, ''),
    model, modelBackground: env.LLM_MODEL_BACKGROUND || model, modelJudge: env.LLM_MODEL_JUDGE || '', extraBody,
    prices: { input: num(env.LLM_PRICE_INPUT), cached: num(env.LLM_PRICE_CACHED), output: num(env.LLM_PRICE_OUTPUT) },
    keySet: Boolean(env.LLM_API_KEY)
  };
}

export function parseJsonText(text) {
  const s = String(text ?? '').trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
  try { return JSON.parse(s); } catch { throw new LlmError('BAD_JSON', '模型返回的不是 JSON'); }
}

/** getEnv() is called per request so settings changes apply without a restart. */
export function createLlm({ getEnv, db, fetchImpl = (...a) => fetch(...a), forceMock = () => false }) {
  const mock = createMock();
  // One row per actual attempt (every HTTP request, every mock answer). logical_id groups the attempts of one call.
  const insertCall = db.prepare(`INSERT INTO llm_calls (id, save_id, purpose, provider, model, input_tokens, cached_tokens, output_tokens, cost_usd, latency_ms, ok, error, real_at, finish_reason, stage, logical_id, attempt, usage_known, cache_reported)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
  const markShape = db.prepare("UPDATE llm_calls SET ok = 0, stage = 'shape', error = ? WHERE id = ?");
  const NO_USAGE = { input: 0, cached: 0, output: 0 };
  function logCall(r) {
    const id = newId('l');
    const u = r.usage || NO_USAGE;
    insertCall.run(id, r.saveId, r.purpose, r.provider, r.model, u.input, u.cached ?? 0, u.output, r.cost ?? null, r.latency, r.stage === 'ok' ? 1 : 0, r.error ?? null, r.at, r.finish ?? null, r.stage, r.logical.id, ++r.logical.n, r.usageKnown ? 1 : 0, r.usageKnown && u.cached != null ? 1 : 0);
    return id;
  }
  const newLogical = () => ({ id: newId('lc'), n: 0 });

  function cost(prices, usage, known) {
    if (!known || prices.input == null || prices.output == null) return null;
    const cached = usage.cached || 0;
    return ((usage.input - cached) * prices.input + cached * (prices.cached ?? prices.input) + usage.output * prices.output) / 1e6;
  }

  /**
   * One JSON call. Network errors and 429/5xx are retried once; every attempt is logged.
   * Returns the parsed object plus .__meta = { model, usage, cost, latency, finishReason, callId, logicalId }.
   * Errors: NO_KEY, NETWORK, HTTP_<status>, BAD_RESPONSE, BAD_JSON, TRUNCATED (finish_reason=length and no valid JSON).
   */
  async function callJson({ purpose, system, user, saveId = null, mockInput = {}, maxTokens = 600, logical = newLogical() }) {
    const env = getEnv();
    const s = llmSettings(env);
    if (forceMock(saveId)) s.provider = 'mock';
    const started = realNow();
    // ooc_judge must be a different model from the one that replies (B9); callers skip it when none is set.
    const model = purpose === 'ooc_judge' || purpose === 'fun_judge' ? (s.modelJudge || s.modelBackground) : BACKGROUND.includes(purpose) ? s.modelBackground : s.model;
    if (s.provider === 'mock') {
      const out = mock.answer(purpose, mockInput);
      const usage = { input: estimate(system) + estimate(user), cached: 0, output: estimate(JSON.stringify(out)) };
      // Mock tokens are estimates, so usage_known = 0 and nothing is priced.
      const callId = logCall({ saveId, purpose, provider: 'mock', model: 'mock', usage, latency: 0, stage: 'ok', at: started, finish: 'stop', logical, usageKnown: false });
      return withMeta(out, { model: 'mock', usage, cost: null, latency: 0, finishReason: 'stop', callId, logicalId: logical.id });
    }
    const key = env.LLM_API_KEY;
    const scrub = m => String(m).split(key || '\u0000').join('***').slice(0, 300);
    const base = { saveId, purpose, provider: 'openai_compat', model, logical };
    if (!key) {
      logCall({ ...base, latency: 0, stage: 'http', error: '没有 API Key', at: started });
      throw new LlmError('NO_KEY', '还没有填写 API Key（右上角 ⚙ 设置）。');
    }
    const body = { model, messages: [{ role: 'system', content: system }, { role: 'user', content: user }], response_format: { type: 'json_object' }, temperature: purpose === 'reply' || purpose === 'sim_user' ? 0.8 : 0.2, max_tokens: maxTokens, ...s.extraBody };
    for (let http = 0; ; http++) {
      const t0 = realNow();
      let r, text;
      try {
        r = await fetchImpl(`${s.baseUrl}/chat/completions`, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` }, body: JSON.stringify(body), signal: AbortSignal.timeout(60000) });
        text = await r.text();
      } catch (e) {
        const err = new LlmError('NETWORK', scrub(`连不上模型服务：${e.message}`));
        logCall({ ...base, latency: realNow() - t0, stage: 'network', error: err.message, at: t0 });
        if (http === 0) { await sleep(2000); continue; }
        throw err;
      }
      if (!r.ok) {
        const err = new LlmError(`HTTP_${r.status}`, scrub(`HTTP ${r.status}: ${text.slice(0, 200)}`));
        logCall({ ...base, latency: realNow() - t0, stage: 'http', error: err.message, at: t0 });
        if ((r.status === 429 || r.status >= 500) && http === 0) { await sleep(2000); continue; }
        throw err;
      }
      let raw;
      try { raw = JSON.parse(text); } catch {
        logCall({ ...base, latency: realNow() - t0, stage: 'http', error: scrub(`响应不是 JSON：${text.slice(0, 120)}`), at: t0 });
        throw new LlmError('BAD_RESPONSE', '模型服务的响应不是 JSON');
      }
      const u = raw.usage;
      const usageKnown = Number.isFinite(u?.prompt_tokens) && Number.isFinite(u?.completion_tokens);
      // Cache hits: DeepSeek says prompt_cache_hit_tokens, OpenAI-style prompt_tokens_details.cached_tokens; neither → null
      // (stored as cached_tokens 0 with cache_reported 0, so the cost tab says the provider did not report it).
      const hit = u?.prompt_cache_hit_tokens ?? u?.prompt_tokens_details?.cached_tokens;
      const usage = usageKnown ? { input: u.prompt_tokens, cached: Number.isFinite(hit) ? hit : null, output: u.completion_tokens } : { ...NO_USAGE };
      const finish = raw.choices?.[0]?.finish_reason ?? null;
      const served = raw.model || model;
      const c = cost(s.prices, usage, usageKnown);
      const row = { ...base, model: served, usage, usageKnown, cost: c, finish, latency: realNow() - t0, at: t0 };
      let out;
      try { out = parseJsonText(raw.choices?.[0]?.message?.content); } catch {
        // Thinking models can spend the whole budget on reasoning and return empty content: say so.
        const reasoning = u?.completion_tokens_details?.reasoning_tokens;
        const detail = `max_tokens=${maxTokens}${Number.isFinite(reasoning) ? `，其中推理 ${reasoning}` : ''}，正文 ${String(raw.choices?.[0]?.message?.content ?? '').length} 字`;
        logCall({ ...row, stage: 'json', error: finish === 'length' ? `输出被截断（${detail}）` : `模型返回的不是 JSON（${detail}）` });
        if (finish === 'length') throw new LlmError('TRUNCATED', `模型输出被截断（max_tokens=${maxTokens}）`);
        throw new LlmError('BAD_JSON', '模型返回的不是 JSON');
      }
      const callId = logCall({ ...row, stage: 'ok' });
      return withMeta(out, { model: served, usage, cost: c, latency: realNow() - started, finishReason: finish, callId, logicalId: logical.id });
    }
  }

  /**
   * callJson + shape check (CHECKS[purpose]) + extra validate(obj) → errors. All attempts share one logical id.
   * Truncated output is retried with a bigger max_tokens (doubling, at most MAX_TOKENS_CAP); other bad JSON gets
   * one "output valid JSON" nudge; a bad shape is retried once with the errors appended.
   */
  async function callChecked(args, validate = () => []) {
    const logical = args.logical || newLogical();
    let user = args.user, maxTokens = args.maxTokens ?? 600, nudged = false, reshaped = false;
    for (;;) {
      let out;
      try { out = await callJson({ ...args, user, maxTokens, logical }); }
      catch (e) {
        if (e.code === 'TRUNCATED' && maxTokens < MAX_TOKENS_CAP) { maxTokens = Math.min(MAX_TOKENS_CAP, maxTokens * 2); continue; }
        if (e.code === 'BAD_JSON' && !nudged) { nudged = true; user = `${user}\n\n（上一次你没有输出合法 JSON。只输出一个 JSON 对象。）`; continue; }
        throw e;
      }
      const shape = CHECKS[args.purpose]?.(out) || [];
      const errors = shape.length ? shape : validate(out);
      if (!errors.length) return out;
      if (out.__meta?.callId) markShape.run(`输出不合规：${errors.join('；')}`.slice(0, 300), out.__meta.callId);
      if (reshaped) throw new LlmError('BAD_SHAPE', `模型输出不合规：${errors.join('；')}`);
      reshaped = true;
      user = `${args.user}\n\n（上一次的输出有问题：${errors.join('；')}。请改正后只输出 JSON。）`;
    }
  }

  async function testConnection() {
    const started = realNow();
    try {
      const out = await callJson({ purpose: 'test', system: '只输出 JSON。', user: '请输出 {"pong": true}', maxTokens: 20 });
      return { ok: true, model: out.__meta.model, latency_ms: realNow() - started, reply: out };
    } catch (e) { return { ok: false, error: e.message, latency_ms: realNow() - started }; }
  }

  return { callJson, callChecked, testConnection, mock, settings: () => llmSettings(getEnv()) };
}

function withMeta(out, meta) {
  Object.defineProperty(out, '__meta', { value: meta, enumerable: false });
  return out;
}
