// ─────────────────────────────────────────────────────────────
// Fall Hike App: Phase 2 switches. Both are OFF in Phase 1.
// Nothing in this file is secret. NEVER put an API key here:
// everything in /public is downloaded to every friend's phone.
// ─────────────────────────────────────────────────────────────

export const CONFIG = {
  // PHASE 2: LIVE AI ANSWERS
  // URL of YOUR server-side proxy (see README → "Phase 2: live AI answers"),
  // e.g. 'https://fall-hike-ai.<your-subdomain>.workers.dev' (phase2/ai-worker/).
  // The proxy runs the AI (Cloudflare Workers AI). This app only ever sends it a question.
  // After changing this, bump VERSION in /sw.js or installed phones keep the old value.
  // null = off: unmatched questions get "I don't know that one — ask Summan!"
  aiEndpoint: 'https://fall-hike-ai.rmbk-holdings.workers.dev',

  // PHASE 2: SHARED RSVP ("who's coming")
  // Paste the Firebase web config object from the Firebase console here,
  // copy phase2/rsvp-firestore.example.js over js/rsvp.js, and set rsvpEnabled to true.
  // Firebase web config is an identifier, not a secret; Firestore security rules protect the data.
  firebase: null,
  rsvpEnabled: false,
};
