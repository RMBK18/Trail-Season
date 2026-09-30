# Fall Hike App: live AI answers (Cloudflare Worker)

When the Ask tab's offline FAQ can't answer a question, the app sends it to this
Worker. The Worker adds the hike plan, asks Claude, and sends back a 1–3 sentence
answer. The app shows it with a small "Live answer" label.

```
Phone ──question──▶ Offline FAQ ──matched──▶ answer (no network, no cost)
                         │
                     no match
                         ▼
            Cloudflare Worker (holds the API key)
                         │
                         ▼
               Anthropic API (Claude Opus 5.5)
```

- **Code:** `src/index.js`. The hike facts come from `../../js/data.js`, the same file the app uses.
- **Model:** `claude-opus-5-5`, the current Claude Opus. (`claude-opus-4-1-20250805` was retired
  on Aug 5, 2026, so calls to it now fail.) To change the model, edit `MODEL` in `src/index.js`.
- **Security:** the API key lives only in Cloudflare as a secret. Only `https://rmbk18.github.io`
  may call the Worker, and each visitor can ask 10 questions per minute.
- **Stateless:** the Worker stores and logs no questions or answers.
- **Cost:** roughly a cent per question that reaches the AI. Questions the offline FAQ answers cost nothing.

## 1. Deploy

You need:

