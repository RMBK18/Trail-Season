// ─────────────────────────────────────────────────────────────
// Fall Hike App: shared RSVPs, "Who's coming" (Cloudflare Worker)
//
// Friends tap Coming / Maybe / Can't make it on a hike page. Replies are kept
// in one Durable Object (a small SQLite database inside Cloudflare, free plan),
// so every phone sees the same list. The organizer gets an ntfy push alert for
// each reply, with a link to remove junk entries.
//
// Carpool: drivers and riders add the area they leave from and, if they like,
// a WhatsApp number. A rider can save a seat with a driver ("Ride with"); the
// seats left count down by themselves. A driver who turned on alerts gets one
// phone notification per rider who saves a seat with them, and nothing else.
//
//   GET    /                 health check (no data)
//   GET    /rsvps            every hike's list          header X-Device
//   PUT    /rsvps/:hikeId    save or update my reply    header X-Device, JSON body
//   DELETE /rsvps/:hikeId    remove my reply            header X-Device
//   PUT    /rides/:hikeId    save a seat: { driver }    header X-Device
//   DELETE /rides/:hikeId    cancel my seat             header X-Device
//   PUT    /push/:hikeId     driver: turn on ride alerts (a PushSubscription)  header X-Device
//   DELETE /push/:hikeId     driver: turn them off      header X-Device
//   GET    /remove?e=&s=     organizer: confirm page for removing a reply (signed link from the alert)
//   POST   /remove           organizer: remove it
//
// Who is who: each phone makes a random id (X-Device) and keeps it. The Worker
// stores only its SHA-256 hash and never sends it back, so nobody can change
// someone else's reply. If a second phone uses a name that already replied,
// the app asks "Is that you?" before taking that reply over (claim: true).
//
// Replies, numbers, areas, seats and alert sign-ups are deleted automatically
// 7 days after each hike. Phone numbers never go into alerts or logs.
// ─────────────────────────────────────────────────────────────

import { DurableObject } from 'cloudflare:workers';
// The same files the app uses, bundled in at deploy time.
import { HIKES } from '../../../js/data.js';
import { endMs } from '../../../js/lib.js';
import { findArea, normalizePhone, MAX_AREA_CHARS } from '../../../js/carpool.js';
import { sendPush, subscriptionKeysOk, b64url, fromB64url } from './webpush.js';

const STATUSES = ['coming', 'maybe', 'cant'];
const LABELS = { coming: 'Coming', maybe: 'Maybe', cant: "Can't make it" };
const CARPOOL = ['', 'driving', 'need-ride'];
const MAX_NAME_CHARS = 40;
const MAX_GUESTS = 5;
const MAX_SEATS = 6;
const MAX_PER_HIKE = 100;
const MAX_BODY_CHARS = 2000;
const MAX_ENDPOINT_CHARS = 1000;
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

// The area someone drives from or needs a ride from: one of the list, or a few typed words ("Other").
function readArea(raw) {
  const a = cleanName(raw);
  if (!a) return '';
  const known = findArea(a);
  if (known) return known.name;
  return [...a].length > MAX_AREA_CHARS ? null : a;
}

// Area and phone only apply to drivers and riders. A field that isn't sent keeps
// what was saved, so phones still on an older app version don't wipe them.
const usesRides = (r) => r.status !== 'cant' && (r.carpool === 'driving' || r.carpool === 'need-ride');
const isDriver = (r) => r.status === 'coming' && r.carpool === 'driving';
const isRider = (r) => r.status === 'coming' && r.carpool === 'need-ride';

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
  const reply = { name, key: nameKey(name), status: body.status, guests, carpool, seats };
  const rides = usesRides(reply);
  if (body.area !== undefined) {
    reply.area = rides ? readArea(body.area) : '';
    if (reply.area === null) return { error: `Area is too long (max ${MAX_AREA_CHARS} characters)` };
  }
  if (body.phone !== undefined) {
    reply.phone = rides ? normalizePhone(body.phone) : '';
    if (reply.phone === null) return { error: 'That WhatsApp number doesn\'t look right. Use 10 digits, like 416 555 0123, or + and the country code.' };
  }
  return { reply };
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
// What every phone sees. Numbers are sent only for the Message button; the
// phone id (device hash) and row ids never leave the Worker.
function publicEntry(row, deviceHash, rides) {
  const e = {
    name: row.name,
    status: row.status,
    guests: row.guests,
    carpool: row.carpool,
    seats: row.seats,
    updatedAt: row.updated_at,
    mine: row.device === deviceHash,
  };
  if (usesRides(row)) {
    e.area = row.area;
    if (row.phone) e.phone = row.phone;
  }
  if (isDriver(row)) e.seatsLeft = Math.max(0, row.seats - (rides.taken.get(row.id) || 0));
  const driver = rides.driverOf.get(row.id);
  if (driver) e.ride = driver.name;
  if (e.mine) {
    e.alerts = rides.alerts.has(row.id);
    if (row.lost_ride) e.lostRide = row.lost_ride;
  }
  return e;
}

