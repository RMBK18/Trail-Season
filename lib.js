import { HIKES, APP } from './data.js';

export const esc = (s) =>
  String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

export const mapsUrl = (destination) =>
  'https://www.google.com/maps/dir/?api=1&destination=' + encodeURIComponent(destination);

export const meetMs = (h) => Date.parse(`${h.dateISO}T${h.meetTime24}:00${APP.tzOffset}`);
export const endMs = (h) => Date.parse(`${h.dateISO}T23:59:59${APP.tzOffset}`);

// 'upcoming' | 'live' (hike day, after meet time) | 'done'
export function statusOf(h, now = new Date()) {
  const t = now.getTime();
  if (t < meetMs(h)) return 'upcoming';
  if (t <= endMs(h)) return 'live';
  return 'done';
}

// First hike whose day hasn't ended yet (Toronto time).
export const nextHike = (now = new Date()) => HIKES.find((h) => now.getTime() <= endMs(h)) || null;

const dateFmt = new Intl.DateTimeFormat('en-CA', {
  timeZone: APP.timeZone, year: 'numeric', month: '2-digit', day: '2-digit',
});
export const torontoDateISO = (d = new Date()) => dateFmt.format(d);

export const isHikeDay = (h, now = new Date()) => torontoDateISO(now) === h.dateISO;

export function countdownParts(ms) {
  const s = Math.max(0, Math.floor(ms / 1000));
  return {
    days: Math.floor(s / 86400),
    hours: Math.floor((s % 86400) / 3600),
    minutes: Math.floor((s % 3600) / 60),
    seconds: s % 60,
  };
}
