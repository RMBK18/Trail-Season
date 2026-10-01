// ─────────────────────────────────────────────────────────────
// Carpool rules shared by the app and the RSVP Worker (no DOM here).
//
// Drivers and riders pick the area they leave from, so riders see the
// drivers near them first. Sharing a WhatsApp number is optional: whoever
// has the other's number sends the first message, and they sort out pickup
// between them.
// ─────────────────────────────────────────────────────────────

// The organizer's list, in this order. Rough centres, used only to list
// the nearest drivers first. "Other" lets people type a few words.
export const AREAS = [
  { name: 'Downtown', lat: 43.651, lng: -79.383 },
  { name: 'Etobicoke', lat: 43.645, lng: -79.535 },
  { name: 'North York', lat: 43.761, lng: -79.411 },
  { name: 'Scarborough', lat: 43.773, lng: -79.258 },
  { name: 'Markham', lat: 43.857, lng: -79.337 },
  { name: 'Vaughan', lat: 43.837, lng: -79.508 },
  { name: 'Mississauga', lat: 43.589, lng: -79.644 },
  { name: 'Brampton', lat: 43.731, lng: -79.762 },
  { name: 'Oakville', lat: 43.467, lng: -79.687 },
  { name: 'Milton', lat: 43.518, lng: -79.877 },
  { name: 'Burlington', lat: 43.325, lng: -79.799 },
  { name: 'Hamilton', lat: 43.256, lng: -79.869 },
  { name: 'Waterloo', lat: 43.464, lng: -80.520 },
  { name: 'Other' },
];
export const MAX_AREA_CHARS = 30;

const areaByKey = new Map(AREAS.map((a) => [a.name.toLowerCase(), a]));
/** The list entry for an area name, or null for typed ("Other") areas. */
export const findArea = (name) => areaByKey.get(String(name || '').trim().toLowerCase()) || null;

/** Rough distance in km between two areas: 0 for the same area, Infinity when either is unknown. */
export function areaKm(a, b) {
  if (!a || !b) return Infinity;
  if (String(a).toLowerCase() === String(b).toLowerCase()) return 0;
  const x = findArea(a), y = findArea(b);
  if (x?.lat == null || y?.lat == null) return Infinity;
  const rad = Math.PI / 180;
  const dLat = (y.lat - x.lat) * rad, dLng = (y.lng - x.lng) * rad;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(x.lat * rad) * Math.cos(y.lat * rad) * Math.sin(dLng / 2) ** 2;
  return 12742 * Math.asin(Math.sqrt(h));
}

/** Sort people nearest to `area` first (same area, then by distance, then unknown areas). Stable. */
export function nearestFirst(people, area) {
  return people
    .map((p, i) => ({ p, i, km: areaKm(area, p.area) }))
    .sort((a, b) => (a.km === b.km ? a.i - b.i : a.km === Infinity ? 1 : b.km === Infinity ? -1 : a.km - b.km))
    .map((x) => x.p);
}

/**
 * A WhatsApp number as digits with the country code (E.164 without "+"),
 * '' for blank, or null when it doesn't look like a phone number.
 * 10 digits are Canadian/US numbers and get the +1.
 */
export function normalizePhone(raw) {
  const s = String(raw ?? '').trim();
  if (!s) return '';
  if (s.length > 30 || /[^\d\s()+.-]/.test(s) || s.indexOf('+') > 0 || (s.match(/\+/g) || []).length > 1) return null;
  let d = s.replace(/\D/g, '');
  if (!s.startsWith('+') && d.length === 10) d = `1${d}`;
  if (d.startsWith('1')) return /^1[2-9]\d{2}[2-9]\d{6}$/.test(d) ? d : null; // Canada / US
  return s.startsWith('+') && /^[2-9]\d{7,14}$/.test(d) ? d : null;
}

/** "+1 416-555-0123" for Canadian/US numbers, "+44 7700900123" otherwise. */
export function formatPhone(d) {
  const s = String(d || '');
  return /^1\d{10}$/.test(s) ? `+1 ${s.slice(1, 4)}-${s.slice(4, 7)}-${s.slice(7)}` : s ? `+${s}` : '';
}

/** WhatsApp "click to chat": opens a chat with the message already typed. */
export const waLink = (digits, text) => `https://wa.me/${digits}?text=${encodeURIComponent(text)}`;
