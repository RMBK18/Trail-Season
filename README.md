# Trail-Season
Plan your perfect fall hike, offline A PWA for discovering and planning scenic autumn trails. Map routes, save favorites, track conditions, and navigate without cell service. Built for hikes who love fall foliage as much as fresh air.

## Phase 2: live AI answers

The Ask tab answers from the hike plan offline. To also answer questions the plan doesn't cover,
deploy the Cloudflare Worker in [`phase2/ai-worker/`](phase2/ai-worker/README.md) (it holds the
Anthropic API key and calls Claude), then set `aiEndpoint` in `js/config.js` to its URL and bump
`VERSION` in `sw.js`. Step-by-step instructions, tests and troubleshooting are in
[`phase2/ai-worker/README.md`](phase2/ai-worker/README.md).
