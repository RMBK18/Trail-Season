// ─────────────────────────────────────────────────────────────
// Fall Hike App: live AI answers (Cloudflare Worker)
//
// The app's Ask tab calls this ONLY when its offline FAQ has no answer
// (see askLiveAI() in js/ask.js). The Worker holds ANTHROPIC_API_KEY,
// adds the hike plan from js/data.js as context, asks Claude, and returns
// { "answer": "..." }. Any error returns { "error": "..." } with a non-2xx
// status, and the app falls back to "I don't know that one — ask Summan!".
//
// Stateless: questions and answers are never stored or logged here.
// ─────────────────────────────────────────────────────────────

import Anthropic from '@anthropic-ai/sdk';
// The same file the app uses, bundled in at deploy time. After editing the
// hike plan, redeploy the Worker so its answers match the app.
import { HIKES, BASICS, APP, GROUP } from '../../../js/data.js';

const MODEL = 'claude-opus-5-5';
const MAX_QUESTION_CHARS = 500; // askLiveAI() in js/ask.js sends at most 500
const MAX_BODY_CHARS = 4000;

// ── System prompt: built once from the hike plan ─────────────
function hikeFacts(h) {
  const trail = (t) => [t.name, t.level, t.length, t.time, t.note].filter(Boolean).join(', ');
  return [
    `${h.dateLong}: ${h.park}, ${h.area}`,
    `- Meet: ${h.meet.time}${h.meet.place ? ` at ${h.meet.place}` : ''}${h.meet.note ? `. ${h.meet.note}` : ''}`,
    `- Difficulty: ${h.level}${h.optionLevel ? `, with ${h.optionLevel === 'EASY' ? 'an' : 'a'} ${h.optionLevel} option` : ''}`,
    `- Trails: ${h.trails.map(trail).join('; ')}`,
    `- Highlights: ${h.fallLine}`,
    `- Drive: ${h.drive.text}`,
    `- Cost: ${h.fee.amount}. ${h.fee.note}${h.booking ? ` Book at ${h.booking.url}` : ''}`,
    `- Washrooms: ${h.washrooms ?? 'not in the plan'}`,
    `- Dogs: ${h.dogs ?? 'not in the plan'}`,
    h.picnic && `- Picnic: ${h.picnic}`,
    h.kidsNote && `- With kids: ${h.kidsNote}`,
    h.food && `- Food nearby (general info, not from the plan): ${h.food}`,
    ...h.alerts.map((a) => `- Alert: ${a.title}. ${a.text}`),
    `- Bring: ${h.bring.join('; ')}`,
    `- Backup park: ${h.backup.name}`,
    h.fallbackTrailheads && `- Fallback trailheads: ${h.fallbackTrailheads.join(', ')}`,
  ].filter(Boolean).join('\n');
}

const DONT_KNOW = `I don't know that one — ask ${APP.askPerson}!`;

const SYSTEM_PROMPT = `You answer questions in the Ask tab of the ${APP.name}, a phone app for a group of friends from Toronto (North York) doing five Saturday fall hikes in October 2026. ${APP.askPerson} organizes the hikes.

The app first tries its offline FAQ, which already answers the plain facts below (meeting times, fees, booking, parking, dogs, kids, difficulty, drive times, washrooms, what to bring, food nearby) and the group rules (rain, carpools, swimming, bikes, cell signal). You only get the questions it couldn't match, so they are often worded unusually, combine several things, or go beyond the plan. Each message gives today's date, then the question.

How to answer:
- 1 to 3 short sentences, friendly and casual. Plain text only: no markdown, bullet points or headings, because the app shows your reply as plain text.
- For anything about these five hikes, the plan below is the source of truth. Never change or invent plan details such as times, fees, meeting spots or trails.
- If the plan doesn't cover it, you may use general knowledge about Ontario parks and hiking, but say it isn't from the plan and suggest checking the park's website.
- You have no live information: no weather forecasts, traffic, trail closures or fall colour reports. For weather, point them to the weather card on that hike's page in the app.
- If you don't know, or only the organizer can answer (who's coming, changes to the plan), reply exactly: "${DONT_KNOW}"
- Stick to the hikes, hiking and the trip. For anything unrelated, say in one sentence that you can only help with the fall hikes.
- In an emergency, tell them to call 911.

THE HIKE PLAN (all times are Toronto time)

${HIKES.map(hikeFacts).join('\n\n')}

Every hike: ${BASICS.join(', ')}.

GROUP RULES AND TIPS
- Rain: ${GROUP.rain}
- Carpools: ${GROUP.carpool}
- Kids: ${GROUP.kids}
- Swimming: ${GROUP.swim}
- Bikes: ${GROUP.bikes}
- Cell signal: ${GROUP.cell}`;

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

