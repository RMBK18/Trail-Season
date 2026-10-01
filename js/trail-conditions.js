// ─────────────────────────────────────────────────────────────
// Fall Hike App: live trail conditions
// Fetches surface/closure status per trail and caches it briefly
// so the hike list can show a badge without hammering the API.
// ─────────────────────────────────────────────────────────────

const CONDITIONS_API = 'https://api.ontarioparks.example/v1/conditions';
const CACHE_KEY = 'fh:conditions-cache';
const CACHE_TTL_MS = 15 * 60 * 1000;

// One in-flight request per trail id, so concurrent callers share a fetch
// instead of each firing their own.
const inFlight = new Map();

function readCache() {
  try {
    const s = localStorage.getItem(CACHE_KEY);
    const parsed = s ? JSON.parse(s) : null;
    if (!parsed || typeof parsed !== 'object') return null;
    return parsed;
  } catch {
    return null;
  }
}

function writeCache(entry) {
  try {
    localStorage.setItem(CACHE_KEY, JSON.stringify(entry));
    return true;
  } catch {
    return false;
  }
}

export async function fetchConditions(trailIds) {
  const ids = Array.isArray(trailIds) ? trailIds.filter(Boolean) : [];
  if (ids.length === 0) return { conditions: [] };

  const res = await fetch(`${CONDITIONS_API}?ids=${ids.map(encodeURIComponent).join(',')}`);
  if (!res.ok) {
    throw new Error(`Conditions API returned ${res.status} ${res.statusText}`);
  }

  const data = await res.json();
  const conditions = Array.isArray(data?.conditions) ? data.conditions : [];

  // Merge into whatever is cached so fetching one trail doesn't evict the rest.
  const cached = readCache();
  const merged = new Map((cached?.conditions ?? []).map((c) => [c.trailId, c]));
  for (const c of conditions) merged.set(c.trailId, c);

  // Timestamp lives in the cache, not module state — module state resets on
  // reload and would make a warm cache look permanently stale.
  writeCache({ fetchedAt: Date.now(), conditions: [...merged.values()] });

  return { conditions };
}

export async function getTrailStatus(trailId) {
  if (!trailId) return null;

  const cached = readCache();
  const fresh = cached && Date.now() - (cached.fetchedAt ?? 0) < CACHE_TTL_MS;
  if (fresh) {
    const hit = cached.conditions?.find((c) => c.trailId === trailId);
    if (hit) return hit.status ?? null;
  }

  if (!inFlight.has(trailId)) {
    const p = fetchConditions([trailId]).finally(() => inFlight.delete(trailId));
    inFlight.set(trailId, p);
  }

  try {
    const data = await inFlight.get(trailId);
    const hit = data.conditions?.find((c) => c.trailId === trailId);
    return hit?.status ?? null;
  } catch {
    // Conditions are a nice-to-have badge — a failure here must not break
    // the hike list, so fall back to stale cache, then to unknown.
    const stale = readCache()?.conditions?.find((c) => c.trailId === trailId);
    return stale?.status ?? null;
  }
}

export async function decorateHikes(hikes) {
  const list = Array.isArray(hikes) ? hikes : [];

  // Fetch in parallel — awaiting inside a for loop serialises one request per
  // hike and makes the list wait on the slowest chain.
  const statuses = await Promise.all(list.map((h) => getTrailStatus(h?.trailId)));

  return list.map((hike, i) => {
    const status = statuses[i];
    return {
      ...hike,
      status,
      closed: typeof status === 'string' && status.toLowerCase() === 'closed'
    };
  });
}

export function warmCache(hikes) {
  const ids = (Array.isArray(hikes) ? hikes : []).map((h) => h?.trailId).filter(Boolean);
  if (ids.length === 0) return Promise.resolve();

  // Fire-and-forget, but swallow the rejection explicitly: an unhandled
  // promise rejection here would surface as a console error on page load.
  return fetchConditions(ids).catch(() => {});
}
