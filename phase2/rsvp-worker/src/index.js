// ─────────────────────────────────────────────────────────────
// Fall Hike App: shared RSVPs, "Who's coming" (Cloudflare Worker)
//
// Friends tap Coming / Maybe / Can't make it on a hike page. Replies are kept
// in one Durable Object (a small SQLite database inside Cloudflare, free plan),
// so every phone sees the same list. The organizer gets an ntfy push alert for
// each reply, with a link to remove junk entries.
//
//   GET    /                 health check (no data)
//   GET    /rsvps            every hike's list          header X-Device
//   PUT    /rsvps/:hikeId    save or update my reply    header X-Device, JSON body
//   DELETE /rsvps/:hikeId    remove my reply            header X-Device
//   GET    /remove?e=&s=     organizer: confirm page for removing a reply (signed link from the alert)
//   POST   /remove           organizer: remove it
//
// Who is who: each phone makes a random id (X-Device) and keeps it. The Worker
// stores only its SHA-256 hash and never sends it back, so nobody can change
// someone else's reply. If a second phone uses a name that already replied,
// the app asks "Is that you?" before taking that reply over (claim: true).
//
// Replies are deleted automatically 7 days after each hike.
// ─────────────────────────────────────────────────────────────

import { DurableObject } from 'cloudflare:workers';
// The same files the app uses, bundled in at deploy time.
import { HIKES } from '../../../js/data.js';
import { endMs } from '../../../js/lib.js';

const STATUSES = ['coming', 'maybe', 'cant'];
const LABELS = { coming: 'Coming', maybe: 'Maybe', cant: "Can't make it" };
const CARPOOL = ['', 'driving', 'need-ride'];
const MAX_NAME_CHARS = 40;
const MAX_GUESTS = 5;
const MAX_SEATS = 6;
const MAX_PER_HIKE = 100;
const MAX_BODY_CHARS = 2000;
const KEEP_AFTER_HIKE_MS = 7 * 24 * 3600 * 1000;

// A pretend hike for automated tests: never alerts, capped at 20 replies,
// hidden from the app, and deleted after an hour.
const SELFTEST = '_selftest';
const SELFTEST_KEEP_MS = 3600 * 1000;
const SELFTEST_MAX = 20;

// A hike replaced by another on the same date: its replies move to the new one,
// and phones still on the old app version keep working until they update.
const RENAMED = { 'short-hills': 'rouge' };

const hikeById = new Map(HIKES.map((h) => [h.id, h]));
const selftestHike = { id: SELFTEST, dateShort: 'Test', shortName: 'Self-test' };
const findHike = (id) => (id === SELFTEST ? selftestHike : hikeById.get(RENAMED[id] || id));
const hikeOver = (h, now = Date.now()) => h.id !== SELFTEST && now > endMs(h);

// ── Input cleaning ──────────────────────────────────────────
// Letters from any language are fine; control and invisible characters are not.
const INVISIBLE = /[\u0000-\u001f\u007f-\u009f\u00ad\u200b-\u200f\u2028-\u202e\u2060-\u2064\u2066-\u206f\ufeff]/g;

export function cleanName(raw) {
  if (typeof raw !== 'string') return '';
  return raw.normalize('NFKC').replace(INVISIBLE, '').replace(/\s+/g, ' ').trim();
}
const nameKey = (name) => name.toLocaleLowerCase('en-CA');

