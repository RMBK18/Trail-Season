# Fall Hike App: live AI answers (Cloudflare Worker)

Every question in the Ask tab goes through three steps:

1. **Fixed answers.** The app's offline FAQ answers from the hike plan. No network, no cost.
2. **AI, only from your plan.** Anything else comes to this Worker. Grok (xAI) may answer **only**
   from the facts in `js/data.js`, and must quote the exact lines it used. The Worker checks
   every quote against the plan and throws the answer away if any quote doesn't match.
3. **Unanswered → Summan.** If there's no verified answer, Summan gets a push alert (ntfy), and
   the asker gets a **Send to Summan** button to send the question and get a reply.

```
Phone ──question──▶ 1. Offline FAQ ──match──▶ answer
                         │ no match
                         ▼
                    2. This Worker ──▶ Grok (plan facts only) ──▶ quote check ──pass──▶ "Live answer"
                         │ not in the plan / check failed / error
                         ▼
                    3. Push alert to Summan  +  "Send to Summan" button for the asker
```

- **Code:** `src/index.js`. The hike facts come from `../../js/data.js`, the same file the app uses.
- **AI:** xAI's Grok API, model `grok-4.3` (about $1.25 / $2.50 per million input / output tokens).
  To change the model, edit `XAI_MODEL` in `wrangler.toml` and redeploy.
- **Security:** the API key lives only in Cloudflare as a secret. Only `https://rmbk18.github.io`
  may call the Worker, and each visitor can ask 10 questions per minute.
- **Stateless:** the Worker stores and logs no questions or answers. Unanswered questions are
  passed straight to your ntfy alert and not kept anywhere.
- **Cost:** well under a cent per question that reaches the AI. Questions the offline FAQ answers
  cost nothing. xAI gives new accounts free starter credits, which cover a small group easily.

## 1. Deploy

You need:

