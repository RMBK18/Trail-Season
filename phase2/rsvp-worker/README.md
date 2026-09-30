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
- **Privacy:** names only. Anyone with the app link can see them. Replies are deleted
  automatically **7 days after each hike**, and replies close at the end of the hike day.
- **Limits:** 30 changes and 120 reads a minute per visitor, and 100 replies per hike. Names are 1–40
  characters; guests 0–5; seats 1–6.

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

| Name | Where | What |
|---|---|---|
| `NTFY_TOPIC` | Secret | Your private ntfy channel: an alert for every reply. Use the same channel as the AI Worker. |
| `ADMIN_SECRET` | Secret | Any long random text. Signs the **Remove reply** links in alerts, so nobody else can make one. |
| `ALLOWED_ORIGIN` | `[vars]` in `wrangler.toml` | `https://rmbk18.github.io` (origin only, no path) |
| `APP_URL` | `[vars]` in `wrangler.toml` | The app's address, for the **Open hike** button in alerts |

Then set `rsvpEndpoint` in `js/config.js` to the Worker URL and bump `VERSION` in `sw.js`.

## Test

Open the Worker URL in a browser:

```json
{"ok":true,"service":"fall-hike-rsvp","storageConfigured":true,"alertsConfigured":true,"removeLinks":true}
```

Test script (writes only to a hidden test hike: no alerts, not shown in the app, cleaned up):

```bash
node test.mjs https://fall-hike-rsvp.<your-subdomain>.workers.dev
```

It checks CORS and blocked sites, replying, updating, the "Is that you?" name check, input
limits, plain-text names, and removing replies.

Local: `npx wrangler dev` then `node test.mjs http://localhost:8787`. For alerts in local
testing, put `NTFY_TOPIC`, `ADMIN_SECRET` and `NTFY_URL` (a local mock) in `.dev.vars`.

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
