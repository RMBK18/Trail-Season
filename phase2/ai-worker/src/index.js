// ─────────────────────────────────────────────────────────────
// Fall Hike App: live AI answers (Cloudflare Worker)
//
// Step 2 of the Ask tab's three steps:
//   1. The app's offline FAQ answers what it can (js/ask.js). No AI.
//   2. Anything else comes here. Claude may answer ONLY from the facts in
//      js/data.js, and must quote the lines it used. The Worker checks every
//      quote against those facts and throws the answer away if one doesn't match.
//   3. If there's no verified answer, the question goes to the organizer:
//      an ntfy push alert (if NTFY_TOPIC is set), and the app shows a
//      "Send to Summan" button so the asker can send it and get a reply.
//
// Response: { "status": "answered", "answer": "..." }
//        or { "status": "unanswered" | "off_topic", "forwarded": true|false }
// Errors keep a non-2xx status and also carry "forwarded".
//
// Stateless: questions and answers are never stored or logged here.
// ─────────────────────────────────────────────────────────────

import Anthropic from '@anthropic-ai/sdk';
import { jsonSchemaOutputFormat } from '@anthropic-ai/sdk/helpers/json-schema';
// The same file the app uses, bundled in at deploy time. After editing the
// hike plan, redeploy the Worker so its answers match the app.
import { HIKES, BASICS, APP, GROUP, KIDS_LABELS } from '../../../js/data.js';

const MODEL = 'claude-opus-5-5';
const MAX_QUESTION_CHARS = 500; // askLiveAI() in js/ask.js sends at most 500
const MAX_BODY_CHARS = 4000;
const MAX_ANSWER_CHARS = 600;
const MIN_QUOTE_CHARS = 10; // at least one quote must be a real phrase, not a single word

// ── The facts: everything Claude is allowed to use ──────────
function hikeFacts(h) {
  const trail = (t) => [t.name, t.level, t.length, t.time, t.note].filter(Boolean).join(', ');
  return [
    `${h.dateLong}: ${h.park}, ${h.area}`,
    `- Meet: ${h.meet.time}${h.meet.place ? ` at ${h.meet.place}` : ''}${h.meet.address ? ` (${h.meet.address})` : ''}${h.meet.note ? `. ${h.meet.note}` : ''}`,
    `- Difficulty: ${h.level}${h.optionLevel ? `, with ${h.optionLevel === 'EASY' ? 'an' : 'a'} ${h.optionLevel} option` : ''}`,
    `- Trails: ${h.trails.map(trail).join('; ')}`,
    `- Highlights: ${h.fallLine}`,
    `- Drive: ${h.drive.text}`,
    `- Cost: ${h.fee.amount}. ${h.fee.note}${h.booking ? ` Book at ${h.booking.url}` : ''}`,
    `- Washrooms: ${h.washrooms ?? 'not in the plan'}`,
    `- Dogs: ${h.dogs ?? 'not in the plan'}`,
    h.picnic && `- Picnic: ${h.picnic}`,
    KIDS_LABELS[h.kids] && `- Kids: ${KIDS_LABELS[h.kids]}`,
    h.kidsNote && `- With kids: ${h.kidsNote}`,
    h.food && `- Food nearby: ${h.food}`,
    ...h.alerts.map((a) => `- Alert: ${a.title}. ${a.text}`),
    `- Bring: ${h.bring.join('; ')}`,
    `- Backup park: ${h.backup.name}`,
    h.fallbackTrailheads && `- Fallback trailheads: ${h.fallbackTrailheads.join(', ')}`,
  ].filter(Boolean).join('\n');
}

const FACTS = `THE HIKE PLAN (all times are Toronto time)

${HIKES.map(hikeFacts).join('\n\n')}

Every hike: ${BASICS.join(', ')}.

GROUP RULES AND TIPS
- Rain: ${GROUP.rain}
- Carpools: ${GROUP.carpool}
- Kids: ${GROUP.kids}
- Swimming: ${GROUP.swim}
- Bikes: ${GROUP.bikes}
- Cell signal: ${GROUP.cell}
- Emergencies: ${GROUP.emergency}`;

const SYSTEM_PROMPT = `You answer questions in the Ask tab of the ${APP.name}, a phone app for a group of friends from Toronto (North York) doing five Saturday fall hikes in October 2026. ${APP.askPerson} organizes the hikes.

The app's offline FAQ has already tried the question and found no match, so questions are often worded unusually or combine several things. Each message gives today's date, then the question.

Answer ONLY from THE FACTS below. They are everything ${APP.askPerson} has written down. Do not use general knowledge, outside facts, or guesses, even about well-known parks. Do not add advice, details or reassurance that THE FACTS don't state.

Reply in the required JSON:
- status "answered": THE FACTS fully answer the question. Put a friendly, plain-text answer of 1 or 2 short sentences in "answer" (no markdown). In "quotes", copy the exact phrases from THE FACTS that support every fact in your answer, word for word. The app checks each quote against THE FACTS and discards the answer if any quote doesn't match.
- status "not_in_plan": the question is about the hikes, the trip or hiking, but THE FACTS don't fully answer it. Leave "answer" empty and "quotes" empty. ${APP.askPerson} will answer it personally. When in doubt, choose this.
- status "off_topic": the question has nothing to do with the hikes or the trip. Leave "answer" and "quotes" empty.

You may use today's date to work out which hike is next or how far away a date is.

${FACTS}`;

