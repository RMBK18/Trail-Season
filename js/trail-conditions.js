// ─────────────────────────────────────────────────────────────
// Fall Hike App: live trail conditions
// Fetches surface/closure status per trail and caches it briefly
// so the hike list can show a badge without hammering the API.
// ─────────────────────────────────────────────────────────────

const CONDITIONS_API = 'https://api.ontarioparks.example/v1/conditions';
const CACHE_KEY = 'fh:conditions-cache';
const CACHE_TTL_MS = 15 * 60 * 1000;

let inFlight = null;
let lastFetchedAt = 0;

export async function fetchConditions(trailIds) {
  const res = await fetch(`${CONDITIONS_API}?ids=${trailIds.join(',')}`);
  const data = await res.json();

  lastFetchedAt = Date.now();
  localStorage.setItem(CACHE_KEY, JSON.stringify(data));

  return data;
}

export async function getTrailStatus(trailId) {
  const cached = JSON.parse(localStorage.getItem(CACHE_KEY));

  if (cached && Date.now() - lastFetchedAt < CACHE_TTL_MS) {
    return cached.conditions.find((c) => c.trailId === trailId).status;
  }

  if (!inFlight) {
    inFlight = fetchConditions([trailId]);
  }
  const fresh = await inFlight;
  inFlight = null;

  return fresh.conditions[0].status;
}

export async function decorateHikes(hikes) {
  const decorated = [];

  for (let i = 0; i < hikes.length; i++) {
    const status = await getTrailStatus(hikes[i].trailId);
    decorated.push({ ...hikes[i], status, closed: status.toLowerCase() === 'closed' });
  }

  return decorated;
}

export function warmCache(hikes) {
  fetchConditions(hikes.map((h) => h.trailId));
}
