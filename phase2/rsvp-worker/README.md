# Fall Hike App: shared RSVPs (Cloudflare Worker)

Friends open a hike and tap **Coming**, **Maybe** or **Can't go**. They can add people with
them (friends or kids) and a carpool choice (**I can drive**, with spare seats, or **Need a ride**).
Everyone sees the same list, each hike card shows how many are coming, and Summan gets a push
alert for every reply.

```
Phone ──PUT /rsvps/<hike>──▶ This Worker ──▶ Durable Object (SQLite, one small database)
  ▲                               │
  └──GET /rsvps (every 30 s ◀─────┤──▶ ntfy alert to Summan: "Meer: Coming · +1 · can drive, 3 spare seats"
     while a hike is open)                  with buttons: Open hike · Remove reply
```

- **Code:** `src/index.js`. Hike ids and dates come from `../../js/data.js`, the same file the app uses.
- **Storage:** one SQLite-backed Durable Object. It's on Cloudflare's free plan, with no extra setup and no extra key.
- **Who is who:** each phone makes a random id and keeps it. The Worker stores only a hash of it
  and never sends it back, so nobody can change someone else's reply. If a second phone uses a
  name that already replied, the app asks **"Is that you?"** first. Yes moves the reply to this
  phone. No asks for a last initial.
- **Offline:** the app keeps the last list it saw. A reply made with no signal is saved on the
  phone and sent automatically when the phone is back online.
- **Privacy:** names, plus (only for drivers and riders who choose to) an area and a WhatsApp
  number. Anyone with the app link can see them; numbers sit behind the **Message** button and
  never go into Summan's alerts or the logs. Replies, numbers, seats and ride-alert sign-ups are
  deleted automatically **7 days after each hike**, and replies close at the end of the hike day.
- **Limits:** 30 changes and 120 reads a minute per visitor, and 100 replies per hike. Names are 1–40
  characters; guests 0–5; seats 1–6.

## Carpool ("Rides")

| Piece | How it works |
|---|---|
| Area | Drivers and riders pick where they leave from (Downtown … Waterloo, or Other + a few words). The list is in `../../js/carpool.js`. Riders see drivers from their area first, then the nearest. |
| WhatsApp | Optional. Ticked by default for drivers, unticked for riders; the number always starts empty. 10-digit numbers get +1. **Message** opens `wa.me/<number>?text=…` with a message already written; if WhatsApp doesn't open, the number shows so they can text or call. |
| Ride with | `PUT /rides/<hike> {"driver":"Name"}` saves a seat. The rider must be **Coming** + **Need a ride**; a rider plus their guests take `1 + guests` seats; one seat at a time per rider (tapping another car moves it). |
| Cancel my seat | `DELETE /rides/<hike>`. Drivers can't remove riders. |
| Driver changes | A driver can't offer fewer seats than are taken. A driver who stops driving (or goes Maybe, or removes their reply) releases their riders, who see "*Name* is no longer driving". The app warns first. |
| Ride alerts | Drivers only, opt-in: `PUT /push/<hike>` with the phone's PushSubscription. One notification per rider per driver, ever ("🚗 Sara (Downtown) wants a ride with you"), sent with Web Push (`src/webpush.js`: RFC 8291 encryption, RFC 8292 VAPID). Only push services' own addresses are accepted. Android: works in Chrome. iPhone: only once the app is on the Home Screen (iOS 16.4+). |

The list API adds `area`, `phone` (shared numbers only), `seatsLeft` (drivers) and `ride` (the
driver a rider has a seat with); on your own entry, `alerts` and `lostRide`. `GET /rsvps` also
returns `pushKey`, the public VAPID key the app needs to turn alerts on.

## Plan updates (organizer only)

Only Summan can post. Everyone sees updates in the app (pinned on the home screen and the hike
page); phones that turned on plan updates also get a notification for hikes they replied
**Coming** or **Maybe** to.

| Piece | How it works |
|---|---|
| Organizer key | The `ORGANIZER_KEY` secret. `POST /organizer/link` (with the key) sends Summan's ntfy channel a private link, `…/#/organizer?k=<key>`. Opening it saves the key on that phone and takes it out of the address bar; a 📣 button then opens the organizer screen. Every organizer request sends the key in `X-Organizer`; it's compared in constant time. New key = old links stop working. |
| Posting | `POST /updates {"hike": "<id>" or "", "text": "…", "urgent": true?}`: up to 300 characters, line breaks kept; only hikes that aren't over; the same text twice within 2 minutes is refused. `DELETE /updates/<id>` takes one down (notifications already sent stay). `GET /organizer` shows reach per hike (`people` replied Coming/Maybe, `phones` with notifications on) and past updates with how many phones got each. |
| Opt-in | `PUT /notify` with the phone's PushSubscription (needs at least one reply); `DELETE /notify` stops it. One sign-up per phone, for every hike it replies Coming or Maybe to. The app asks once after a reply. |
| Sending | Notifications are queued and sent by the Durable Object's alarm, 40 per run, so a run never passes the free plan's 50 outgoing calls. A phone the push service says is gone (404/410) is forgotten. |
| Clean-up | Hike updates go a week after the hike; updates to everyone two weeks after they're sent. Sign-ups go when the phone has no replies left. |

The app's only two notifications are ride requests (drivers who turned them on) and these plan updates.

## Deploy

With a Cloudflare API token that has the **Edit Cloudflare Workers** permissions (the same
kind used for the AI Worker):

```bash
cd phase2/rsvp-worker
npm install
npx wrangler deploy
printf '%s' "your-ntfy-channel" | npx wrangler secret put NTFY_TOPIC
openssl rand -base64 48 | tr -d '\n' | npx wrangler secret put ADMIN_SECRET
```

