// ─────────────────────────────────────────────────────────────
// Fall Hike App: Phase 2 switches (live AI answers, shared RSVPs).
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

  // PHASE 2: SHARED RSVP ("Who's coming")
  // URL of the RSVP Worker (see phase2/rsvp-worker/README.md). Friends tap
  // Coming / Maybe / Can't make it and everyone sees the same list.
  // After changing this, bump VERSION in /sw.js.
  // null = off: the hike page offers "Copy my reply" for the group chat instead.
  rsvpEndpoint: 'https://fall-hike-rsvp.rmbk-holdings.workers.dev',
};
