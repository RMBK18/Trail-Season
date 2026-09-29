// ─────────────────────────────────────────────────────────────
// Fall Hike App: admin panel for editing hikes
// Persists changes to localStorage under fh:hikes-custom
// ─────────────────────────────────────────────────────────────

import { HIKES as DEFAULT_HIKES } from './data.js';

const STORAGE_KEY = 'fh:hikes-custom';

export function getHikes() {
  const custom = getCustomHikes();
  return custom.length > 0 ? custom : DEFAULT_HIKES;
}

export function getCustomHikes() {
  try {
    const s = localStorage.getItem(STORAGE_KEY);
    return s ? JSON.parse(s) : [];
  } catch {
    return [];
  }
}

export function saveCustomHikes(hikes) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(hikes));
    return true;
  } catch {
    return false;
  }
}

export function resetToDefaults() {
  try {
    localStorage.removeItem(STORAGE_KEY);
    return true;
  } catch {
    return false;
  }
}

export function isUsingCustomHikes() {
  return getCustomHikes().length > 0;
}

// Backup and restore (for moving to a new phone)
export function backupHikes() {
  const hikes = getCustomHikes();
  if (hikes.length === 0) return 'No custom hikes to back up.';
  return JSON.stringify(hikes, null, 2);
}

export function restoreHikes(json) {
  try {
    const hikes = JSON.parse(json);
    if (!Array.isArray(hikes)) throw new Error('Not an array');
    saveCustomHikes(hikes);
    return true;
  } catch (err) {
    throw new Error('Invalid backup JSON: ' + err.message);
  }
}

export const EXAMPLE_HIKE = {
  id: 'example-hike',
  n: 1,
  dateISO: '2026-10-03',
  day: 3,
  meetTime24: '08:00',
  dateShort: 'Sat Oct 3',
  dateLong: 'Saturday, October 3',
  park: 'Park Name',
  shortName: 'Short Name',
  area: 'City / Region',
  level: 'EASY',
  optionLevel: null,
  meet: { time: '8:00 AM', place: 'meeting spot name', note: null },
  trails: [{ name: 'Trail Name', level: 'EASY', length: null, time: null, note: null }],
  fallLine: 'Why this place is beautiful in fall.',
  highlights: ['Highlight 1', 'Highlight 2'],
  drive: { text: '~45–60 min', short: '~45–60 min' },
  fee: { amount: 'FREE', note: 'No booking.', short: 'no booking' },
  booking: null,
  washrooms: 'Washrooms available',
  noWashrooms: false,
  dogs: 'Dogs OK',
  picnic: null,
  alerts: [],
  bring: ['Item 1', 'Item 2'],
  maps: 'Park Name, City, Region',
  backup: { name: 'Backup Park Name', maps: 'Backup Park Name, City, Region' },
  fallbackTrailheads: null,
  accent: 'rust',
};