Ride alerts need a VAPID key pair. Make one (the private half goes straight into the secret and
is never shown), then put the printed public half in `VAPID_PUBLIC_KEY` in `wrangler.toml` and
deploy again:

```bash
node -e 'const e=require("crypto").createECDH("prime256v1");e.generateKeys();const d=e.getPrivateKey();require("fs").writeFileSync(1,Buffer.concat([Buffer.alloc(32-d.length),d]).toString("base64url"));console.error("VAPID_PUBLIC_KEY =",e.getPublicKey("base64url"))' | npx wrangler secret put VAPID_PRIVATE_KEY
```

Changing the pair later means drivers turn alerts on again (the app re-subscribes when they do).

The organizer key, and sending the organizer link to Summan's ntfy channel (the key is never shown):

```bash
openssl rand -base64 32 | tr '+/' '-_' | tr -d '=\n' > organizer.key
npx wrangler secret put ORGANIZER_KEY < organizer.key
curl -X POST https://fall-hike-rsvp.<your-subdomain>.workers.dev/organizer/link \
  -H "Origin: https://fallhike.pages.dev" -H "X-Organizer: $(cat organizer.key)"
rm organizer.key
```

Lost phone? Run the same steps: the new key replaces the old one, and the old link stops working.

| Name | Where | What |
|---|---|---|
| `NTFY_TOPIC` | Secret | Your private ntfy channel: an alert for every reply. Use the same channel as the AI Worker. |
| `ADMIN_SECRET` | Secret | Any long random text. Signs the **Remove reply** links in alerts, so nobody else can make one. |
| `VAPID_PRIVATE_KEY` | Secret | Private half of the ride-alert key pair (base64url, 32 bytes). Without it, ride alerts are off and the app hides the option. |
| `VAPID_PUBLIC_KEY` | `[vars]` in `wrangler.toml` | Public half (base64url, 65 bytes). Not secret. |
| `ORGANIZER_KEY` | Secret | Long random text that unlocks posting plan updates. Without it, nobody can post. |
| `ALLOWED_ORIGIN` | `[vars]` in `wrangler.toml` | `https://fallhike.pages.dev,https://rmbk18.github.io` (origins only, no path) |
| `APP_URL` | `[vars]` in `wrangler.toml` | The app's address, for the **Open hike** button in alerts |

Then set `rsvpEndpoint` in `js/config.js` to the Worker URL and bump `VERSION` in `sw.js`.

## Test

Open the Worker URL in a browser:

```json
{"ok":true,"service":"fall-hike-rsvp","storageConfigured":true,"alertsConfigured":true,"removeLinks":true,"rideAlerts":true}
```

Test script (writes only to a hidden test hike: no alerts, not shown in the app, cleaned up):

```bash
node test.mjs https://fall-hike-rsvp.<your-subdomain>.workers.dev
```

It checks CORS and blocked sites, replying, updating, the "Is that you?" name check, input
limits, plain-text names, removing replies, and carpooling: areas and numbers, seats counting
down (guests included), full cars, cancelling, switching cars, drivers dropping out, and ride
alert sign-ups. It waits when it hits the rate limit, so it takes a few minutes.

`node test-webpush.mjs` checks the push encryption against the RFC 8291 test vector and the
VAPID signature, with no network.

With `ORGANIZER_KEY=… node test.mjs <url>` it also checks plan updates: the key is required,
posting to the hidden test hike, reach counts, the double-tap check, and taking an update down.
On the live Worker no notification is sent for the test hike.

Local: `npx wrangler dev` then `LOCAL=1 node test.mjs http://localhost:8787`. LOCAL=1 also runs
a mock push service and a mock ntfy, to check the notification a driver's phone decrypts and
that phone numbers never reach Summan's alerts. Put these in `.dev.vars` (never committed):
`NTFY_TOPIC`, `ADMIN_SECRET`, `NTFY_URL=http://127.0.0.1:8799`, `ALLOW_HTTP_PUSH=1`, a
test `VAPID_PUBLIC_KEY` / `VAPID_PRIVATE_KEY` pair, a test `ORGANIZER_KEY`, and `PUSH_BATCH=2`
(to check that big groups are sent in batches).

## Removing a junk reply

Tap **Remove reply** on its alert. A page asks **Remove this reply?**, and **Remove it**
deletes it for everyone. The link does nothing until you tap the button, so link previews
can't remove anything.

## Troubleshooting

| Symptom | Cause and fix |
|---|---|
| Hike page says "Couldn't load the list" | The Worker isn't reachable. Open its URL in a browser. `403 Origin not allowed` means `ALLOWED_ORIGIN` is wrong. |
| Old phones still show "Copy my reply" | They have the old cached app. Bump `VERSION` in `sw.js`, then close the app fully and reopen it. |
| No alerts | The health check shows `"alertsConfigured":false`: set the `NTFY_TOPIC` secret. |
| No **Remove reply** button in alerts | `"removeLinks":false`: set the `ADMIN_SECRET` secret. |
| Replies for an edited hike are missing | Hike ids come from `js/data.js`. After changing hike ids or dates, redeploy the Worker. |
| `429` | More than 30 changes a minute from one network. Wait a minute. |
| No 🔔 ride-alert option | `"rideAlerts":false` in the health check: set `VAPID_PRIVATE_KEY` and `VAPID_PUBLIC_KEY`. On iPhone the option says to add the app to the Home Screen first. |
| A driver gets no notification | They must have ticked 🔔 and allowed notifications; each rider alerts a driver once, ever. If their phone unsubscribed, the push service says so and the sign-up is dropped: tick 🔔 again. |