const sameReply = (row, r) =>
  row.name === r.name && row.status === r.status && row.guests === r.guests && row.carpool === r.carpool && row.seats === r.seats
  && row.area === r.area && row.phone === r.phone;

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
    // Carpool columns, added to databases made before carpooling existed.
    // phone: WhatsApp number with country code, digits only; '' = not shared.
    // lost_ride: the driver who stopped driving, so the rider sees why their seat went.
    const cols = new Set(this.sql.exec('PRAGMA table_info(rsvps)').toArray().map((c) => c.name));
    for (const col of ['area', 'phone', 'lost_ride']) {
      if (!cols.has(col)) this.sql.exec(`ALTER TABLE rsvps ADD COLUMN ${col} TEXT NOT NULL DEFAULT ''`);
    }
    // A rider holds one seat at a time; seats left = driver's seats − riders (and their guests).
    this.sql.exec(`CREATE TABLE IF NOT EXISTS ride_requests (
      hike_id    TEXT NOT NULL,
      driver_id  TEXT NOT NULL,
      rider_id   TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      PRIMARY KEY (hike_id, rider_id)
    )`);
    // Who already alerted which driver: one notification per rider and driver, ever.
    this.sql.exec(`CREATE TABLE IF NOT EXISTS ride_pings (
      hike_id   TEXT NOT NULL,
      driver_id TEXT NOT NULL,
      rider_id  TEXT NOT NULL,
      PRIMARY KEY (hike_id, driver_id, rider_id)
    )`);
    // Drivers' ride alerts: the phone's PushSubscription, one per reply.
    this.sql.exec(`CREATE TABLE IF NOT EXISTS push_subs (
      rsvp_id    TEXT PRIMARY KEY,
      hike_id    TEXT NOT NULL,
      endpoint   TEXT NOT NULL,
      p256dh     TEXT NOT NULL,
      auth       TEXT NOT NULL,
      created_at INTEGER NOT NULL
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

  myRow(hikeId, deviceHash) {
    return this.sql.exec('SELECT * FROM rsvps WHERE hike_id = ? AND device = ?', hikeId, deviceHash).toArray()[0] || null;
  }

  // Who rides with whom, seats taken per driver, and which replies have alerts on.
  rideState(hikeId, rows) {
    const byId = new Map(rows.map((r) => [r.id, r]));
    const driverOf = new Map();
    const taken = new Map();
    for (const q of this.sql.exec('SELECT driver_id, rider_id FROM ride_requests WHERE hike_id = ?', hikeId)) {
      const driver = byId.get(q.driver_id);
      const rider = byId.get(q.rider_id);
      if (!driver || !rider) continue;
      driverOf.set(rider.id, driver);
      taken.set(driver.id, (taken.get(driver.id) || 0) + 1 + rider.guests);
    }
    const alerts = new Set(this.sql.exec('SELECT rsvp_id FROM push_subs WHERE hike_id = ?', hikeId).toArray().map((r) => r.rsvp_id));
    return { driverOf, taken, alerts };
  }

  list(deviceHash, hikeId = null) {
    const one = (id) => {
      const rows = this.rows(id);
      const rides = this.rideState(id, rows);
      return rows.map((r) => publicEntry(r, deviceHash, rides));
    };
    if (hikeId) return one(hikeId);
    const out = Object.fromEntries(HIKES.map((h) => [h.id, one(h.id)]));
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

  // Seats taken in a driver's car: each rider plus the people with them.
  seatsTaken(driverId, exceptRiderId = '') {
    return this.sql.exec(
      `SELECT COALESCE(SUM(1 + r.guests), 0) AS n FROM ride_requests q JOIN rsvps r ON r.id = q.rider_id
       WHERE q.driver_id = ? AND q.rider_id != ?`,
      driverId, exceptRiderId,
    ).one().n;
  }

  seatOf(riderId) {
    return this.sql.exec('SELECT * FROM ride_requests WHERE rider_id = ?', riderId).toArray()[0] || null;
  }

  // A driver who stops driving: their riders lose their seats and are told why.
  releaseRiders(driver) {
    this.sql.exec(
      'UPDATE rsvps SET lost_ride = ? WHERE id IN (SELECT rider_id FROM ride_requests WHERE driver_id = ?)',
      driver.name, driver.id,
    );
    this.sql.exec('DELETE FROM ride_requests WHERE driver_id = ?', driver.id);
  }

  // After a reply changes: drop whatever no longer applies to it.
  settleRides(row) {
    if (!isDriver(row)) {
      this.releaseRiders(row);
      this.sql.exec('DELETE FROM push_subs WHERE rsvp_id = ?', row.id);
    }
    if (!isRider(row)) this.sql.exec('DELETE FROM ride_requests WHERE rider_id = ?', row.id);
  }

  // A reply that's going away entirely.
  forgetRow(row) {
    this.releaseRiders(row);
    this.sql.exec('DELETE FROM ride_requests WHERE rider_id = ?', row.id);
    this.sql.exec('DELETE FROM ride_pings WHERE driver_id = ? OR rider_id = ?', row.id, row.id);
    this.sql.exec('DELETE FROM push_subs WHERE rsvp_id = ?', row.id);
    this.sql.exec('DELETE FROM rsvps WHERE id = ?', row.id);
  }

  // Save or update this phone's reply. Returns { conflict } when another phone
  // already replied with the same name and the caller hasn't confirmed it's them.
  async put(hikeId, deviceHash, reply, claim) {
    const now = Date.now();
    const mine = this.myRow(hikeId, deviceHash);
    const twin = this.sql.exec('SELECT * FROM rsvps WHERE hike_id = ? AND name_key = ? AND device != ?', hikeId, reply.key, deviceHash).toArray()[0];
    if (twin && !claim) {
      return { conflict: { name: twin.name, status: twin.status, guests: twin.guests, carpool: twin.carpool, seats: twin.seats, area: twin.area } };
    }

    if (!mine && !twin) {
      const cap = hikeId === SELFTEST ? SELFTEST_MAX : MAX_PER_HIKE;
      const n = this.sql.exec('SELECT COUNT(*) AS n FROM rsvps WHERE hike_id = ?', hikeId).one().n;
      if (n >= cap) return { full: true };
    }

    // Taking over the same-name reply from another phone: keep its id, move it to this phone.
    const before = twin || mine || null;
    const rides = usesRides(reply);
    const r = {
      ...reply,
      area: !rides ? '' : reply.area ?? before?.area ?? '',
      phone: !rides ? '' : reply.phone ?? before?.phone ?? '',
    };
    if (mine && !twin && sameReply(mine, r)) {
      return { change: 'same', entry: mine, list: this.list(deviceHash, hikeId), counts: this.counts(hikeId) };
    }

    // Seats already promised can't disappear by accident.
    if (before) {
      if (isDriver(r) && isDriver(before)) {
        const taken = this.seatsTaken(before.id);
        if (r.seats < taken) return { seatsTaken: taken };
      }
      const seat = isRider(r) && this.seatOf(before.id);
      if (seat) {
        const driver = this.sql.exec('SELECT * FROM rsvps WHERE id = ?', seat.driver_id).one();
        const left = driver.seats - this.seatsTaken(driver.id, before.id);
        if (1 + r.guests > left) return { carFull: { driver: driver.name, left } };
      }
    }

    if (twin) {
      this.sql.exec('DELETE FROM rsvps WHERE id = ?', twin.id);
      // Ride alerts belonged to the other phone.
      this.sql.exec('DELETE FROM push_subs WHERE rsvp_id = ?', twin.id);
      if (mine) this.forgetRow(mine);
    }
    const id = twin?.id || mine?.id || randomId();
    this.sql.exec(
      `INSERT INTO rsvps (id, hike_id, device, name, name_key, status, guests, carpool, seats, area, phone, lost_ride, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, '', ?)
       ON CONFLICT (hike_id, device) DO UPDATE SET
         name = excluded.name, name_key = excluded.name_key, status = excluded.status, guests = excluded.guests,
         carpool = excluded.carpool, seats = excluded.seats, area = excluded.area, phone = excluded.phone,
         lost_ride = '', updated_at = excluded.updated_at`,
      id, hikeId, deviceHash, r.name, r.key, r.status, r.guests, r.carpool, r.seats, r.area, r.phone, now,
    );
    const entry = this.myRow(hikeId, deviceHash);
    this.settleRides(entry);
    await this.scheduleCleanup();
    // Moving an unchanged reply to another phone isn't news, so it sends no alert.
    const change = !before ? 'new' : sameReply(before, r) ? 'same' : 'changed';
    return { change, before, entry, list: this.list(deviceHash, hikeId), counts: this.counts(hikeId) };
  }

  remove(hikeId, deviceHash) {
    const row = this.myRow(hikeId, deviceHash);
    if (row) this.forgetRow(row);
    return { removed: row || null, list: this.list(deviceHash, hikeId), counts: this.counts(hikeId) };
  }

  getById(id) {
    return this.sql.exec('SELECT * FROM rsvps WHERE id = ?', id).toArray()[0] || null;
  }

  removeById(id) {
    const row = this.getById(id);
    if (row) this.forgetRow(row);
    return { removed: row, counts: row ? this.counts(row.hike_id) : null };
  }

  // ── Seats ──
  // Save a seat with a driver (or move it to another driver). Returns { error }
  // or { change: 'new' | 'switched' | 'same', list, alert }. `alert` is the
  // driver's push subscription when this rider hasn't alerted them before.
  requestSeat(hikeId, deviceHash, driverName) {
    const me = this.myRow(hikeId, deviceHash);
    if (!me) return { error: 'no_reply' };
    if (!isRider(me)) return { error: 'not_rider' };
    const driver = this.sql.exec('SELECT * FROM rsvps WHERE hike_id = ? AND name_key = ?', hikeId, nameKey(cleanName(driverName))).toArray()[0];
    if (!driver) return { error: 'no_driver' };
    if (driver.id === me.id) return { error: 'own_car' };
    if (!isDriver(driver)) return { error: 'not_driving', driver: driver.name };

    const seat = this.seatOf(me.id);
    const from = seat && seat.driver_id !== driver.id ? this.getById(seat.driver_id)?.name || '' : '';
    const change = !seat ? 'new' : from ? 'switched' : 'same';
    let alert = null;
    if (change !== 'same') {
      const left = driver.seats - this.seatsTaken(driver.id, me.id);
      if (1 + me.guests > left) return { error: 'car_full', driver: driver.name, left: Math.max(0, left), need: 1 + me.guests };
      this.sql.exec(
        `INSERT INTO ride_requests (hike_id, driver_id, rider_id, created_at) VALUES (?, ?, ?, ?)
         ON CONFLICT (hike_id, rider_id) DO UPDATE SET driver_id = excluded.driver_id, created_at = excluded.created_at`,
        hikeId, driver.id, me.id, Date.now(),
      );
      const pinged = this.sql.exec('SELECT 1 FROM ride_pings WHERE driver_id = ? AND rider_id = ?', driver.id, me.id).toArray().length;
      if (!pinged) {
        this.sql.exec('INSERT INTO ride_pings (hike_id, driver_id, rider_id) VALUES (?, ?, ?)', hikeId, driver.id, me.id);
        const sub = this.sql.exec('SELECT endpoint, p256dh, auth FROM push_subs WHERE rsvp_id = ?', driver.id).toArray()[0];
        if (sub) alert = { sub: { ...sub }, driverId: driver.id, rider: me.name, area: me.area };
      }
    }
    this.sql.exec("UPDATE rsvps SET lost_ride = '' WHERE id = ?", me.id);
    return { change, from, driver: driver.name, list: this.list(deviceHash, hikeId), alert };
  }

  cancelSeat(hikeId, deviceHash) {
    const me = this.myRow(hikeId, deviceHash);
    let cancelled = false;
    if (me) {
      cancelled = Boolean(this.seatOf(me.id));
      this.sql.exec('DELETE FROM ride_requests WHERE rider_id = ?', me.id);
      this.sql.exec("UPDATE rsvps SET lost_ride = '' WHERE id = ?", me.id);
    }
    return { cancelled, list: this.list(deviceHash, hikeId) };
  }

  // ── Ride alerts (drivers only) ──
  setAlerts(hikeId, deviceHash, sub) {
    const me = this.myRow(hikeId, deviceHash);
    if (!me) return { error: 'no_reply' };
    if (sub) {
      if (!isDriver(me)) return { error: 'not_driver' };
      this.sql.exec(
        `INSERT INTO push_subs (rsvp_id, hike_id, endpoint, p256dh, auth, created_at) VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT (rsvp_id) DO UPDATE SET endpoint = excluded.endpoint, p256dh = excluded.p256dh, auth = excluded.auth, created_at = excluded.created_at`,
        me.id, hikeId, sub.endpoint, sub.p256dh, sub.auth, Date.now(),
      );
    } else {
      this.sql.exec('DELETE FROM push_subs WHERE rsvp_id = ?', me.id);
    }
    return { list: this.list(deviceHash, hikeId) };
  }

  // The push service said this phone unsubscribed (404/410).
  dropAlerts(rsvpId, endpoint) {
    this.sql.exec('DELETE FROM push_subs WHERE rsvp_id = ? AND endpoint = ?', rsvpId, endpoint);
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
    // Seats, alert history and alert sign-ups go with the replies they belong to.
    this.sql.exec('DELETE FROM ride_requests WHERE driver_id NOT IN (SELECT id FROM rsvps) OR rider_id NOT IN (SELECT id FROM rsvps)');
    this.sql.exec('DELETE FROM ride_pings WHERE driver_id NOT IN (SELECT id FROM rsvps) OR rider_id NOT IN (SELECT id FROM rsvps)');
    this.sql.exec('DELETE FROM push_subs WHERE rsvp_id NOT IN (SELECT id FROM rsvps)');
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

// ── Ride alerts for drivers (Web Push) ──────────────────────
// The only notification anyone in the group can get. Only push services' own
// addresses are accepted, so the Worker can't be used to call other sites.
const PUSH_HOSTS = [/^fcm\.googleapis\.com$/, /^android\.googleapis\.com$/, /^web\.push\.apple\.com$/, /\.push\.services\.mozilla\.com$/, /\.notify\.windows\.com$/];

function pushEndpointOk(endpoint, env) {
  if (typeof endpoint !== 'string' || endpoint.length > MAX_ENDPOINT_CHARS) return false;
  let u;
  try { u = new URL(endpoint); } catch { return false; }
  // Local testing only: a mock push service on this computer.
  if (env.ALLOW_HTTP_PUSH === '1' && u.protocol === 'http:' && ['localhost', '127.0.0.1'].includes(u.hostname)) return true;
  return u.protocol === 'https:' && !u.port && !u.username && PUSH_HOSTS.some((re) => re.test(u.hostname));
}

const pushReady = (env) => Boolean(env.VAPID_PUBLIC_KEY && env.VAPID_PRIVATE_KEY);

// "🚗 Sara (Downtown) wants a ride with you" → opens the hike's rides list.
function alertDriver(env, ctx, db, hike, alert) {
  if (!pushReady(env)) return false;
  // The test hike only alerts a local mock push service.
  if (hike.id === SELFTEST && env.ALLOW_HTTP_PUSH !== '1') return false;
  const message = {
    title: `🚗 ${alert.rider}${alert.area ? ` (${alert.area})` : ''} wants a ride with you`,
    body: `to ${hike.shortName} on ${hike.dateShort}. Tap to see the request and message ${alert.rider}.`,
    url: `#/hike/${hike.id}/rides`,
    tag: `ride-${hike.id}`,
  };
  const vapid = { publicKey: env.VAPID_PUBLIC_KEY, privateKey: env.VAPID_PRIVATE_KEY, subject: env.APP_URL || 'https://fallhike.pages.dev/' };
  const send = sendPush(alert.sub, message, vapid)
    .then(async (status) => {
      if (status === 404 || status === 410) await db.dropAlerts(alert.driverId, alert.sub.endpoint); // phone unsubscribed
      else if (status >= 400) console.error('Ride alert failed:', status);
    })
    .catch((err) => console.error('Ride alert failed:', err.message));
  ctx.waitUntil(send);
  return true;
}

