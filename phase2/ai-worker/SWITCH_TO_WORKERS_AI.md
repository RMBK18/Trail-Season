# Task for Claude Code: switch the AI Worker to Cloudflare Workers AI (free) and deploy it

Hand this file to a Claude Code session on this repo:
"Follow phase2/ai-worker/SWITCH_TO_WORKERS_AI.md".

## Goal

Deploy the Ask tab's live-AI Worker (`phase2/ai-worker/`, Worker name `fall-hike-ai`) on
**Cloudflare Workers AI**, test it, and turn it on in the app. It runs on the Cloudflare
**free plan**, with no AI key and no bill.

**Status: the code switch is done** (commit c66cc2f on branch `claude/fall-hike-ai-agent-ihrg1c`).
The Worker calls `env.AI.run()` through the `[ai]` binding, with model `AI_MODEL`
(`@cf/meta/llama-3.3-70b-instruct-fp8-fast`). It uses JSON Mode and accepts object or string
replies. It has the 12 s timeout and one retry. A used-up daily allowance returns 429 and
anything else 502, and both still alert. The health check shows `aiConfigured` and `model`.
There's no xAI code left. What's left is steps 2 to 6.

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

Work on branch `claude/fall-hike-ai-agent-ihrg1c`, which has the code switch: `git fetch origin
claude/fall-hike-ai-agent-ihrg1c && git checkout claude/fall-hike-ai-agent-ihrg1c`. Never work
directly on `main`.

## Steps

### 1. Check the code (already switched)

```sh
cd phase2/ai-worker && npm install
node --check src/index.js && npx wrangler deploy --dry-run   # expect env.AI binding and AI_MODEL
```

If `[[ratelimits]]` turns out not to be available on the free plan when you deploy, remove it
(the code already skips the limit when `env.RATE_LIMITER` is missing) and tell the user.

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
