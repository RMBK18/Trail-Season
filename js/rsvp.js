// ═════════════════════════════════════════════════════════════
// SHARED RSVP ("Who's coming")
// ═════════════════════════════════════════════════════════════
//
// Replies live in the RSVP Worker (phase2/rsvp-worker/), so every phone sees
// the same list. Off when CONFIG.rsvpEndpoint is null: the app then offers the
// copy-a-reply-for-the-group-chat fallback instead.
//
// On this phone (localStorage):
//   fh:device       a random id for this phone. The Worker keeps only its hash,
//                   so only this phone can change its own replies.
//   fh:rsvps        the last lists seen, so the page works with no signal
//   fh:rsvp-outbox  replies made with no signal; sent when the phone is back online
// ═════════════════════════════════════════════════════════════

import { CONFIG } from './config.js';

export const RSVP_STATUSES = /** @type {const} */ (['coming', 'maybe', 'cant']);
export const RSVP_LABELS = { coming: 'Coming', maybe: 'Maybe', cant: "Can't make it" };
export const MAX_GUESTS = 5;
export const MAX_SEATS = 6;

const POLL_MS = 30_000;
const TIMEOUT_MS = 10_000;
const CACHE_KEY = 'fh:rsvps';
const OUTBOX_KEY = 'fh:rsvp-outbox';
const DEVICE_KEY = 'fh:device';

export const isRsvpLive = () => Boolean(CONFIG.rsvpEndpoint);
const base = () => String(CONFIG.rsvpEndpoint || '').replace(/\/+$/, '');

const read = (k, fallback) => {
  try { const v = localStorage.getItem(k); return v == null ? fallback : JSON.parse(v); } catch { return fallback; }
};
const write = (k, v) => {
  try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* private mode: the list just isn't kept */ }
};

// ── This phone's id ─────────────────────────────────────────
let memoryDevice = '';
export function deviceId() {
  let id = read(DEVICE_KEY, '');
  if (!/^[A-Za-z0-9_-]{16,64}$/.test(id)) {
    id = memoryDevice || (crypto.randomUUID ? crypto.randomUUID()
      : [...crypto.getRandomValues(new Uint8Array(16))].map((b) => b.toString(16).padStart(2, '0')).join(''));
    memoryDevice = id; // survives the session even if storage is blocked
    write(DEVICE_KEY, id);
  }
  return id;
}

// ── Talking to the Worker ───────────────────────────────────
export class RsvpError extends Error {
  constructor(message, code, data = {}) {
    super(message);
    this.code = code;
    this.data = data;
  }
}

// No signal, a timeout, "too many requests" or a server hiccup: worth trying again later.
const retryable = (err) => err.code === 'network' || err.code === 'http_429' || /^http_5/.test(err.code);

async function request(method, path, body) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  let res;
  try {
    res = await fetch(base() + path, {
      method,
      headers: { 'X-Device': deviceId(), ...(body ? { 'Content-Type': 'application/json' } : {}) },
      body: body ? JSON.stringify(body) : undefined,
      cache: 'no-store',
      signal: ctrl.signal,
    });
  } catch {
    throw new RsvpError('No signal right now.', 'network');
  } finally {
    clearTimeout(timer);
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    // The Worker sends either a code ("name_taken") with a message, or a sentence to show.
    const isCode = /^[a-z_]+$/.test(data.error || '');
    const code = isCode ? data.error : `http_${res.status}`;
    const message = data.message || (isCode ? '' : data.error) || `Something went wrong (${res.status}).`;
    throw new RsvpError(message, code, data);
  }
  return data;
}

// ── What this phone knows ───────────────────────────────────
// cache = { at: last full refresh (ms), hikes: { [hikeId]: entry[] } }
let cache = read(CACHE_KEY, null) || { at: 0, hikes: {} };
const listeners = new Set();
const problemListeners = new Set();
const emit = () => listeners.forEach((fn) => { try { fn(); } catch (err) { console.error(err); } });

