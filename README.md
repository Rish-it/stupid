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
  Pick creator or business (`PUT /api/me/persona`) and `GET /api/setup/next` names the one
  thing left to do for that path, read from what is already stored; the agents follow that order.

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
| Lead finder, post ideas (which also look at your 6 best post pictures), reply drafts, ad watcher (`server/src/agents.rs`) | Muse Spark Open, `meta-models/muse-spark-open-1026` | Baseten Model APIs (`STUPID_MUSE_BASE_URL`) |
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
- The person picks the model for their agents in Settings → AI model, from every Meta chat model
  the server can reach: Baseten's `meta-models/muse-spark-open*` (open weights) and the Model API's
  Muse Spark 1.3, 1.2 and 1.1 (`PUT /api/settings/ai/model`). The list is read from each provider's
  `/models` at most every 10 minutes, with known defaults when a provider can't be reached.
  Contributor-tier models and Muse Image are never offered or called.

## Use Stupid from Muse (MCP)

Stupid is also an MCP server, for a Muse custom connector or any MCP client: `POST /mcp`
(JSON-RPC 2.0 over streamable HTTP, one JSON answer per request). In Settings → "Use Stupid from
Muse", make an access key (shown once; stored as a hash, revocable) and paste the URL, the key and
the ready-made words into Muse.