// ── What the app shows when a carpool change can't be made ──
const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;
const SEAT_ERRORS = {
  no_reply: () => [409, 'Reply Coming first, then save a seat.'],
  not_rider: () => [409, 'Pick Coming and Need a ride first, then save a seat.'],
  no_driver: () => [404, 'That driver isn\'t on the list anymore.'],
  own_car: () => [400, 'That\'s your own car.'],
  not_driving: (o) => [409, `${o.driver} isn't driving anymore.`],
  car_full: (o) => [409, o.left <= 0 ? `${o.driver}'s car is full.`
    : `${o.driver}'s car has room for ${plural(o.left, 'more person', 'more people')}, and you need ${plural(o.need, 'seat', 'seats')}.`],
  not_driver: () => [409, 'Ride alerts are for drivers. Pick Coming and I can drive first.'],
};
const seatError = (out, cors) => {
  const [status, message] = SEAT_ERRORS[out.error](out);
  const { list, alert, ...detail } = out;
  return json({ ...detail, message }, status, cors);
};

async function readJson(request) {
  const raw = await request.text();
  if (raw.length > MAX_BODY_CHARS) return { status: 413, error: 'Request too large' };
  try {
    const body = JSON.parse(raw);
    return body && typeof body === 'object' && !Array.isArray(body) ? { body } : { status: 400, error: 'Send JSON' };
  } catch {
    return { status: 400, error: 'Send JSON' };
  }
}