- An **Anthropic API key**: [console.anthropic.com](https://console.anthropic.com) → API Keys →
  Create Key. While you're there, set a monthly spend limit under Settings → Limits.
- A free **Cloudflare account**: [dash.cloudflare.com/sign-up](https://dash.cloudflare.com/sign-up).
- **Node.js 22 or newer** for option A: [nodejs.org](https://nodejs.org).

### Option A: from your computer (recommended)

```bash
git clone https://github.com/rmbk18/Trail-Season.git
cd Trail-Season/phase2/ai-worker
npm install

npx wrangler login                        # opens a browser to sign in to Cloudflare
npx wrangler deploy                       # first deploy; prints your Worker URL
npx wrangler secret put ANTHROPIC_API_KEY # paste the key when asked (it's hidden)
```

1. `wrangler login` opens Cloudflare in your browser. Click **Allow**.
2. `wrangler deploy` uploads the Worker. On your very first Worker, it asks you to pick a
   `workers.dev` subdomain (e.g. `summan`). At the end it prints the URL:
   ```
   https://fall-hike-ai.<your-subdomain>.workers.dev
   ```
   **Copy this URL.** You'll paste it into `js/config.js`.
3. `wrangler secret put ANTHROPIC_API_KEY` stores the key encrypted in Cloudflare.
   It never goes into git or into the app.

### Option B: from the Cloudflare dashboard (no Node.js needed)

1. Cloudflare dashboard → **Workers & Pages** → **Create** → **Import a repository**.
2. Connect GitHub and pick **rmbk18/Trail-Season**.
3. Set the project name to **`fall-hike-ai`** (it must match `name` in `wrangler.toml`) and the
   **root directory** (under advanced/build settings) to **`phase2/ai-worker`**. Deploy.
4. Open the Worker → **Settings** → **Variables and Secrets** → **Add**. Type **Secret**,
   name `ANTHROPIC_API_KEY`, value = your key. Save (this redeploys).
5. The URL is shown on the Worker's overview page (also under Settings → Domains & Routes).

With option B, every push to `main` redeploys the Worker automatically.

### Environment variables

| Name | Where it's set | Value |
|---|---|---|
| `ANTHROPIC_API_KEY` | Secret: `npx wrangler secret put ANTHROPIC_API_KEY` or dashboard → Variables and Secrets | Your key, `sk-ant-...` |
| `ALLOWED_ORIGIN` | `[vars]` in `wrangler.toml` | `https://rmbk18.github.io` |

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

Then in **`sw.js`**, raise the number at the end of `VERSION` by one, e.g. `v7` → `v8`:

```js
const VERSION = 'fall-hike-2026-10-v8';
```

Commit and push. The service worker caches `config.js`, so **without the version bump, installed
phones keep the old config and never call the AI.** Each phone picks up the change the next time
it opens the app online. If it doesn't, close the app fully and open it again.

## 3. Test

**In a browser:** open the Worker URL. You should see:

```json
{"ok":true,"service":"fall-hike-ai","apiKeyConfigured":true}
```

This doesn't call Claude. `"apiKeyConfigured":false` means the secret isn't set.

**Test script** (from `phase2/ai-worker`):

```bash
node test.mjs https://fall-hike-ai.<your-subdomain>.workers.dev
```

It checks that CORS allows the app, other sites are blocked, and empty questions are rejected.
Then it asks five real questions and prints the answers:

```
PASS  Worker is live
PASS  ANTHROPIC_API_KEY secret is set
PASS  CORS preflight allows the app  (status 204, allow-origin https://rmbk18.github.io)
PASS  Other origins are blocked  (status 403)
PASS  Empty question is rejected  (status 400)

PASS  "I have bad knees, which hike should I pick?"  (200, 3.1s)
      → (Claude's answer is printed here)
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
| I have bad knees, which hike should I pick? | AI answer with a "Live answer" label |
| Are there bears at Short Hills? | AI answer |
| Write me a poem about cats | AI says it only helps with the hikes |

**Local testing** (optional): create `phase2/ai-worker/.dev.vars` (git-ignored) containing
`ANTHROPIC_API_KEY=sk-ant-...`, then run `npx wrangler dev` and `node test.mjs http://localhost:8787`.

**Live logs:** `npx wrangler tail` shows errors as they happen. Questions are never logged.

## 4. Troubleshooting

| Symptom | Cause and fix |
|---|---|
| App always says "ask Summan!" for new questions | `aiEndpoint` is still `null`, or phones have the old cached `config.js`. Bump `VERSION` in `sw.js`, push, then fully close and reopen the app. |
| Worker URL shows `"apiKeyConfigured":false` | Secret missing. Run `npx wrangler secret put ANTHROPIC_API_KEY`. |
| `403 Origin not allowed` | `ALLOWED_ORIGIN` must be exactly `https://rmbk18.github.io` (no path). curl and scripts must send an `Origin` header. |
| `500 AI service is misconfigured` | The key is wrong, revoked or unset. Create a new key and run `secret put` again. |
| `429 Too many questions` | The 10-per-minute limit, or your Anthropic account's rate limit. Wait a minute, or raise `limit` in `wrangler.toml`. |
| `502 AI service unavailable` | Anthropic is overloaded or down, or your account is out of credit (check console.anthropic.com → Billing). `npx wrangler tail` shows the status code. |
| `504` or the app gives up | The answer took over 12 s. The app waits 15 s, then falls back to "ask Summan!". Try again. |
| `422 No answer for that one` | Claude declined the question. The app shows "ask Summan!". |
| CORS error in the browser console | The URL in `config.js` is wrong (typo, extra path), or the Worker isn't deployed. Open the URL in a browser to check. |
| `wrangler` says Node is too old | Install Node.js 22 or newer. |
| AI answers don't match an edited hike | The Worker has its own copy of `js/data.js` from its last deploy. Run `npx wrangler deploy` again (option B does this on every push). |

## How it behaves

- **Offline FAQ first.** `js/app.js` only calls the Worker when the offline FAQ has no match, so
  the AI never duplicates an FAQ answer and FAQ questions cost nothing.
- **Grounded in the plan.** The system prompt holds every fact from `js/data.js`. Claude is told
  never to change plan details and to reply "I don't know that one — ask Summan!" when it can't
  answer.
- **Short and plain.** 1–3 friendly sentences, plain text (the app shows it with `textContent`).
- **Refusal fallback.** If Claude's safety filters decline a harmless question, the API
  automatically retries it on Anthropic's recommended fallback model (`fallbacks: "default"`).
  To turn this off, delete the `betas` and `fallbacks` lines in `src/index.js`.
- **Failures degrade quietly.** Every error returns a non-2xx status and the app shows
  "ask Summan!". Nothing breaks.
