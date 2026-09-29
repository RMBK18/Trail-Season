// ═════════════════════════════════════════════════════════════
// PHASE 2 STUB: SHARED RSVP ("who's coming")  ·  NOT IMPLEMENTED
// ═════════════════════════════════════════════════════════════
//
// Shared RSVP needs a real backend so every friend sees the same list.
// This app deliberately does NOT fake it with localStorage: data saved on
// one phone is invisible to everyone else, so it would be a lie to call it shared.
//
// Backend: Firebase Firestore (+ Firebase Anonymous Auth for a per-device user id)
//
// Data model
//   hikes/{hikeId}/rsvps/{userId}
//     name:      string      display name the friend typed, 1–40 chars
//     status:    'coming' | 'maybe' | 'cant'
//     updatedAt: Timestamp   always serverTimestamp(), never the phone's clock
//
//   hikeId  = the `id` field in js/data.js, e.g. 'forks-of-the-credit'
//   userId  = Firebase Auth uid (anonymous sign-in), so rules can check
//             request.auth.uid == userId and nobody can overwrite someone else.
//
// Security rules: see phase2/firestore.rules
// Working implementation to drop in: phase2/rsvp-firestore.example.js
// Step-by-step wiring: see README → "Phase 2: shared RSVP"
//
// The UI (js/app.js → "PHASE 2: SHARED RSVP UI") only shows RSVP buttons when
// isRsvpLive() returns true. Until then it tells people to reply to the invite.
// ═════════════════════════════════════════════════════════════

import { CONFIG } from './config.js';

export const RSVP_STATUSES = /** @type {const} */ (['coming', 'maybe', 'cant']);

export const RSVP_LABELS = { coming: 'Coming', maybe: 'Maybe', cant: "Can't make it" };

/** True only once Firestore is configured AND the stubs below are implemented. */
export function isRsvpLive() {
  return Boolean(CONFIG.rsvpEnabled && CONFIG.firebase);
}

/**
 * PHASE 2 TODO: sign in anonymously and return the uid.
 * @returns {Promise<string>}
 */
export async function getUserId() {
  throw new Error('PHASE 2 not implemented: getUserId(). See README → "Phase 2: shared RSVP".');
}

/**
 * PHASE 2 TODO: write hikes/{hikeId}/rsvps/{uid} = { name, status, updatedAt: serverTimestamp() }.
 * @param {string} hikeId
 * @param {{ name: string, status: 'coming'|'maybe'|'cant' }} rsvp
 * @returns {Promise<void>}
 */
export async function setRsvp(hikeId, rsvp) {
  throw new Error('PHASE 2 not implemented: setRsvp(). See README → "Phase 2: shared RSVP".');
}

/**
 * PHASE 2 TODO: onSnapshot(collection(db, 'hikes', hikeId, 'rsvps')) and call
 * onChange([{ userId, name, status, updatedAt }]) on every update.
 * @param {string} hikeId
 * @param {(rsvps: Array<{userId:string,name:string,status:string,updatedAt:Date}>) => void} onChange
 * @param {(err: Error) => void} [onError]
 * @returns {() => void} unsubscribe
 */
export function subscribeRsvps(hikeId, onChange, onError) {
  throw new Error('PHASE 2 not implemented: subscribeRsvps(). See README → "Phase 2: shared RSVP".');
}
