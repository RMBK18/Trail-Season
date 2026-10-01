// ─────────────────────────────────────────────────────────────
// Fall Hike App: live AI answers (Cloudflare Worker)
//
// Step 2 of the Ask tab's three steps:
//   1. The app's offline FAQ answers what it can (js/ask.js). No AI.
//   2. Anything else comes here. Cloudflare Workers AI may answer ONLY from the facts in
//      js/data.js, and must quote the lines it used. The Worker checks every
//      quote against those facts and throws the answer away if one doesn't match.
//   3. If there's no verified answer, the question goes to the organizer:
//      an ntfy push alert (if NTFY_TOPIC is set), and the app shows a
//      "Send to Summan" button so the asker can send it and get a reply.
//
// Response: { "status": "answered", "answer": "...", "ride_help": true? }
//        or { "status": "unanswered" | "off_topic", "forwarded": true|false }
// ride_help: the person is looking for a ride. The app then shows its live
// rides card from the RSVP list; the AI never sees names or phone numbers.
// Errors keep a non-2xx status and also carry "forwarded".
//
// Stateless: questions and answers are never stored or logged here.
// ─────────────────────────────────────────────────────────────

// The same file the app uses, bundled in at deploy time. After editing the
// hike plan, redeploy the Worker so its answers match the app.
import { HIKES, BASICS, APP, GROUP, KIDS_LABELS } from '../../../js/data.js';

// Cloudflare Workers AI, through the `AI` binding in wrangler.toml: no API key,
// and Cloudflare's free daily allowance covers a small group. The model can be
// changed with the AI_MODEL variable in wrangler.toml, without touching this code.
const DEFAULT_MODEL = '@cf/meta/llama-3.3-70b-instruct-fp8-fast';
const TIMEOUT_MS = 12_000; // the app gives up after 15 s
const MAX_QUESTION_CHARS = 500; // askLiveAI() in js/ask.js sends at most 500
const MAX_BODY_CHARS = 4000;
const MAX_ANSWER_CHARS = 600;
const MIN_QUOTE_CHARS = 10; // at least one quote must be a real phrase, not a single word

// ── The facts: everything the AI is allowed to use ──────────
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
    // Backups in the order to try them, each on its own line so the AI can't mix them up
    h.fallbackTrailheads && `- If the park is too busy, first try these fallback trailheads in the same park: ${h.fallbackTrailheads.join(', ')}`,
    `- Backup park${h.backup.then ? ' (first choice)' : ''}: ${h.backup.name}`,
    h.backup.note && `- About ${h.backup.name}: ${h.backup.note}${h.backup.booking ? ` Book at ${h.backup.booking.url}` : ''}`,
    h.backup.then && `- Second backup park, only if ${h.backup.name} is sold out or can't be used: ${h.backup.then.name}`,
  ].filter(Boolean).join('\n');
}

const FACTS = `THE HIKE PLAN (all times are Toronto time)

${HIKES.map(hikeFacts).join('\n\n')}

Every hike: ${BASICS.join(', ')}.

CARPOOLING (the Rides list on each hike page of the app)
- To offer a ride: open the hike, reply Coming, pick I can drive, set your spare seats and pick your area.
- To get a ride: open the hike, reply Coming, pick Need a ride and pick your area. Drivers from your area are listed first.
- Tap Message to open WhatsApp with a message already written, or Ride with to save a seat in a driver's car. The seats left go down by themselves, and a full car shows Full.
- Only one of the two people needs to share a WhatsApp number: whoever has the other's number sends the first message, and they sort out the pickup time and place between them.
- Sharing a WhatsApp number is optional. There are no logins, so anyone with the app link can see a shared number when they tap Message.
- Riders can cancel their seat any time with Cancel my seat. Drivers can't remove riders; they sort it out on WhatsApp and the rider cancels.
- People coming with you need seats too.
- Drivers can turn on ride alerts: one notification each time someone taps Ride with them, and no other notifications. On iPhone, alerts need the app added to the Home Screen (iOS 16.4 or later).
- If a driver stops driving, their riders lose their seats and see a notice in the app.
- Numbers, areas, seats and ride alerts are deleted a week after each hike.
- Areas to pick from: Downtown, Etobicoke, North York, Scarborough, Markham, Vaughan, Mississauga, Brampton, Oakville, Milton, Burlington, Hamilton, Waterloo, or Other.

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

Reply with only a JSON object of this shape: {"status": "...", "answer": "...", "quotes": ["..."], "ride_help": false}
- status "answered": THE FACTS fully answer the question. Put a friendly, plain-text answer of 1 or 2 short sentences in "answer" (no markdown). In "quotes", copy the exact phrases from THE FACTS that support every fact in your answer, word for word. The app checks each quote against THE FACTS and discards the answer if any quote doesn't match.
- status "not_in_plan": the question is about the hikes, the trip or hiking, but THE FACTS don't fully answer it. Leave "answer" empty and "quotes" empty. ${APP.askPerson} will answer it personally. When in doubt, choose this.
- status "off_topic": the question has nothing to do with the hikes or the trip. Leave "answer" and "quotes" empty.

Set "ride_help" to true only when the person is looking for a ride, a lift, a driver or a free seat to a hike (for example "can anyone pick me up from Markham?" or "is anyone driving from Brampton on Saturday?"). The app then shows them its live list of drivers. You never see that list, so never name drivers, never say whether seats are free, and answer from CARPOOLING (for example how to save a seat). Otherwise set "ride_help" to false.

You may use today's date to work out which hike is next or how far away a date is.

${FACTS}`;

