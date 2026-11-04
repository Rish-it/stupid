# Stupid

An agent for creators and small businesses on Meta. Sign in with Facebook, connect Instagram,
WhatsApp, your Facebook Page and Meta Ads, and let it do the busywork while you decide:

- **It answers with you.** Each new message is read as it lands. The agent, on Muse Spark Open,
  drafts a reply within a minute or asks you one concrete question when it needs a fact. Today
  shows only what needs you, then what it did. Nothing is sent, posted or changed without your tap.
- **Inbox.** Messenger, Instagram DMs and comments, and WhatsApp, newest first, updating live.
- **Jobs on a tap.** Lead finder, post ideas, a Reel director that watches your best Reels with
  Muse Wonder, reply drafts and an ad watcher run when you ask.
- **Results in plain words.** Ad results for the last 7 days and Instagram reach, followers and
  engagement, straight from Meta. An empty or unconnected account says so; no numbers are invented.
- **Setup without the maze.** Each connected account says what Meta still needs (a payment
  method, a time zone, a linked Page) in plain words, with a link to the exact Meta screen.

Built with Muse Spark Open. Stupid is built for Meta's platform. It is not an official Meta product.

Live at [app.secndai.com](https://app.secndai.com), served from the owner's machine through a
Cloudflare tunnel.

## How it works

- `server/`: Rust (axum, tokio, SQLite). Facebook Login for Business, Graph API v25.0 with
  `appsecret_proof` on every call, signed webhooks, live updates over server-sent events, and the
  agent runner. It also serves the built frontend.
- `frontend/`: Vite, React 19 and Astryx.

Security: Meta tokens are encrypted at rest (Fernet) and never reach the browser. Over HTTPS the
session cookie is `__Host-` and writes are accepted only from Stupid's own origin. Webhooks are
checked against `X-Hub-Signature-256` before anything is stored. Messages are kept 30 days. Meta's
data-deletion callback removes a person's data in one transaction. AI spend stops at
`STUPID_MUSE_BUDGET_USD`, and people can bring their own key.

## Meta models used and where

| What | Model | Where it runs |
|---|---|---|
| Lead finder, post ideas, reply drafts, ad watcher (`server/src/agents.rs`) | Muse Spark Open, `meta-models/muse-spark-open-1026` | Baseten Model APIs (`STUPID_MUSE_BASE_URL`) |
| The agent on new messages: intake decision (`tickets.rs`) and a tool-calling executor that drafts replies or asks you one question (`executor.rs`, `tools.rs`) | Muse Spark Open, same model | Baseten Model APIs |
| Reel director watches your best Reels (up to 3) and writes three new scripts with shot lists (`reels.rs`), plus the agent's `watch_video` tool | Muse Wonder, `muse-wonder-1.0` (preview) | Meta Model API, same key and cap |
| Smart crops: the Ad watcher's creative pack finds the product or subject in your best post pictures and Reel covers, then the browser crops them to 1:1, 4:5 and 9:16 (`crops.rs`, `crop.ts`), plus the agent's `find_subject` tool | SAM 3.1, `sam-3.1` | Meta Model API, same key and cap |
| Customer voice notes on WhatsApp, Messenger and Instagram become text the agent reads (`voice.rs`) | Muse Voice Transcribe, `muse-voice-transcribe-1.0` | Meta Model API (`STUPID_META_API_KEY`, its own cap `STUPID_META_API_BUDGET_USD`) |

- One chat call per agent run, from the server only. The browser never sees a model key.
- On a new message, a gate with no model call filters it (account on, inside 24 hours, not replied,
  budget and daily limit left), one call decides whether it needs an answer, and the executor works
  the task with read and prepare tools only: at most 6 steps and $0.05 per task. Its tools can save a
  draft or ask you a question; none can send. Sends stay your tap in the Inbox.
- Spend stops at `STUPID_MUSE_BUDGET_USD` (workspace key), with at most 30 runs per person per day.
  A person who saves their own Baseten API key pays their own account instead. Stupid never asks
  for a Meta Model API key, which may not be shared with another service.
- Each run's model id and cost are shown on the Agents screen and stored with the run. The server
  logs one `muse call` line per call: agent, model, prompt and completion tokens, cost and time.
- Calls use `reasoning_effort: "low"` and a 4,000-token cap. A model id containing `contributor`
  is refused at startup, because contributor-tier models may train on what they receive.

## Service providers

Stupid sends Meta Platform Data to these model providers, only to do the work the person asked for:

| Provider | What it gets | Retention | Agreement |
|---|---|---|---|
| Meta Model API (Muse Wonder) | When the person runs Reel director: links to their own top Reels, and their captions and counts | Same terms as below | Same |
| Meta Model API (SAM 3.1) | When the person runs Ad watcher with Instagram on: links to their own top post pictures and a short subject name. Stupid keeps only the boxes | Same terms as below | Same |
| Meta Model API (Muse Voice Transcribe) | The audio of a customer's voice note, once, to turn it into words. The audio isn't stored by Stupid; only the words are, for 30 days | Standard tier: not used for training; Meta may keep requests for safety review | [Model API terms](https://dev.meta.ai/legal/terms-of-service) |
| Baseten (model inference) | For the agent a person runs: message and comment text with the sender's first name, Instagram bio, captions and post counts, ad campaign totals. Never phone numbers, Meta IDs or tokens | Zero data retention on Model APIs; no training on customer data | [DPA](https://www.baseten.co/dpa/), [security practices](https://www.baseten.co/security-practices/) |
| The person's own Baseten account | The same, only after they save their own Baseten API key in Settings and tick the consent box (the time is stored) | Their account's terms | Their own account |

Meta tokens and the database stay on Stupid's server. The Cloudflare tunnel only carries the
site's HTTPS traffic to that server. Agent results expire after 30 days, like messages.

## Run it

Needs Rust 1.95 and Node.js 22.12 or newer (CI uses 24). Voice notes also need `ffmpeg` on the
server's PATH, to turn WhatsApp's Opus and Instagram's AAC into the WAV Voice Transcribe reads;
without it a voice note says it couldn't be transcribed. The Docker image doesn't include it.

```bash
cp .env.example .env    # fill in the Meta app values; never commit .env
npm ci
npm run build           # frontend/dist
npm run dev:api         # server on http://127.0.0.1:8000
```

`npm run dev` runs the server and the Vite dev server together (http://localhost:3000).

Or one container (the database lives in the `stupid-data` volume):

```bash
docker compose up --build
```

### Meta app setup

In your app at developers.facebook.com:

1. **Facebook Login for Business**: create a configuration (user access token) with the
   permissions Stupid uses, and add `STUPID_META_REDIRECT_URI` to Valid OAuth Redirect URIs.
2. **Webhooks**: callback `<public url>/webhooks/meta`, verify token `STUPID_META_VERIFY_TOKEN`.
   Subscribe to `messages` for WhatsApp Business Account, Page and Instagram, plus `comments`
   for Instagram.
3. **App settings → Basic**: data deletion callback `<public url>/api/v1/meta/deletion`.

Until the app is published, Meta sends webhooks only from the dashboard's Test button. Stupid still
reads Messenger and Instagram conversations directly while a screen is open.

## Checks

```bash
npm run check           # cargo clippy -D warnings, cargo test, lint, build
npm run test:inbox      # browser tests
```

## Also built during this hackathon

Ren, an open decision model for Meta business decisions, was built and published by Secnd AI
during this hackathon (Oct 29 – Nov 1, 2026); Stupid does not use it at runtime. Its weights,
model card and training record are at
[huggingface.co/Secnd-AI/ren](https://huggingface.co/Secnd-AI/ren) and
[github.com/Secnd-AI/ren](https://github.com/Secnd-AI/ren).