// ── Claude ───────────────────────────────────────────────────
async function askClaude(env, question) {
  const client = new Anthropic({
    apiKey: env.ANTHROPIC_API_KEY,
    maxRetries: 1, // one quick retry on 429/5xx; the app gives up after 15 s anyway
    timeout: 12_000, // milliseconds
  });

  const message = await client.beta.messages.create({
    model: MODEL,
    max_tokens: 4096, // thinking counts toward this too; replies are 1-3 sentences
    output_config: { effort: 'low' }, // short FAQ answers: keep latency and cost down
    // If Claude's safety filters decline a harmless question, the API retries it
    // on Anthropic's recommended fallback model instead of returning a refusal.
    betas: ['server-side-fallback-2026-07-01'],
    fallbacks: 'default',
    // The hike plan is the same on every request, so cache it (only the plan is
    // cached, never the question).
    system: [{ type: 'text', text: SYSTEM_PROMPT, cache_control: { type: 'ephemeral' } }],
    messages: [
      {
        role: 'user',
        content: `Today is ${todayInToronto()}.\n\n<question>\n${question}\n</question>`,
      },
    ],
  });

  if (message.stop_reason === 'refusal') return null;
  const text = message.content
    .filter((b) => b.type === 'text')
    .map((b) => b.text)
    .join('')
    .trim();
  return text || null;
}

// Map Anthropic errors to what the app should get back. The app treats any
// non-2xx as "no live answer", so these mostly matter for testing and logs.
function errorResponse(err, cors) {
  if (err instanceof Anthropic.RateLimitError) {
    return json({ error: 'Too many questions right now. Try again in a minute.' }, 429, { ...cors, 'Retry-After': '60' });
  }
  if (err instanceof Anthropic.AuthenticationError || err instanceof Anthropic.PermissionDeniedError) {
    console.error('Anthropic rejected the API key:', err.status);
    return json({ error: 'AI service is misconfigured' }, 500, cors);
  }
  if (err instanceof Anthropic.APIConnectionTimeoutError) {
    return json({ error: 'AI took too long to answer' }, 504, cors);
  }
  if (err instanceof Anthropic.APIConnectionError) {
    console.error('Could not reach Anthropic:', err.message);
    return json({ error: 'AI service unavailable' }, 502, cors);
  }
  if (err instanceof Anthropic.APIError) {
    // 529 overloaded, 5xx, or a 400 from a bad request shape
    console.error('Anthropic API error:', err.status, err.type ?? '');
    return json({ error: 'AI service unavailable' }, 502, cors);
  }
  console.error('Unexpected error:', err?.message ?? err);
  return json({ error: 'Something went wrong' }, 500, cors);
}

// ── Request handler ──────────────────────────────────────────
export default {
  async fetch(request, env) {
    // Health check: open the Worker URL in a browser to see it's live.
    // Does not call Claude.
    if (request.method === 'GET' || request.method === 'HEAD') {
      return json({ ok: true, service: 'fall-hike-ai', apiKeyConfigured: Boolean(env.ANTHROPIC_API_KEY) }, 200);
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

    if (!env.ANTHROPIC_API_KEY) {
      console.error('ANTHROPIC_API_KEY is not set. Run: npx wrangler secret put ANTHROPIC_API_KEY');
      return json({ error: 'AI service is misconfigured' }, 500, cors);
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

    try {
      const answer = await askClaude(env, question);
      if (!answer) return json({ error: 'No answer for that one' }, 422, cors);
      return json({ answer }, 200, cors);
    } catch (err) {
      return errorResponse(err, cors);
    }
  },
};