function readReply(body) {
  const name = cleanName(body.name);
  if (!name) return { error: 'Add your name first' };
  if ([...name].length > MAX_NAME_CHARS) return { error: `Name is too long (max ${MAX_NAME_CHARS} characters)` };
  if (!STATUSES.includes(body.status)) return { error: 'Pick Coming, Maybe or Can\'t make it' };
  const going = body.status !== 'cant';
  const guests = going ? Number(body.guests ?? 0) : 0;
  if (!Number.isInteger(guests) || guests < 0 || guests > MAX_GUESTS) return { error: `Guests must be 0 to ${MAX_GUESTS}` };
  const carpool = going ? String(body.carpool ?? '') : '';
  if (!CARPOOL.includes(carpool)) return { error: 'Unknown carpool choice' };
  const seats = carpool === 'driving' ? Number(body.seats ?? 0) : 0;
  if (!Number.isInteger(seats) || seats < 0 || seats > MAX_SEATS) return { error: `Seats must be 0 to ${MAX_SEATS}` };
  return { reply: { name, key: nameKey(name), status: body.status, guests, carpool, seats } };
}

async function sha256hex(text) {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

const randomId = () => {
  const b = crypto.getRandomValues(new Uint8Array(12));
  return btoa(String.fromCharCode(...b)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
};

// ── Storage: one Durable Object holds every reply ────────────
const publicEntry = (row, deviceHash) => ({
  name: row.name,
  status: row.status,
  guests: row.guests,
  carpool: row.carpool,
  seats: row.seats,
  updatedAt: row.updated_at,
  mine: row.device === deviceHash,
});

const sameReply = (row, r) =>
  row.name === r.name && row.status === r.status && row.guests === r.guests && row.carpool === r.carpool && row.seats === r.seats;

export class RsvpStore extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.sql = ctx.storage.sql;
    this.sql.exec(`CREATE TABLE IF NOT EXISTS rsvps (
      id         TEXT PRIMARY KEY,
      hike_id    TEXT NOT NULL,
      device     TEXT NOT NULL,
      name       TEXT NOT NULL,
      name_key   TEXT NOT NULL,
      status     TEXT NOT NULL,
      guests     INTEGER NOT NULL DEFAULT 0,
      carpool    TEXT NOT NULL DEFAULT '',
      seats      INTEGER NOT NULL DEFAULT 0,
      updated_at INTEGER NOT NULL,
      UNIQUE (hike_id, device)
    )`);
    for (const [from, to] of Object.entries(RENAMED)) {
      if (!hikeById.has(to)) continue;
      // A phone that somehow replied to both keeps its newer reply.
      this.sql.exec(`DELETE FROM rsvps WHERE hike_id = ? AND device IN (SELECT device FROM rsvps WHERE hike_id = ?)`, from, to);
      this.sql.exec('UPDATE rsvps SET hike_id = ? WHERE hike_id = ?', to, from);
    }
  }

  rows(hikeId) {
    return this.sql.exec('SELECT * FROM rsvps WHERE hike_id = ? ORDER BY updated_at', hikeId).toArray();
  }

  list(deviceHash, hikeId = null) {
    if (hikeId) return this.rows(hikeId).map((r) => publicEntry(r, deviceHash));
    const out = Object.fromEntries(HIKES.map((h) => [h.id, []]));
    for (const r of this.sql.exec('SELECT * FROM rsvps WHERE hike_id != ? ORDER BY updated_at', SELFTEST)) {
      if (out[r.hike_id]) out[r.hike_id].push(publicEntry(r, deviceHash));
    }
    for (const [from, to] of Object.entries(RENAMED)) if (out[to]) out[from] = out[to];
    return out;
  }

  counts(hikeId) {
    const c = { coming: 0, maybe: 0, cant: 0, people: 0 };
    for (const r of this.rows(hikeId)) {
      c[r.status] += 1;
      if (r.status === 'coming') c.people += 1 + r.guests;
    }
    return c;
  }

  // Save or update this phone's reply. Returns { conflict } when another phone
  // already replied with the same name and the caller hasn't confirmed it's them.
  async put(hikeId, deviceHash, reply, claim) {
    const now = Date.now();
    const mine = this.sql.exec('SELECT * FROM rsvps WHERE hike_id = ? AND device = ?', hikeId, deviceHash).toArray()[0];
    const twin = this.sql.exec('SELECT * FROM rsvps WHERE hike_id = ? AND name_key = ? AND device != ?', hikeId, reply.key, deviceHash).toArray()[0];
    if (twin && !claim) {
      return { conflict: { name: twin.name, status: twin.status, guests: twin.guests, carpool: twin.carpool, seats: twin.seats } };
    }

    if (!mine && !twin) {
      const cap = hikeId === SELFTEST ? SELFTEST_MAX : MAX_PER_HIKE;
      const n = this.sql.exec('SELECT COUNT(*) AS n FROM rsvps WHERE hike_id = ?', hikeId).one().n;
      if (n >= cap) return { full: true };
    }
    if (mine && !twin && sameReply(mine, reply)) {
      return { change: 'same', entry: mine, list: this.list(deviceHash, hikeId), counts: this.counts(hikeId) };
    }

    // Taking over the same-name reply from another phone: keep its id, move it to this phone.
    const before = mine || twin || null;
    if (twin) {
      this.sql.exec('DELETE FROM rsvps WHERE id = ?', twin.id);
      if (mine) this.sql.exec('DELETE FROM rsvps WHERE id = ?', mine.id);
    }
    const id = twin?.id || mine?.id || randomId();
    this.sql.exec(
      `INSERT INTO rsvps (id, hike_id, device, name, name_key, status, guests, carpool, seats, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (hike_id, device) DO UPDATE SET
         name = excluded.name, name_key = excluded.name_key, status = excluded.status, guests = excluded.guests,
         carpool = excluded.carpool, seats = excluded.seats, updated_at = excluded.updated_at`,
      id, hikeId, deviceHash, reply.name, reply.key, reply.status, reply.guests, reply.carpool, reply.seats, now,
    );
    await this.scheduleCleanup();
    const entry = this.sql.exec('SELECT * FROM rsvps WHERE hike_id = ? AND device = ?', hikeId, deviceHash).one();
    // Moving an unchanged reply to another phone isn't news, so it sends no alert.
    const change = !before ? 'new' : sameReply(before, reply) ? 'same' : 'changed';
    return { change, before, entry, list: this.list(deviceHash, hikeId), counts: this.counts(hikeId) };
  }

  remove(hikeId, deviceHash) {
    const row = this.sql.exec('SELECT * FROM rsvps WHERE hike_id = ? AND device = ?', hikeId, deviceHash).toArray()[0];
    if (row) this.sql.exec('DELETE FROM rsvps WHERE id = ?', row.id);
    return { removed: row || null, list: this.list(deviceHash, hikeId), counts: this.counts(hikeId) };
  }

  getById(id) {
    return this.sql.exec('SELECT * FROM rsvps WHERE id = ?', id).toArray()[0] || null;
  }

  removeById(id) {
    const row = this.getById(id);
    if (row) this.sql.exec('DELETE FROM rsvps WHERE id = ?', id);
    return { removed: row, counts: row ? this.counts(row.hike_id) : null };
  }

  // ── Automatic clean-up: a week after each hike, its replies are deleted ──
  purgeTime(hikeId, updatedAt) {
    if (hikeId === SELFTEST) return updatedAt + (Number(this.env.SELFTEST_KEEP_SECONDS) * 1000 || SELFTEST_KEEP_MS);
    const h = hikeById.get(hikeId);
    return h ? endMs(h) + KEEP_AFTER_HIKE_MS : 0; // a hike no longer in the plan: delete now
  }

  nextPurge() {
    let next = Infinity;
    for (const r of this.sql.exec('SELECT hike_id, MIN(updated_at) AS t FROM rsvps GROUP BY hike_id')) {
      next = Math.min(next, this.purgeTime(r.hike_id, r.t));
    }
    return Number.isFinite(next) ? next : null;
  }

  async scheduleCleanup() {
    const next = this.nextPurge();
    if (next == null) return;
    const current = await this.ctx.storage.getAlarm();
    if (current == null || next < current) await this.ctx.storage.setAlarm(Math.max(next, Date.now() + 1000));
  }

  async alarm() {
    const now = Date.now();
    for (const r of this.sql.exec('SELECT id, hike_id, updated_at FROM rsvps').toArray()) {
      if (this.purgeTime(r.hike_id, r.updated_at) <= now) this.sql.exec('DELETE FROM rsvps WHERE id = ?', r.id);
    }
    const next = this.nextPurge();
    if (next != null) await this.ctx.storage.setAlarm(Math.max(next, now + 1000));
  }
}

