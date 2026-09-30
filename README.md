# Trail-Season
Plan your perfect fall hike, offline A PWA for discovering and planning scenic autumn trails. Map routes, save favorites, track conditions, and navigate without cell service. Built for hikes who love fall foliage as much as fresh air.

## Phase 2: live AI answers

The Ask tab works in three steps: (1) fixed answers from the hike plan, offline; (2) if none
match, the Cloudflare Worker in [`phase2/ai-worker/`](phase2/ai-worker/README.md) asks Cloudflare Workers AI,
which may answer only from the plan and must quote it; (3) anything still unanswered goes to
Summan (a push alert, plus a "Send to Summan" button for the asker). To turn on step 2, deploy
the Worker, set `aiEndpoint` in `js/config.js` to its URL, and bump `VERSION` in `sw.js`. Step-by-step instructions, tests and troubleshooting are in
[`phase2/ai-worker/README.md`](phase2/ai-worker/README.md).