// ── The Worker ──────────────────────────────────────────────
export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const path = url.pathname.replace(/\/+$/, '') || '/';

    if (path === '/remove') return removePage(request, env);

    // Health check: no data, open to anyone
    if (request.method === 'GET' && path === '/') {
      return json({
        ok: true, service: 'fall-hike-rsvp', storageConfigured: Boolean(env.RSVPS), alertsConfigured: Boolean(env.NTFY_TOPIC),
        removeLinks: Boolean(env.ADMIN_SECRET), rideAlerts: pushReady(env),
      }, 200);
    }

    // CORS: only the app's own site gets in.
    const origin = request.headers.get('Origin');
    if (!origin || !allowedOrigins(env).includes(origin)) return json({ error: 'Origin not allowed' }, 403);
    const cors = corsHeaders(origin);
    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });
    if (!env.RSVPS) return json({ error: 'RSVP storage is not set up' }, 500, cors);

    const m = /^\/(rsvps|rides|push)(?:\/([a-z0-9_-]{1,60}))?$/.exec(path);
    if (!m) return json({ error: 'Not found' }, 404, cors);
    const what = m[1];
    const hikeId = m[2] ? RENAMED[m[2]] || m[2] : null;

    const device = request.headers.get('X-Device') || '';
    if (!/^[A-Za-z0-9_-]{16,64}$/.test(device)) return json({ error: 'Missing or invalid X-Device header' }, 400, cors);
    const deviceHash = await sha256hex(device);
    const db = store(env);

    // Read the lists
    if (request.method === 'GET') {
      if (what !== 'rsvps') return json({ error: 'Method not allowed' }, 405, { ...cors, Allow: 'PUT, DELETE, OPTIONS' });
      if (await limited(env.READ_LIMITER, request)) return json({ error: 'Too many requests. Wait a minute.' }, 429, { ...cors, 'Retry-After': '60' });
      if (hikeId) {
        const hike = findHike(hikeId);
        if (!hike) return json({ error: 'Unknown hike' }, 404, cors);
        return json({ hike: hikeId, list: await db.list(deviceHash, hikeId), now: Date.now() }, 200, cors);
      }
      // pushKey: the app needs it to turn on ride alerts (null = alerts not set up)
      return json({ hikes: await db.list(deviceHash), now: Date.now(), pushKey: pushReady(env) ? env.VAPID_PUBLIC_KEY : null }, 200, cors);
    }

    if (request.method !== 'PUT' && request.method !== 'DELETE') {
      return json({ error: 'Method not allowed' }, 405, { ...cors, Allow: 'GET, PUT, DELETE, OPTIONS' });
    }
    if (!hikeId) return json({ error: `Say which hike: /${what}/<hikeId>` }, 400, cors);
    const hike = findHike(hikeId);
    if (!hike) return json({ error: 'Unknown hike' }, 404, cors);
    if (await limited(env.WRITE_LIMITER, request)) return json({ error: 'Too many changes. Wait a minute and try again.' }, 429, { ...cors, 'Retry-After': '60' });
    if (hikeOver(hike)) return json({ error: 'hike_over', message: 'This hike is over, so replies are closed.' }, 409, cors);

    // ── Seats ──
    if (what === 'rides') {
      if (request.method === 'DELETE') {
        const out = await db.cancelSeat(hikeId, deviceHash);
        return json({ ok: true, cancelled: out.cancelled, list: out.list }, 200, cors);
      }
      const { body, status, error } = await readJson(request);
      if (!body) return json({ error }, status, cors);
      if (typeof body.driver !== 'string' || !body.driver.trim()) return json({ error: 'Say which driver: { "driver": "<name>" }' }, 400, cors);
      const out = await db.requestSeat(hikeId, deviceHash, body.driver);
      if (out.error) return seatError(out, cors);
      const driverAlerted = out.alert ? alertDriver(env, ctx, db, hike, out.alert) : false;
      return json({ ok: true, change: out.change, driver: out.driver, from: out.from || undefined, driverAlerted, list: out.list }, 200, cors);
    }

    // ── Ride alerts ──
    if (what === 'push') {
      if (request.method === 'DELETE') return json({ ok: true, ...(await db.setAlerts(hikeId, deviceHash, null)) }, 200, cors);
      if (!pushReady(env)) return json({ error: 'alerts_off', message: 'Ride alerts aren\'t set up yet.' }, 503, cors);
      const { body, status, error } = await readJson(request);
      if (!body) return json({ error }, status, cors);
      const sub = { endpoint: body.endpoint, p256dh: body.keys?.p256dh, auth: body.keys?.auth };
      if (!pushEndpointOk(sub.endpoint, env) || !subscriptionKeysOk(sub.p256dh, sub.auth)) {
        return json({ error: 'This phone\'s notification details didn\'t look right. Try turning alerts on again.' }, 400, cors);
      }
      const out = await db.setAlerts(hikeId, deviceHash, sub);
      if (out.error) return seatError(out, cors);
      return json({ ok: true, list: out.list }, 200, cors);
    }

    // Remove my reply
    if (request.method === 'DELETE') {
      const out = await db.remove(hikeId, deviceHash);
      const alerted = out.removed ? alertOrganizer(env, ctx, request, hike, 'removed', out.removed, out.counts) : false;
      return json({ ok: true, removed: Boolean(out.removed), list: out.list, counts: out.counts, alerted }, 200, cors);
    }

    // Save or update my reply
    const { body, status, error: badBody } = await readJson(request);
    if (!body) return json({ error: badBody }, status, cors);
    const { reply, error } = readReply(body);
    if (error) return json({ error }, 400, cors);

    const out = await db.put(hikeId, deviceHash, reply, body.claim === true);
    if (out.conflict) return json({ error: 'name_taken', name: out.conflict.name, existing: out.conflict }, 409, cors);
    if (out.full) return json({ error: 'list_full', message: 'This hike\'s list is full.' }, 409, cors);
    if (out.seatsTaken) {
      return json({
        error: 'seats_taken', taken: out.seatsTaken,
        message: `${plural(out.seatsTaken, 'seat is', 'seats are')} taken in your car, so you can't offer fewer than ${out.seatsTaken}. Riders can cancel their own seat.`,
      }, 409, cors);
    }
    if (out.carFull) {
      const { driver, left } = out.carFull;
      return json({
        error: 'car_full', driver, left,
        message: left <= 1 ? `${driver}'s car only has room for you, not people with you. Cancel your seat first, or check with ${driver}.`
          : `${driver}'s car only has room for you and ${plural(left - 1, 'more person', 'more people')}. Cancel your seat first, or check with ${driver}.`,
      }, 409, cors);
    }
    const alerted = out.change === 'same' ? false : alertOrganizer(env, ctx, request, hike, out.change, out.entry, out.counts);
    return json({ ok: true, change: out.change, list: out.list, counts: out.counts, alerted }, 200, cors);
  },
};