const ANSWER_FORMAT = jsonSchemaOutputFormat({
  type: 'object',
  properties: {
    status: { type: 'string', enum: ['answered', 'not_in_plan', 'off_topic'] },
    answer: { type: 'string' },
    quotes: { type: 'array', items: { type: 'string' } },
  },
  required: ['status', 'answer', 'quotes'],
  additionalProperties: false,
}, { transform: false }); // send the schema as written, so the API enforces the status enum

// ── Quote check: every quote must appear in THE FACTS ────────
const norm = (s) =>
  String(s)
    .toLowerCase()
    .replace(/[‘’`]/g, "'")
    .replace(/[“”]/g, '"')
    .replace(/[–—]/g, '-')
    .replace(/\s+/g, ' ')
    .trim();
const FACTS_NORM = norm(FACTS);
const cleanQuote = (q) => norm(q).replace(/^[-"'\s]+|["'\s.,;:!?]+$/g, '');

function quotesCheckOut(quotes) {
  const qs = (Array.isArray(quotes) ? quotes : []).map(cleanQuote).filter(Boolean);
  return qs.length > 0 && qs.every((q) => FACTS_NORM.includes(q)) && qs.some((q) => q.length >= MIN_QUOTE_CHARS);
}

// Keep answers short even if Claude runs long: cut at the last full sentence.
function trimAnswer(text) {
  const t = text.trim();
  if (t.length <= MAX_ANSWER_CHARS) return t;
  const cut = t.slice(0, MAX_ANSWER_CHARS);
  const end = Math.max(cut.lastIndexOf('. '), cut.lastIndexOf('! '), cut.lastIndexOf('? '));
  return end > 0 ? cut.slice(0, end + 1) : '';
}

// ── HTTP helpers ─────────────────────────────────────────────
function allowedOrigins(env) {
  return String(env.ALLOWED_ORIGIN || '')
    .split(',')
    .map((s) => s.trim().replace(/\/+$/, ''))
    .filter(Boolean);
}

function corsHeaders(origin) {
  return {
    'Access-Control-Allow-Origin': origin,
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Max-Age': '86400',
    Vary: 'Origin',
  };
}

function json(body, status, headers = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...headers },
  });
}

function todayInToronto() {
  try {
    return new Intl.DateTimeFormat('en-CA', {
      timeZone: APP.timeZone, weekday: 'long', year: 'numeric', month: 'long', day: 'numeric',
    }).format(new Date());
  } catch {
    return new Date().toISOString().slice(0, 10);
  }
}

// ── Step 3: tell the organizer (ntfy push alert) ─────────────
// Sends in the background so the app isn't kept waiting. Returns whether an
// alert was sent. The question is passed on, never stored.
function alertOrganizer(env, ctx, question) {
  if (!env.NTFY_TOPIC) return false;
  const send = fetch(`https://ntfy.sh/${encodeURIComponent(env.NTFY_TOPIC)}`, {
    method: 'POST',
    headers: { Title: 'Fall Hike App: unanswered question', Tags: 'question' },
    body: question,
  })
    .then((r) => { if (!r.ok) console.error('ntfy alert failed:', r.status); })
    .catch((err) => console.error('ntfy alert failed:', err.message));
  ctx?.waitUntil?.(send);
  return true;
}

// ── Step 2: Claude, restricted to THE FACTS ──────────────────
// Returns { status: 'answered', answer } | { status: 'unanswered' } | { status: 'off_topic' }
async function askClaude(env, question) {
  const client = new Anthropic({
    apiKey: env.ANTHROPIC_API_KEY,
    maxRetries: 1, // one quick retry on 429/5xx; the app gives up after 15 s anyway
    timeout: 12_000, // milliseconds
  });

  let message;
  try {
    message = await client.beta.messages.parse({
      model: MODEL,
      max_tokens: 4096, // thinking counts toward this too; replies are 1-2 sentences
      output_config: { effort: 'low', format: ANSWER_FORMAT },
      // If Claude's safety filters decline a harmless question, the API retries it
      // on Anthropic's recommended fallback model instead of returning a refusal.
      betas: ['server-side-fallback-2026-07-01'],
      fallbacks: 'default',
      // The facts are the same on every request, so cache them (only the facts
      // are cached, never the question).
      system: [{ type: 'text', text: SYSTEM_PROMPT, cache_control: { type: 'ephemeral' } }],
      messages: [
        {
          role: 'user',
          content: `Today is ${todayInToronto()}.\n\n<question>\n${question}\n</question>`,
        },
      ],
    });
  } catch (err) {
    if (err instanceof Anthropic.APIError) throw err; // network/API problems: handled by the caller
    console.error('Unreadable reply from Claude:', err?.message ?? err);
    return { status: 'unanswered' };
  }

  if (message.stop_reason === 'refusal' || message.stop_reason === 'max_tokens') return { status: 'unanswered' };
  const out = message.parsed_output;
  if (!out) return { status: 'unanswered' };
  if (out.status === 'off_topic') return { status: 'off_topic' };
  if (out.status !== 'answered') return { status: 'unanswered' };

  const answer = trimAnswer(out.answer || '');
  if (!answer || !quotesCheckOut(out.quotes)) {
    console.warn('Answer discarded: quotes did not match the facts');
    return { status: 'unanswered' };
  }
  return { status: 'answered', answer };
}

