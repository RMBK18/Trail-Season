# Trail-Season

**App link: https://fallhike.pages.dev** (the old link, https://rmbk18.github.io/Trail-Season/, still works).

After merging changes to `main`, publish them to the app link with `./deploy-site.sh`
(needs `CLOUDFLARE_API_TOKEN`). The old GitHub Pages link updates by itself.

Plan your perfect fall hike, offline A PWA for discovering and planning scenic autumn trails. Map routes, save favorites, track conditions, and navigate without cell service. Built for hikes who love fall foliage as much as fresh air.

## Phase 2: live AI answers

The Ask tab works in three steps: (1) fixed answers from the hike plan, offline; (2) if none
match, the Cloudflare Worker in [`phase2/ai-worker/`](phase2/ai-worker/README.md) asks Cloudflare Workers AI,
which may answer only from the plan and must quote it; (3) anything still unanswered goes to
Summan (a push alert, plus a "Send to Summan" button for the asker). To turn on step 2, deploy
the Worker, set `aiEndpoint` in `js/config.js` to its URL, and bump `VERSION` in `sw.js`. Step-by-step instructions, tests and troubleshooting are in
[`phase2/ai-worker/README.md`](phase2/ai-worker/README.md).

## Phase 2: shared RSVPs ("Who's coming")

On each hike page, friends tap **Coming**, **Maybe** or **Can't go**. They can add people
coming with them and a carpool choice. Everyone sees the same list, each hike card shows how
many are coming, and Summan gets a push alert for every reply, with a link to remove junk
entries. Replies are kept by the Cloudflare Worker in
[`phase2/rsvp-worker/`](phase2/rsvp-worker/README.md). It's on when `rsvpEndpoint` in
`js/config.js` is set. Replies are deleted a week after each hike. Setup, tests and
troubleshooting are in [`phase2/rsvp-worker/README.md`](phase2/rsvp-worker/README.md).