// JSON Mode: asks the model to reply in this exact JSON shape. Workers AI
// doesn't guarantee it, so askAI() checks the reply anyway.
const ANSWER_FORMAT = {
  type: 'json_schema',
  json_schema: {
    type: 'object',
    properties: {
      status: { type: 'string', enum: ['answered', 'not_in_plan', 'off_topic'] },
      answer: { type: 'string' },
      quotes: { type: 'array', items: { type: 'string' } },
      ride_help: { type: 'boolean' },
    },
    required: ['status', 'answer', 'quotes', 'ride_help'],
    additionalProperties: false,
  },
};

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

// Keep answers short even if the model runs long: cut at the last full sentence.
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

// ── Step 2: Workers AI, restricted to THE FACTS ──────────────
class AIError extends Error {
  constructor(kind, detail = '') {
    super(`${kind}${detail ? `: ${detail}` : ''}`);
    this.kind = kind; // 'timeout' | 'failed'
  }
}

async function runModel(env, question) {
  const input = {
    messages: [
      { role: 'system', content: SYSTEM_PROMPT },
      { role: 'user', content: `Today is ${todayInToronto()}.\n\n<question>\n${question}\n</question>` },
    ],
    response_format: ANSWER_FORMAT,
    max_tokens: 600, // the model's default (256) can cut the JSON off
    temperature: 0.2, // stick closely to the facts
  };
  // One quick retry if Workers AI fails (for example, briefly out of capacity).
  for (let attempt = 0; ; attempt++) {
    let timer;
    const timeout = new Promise((_, reject) => {
      timer = setTimeout(() => reject(new AIError('timeout')), TIMEOUT_MS);
    });
    try {
      return await Promise.race([env.AI.run(env.AI_MODEL || DEFAULT_MODEL, input), timeout]);
    } catch (err) {
      if (err instanceof AIError) throw err;
      console.error('Workers AI error:', String(err?.message ?? err).slice(0, 300));
      if (attempt === 0) {
        await new Promise((r) => setTimeout(r, 600));
        continue;
      }
      throw new AIError('failed', String(err?.message ?? err));
    } finally {
      clearTimeout(timer);
    }
  }
}

// JSON Mode usually returns `response` as an object; accept a JSON string too.
function readReply(result) {
  const r = result?.response;
  if (r && typeof r === 'object') return r;
  if (typeof r !== 'string') return null;
  const text = r.trim().replace(/^```(?:json)?\s*|\s*```$/g, '');
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

// When someone wants a ride and the AI's own answer didn't check out, this is said
// instead; the app shows the live drivers under it.
const RIDE_HELP_ANSWER = 'Here are the drivers for the hike. Tap Ride with to save a seat, or Message to WhatsApp a driver.';

// Returns { status: 'answered', answer, rideHelp? } | { status: 'unanswered' } | { status: 'off_topic' }
async function askAI(env, question) {
  const out = readReply(await runModel(env, question));
  if (!out) {
    console.error('Unreadable reply from the AI');
    return { status: 'unanswered' };
  }
  const rideHelp = out.ride_help === true;
  if (out.status === 'off_topic' && !rideHelp) return { status: 'off_topic' };
  if (out.status !== 'answered' && !rideHelp) return { status: 'unanswered' };

  const answer = trimAnswer(String(out.answer || ''));
  if (!answer || !quotesCheckOut(out.quotes)) {
    // A ride request is answered by the app's live rides card, so it never goes to the organizer.
    if (rideHelp) return { status: 'answered', answer: RIDE_HELP_ANSWER, rideHelp };
    console.warn('Answer discarded: quotes did not match the facts');
    return { status: 'unanswered' };
  }
  return { status: 'answered', answer, rideHelp };
}

// Map AI problems to what the app should get back. The app treats any
// non-2xx as "no live answer".
function errorResponse(err, cors, forwarded) {
  if (err instanceof AIError && err.kind === 'timeout') {
    return json({ error: 'AI took too long to answer', forwarded }, 504, cors);
  }
  if (err instanceof AIError && /limit|allocation|neuron|quota|429/i.test(err.message)) {
    // Free daily allowance used up (resets 00:00 UTC) or Workers AI rate limit
    return json({ error: 'Too many questions right now. Try again later.', forwarded }, 429, { ...cors, 'Retry-After': '3600' });
  }
  if (err instanceof AIError) {
    // Workers AI failed twice: out of capacity, or a retired model name in AI_MODEL
    return json({ error: 'AI service unavailable', forwarded }, 502, cors);
  }
  console.error('Unexpected error:', err?.message ?? err);
  return json({ error: 'Something went wrong', forwarded }, 500, cors);
}

// ── Request handler ──────────────────────────────────────────
export default {
  async fetch(request, env, ctx) {
    // Health check: open the Worker URL in a browser to see it's live.
    // Does not call the AI.
    if (request.method === 'GET' || request.method === 'HEAD') {
      return json({
        ok: true,
        service: 'fall-hike-ai',
        aiConfigured: Boolean(env.AI),
        model: env.AI_MODEL || DEFAULT_MODEL,
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

    if (!env.AI) {
      console.error('The Workers AI binding is missing. Check [ai] in wrangler.toml.');
      const forwarded = alertOrganizer(env, ctx, question);
      return json({ error: 'AI service is misconfigured', forwarded }, 500, cors);
    }

    try {
      const result = await askAI(env, question);
      if (result.status === 'answered') {
        return json({ status: 'answered', answer: result.answer, ...(result.rideHelp ? { ride_help: true } : {}) }, 200, cors);
      }
      if (result.status === 'off_topic') return json({ status: 'off_topic', forwarded: false }, 200, cors);
      const forwarded = alertOrganizer(env, ctx, question);
      return json({ status: 'unanswered', forwarded }, 200, cors);
    } catch (err) {
      return errorResponse(err, cors, alertOrganizer(env, ctx, question));
    }
  },
};
