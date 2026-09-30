# Task for Claude Code: switch the AI Worker to Cloudflare Workers AI (free) and deploy it

Hand this file to a Claude Code session on this repo:
"Follow phase2/ai-worker/SWITCH_TO_WORKERS_AI.md".

## Goal

The Ask tab's live-AI step (`phase2/ai-worker/`, Worker name `fall-hike-ai`) currently calls
xAI's Grok, which is paid. Switch it to **Cloudflare Workers AI** so it runs on the Cloudflare
**free plan** with no AI key and no bill. Then deploy it, test it and turn it on in the app.

Everything else stays as it is:
- The AI may answer only from `js/data.js`, and every quote is checked against THE FACTS.
- JSON replies are `answered` / `not_in_plan` / `off_topic`.
- The ntfy alert still goes to the organizer for unanswered questions.
- CORS still allows only `https://rmbk18.github.io`.
- The Worker still stores nothing.

## Must not

- Print, echo, log or commit `CLOUDFLARE_API_TOKEN` or `NTFY_TOPIC`. The ntfy channel name
  counts as a secret: anyone who knows it can send the organizer alerts. Never write it into
  a tracked file.
- Upgrade the Cloudflare account to Workers Paid, add a payment method or enable anything
  billable. If something only works on a paid plan, drop it and tell the user.
- Ask the user to paste secrets into chat. If a secret is missing, tell them to add it to the
  claude.ai environment settings and start a new session.

## Before you start

The session environment needs these secrets (set by the user in the claude.ai environment
settings):

| Variable | What it is |
|---|---|
| `CLOUDFLARE_API_TOKEN` | Cloudflare API token ("Edit Cloudflare Workers" template plus **Account → Workers AI → Edit**) |
| `NTFY_TOPIC` | The organizer's ntfy channel name |

Check only that they are set, without printing them:
`[ -n "$CLOUDFLARE_API_TOKEN" ] && echo set`. If either is missing, stop and tell the user.

Work on a branch made from the latest `main`, never directly on `main`.

## Steps

### 1. Code changes in `phase2/ai-worker/`

**`wrangler.toml`**
- Add the Workers AI binding:
  ```toml
  [ai]
  binding = "AI"
  ```
- Replace `XAI_MODEL` with `AI_MODEL`. Pick a current text-generation model from
  <https://developers.cloudflare.com/workers-ai/models/> that supports **JSON mode**
  (`response_format`). Candidates:
  - `@cf/meta/llama-3.3-70b-instruct-fp8-fast`: best answers, uses more of the free daily
    allowance.
  - `@cf/meta/llama-3.1-8b-instruct-fast`: cheapest, so the free allowance covers far more
    questions.

  Start with the 70B model. If testing shows it follows the quote rules badly or costs too
  much, compare with the 8B one.
- Update the comments: no `XAI_API_KEY` any more; `NTFY_TOPIC` is the only secret.
- Keep `[[ratelimits]]`. If `wrangler deploy` says it isn't available on the free plan,
  remove it (the code already skips the limit when `env.RATE_LIMITER` is missing) and tell
  the user.

**`src/index.js`**
- Replace `callGrok()` with a call through the binding: `env.AI.run(model, { messages,
  max_tokens, response_format })`, keeping the same system prompt and user message.
- Workers AI's JSON mode takes the schema directly:
  `response_format: { type: 'json_schema', json_schema: <the schema object> }`.
  It does not take OpenAI's `{ name, strict, schema }` wrapper. Check this against the current
  Workers AI JSON-mode docs.
- The result is `{ response: ... }`, not `choices[0].message.content`. `response` can be an
  already-parsed object or a JSON string; handle both. Anything unreadable becomes
  `unanswered`, same as now.
- Keep the 12 s timeout, for example by racing `env.AI.run` against a timer, so the app (15 s)
  never waits longer.
- Map errors to the existing responses:
  - The free daily allowance running out (the error mentions the neuron allocation or daily
    limit) and rate-limit errors → 429 "Too many questions right now".
  - Anything else → 502 "AI service unavailable".

  Always still call `alertOrganizer()`, as the current catch block does.
- Remove the `XAI_API_KEY` check and `XAI_URL`. Instead, if `env.AI` is missing, return the
  "misconfigured" 500 and alert the organizer.
- Health check (`GET`): replace `apiKeyConfigured` with `aiConfigured: Boolean(env.AI)`, and
  add `model`.
- Update the header comment ("Grok (xAI)" → "Workers AI").

**`test.mjs`**: change the key check to `health.aiConfigured === true`, and remove the
"costs xAI credits" wording.

**`package.json`**: update `description`.

**`README.md`**: rewrite for Workers AI. Cover: no AI key needed, free plan, 10,000 free
neurons a day (resets 00:00 UTC), what happens when it runs out (the app shows "ask Summan"
and the organizer gets the alert, with no charge), how to change `AI_MODEL`, and the new
deploy steps. Remove the xAI setup.

Run a quick syntax check (`node --check src/index.js`) and `npx wrangler deploy --dry-run`.

### 2. Deploy

```sh
cd phase2/ai-worker && npm install
npx wrangler whoami            # shows the account ID; export CLOUDFLARE_ACCOUNT_ID if wrangler asks
```

- If the account has no workers.dev subdomain, register one with the Cloudflare API
  (`GET/PUT /accounts/{id}/workers/subdomain`). Use something short, such as `fallhike`.
- Run `npx wrangler deploy` and note the URL: `https://fall-hike-ai.<subdomain>.workers.dev`.
- Set the alert secret without printing it:
  `printf %s "$NTFY_TOPIC" | npx wrangler secret put NTFY_TOPIC`
- If an old `XAI_API_KEY` secret exists on the Worker, delete it:
  `npx wrangler secret delete XAI_API_KEY`.

### 3. Test

Wait about 30 seconds, then run `node test.mjs <worker-url>`.

Expected:
- PASS on: live, AI configured, CORS, blocked origin, empty question.
- The four hike questions come back `answered` or `unanswered (alert sent)`.
- The poem question comes back `off_topic`.

If something fails, read `npx wrangler tail` and fix only what's needed, then retest. Make sure
`answered` actually happens for at least one question the plan covers, for example
`node test.mjs <url> "What time do we meet for the first hike?"`. If nothing is ever answered,
the quote check is probably rejecting everything: look at the raw model output in
`wrangler tail` before changing the prompt.

### 4. Turn it on in the app

- `js/config.js`: set `aiEndpoint` to the Worker URL.
- `sw.js`: raise the number at the end of `VERSION` by one (check its current value first).
- Update the top-level `README.md` wherever it describes Phase 2 AI as Grok/xAI.

### 5. Commit, push, pull request

- Commit everything on your branch and push it.
- Open a pull request into `main` titled "Turn on free live AI answers (Cloudflare Workers AI)".
- In the body, include the Worker URL, the model and the test output. Include no secrets and
  not the ntfy channel name.

### 6. Tell the user, in plain language

- The Worker URL, and whether the tests passed, with a couple of real answers.
- That it's free: Cloudflare free plan and Workers AI's daily allowance, with no card on file.
- Roughly how many questions a day the allowance covers with the chosen model.
- That they should **merge the pull request** to switch the AI on.
- That their ntfy app should have received alerts for the unanswered test questions.
