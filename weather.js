// ─────────────────────────────────────────────────────────────
// Fall Hike App: weather forecasts for each hike location
// Uses Open-Meteo (free, no API key needed, no signup).
// Fetches on first visit to a hike detail; caches for 6 hours.
// ─────────────────────────────────────────────────────────────

import { HIKES } from './data.js';

// Lat/long for each park (from public sources; very close is fine)
const COORDS = {
  'forks-of-the-credit': { lat: 43.9069, lng: -80.0603, name: 'Forks of the Credit' },
  'dundas-valley': { lat: 43.2817, lng: -80.3940, name: 'Dundas Valley' },
  'rattlesnake-point': { lat: 43.4731, lng: -79.7858, name: 'Rattlesnake Point' },
  'balls-falls': { lat: 43.1978, lng: -79.4458, name: 'Balls Falls' },
  'short-hills': { lat: 43.1764, lng: -79.2503, name: 'Short Hills' },
};

const CACHE_HOURS = 6;

export async function getWeather(hikeId) {
  const h = HIKES.find((x) => x.id === hikeId);
  if (!h || !COORDS[hikeId]) return null;

  const cached = getCached(hikeId);
  if (cached) return cached;

  try {
    const coords = COORDS[hikeId];
    const res = await fetch(
      `https://api.open-meteo.com/v1/forecast?latitude=${coords.lat}&longitude=${coords.lng}&daily=temperature_2m_max,temperature_2m_min,precipitation_sum,weather_code&temperature_unit=celsius&timezone=America/Toronto`,
      { signal: AbortSignal.timeout(8000) },
    );
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();

    // Find the hike day in the forecast
    const hike = HIKES.find((x) => x.id === hikeId);
    if (!hike) return null;
    const hikeIdx = data.daily.time.indexOf(hike.dateISO);
    if (hikeIdx === -1) return null; // Hike day not in forecast range

    const w = data.daily;
    const weather = {
      hikeDate: hike.dateISO,
      high: w.temperature_2m_max[hikeIdx],
      low: w.temperature_2m_min[hikeIdx],
      rain: w.precipitation_sum[hikeIdx],
      code: w.weather_code[hikeIdx],
      fetchedAt: new Date().toISOString(),
    };
    setCached(hikeId, weather);
    return weather;
  } catch (err) {
    console.error('Weather fetch failed:', err.message);
    return null;
  }
}

function getCached(hikeId) {
  try {
    const s = localStorage.getItem(`fh:weather:${hikeId}`);
    if (!s) return null;
    const w = JSON.parse(s);
    const age = (new Date() - new Date(w.fetchedAt)) / (1000 * 60 * 60);
    return age < CACHE_HOURS ? w : null;
  } catch {
    return null;
  }
}

function setCached(hikeId, weather) {
  try {
    localStorage.setItem(`fh:weather:${hikeId}`, JSON.stringify(weather));
  } catch { /* private mode */ }
}

// Convert WMO weather code to a human-readable description and icon
export function describeWeather(code) {
  const codes = {
    0: { desc: 'Clear', icon: '☀️' },
    1: { desc: 'Mostly clear', icon: '🌤️' },
    2: { desc: 'Partly cloudy', icon: '⛅' },
    3: { desc: 'Overcast', icon: '☁️' },
    45: { desc: 'Foggy', icon: '🌫️' },
    48: { desc: 'Freezing fog', icon: '🌫️' },
    51: { desc: 'Drizzle', icon: '🌧️' },
    53: { desc: 'Light rain', icon: '🌧️' },
    55: { desc: 'Heavy rain', icon: '⛈️' },
    61: { desc: 'Rain', icon: '🌧️' },
    63: { desc: 'Heavy rain', icon: '⛈️' },
    65: { desc: 'Very heavy rain', icon: '⛈️' },
    71: { desc: 'Light snow', icon: '🌨️' },
    73: { desc: 'Snow', icon: '❄️' },
    75: { desc: 'Heavy snow', icon: '❄️' },
    77: { desc: 'Snow grains', icon: '❄️' },
    80: { desc: 'Rain showers', icon: '🌧️' },
    81: { desc: 'Heavy rain showers', icon: '⛈️' },
    82: { desc: 'Violent rain showers', icon: '⛈️' },
    85: { desc: 'Snow showers', icon: '🌨️' },
    86: { desc: 'Heavy snow showers', icon: '❄️' },
    95: { desc: 'Thunderstorm', icon: '⛈️' },
    96: { desc: 'Thunderstorm with hail', icon: '⛈️' },
    99: { desc: 'Thunderstorm with hail', icon: '⛈️' },
  };
  return codes[code] || { desc: 'Unknown', icon: '🌡️' };
}