// Map Anthropic errors to what the app should get back. The app treats any
// non-2xx as "no live answer".
function errorResponse(err, cors, forwarded) {
  if (err instanceof Anthropic.RateLimitError) {
    return json({ error: 'Too many questions right now. Try again in a minute.', forwarded }, 429, { ...cors, 'Retry-After': '60' });
  }
  if (err instanceof Anthropic.AuthenticationError || err instanceof Anthropic.PermissionDeniedError) {
    console.error('Anthropic rejected the API key:', err.status);
    return json({ error: 'AI service is misconfigured', forwarded }, 500, cors);
  }
  if (err instanceof Anthropic.APIConnectionTimeoutError) {
    return json({ error: 'AI took too long to answer', forwarded }, 504, cors);
  }
  if (err instanceof Anthropic.APIConnectionError) {
    console.error('Could not reach Anthropic:', err.message);
    return json({ error: 'AI service unavailable', forwarded }, 502, cors);
  }
  if (err instanceof Anthropic.APIError) {
    // 529 overloaded, 5xx, or a 400 from a bad request shape
    console.error('Anthropic API error:', err.status, err.type ?? '');
    return json({ error: 'AI service unavailable', forwarded }, 502, cors);
  }
  console.error('Unexpected error:', err?.message ?? err);
  return json({ error: 'Something went wrong', forwarded }, 500, cors);
}

// ── Request handler ──────────────────────────────────────────
export default {
  async fetch(request, env, ctx) {
    // Health check: open the Worker URL in a browser to see it's live.
    // Does not call Claude.
    if (request.method === 'GET' || request.method === 'HEAD') {
      return json({
        ok: true,
        service: 'fall-hike-ai',
        apiKeyConfigured: Boolean(env.ANTHROPIC_API_KEY),
        alertsConfigured: Boolean(env.NTFY_TOPIC),
      }, 200);
    }

    // CORS: only the app's own origin gets in. (Browsers enforce this; the
    // check below also turns away scripts that send no or a different Origin.)
    const origin = request.headers.get('Origin');
    if (!origin || !allowedOrigins(env).includes(origin)) {
      return json({ error: 'Origin not allowed' }, 403);
    }
    const cors = corsHeaders(origin);

    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });
    if (request.method !== 'POST') return json({ error: 'Use POST' }, 405, { ...cors, Allow: 'GET, POST, OPTIONS' });

    // Per-IP rate limit (see [[ratelimits]] in wrangler.toml).
    if (env.RATE_LIMITER) {
      const ip = request.headers.get('CF-Connecting-IP') || 'unknown';
      const { success } = await env.RATE_LIMITER.limit({ key: ip });
      if (!success) {
        return json({ error: 'Too many questions. Wait a minute and try again.' }, 429, { ...cors, 'Retry-After': '60' });
      }
    }

    const raw = await request.text();
    if (raw.length > MAX_BODY_CHARS) return json({ error: 'Request too large' }, 413, cors);
    let body;
    try {
      body = JSON.parse(raw);
    } catch {
      return json({ error: 'Send JSON: { "question": "..." }' }, 400, cors);
    }
    const question = typeof body?.question === 'string' ? body.question.trim() : '';
    if (!question) return json({ error: 'Missing "question"' }, 400, cors);
    if (question.length > MAX_QUESTION_CHARS) {
      return json({ error: `Question is too long (max ${MAX_QUESTION_CHARS} characters)` }, 400, cors);
    }

    if (!env.ANTHROPIC_API_KEY) {
      console.error('ANTHROPIC_API_KEY is not set. Run: npx wrangler secret put ANTHROPIC_API_KEY');
      const forwarded = alertOrganizer(env, ctx, question);
      return json({ error: 'AI service is misconfigured', forwarded }, 500, cors);
    }

    try {
      const result = await askClaude(env, question);
      if (result.status === 'answered') return json({ status: 'answered', answer: result.answer }, 200, cors);
      if (result.status === 'off_topic') return json({ status: 'off_topic', forwarded: false }, 200, cors);
      const forwarded = alertOrganizer(env, ctx, question);
      return json({ status: 'unanswered', forwarded }, 200, cors);
    } catch (err) {
      return errorResponse(err, cors, alertOrganizer(env, ctx, question));
    }
  },
};