/** Called whenever any list, or this phone's pending replies, change. Returns an unsubscribe function. */
export function onRsvpChange(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

/** Called when a reply made offline couldn't be sent later (e.g. the name was taken). */
export function onRsvpProblem(fn) {
  problemListeners.add(fn);
  return () => problemListeners.delete(fn);
}

function setHike(hikeId, list) {
  cache = { ...cache, hikes: { ...cache.hikes, [hikeId]: list } };
  write(CACHE_KEY, cache);
}

const outbox = () => read(OUTBOX_KEY, {}) || {};
const setOutbox = (box) => write(OUTBOX_KEY, box);
function queue(hikeId, item) {
  setOutbox({ ...outbox(), [hikeId]: { ...item, at: Date.now() } });
}
function unqueue(hikeId) {
  const box = outbox();
  delete box[hikeId];
  setOutbox(box);
}

/**
 * The list for one hike as this phone should show it: the last list seen,
 * with this phone's not-yet-sent reply (if any) put in place of its old one.
 * @returns {{ list: Array<{name:string,status:string,guests:number,carpool:string,seats:number,mine:boolean,pending?:boolean}>, at: number, pending: boolean }}
 */
export function listFor(hikeId) {
  let list = (cache.hikes[hikeId] || []).slice();
  const waiting = outbox()[hikeId];
  if (waiting) {
    list = list.filter((e) => !e.mine && !(waiting.claim && waiting.reply && e.name.toLocaleLowerCase() === waiting.reply.name.toLocaleLowerCase()));
    if (waiting.reply) list.push({ ...waiting.reply, updatedAt: waiting.at, mine: true, pending: true });
  }
  return { list, at: cache.at, pending: Boolean(waiting) };
}

export function countsFor(hikeId) {
  const c = { coming: 0, maybe: 0, cant: 0, people: 0 };
  for (const e of listFor(hikeId).list) {
    c[e.status] += 1;
    if (e.status === 'coming') c.people += 1 + (e.guests || 0);
  }
  return c;
}

export const myReply = (hikeId) => listFor(hikeId).list.find((e) => e.mine) || null;

// ── Refreshing ──────────────────────────────────────────────
let refreshing = null;
/** Fetch every hike's list (one request). Sends any waiting replies first. */
export function refreshAll() {
  if (!isRsvpLive()) return Promise.resolve();
  refreshing ||= (async () => {
    try {
      await flushOutbox();
      const data = await request('GET', '/rsvps');
      cache = { at: Date.now(), hikes: data.hikes || {} };
      write(CACHE_KEY, cache);
      emit();
    } finally {
      refreshing = null;
    }
  })();
  return refreshing;
}

let flushing = null;
function flushOutbox() {
  flushing ||= (async () => {
    try {
      for (const [hikeId, item] of Object.entries(outbox())) {
        try {
          const data = item.remove
            ? await request('DELETE', `/rsvps/${hikeId}`)
            : await request('PUT', `/rsvps/${hikeId}`, { ...item.reply, claim: Boolean(item.claim) });
          unqueue(hikeId);
          setHike(hikeId, data.list);
        } catch (err) {
          if (retryable(err)) break; // still no signal: try again later
          unqueue(hikeId); // can't ever succeed as it is: tell the person
          problemListeners.forEach((fn) => fn({ hikeId, error: err, reply: item.reply }));
        }
      }
    } finally {
      flushing = null;
      emit();
    }
  })();
  return flushing;
}

/**
 * Keep one hike's list fresh while its page is open: shows the saved list at once,
 * then refreshes now, every 30 seconds while the page is visible, and when the
 * phone comes back online. Returns an unsubscribe function.
 */
export function subscribeRsvps(hikeId, onChange, onError) {
  let stopped = false;
  const show = () => { if (!stopped) onChange(listFor(hikeId)); };
  const tick = () => {
    if (stopped || document.hidden) return;
    refreshAll().then(show, (err) => { if (!stopped) onError?.(err, listFor(hikeId)); });
  };
  const off = onRsvpChange(show);
  const onVisible = () => { if (!document.hidden) tick(); };
  document.addEventListener('visibilitychange', onVisible);
  window.addEventListener('online', onVisible);
  const timer = setInterval(tick, POLL_MS);
  show();
  tick();
  return () => {
    stopped = true;
    off();
    clearInterval(timer);
    document.removeEventListener('visibilitychange', onVisible);
    window.removeEventListener('online', onVisible);
  };
}

// ── Replying ────────────────────────────────────────────────
/**
 * Save or update this phone's reply.
 * Resolves { sent: true, change, alerted } or, with no signal, { sent: false, queued: true }.
 * Rejects with RsvpError: code 'name_taken' (data.name = the existing name; ask
 * "Is that you?" and call again with { claim: true }), 'hike_over', 'list_full',
 * or a message to show.
 * @param {string} hikeId
 * @param {{ name: string, status: 'coming'|'maybe'|'cant', guests?: number, carpool?: ''|'driving'|'need-ride', seats?: number }} reply
 */
export async function setRsvp(hikeId, reply, { claim = false } = {}) {
  try {
    const data = await request('PUT', `/rsvps/${hikeId}`, { ...reply, claim });
    unqueue(hikeId);
    setHike(hikeId, data.list);
    emit();
    return { sent: true, change: data.change, alerted: Boolean(data.alerted) };
  } catch (err) {
    if (!retryable(err)) throw err;
    queue(hikeId, { reply, claim });
    emit();
    return { sent: false, queued: true };
  }
}

/** Remove this phone's reply. Resolves { sent: true } or, with no signal, { sent: false, queued: true }. */
export async function removeRsvp(hikeId) {
  try {
    const data = await request('DELETE', `/rsvps/${hikeId}`);
    unqueue(hikeId);
    setHike(hikeId, data.list);
    emit();
    return { sent: true };
  } catch (err) {
    if (!retryable(err)) throw err;
    queue(hikeId, { remove: true });
    emit();
    return { sent: false, queued: true };
  }
}