- An **xAI API key**: [console.x.ai](https://console.x.ai) → sign in → **API Keys** → **Create API key**.
  Check your credits there too. Leave xAI's optional "data sharing" program off: it lets xAI
  train on the questions your friends ask.
- A free **Cloudflare account**: [dash.cloudflare.com/sign-up](https://dash.cloudflare.com/sign-up).
- **Node.js 22 or newer** for option A: [nodejs.org](https://nodejs.org).

### Option A: from your computer (recommended)

```bash
git clone https://github.com/rmbk18/Trail-Season.git
cd Trail-Season/phase2/ai-worker
npm install

npx wrangler login                        # opens a browser to sign in to Cloudflare
npx wrangler deploy                       # first deploy; prints your Worker URL
npx wrangler secret put XAI_API_KEY       # paste the key when asked (it's hidden)
npx wrangler secret put NTFY_TOPIC        # your private alert channel name (see "Alerts" below)
```

1. `wrangler login` opens Cloudflare in your browser. Click **Allow**.
2. `wrangler deploy` uploads the Worker. On your very first Worker, it asks you to pick a
   `workers.dev` subdomain (e.g. `summan`). At the end it prints the URL:
   ```
   https://fall-hike-ai.<your-subdomain>.workers.dev
   ```
   **Copy this URL.** You'll paste it into `js/config.js`.
3. `wrangler secret put XAI_API_KEY` stores the key encrypted in Cloudflare.
   It never goes into git or into the app.
4. `wrangler secret put NTFY_TOPIC` stores your alert channel name the same way.

### Option B: from the Cloudflare dashboard (no Node.js needed)

1. Cloudflare dashboard → **Workers & Pages** → **Create** → **Import a repository**.
2. Connect GitHub and pick **rmbk18/Trail-Season**.
3. Set the project name to **`fall-hike-ai`** (it must match `name` in `wrangler.toml`) and the
   **root directory** (under advanced/build settings) to **`phase2/ai-worker`**. Deploy.
4. Open the Worker → **Settings** → **Variables and Secrets** → **Add**. Type **Secret**,
   name `XAI_API_KEY`, value = your key. Add a second secret named `NTFY_TOPIC` with your
   alert channel name (see "Alerts" below). Save (this redeploys).
5. The URL is shown on the Worker's overview page (also under Settings → Domains & Routes).

With option B, every push to `main` redeploys the Worker automatically.

### Alerts for unanswered questions (ntfy)

1. Install the free **ntfy** app on your phone ([iPhone](https://apps.apple.com/app/ntfy/id1625396347),
   [Android](https://play.google.com/store/apps/details?id=io.heckel.ntfy)).
2. Tap **+** (Subscribe to topic) and type a private channel name: long and random, like
   `fallhike-7k2q9x4m8r`. Leave the server as `ntfy.sh`. Tap **Subscribe**.
3. Save **the same name** as the Worker's `NTFY_TOPIC` secret (step above).

Anyone who knows the name can read the alerts, so keep it random and private. Without
`NTFY_TOPIC`, everything else still works; the only difference is there's no alert.

### Environment variables

| Name | Where it's set | Value |
|---|---|---|
| `XAI_API_KEY` | Secret: `npx wrangler secret put XAI_API_KEY` or dashboard → Variables and Secrets | Your xAI key, `xai-...` |
| `NTFY_TOPIC` | Secret: `npx wrangler secret put NTFY_TOPIC` or dashboard → Variables and Secrets | Your private ntfy channel name |
| `ALLOWED_ORIGIN` | `[vars]` in `wrangler.toml` | `https://rmbk18.github.io` |
| `XAI_MODEL` | `[vars]` in `wrangler.toml` | `grok-4.3` |

`ALLOWED_ORIGIN` is the site's origin only: `https://rmbk18.github.io`, **not**
`https://rmbk18.github.io/Trail-Season/`. For more than one origin, separate them with commas.
Change it in `wrangler.toml` and redeploy. A value set only in the dashboard is overwritten by
the next deploy.

The per-visitor limit (10 per minute) is `[[ratelimits]]` in `wrangler.toml`.

## 2. Turn it on in the app

In **`js/config.js`** (there is no `public/` folder in this repo), change:

```js
  aiEndpoint: null,
```

to your Worker URL:

```js
  aiEndpoint: 'https://fall-hike-ai.<your-subdomain>.workers.dev',
```

Then in **`sw.js`**, raise the number at the end of `VERSION` by one, e.g. `v11` → `v12`:

```js
const VERSION = 'fall-hike-2026-10-v12';
```

Commit and push. The service worker caches `config.js`, so **without the version bump, installed
phones keep the old config and never call the AI.** Each phone picks up the change the next time
it opens the app online. If it doesn't, close the app fully and open it again.

## 3. Test

**In a browser:** open the Worker URL. You should see:

```json
{"ok":true,"service":"fall-hike-ai","apiKeyConfigured":true,"alertsConfigured":true}
```

This doesn't call the AI. `false` for either one means that secret isn't set.

**Test script** (from `phase2/ai-worker`):

```bash
node test.mjs https://fall-hike-ai.<your-subdomain>.workers.dev
```

It checks that CORS allows the app, other sites are blocked, and empty questions are rejected.
Then it asks five real questions. Each must come back either **answered from the plan** or
**unanswered** (which sends you a real ntfy alert, so this also tests alerts). The poem question
must be refused as off topic:

```
PASS  Worker is live
PASS  XAI_API_KEY secret is set
PASS  CORS preflight allows the app  (status 204, allow-origin https://rmbk18.github.io)
PASS  Other origins are blocked  (status 403)
PASS  Empty question is rejected  (status 400)

PASS  "I have bad knees, which hike should I pick?"  (200, 3.1s)
      → (Grok's answer, or "unanswered (alert sent to the organizer)")
```

Ask your own question: `node test.mjs <url> "Can I bring my drone to Rattlesnake Point?"`

**With curl** (macOS/Linux):

```bash
curl -X POST https://fall-hike-ai.<your-subdomain>.workers.dev \
  -H "Origin: https://rmbk18.github.io" \
  -H "Content-Type: application/json" \
  -d '{"question":"I have bad knees, which hike should I pick?"}'
```

**In the app:** Ask tab → type a question the FAQ can't answer:

| Question | Expected |
|---|---|
| What time do we meet on Oct 3? | Offline FAQ answer, no AI call |
| Is Short Hills good for kids? | Offline FAQ answer, no AI call |
| I'm lost on the trail | Offline emergency answer: call 911 |
| I have bad knees, which hike should I pick? | AI answer from the plan with a "Live answer" label |
| Are there bears at Short Hills? | Not in the plan: "I've passed it on to Summan" + **Send to Summan**, and you get an alert |
| Write me a poem about cats | "I can only help with the fall hikes." (no alert) |

**Local testing** (optional): create `phase2/ai-worker/.dev.vars` (git-ignored) containing
`XAI_API_KEY=xai-...`, then run `npx wrangler dev` and `node test.mjs http://localhost:8787`.

**Live logs:** `npx wrangler tail` shows errors as they happen. Questions are never logged.

## 4. Troubleshooting

| Symptom | Cause and fix |
|---|---|
| App always says "ask Summan!" for new questions | `aiEndpoint` is still `null`, or phones have the old cached `config.js`. Bump `VERSION` in `sw.js`, push, then fully close and reopen the app. |
| Worker URL shows `"apiKeyConfigured":false` | Secret missing. Add `XAI_API_KEY` in the Worker's Variables and Secrets. |
| `403 Origin not allowed` | `ALLOWED_ORIGIN` must be exactly `https://rmbk18.github.io` (no path). curl and scripts must send an `Origin` header. |
| `500 AI service is misconfigured` | The key is wrong, revoked or unset. Create a new key and run `secret put` again. |
| `429 Too many questions` | The 10-per-minute limit, or your xAI account's rate limit. Wait a minute, or raise `limit` in `wrangler.toml`. |
| `502 AI service unavailable` | xAI is down, your credits ran out (check console.x.ai), or the model in `XAI_MODEL` was retired. `npx wrangler tail` shows xAI's error message. |
| `504` or the app gives up | The answer took over 12 s. The app waits 15 s, then falls back to "ask Summan!". Try again. |
| No ntfy alerts arrive | `alertsConfigured` is `false` (set the `NTFY_TOPIC` secret), or the name in the app doesn't exactly match the secret. Off-topic questions never send alerts. |
| AI says it doesn't know something the plan covers | By design it answers only when it can quote the plan exactly. Add or reword the fact in `js/data.js` (or ask Summan to), then redeploy. |
| CORS error in the browser console | The URL in `config.js` is wrong (typo, extra path), or the Worker isn't deployed. Open the URL in a browser to check. |
| `wrangler` says Node is too old | Install Node.js 22 or newer. |
| AI answers don't match an edited hike | The Worker has its own copy of `js/data.js` from its last deploy. Run `npx wrangler deploy` again (option B does this on every push). |

## How it behaves

- **Offline FAQ first.** `js/app.js` only calls the Worker when the offline FAQ has no match, so
  the AI never duplicates an FAQ answer and FAQ questions cost nothing.
- **Only your facts.** Grok gets the facts from `js/data.js` and nothing else, is told not to
  use general knowledge, and replies in a fixed format: `answered` (with quotes), `not_in_plan`
  or `off_topic`. An answer is shown only if every quote is found word for word in the plan.
  The quote check stops answers with no basis in the plan. It can't prove every word of an
  answer, so answers are also kept to 1–2 sentences (cut at 600 characters).
- **Unanswered goes to Summan.** `not_in_plan`, a failed quote check, a refusal or an error all
  send an ntfy alert (if set up). Off-topic questions don't.
- **Short and plain.** 1–2 friendly sentences, plain text (the app shows it with `textContent`).
- **Failures degrade quietly.** Every error returns a non-2xx status, the question is still
  sent to Summan, and the app shows the **Send to Summan** button. Nothing breaks.