- Read tools, from the agent's own registry: `get_today`, `list_inbox`, `read_thread`, `get_ads`,
  `get_instagram`, `list_leads`, `list_drafts`, `get_ad_advice`, and the media tools
  `watch_video` (Muse Wonder), `find_subject` (SAM 3.1) and `transcribe_voice_note` (Voice
  Transcribe, or what a customer's photo or video shows). The media tools spend from Stupid's
  Model API budget.
- Prepare tools: `queue_reply_draft(item_id, text)` queues a draft that opens in Stupid's Inbox
  marked "From Muse"; `save_idea` and `save_ad_advice` leave work in Stupid for review;
  `run_agent(name)` starts a job under the same spend cap and daily limit.
- There is no send, post or spend tool. Only a Bearer key opens `/mcp`; cookies are ignored.

```bash
curl -s https://app.secndai.com/mcp -H "Authorization: Bearer $STUPID_KEY" \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}'
```

**Muse Code.** Add the server to `~/.config/muse/settings.json` (Settings in Stupid shows this with
your URL filled in) and keep the key in an environment variable:

```json
{ "schema_version": 1,
  "mcp_servers": { "stupid": { "transport": "streamable_http", "url": "https://app.secndai.com/mcp",
    "headers": { "Authorization": "${STUPID_MCP_AUTH}" }, "mode": "optional" } } }
```

```bash
export STUPID_MCP_AUTH="Bearer $STUPID_KEY"
muse exec "What's waiting in my Stupid inbox? Queue a short reply to the newest message."
```

Muse Code then reads the inbox and queues a draft marked "From Muse"; you send it from Stupid.

## Service providers

Stupid sends Meta Platform Data to these model providers, only to do the work the person asked for:

| Provider | What it gets | Retention | Agreement |
|---|---|---|---|
| Meta Model API (Muse Wonder) | When the person runs Reel director: links to their own top Reels, and their captions and counts | Same terms as below | Same |
| Meta Model API (SAM 3.1) | When the person runs Ad watcher with Instagram on: links to their own top post pictures and a short subject name. Stupid keeps only the boxes | Same terms as below | Same |
| Meta Model API (Muse Voice Transcribe) | The audio of a customer's voice note, once, to turn it into words. The audio isn't stored by Stupid; only the words are, for 30 days | Standard tier: not used for training; Meta may keep requests for safety review | [Model API terms](https://dev.meta.ai/legal/terms-of-service) |
| Baseten (model inference) | For the agent a person runs: message and comment text with the sender's first name, Instagram bio, captions and post counts, links to their own best post pictures (Post ideas), ad campaign totals. Never phone numbers, Meta IDs or tokens | Zero data retention on Model APIs; no training on customer data | [DPA](https://www.baseten.co/dpa/), [security practices](https://www.baseten.co/security-practices/) |
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

### Self-host: create your Meta app

The in-app tutorial is for connecting a business. This walkthrough is for the person running
Stupid's server. Use placeholders below with your own public HTTPS origin; keep all real values
in your local `.env`, never in Git, a screenshot, a chat, or a browser field.

1. Open the [Meta App Dashboard](https://developers.facebook.com/apps/) → **Create App**.
   Enter your app name and contact email. Add the use cases for Facebook Login for Business,
   Instagram, Messenger, WhatsApp and Marketing API as needed, and associate the business
   portfolio that owns the assets. Meta's available use cases depend on the app and portfolio;
   use **Customize** on the relevant use case to reach its setup. For WhatsApp, the current
   use case is **Connect with customers through WhatsApp** → **Quickstart** → **Start using
   the API** → **API Setup**. A test number is generated and registered for you. This does not
   require entering an access token into Stupid's frontend.
2. In **App settings → Basic**, copy **App ID** to `STUPID_META_APP_ID`. Beside **App secret**,
   click **Show** and put it in `STUPID_META_APP_SECRET`. Configure the app domain, contact
   email, privacy policy (`<public-origin>/privacy.html`) and terms (`<public-origin>/terms.html`).
   The app secret stays on the server.
3. Open **Facebook Login for Business → Configurations → Create configuration**.
   Choose **User access token**, select the assets and permissions Stupid uses, and save.
   Copy the resulting **Configuration ID** into `STUPID_META_LOGIN_CONFIG_ID`.
   [Meta's configuration instructions](https://developers.facebook.com/docs/facebook-login/facebook-login-for-business/)
   describe the options; do not select a system-user-only configuration for Stupid's user login.
   Request access only for the apps you will use:

   | App | Permissions used by Stupid |
   |---|---|
   | Shared discovery | `business_management`, `pages_show_list` |
   | Facebook Page / Messenger | `pages_read_engagement`, `pages_manage_metadata`, `pages_messaging` |
   | Page-linked Instagram | `instagram_basic`, `instagram_manage_insights`, `instagram_manage_comments`, `instagram_manage_messages` |
   | WhatsApp | `whatsapp_business_management`, `whatsapp_business_messaging` |
   | Ads results | `ads_read` |

4. Set `STUPID_META_PUBLIC_URL` to the public HTTPS origin, with no path. Set
   `STUPID_META_REDIRECT_URI` to that same origin plus `/api/v1/meta/oauth/callback`.
   In **Facebook Login for Business → Settings → Valid OAuth Redirect URIs**, paste that exact
   callback and **Save changes**. Scheme, hostname, port and path must match, including the
   absence of an extra trailing slash. Add the production address as well as any local callback
   you actually use; Meta must allow the callback before sign-in can return successfully.
5. Generate two separate local secrets. Choose a long random webhook verification string for
   `STUPID_META_VERIFY_TOKEN`. Generate `STUPID_META_TOKEN_KEY` with:

   ```bash
   python3 -c "import base64,os;print(base64.urlsafe_b64encode(os.urandom(32)).decode())"
   ```

   Save the generated encryption key privately in `.env`. Keep it stable: replacing it makes
   existing encrypted Meta tokens unreadable and people must connect again. It is a Stupid
   encryption key, not a value from Meta. `STUPID_META_GRAPH_VERSION` is `v25.0`, the version
   configured in `.env.example`; do not copy a different version from a documentation example.
6. In the app's **Webhooks** settings (or the relevant use case's **Configuration**), choose
   each object below. Click **Edit** beside the callback, enter `<public-origin>/webhooks/meta`
   and the same `STUPID_META_VERIFY_TOKEN`, then **Verify and save**. Subscribe to:

   | Object | Fields |
   |---|---|
   | WhatsApp Business Account | `messages` (incoming messages and delivery failures) |
   | Page | `messages` |
   | Instagram | `messages`, `comments` |

   The callback must already be reachable over HTTPS. Verification checks the verify token;
   later webhook deliveries are checked with the app secret. Stupid subscribes the shared
   Page and WhatsApp accounts during connection; those subscriptions cannot replace the
   dashboard field configuration. Never paste Meta access tokens into Settings.
7. In **App settings → Basic → User data deletion**, choose the data deletion callback URL
   and enter `<public-origin>/api/v1/meta/deletion`, then save. The human-readable removal
   instructions are at `<public-origin>/deletion.html`. These are different URLs.
8. While developing, give the connecting Facebook profile the app's required role/test access
   and access to the real assets. For WhatsApp tests, use **API Setup → To** to add and verify
   the recipient. A test send in Meta is an explicit action; reply from that recipient to open
   the 24-hour window. Test resources do not need a payment method for test templates. For
   a production number, complete registration, display-name requirements and billing in
   [WhatsApp Manager](https://business.facebook.com/wa/manage/home/). Production service
   replies can be charged even inside 24 hours; see
   [Meta's current pricing](https://developers.facebook.com/documentation/business-messaging/whatsapp/pricing/non-template-messages).
9. Serving other businesses may require **App Review → Permissions and Features → Advanced
   Access**, app publishing and business verification for the requested permissions. Follow the
   requirements listed for this app; verification is not the paid Meta Verified subscription.
   In development, normal webhook events can be limited by app roles and access. The dashboard's
   **Test** buttons help check delivery. Stupid also reads Messenger and Instagram conversations
   while a screen is open; an empty Inbox does not prove the webhook is configured correctly.
10. Run the server using the Run it steps above, sign in using the Facebook profile that manages
    your assets, and follow **Setup**. After changing Meta access, return to Stupid and **Check
    again** or **Connect again**. Edit grants later in Facebook **Settings & privacy → Settings →
    Business Integrations → Stupid → View and Edit → Save**.
    [Open Business Integrations](https://www.facebook.com/settings?tab=business_tools).

Every Meta-related `.env.example` setting:

| Setting | Where it comes from |
|---|---|
| `STUPID_META_APP_ID` | App settings → Basic → App ID |
| `STUPID_META_APP_SECRET` | App settings → Basic → App secret → Show |
| `STUPID_META_LOGIN_CONFIG_ID` | Facebook Login for Business → Configurations → saved Configuration ID |
| `STUPID_META_PUBLIC_URL` | Your public HTTPS origin |
| `STUPID_META_REDIRECT_URI` | Your origin + `/api/v1/meta/oauth/callback`; register the exact value in Valid OAuth Redirect URIs |
| `STUPID_META_VERIFY_TOKEN` | Locally chosen random string; same value in webhook verification |
| `STUPID_META_TOKEN_KEY` | Locally generated base64url 32-byte encryption key |
| `STUPID_META_GRAPH_VERSION` | `v25.0` in the example configuration |
| `STUPID_META_API_KEY` | Optional, separate Meta Model API team key from [Meta's developer site](https://dev.meta.ai/); used only by the server's media features, never for Facebook Login or pasted into a person's Settings |
| `STUPID_META_API_BUDGET_USD` | Your explicit media budget; separate from the agent budget |

The optional `STUPID_MUSE_API_KEY` is a **Baseten** key, created at **Organization settings → API
keys → Create API key → Team → Next → Call Model APIs → Create API key**.
[Key instructions](https://docs.baseten.co/organization/api-keys),
[current model prices](https://docs.baseten.co/inference/model-apis/pricing-and-limits).
It pays for the workspace's agents up to `STUPID_MUSE_BUDGET_USD`. To revoke it, use the trash icon
on Baseten's API keys page, then remove or replace the server value. A person's optional own key
and consent are managed in Settings; removing Stupid's encrypted copy does not revoke the key
at Baseten. Never substitute a Meta access token or a Meta Model API key in that field.


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
