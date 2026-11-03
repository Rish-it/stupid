# Stupid

A workspace for creators and small businesses on Meta. Sign in with Facebook, connect
Instagram, WhatsApp, your Facebook Page and Meta Ads, and work from one place:

- **Inbox.** Messenger, Instagram DMs and comments, and WhatsApp, newest first, updating live.
- **Agents.** Background agents on Muse Spark Open draft replies, find leads, suggest posts and
  read your ads. They prepare work and wait: nothing is sent, posted or changed without your tap.
- **Results in plain words.** Ad results for the last 7 days and Instagram reach, followers and
  engagement, straight from Meta. An empty or unconnected account says so; no numbers are invented.
- **Setup without the maze.** Each connected account says what Meta still needs (a payment
  method, a time zone, a linked Page) in plain words, with a link to the exact Meta screen.

Stupid is built for Meta's platform. It is not an official Meta product.

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

## Run it

Needs Rust 1.95 and Node.js 24.

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

## Earlier work

Before this workspace, Secnd AI built Ren, an open decision model for Meta business decisions.
Its weights, model card and training record are at
[huggingface.co/Secnd-AI/ren](https://huggingface.co/Secnd-AI/ren) and
[github.com/Secnd-AI/ren](https://github.com/Secnd-AI/ren).