// ── HTTP helpers ────────────────────────────────────────────
function allowedOrigins(env) {
  return String(env.ALLOWED_ORIGIN || '').split(',').map((s) => s.trim()).filter(Boolean);
}

function corsHeaders(origin) {
  return {
    'Access-Control-Allow-Origin': origin,
    'Access-Control-Allow-Methods': 'GET, PUT, DELETE, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, X-Device',
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

const store = (env) => env.RSVPS.get(env.RSVPS.idFromName('fall-hike-rsvps'));

async function limited(limiter, request) {
  if (!limiter) return false;
  const ip = request.headers.get('CF-Connecting-IP') || 'unknown';
  const { success } = await limiter.limit({ key: ip });
  return !success;
}

// ── Organizer alerts (ntfy) ─────────────────────────────────
const b64url = (buf) => btoa(String.fromCharCode(...new Uint8Array(buf))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const fromB64url = (s) => Uint8Array.from(atob(s.replace(/-/g, '+').replace(/_/g, '/')), (c) => c.charCodeAt(0));

async function hmacKey(env) {
  return crypto.subtle.importKey('raw', new TextEncoder().encode(env.ADMIN_SECRET), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign', 'verify']);
}
async function signRemoval(env, id) {
  return b64url(await crypto.subtle.sign('HMAC', await hmacKey(env), new TextEncoder().encode(`remove:${id}`)));
}
async function checkRemoval(env, id, sig) {
  if (!env.ADMIN_SECRET || !id || !sig || sig.length > 100) return false;
  try {
    return await crypto.subtle.verify('HMAC', await hmacKey(env), fromB64url(sig), new TextEncoder().encode(`remove:${id}`));
  } catch {
    return false;
  }
}

function replyText(e) {
  const bits = [LABELS[e.status]];
  if (e.guests) bits.push(`+${e.guests}`);
  if (e.carpool === 'driving') bits.push(`can drive${e.seats ? `, ${e.seats} spare seat${e.seats === 1 ? '' : 's'}` : ''}`);
  if (e.carpool === 'need-ride') bits.push('needs a ride');
  return bits.join(' · ');
}

function countsText(c) {
  return `So far: ${c.people} ${c.people === 1 ? 'person' : 'people'} coming, ${c.maybe} maybe, ${c.cant} can't make it.`;
}

// Published as JSON, so names with accents or emoji are safe (HTTP headers aren't).
function alertOrganizer(env, ctx, request, hike, kind, entry, counts) {
  if (!env.NTFY_TOPIC || hike.id === SELFTEST) return false;
  const send = (async () => {
    const title = kind === 'removed' ? `${entry.name} removed their reply`
      : kind === 'changed' ? `${entry.name} changed their reply: ${replyText(entry)}`
        : `${entry.name}: ${replyText(entry)}`;
    const actions = [];
    if (env.APP_URL) actions.push({ action: 'view', label: 'Open hike', url: `${env.APP_URL}#/hike/${hike.id}` });
    if (kind !== 'removed' && env.ADMIN_SECRET) {
      const url = new URL('/remove', request.url);
      url.searchParams.set('e', entry.id);
      url.searchParams.set('s', await signRemoval(env, entry.id));
      actions.push({ action: 'view', label: 'Remove reply', url: url.toString() });
    }
    const res = await fetch(env.NTFY_URL || 'https://ntfy.sh', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        topic: env.NTFY_TOPIC,
        title: `RSVP · ${title}`,
        message: `${hike.dateShort}, ${hike.shortName}\n${countsText(counts)}`,
        tags: [kind === 'removed' ? 'wastebasket' : entry.status === 'coming' ? 'white_check_mark' : entry.status === 'maybe' ? 'grey_question' : 'x'],
        actions,
      }),
    });
    if (!res.ok) console.error('ntfy alert failed:', res.status);
  })().catch((err) => console.error('ntfy alert failed:', err.message));
  ctx.waitUntil(send);
  return true;
}

// ── Organizer: remove a reply from the link in the alert ────
const escHtml = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

function page(title, body, status = 200) {
  const html = `<!doctype html><html lang="en-CA"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1"><meta name="robots" content="noindex">
<title>${escHtml(title)}</title>
<style>
  body{margin:0;padding:32px 20px;font:17px/1.5 system-ui,-apple-system,sans-serif;background:#f7f2e7;color:#183126}
  main{max-width:420px;margin:0 auto;background:#fffdf7;border:1px solid #d9cdb8;border-radius:20px;padding:24px}
  h1{margin:0 0 8px;font:700 22px/1.25 Georgia,serif;color:#173c2c} p{margin:8px 0}
  button{margin-top:16px;width:100%;min-height:50px;border:0;border-radius:14px;background:#b34d24;color:#fff;font:700 16px system-ui,sans-serif}
  @media (prefers-color-scheme:dark){body{background:#101813;color:#f4f0e6}main{background:#17221b;border-color:#36483c}h1{color:#f4f0e6}}
</style></head><body><main>${body}</main></body></html>`;
  return new Response(html, {
    status,
    headers: {
      'Content-Type': 'text/html; charset=utf-8',
      'Cache-Control': 'no-store',
      'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'",
      'Referrer-Policy': 'no-referrer',
      'X-Robots-Tag': 'noindex',
    },
  });
}

async function removePage(request, env) {
  let id, sig;
  if (request.method === 'POST') {
    const form = await request.formData().catch(() => null);
    id = form?.get('e');
    sig = form?.get('s');
  } else if (request.method === 'GET') {
    const url = new URL(request.url);
    id = url.searchParams.get('e');
    sig = url.searchParams.get('s');
  } else {
    return page('Not allowed', '<h1>Not allowed</h1>', 405);
  }
  if (!(await checkRemoval(env, String(id || ''), String(sig || '')))) {
    return page('Link not valid', '<h1>This link isn\'t valid</h1><p>Use the Remove link in the RSVP alert.</p>', 403);
  }
  const db = store(env);
  const row = await db.getById(id);
  if (!row) return page('Already removed', '<h1>Already removed</h1><p>This reply isn\'t on the list anymore.</p>');
  const hike = findHike(row.hike_id);
  const what = `<p><b>${escHtml(row.name)}</b>: ${escHtml(replyText(row))}</p><p>${escHtml(hike ? `${hike.dateShort}, ${hike.shortName}` : row.hike_id)}</p>`;

  // GET only shows the question, so link previews can't remove anything.
  if (request.method === 'GET') {
    return page('Remove this reply?', `<h1>Remove this reply?</h1>${what}
<form method="post" action="/remove"><input type="hidden" name="e" value="${escHtml(id)}"><input type="hidden" name="s" value="${escHtml(sig)}"><button type="submit">Remove it</button></form>`);
  }
  await db.removeById(id);
  return page('Removed', `<h1>Removed</h1>${what}<p>It's gone from everyone's list.</p>`);
}

// ── The Worker ──────────────────────────────────────────────
export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const path = url.pathname.replace(/\/+$/, '') || '/';

    if (path === '/remove') return removePage(request, env);

    // Health check: no data, open to anyone
    if (request.method === 'GET' && path === '/') {
      return json({ ok: true, service: 'fall-hike-rsvp', storageConfigured: Boolean(env.RSVPS), alertsConfigured: Boolean(env.NTFY_TOPIC), removeLinks: Boolean(env.ADMIN_SECRET) }, 200);
    }

    // CORS: only the app's own site gets in.
    const origin = request.headers.get('Origin');
    if (!origin || !allowedOrigins(env).includes(origin)) return json({ error: 'Origin not allowed' }, 403);
    const cors = corsHeaders(origin);
    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });
    if (!env.RSVPS) return json({ error: 'RSVP storage is not set up' }, 500, cors);

    const m = /^\/rsvps(?:\/([a-z0-9_-]{1,60}))?$/.exec(path);
    if (!m) return json({ error: 'Not found' }, 404, cors);
    const hikeId = m[1] ? RENAMED[m[1]] || m[1] : null;

    const device = request.headers.get('X-Device') || '';
    if (!/^[A-Za-z0-9_-]{16,64}$/.test(device)) return json({ error: 'Missing or invalid X-Device header' }, 400, cors);
    const deviceHash = await sha256hex(device);
    const db = store(env);

    // Read the lists
    if (request.method === 'GET') {
      if (await limited(env.READ_LIMITER, request)) return json({ error: 'Too many requests. Wait a minute.' }, 429, { ...cors, 'Retry-After': '60' });
      if (hikeId) {
        const hike = findHike(hikeId);
        if (!hike) return json({ error: 'Unknown hike' }, 404, cors);
        return json({ hike: hikeId, list: await db.list(deviceHash, hikeId), now: Date.now() }, 200, cors);
      }
      return json({ hikes: await db.list(deviceHash), now: Date.now() }, 200, cors);
    }

    if (request.method !== 'PUT' && request.method !== 'DELETE') {
      return json({ error: 'Method not allowed' }, 405, { ...cors, Allow: 'GET, PUT, DELETE, OPTIONS' });
    }
    if (!hikeId) return json({ error: 'Say which hike: /rsvps/<hikeId>' }, 400, cors);
    const hike = findHike(hikeId);
    if (!hike) return json({ error: 'Unknown hike' }, 404, cors);
    if (await limited(env.WRITE_LIMITER, request)) return json({ error: 'Too many changes. Wait a minute and try again.' }, 429, { ...cors, 'Retry-After': '60' });
    if (hikeOver(hike)) return json({ error: 'hike_over', message: 'This hike is over, so replies are closed.' }, 409, cors);

    // Remove my reply
    if (request.method === 'DELETE') {
      const out = await db.remove(hikeId, deviceHash);
      const alerted = out.removed ? alertOrganizer(env, ctx, request, hike, 'removed', out.removed, out.counts) : false;
      return json({ ok: true, removed: Boolean(out.removed), list: out.list, counts: out.counts, alerted }, 200, cors);
    }

    // Save or update my reply
    const raw = await request.text();
    if (raw.length > MAX_BODY_CHARS) return json({ error: 'Request too large' }, 413, cors);
    let body;
    try {
      body = JSON.parse(raw);
    } catch {
      return json({ error: 'Send JSON' }, 400, cors);
    }
    if (!body || typeof body !== 'object') return json({ error: 'Send JSON' }, 400, cors);
    const { reply, error } = readReply(body);
    if (error) return json({ error }, 400, cors);

    const out = await db.put(hikeId, deviceHash, reply, body.claim === true);
    if (out.conflict) return json({ error: 'name_taken', name: out.conflict.name, existing: out.conflict }, 409, cors);
    if (out.full) return json({ error: 'list_full', message: 'This hike\'s list is full.' }, 409, cors);
    const alerted = out.change === 'same' ? false : alertOrganizer(env, ctx, request, hike, out.change, out.entry, out.counts);
    return json({ ok: true, change: out.change, list: out.list, counts: out.counts, alerted }, 200, cors);
  },
};
