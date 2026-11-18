# Personal AI Content Assistant

A personal AI news-to-LinkedIn posting agent powered by **OpenRouter** with **WhatsApp approval**. Every day, the bot finds recent AI and engineering stories, drafts a short LinkedIn post, and sends it for review. **Nothing is published automatically.**

## Features

- **AI writing with OpenRouter** — defaults to `openrouter/free` (subject to provider availability, limits, and terms).
- **Recent news collection** — fetches dated RSS items from sources such as TechCrunch, InfoQ, and Hugging Face.
- **WhatsApp review** — create, preview, edit, reject, or approve a draft using your configured personal WhatsApp account.
- **Exact-ID approval** — only an `approve <draft-id>` command for the current pending draft can publish.
- **Duplicate protection** — refuses second approval and stops automated retries when the result of a publishing attempt is uncertain.
- **Daily schedule** — defaults to 09:00 in `Asia/Karachi` (configurable).
- **LinkedIn Posts API** — supports text-only posts to your authorized personal LinkedIn profile.
- **Local state** — SQLite/JSON state and WhatsApp session are stored locally, outside Git.

This is a focused standalone bot that reuses the WhatsApp module from the original NanoClaw project. **Claude, OneCLI, Docker, and OmniRoute are not required for this mode.** The original NanoClaw source code remains in this repository for reference and is started separately.

## Tech stack

TypeScript, Node.js 22+, Baileys (WhatsApp Web), OpenRouter chat completions, RSS, LinkedIn OAuth and Posts API, SQLite, and Vitest.

## Quick start

```bash
git clone https://github.com/abu-huraira-abid/linkedIn-agent.git
cd linkedIn-agent
npm ci
cp .env.example .env
chmod 600 .env
```

Edit `.env` with your own values:

```dotenv
TZ=Asia/Karachi
LINKEDIN_DAILY_TIME=09:00
LINKEDIN_OWNER_JID=923001234567@s.whatsapp.net
OPENROUTER_API_KEY=replace-with-your-key
OPENROUTER_MODEL=openrouter/free
LINKEDIN_PUBLISH_ENABLED=false
LINKEDIN_ACCESS_TOKEN=
LINKEDIN_PERSON_URN=
LINKEDIN_API_VERSION=202608
```

**Replace the example WhatsApp number** with your own country-code number, with no `+` sign or spaces. Keep the API key and LinkedIn access token private.

Get an OpenRouter API key: https://openrouter.ai/settings/keys

Connect WhatsApp (only needed on first setup or after an expired/revoked linked-device session):

```bash
npm run auth
```

Scan the QR using **WhatsApp > Linked Devices**. If you migrated from the earlier `linkedin-agent` folder and copied `store/auth/`, the existing authenticated session should normally remain usable; do not pair again unnecessarily.

Start the complete Andy application (dashboard + one WhatsApp LinkedIn bot):

```bash
npm run dev
```

For production, build and start the same unified application:

```bash
npm run build
npm start
```

Use only one application process. Do not run `npm run linkedin:bot` or `npm run nanoclaw:start` alongside it; the unified application already starts the LinkedIn bot and dashboard.

**Run only one copy of the bot at a time**, especially when reusing the same WhatsApp session. This is a long-running process: keep the computer running or deploy it to an always-on server.

## WhatsApp commands

Send these commands from the WhatsApp account configured in `LINKEDIN_OWNER_JID`:

| Command | Purpose |
| --- | --- |
| `draft` | Collect news and generate a new draft |
| `status` | Show the current draft and its ID |
| `edit Make the hook more direct` | Revise the draft; the approval ID changes |
| `reject ab12cd34` | Discard the matching draft |
| `approve ab12cd34` | Publish **only if** publishing is enabled and credentials are valid |
| `help` | Display supported commands |

A plain message such as `post it` **does not** publish; the exact draft ID is required.

## Enabling LinkedIn publishing

1. Create a developer app at https://www.linkedin.com/developers/apps. An eligible associated LinkedIn Page may be required by the developer portal.
2. Enable **Share on LinkedIn** (permission `w_member_social`) and **Sign In with LinkedIn using OpenID Connect**.
3. Configure your application's OAuth redirect URI as `http://localhost:8080/callback` if using the included token helper.
4. Set the developer app credentials **locally**, then run `python3 scripts/linkedin_get_token.py` (requires Python `requests`). Place the resulting access token and member URN into your local `.env`.
5. Set `LINKEDIN_API_VERSION` to a supported LinkedIn API version.
6. Only after checking the workflow end to end, set `LINKEDIN_PUBLISH_ENABLED=true` and restart the bot.

The LinkedIn API setup depends on LinkedIn's current product eligibility, app approval and access policies. The agent will not publish when these requirements are missing.

## Local configuration and security

- **Never commit** `.env`, `store/`, or `data/` — these contain credentials, auth sessions, and local state. They are ignored by Git.
- Treat WhatsApp's linked device (shown as Chrome/macOS due to the Baileys browser-identification setting) as a sensitive session. Only link accounts you control.
- Baileys is an **unofficial** WhatsApp Web integration and can be disconnected or restricted by WhatsApp.
- The agent never auto-retries uncertain LinkedIn publishing attempts; check your LinkedIn profile before manually reconciling a failed draft.
- RSS headlines and generated posts require **human fact-checking** before approval.
- The included bot supports **text-only posts**; images, analytics and a built-in public privacy policy page are not part of this implementation.

## Development

```bash
npm run typecheck
npm run linkedin:check
npm run build
```

The LinkedIn workflow has automated tests with mock responses for feed parsing, approval, edits, error handling and duplicate protection. Actual LinkedIn publishing requires an authorized account and has **not** been exercised by the tests.

For the detailed setup guide, see [docs/OPENROUTER_LINKEDIN.md](docs/OPENROUTER_LINKEDIN.md).

## Legacy NanoClaw runtime

The original source and Docker-based Claude agent runtime remain available for separate use:

```bash
npm run nanoclaw:start
```

This is **not** the recommended posting workflow because its original LinkedIn approval rules were prompt-based. Use the OpenRouter bot (`npm start`) for code-enforced post approval.

## License

See [LICENSE](LICENSE) for the retained upstream project license and attribution.


## Dedicated WhatsApp number for Andy

The bot must use a **different WhatsApp account** from the LinkedIn owner. Keep LINKEDIN_OWNER_JID set to the owner's existing personal number in international format (no plus sign), and set ASSISTANT_HAS_OWN_NUMBER=true.

The bot accepts incoming commands only in the owner's direct chat, ignores its own outgoing messages, and refuses to start if linked to the owner account. LinkedIn and OpenRouter credentials are unchanged.

Setup:

1. Stop the old bot before re-pairing.
2. Back up the old self-chat session rather than deleting it. A private backup is kept in store/auth-backups.
3. Run npm run auth and scan its QR with **Andy's second WhatsApp account** (WhatsApp or WhatsApp Business), not the owner's account. Use Linked Devices > Link a Device on that account.
4. Run npm start. From your personal WhatsApp, open the dedicated Andy chat and send status. The commands draft, status, edit, reject, and approve retain their previous behavior.

The second account needs its owner to complete QR linking. Baileys is an unofficial WhatsApp Web client and cannot guarantee delivery, but separating the sender and recipient avoids the problematic self-chat path.


## Free AI images for LinkedIn drafts

The standalone bot can use OpenRouter's free Recraft image model. Add these
values to .env (already configured on this machine):

- OPENROUTER_IMAGE_ENABLED=true
- OPENROUTER_IMAGE_MODEL=recraft/recraft-v4.1-flash-v2:free

Images are generated from the selected RSS story and the human-readable post,
saved privately to data/generated-images/, previewed in the approved owner's
WhatsApp chat, and uploaded to LinkedIn Images API only after an exact-ID
approval. WebP generations are converted locally to PNG. A failed generation
leaves the draft pending with a diagnostic and prevents approval while images
are enabled. No paid-model fallback is attempted. The free Recraft endpoint is
time-limited and may stop working after Nov 28, 2026; disable image generation
explicitly if you want to return to text-only drafts.

Text model charges are controlled separately by OPENROUTER_MODEL; the free
image model does not automatically make text generation free.

## Andy AI providers: GPT content + Gemini images

The standalone LinkedIn agent can use OpenAI for source analysis and post
writing, and Google Gemini for a 4:5 editorial image. Configure in .env:

- AI_TEXT_PROVIDER=openai
- OPENAI_API_KEY=...
- OPENAI_MODEL=openai/gpt-6.1-terra
- AI_IMAGE_PROVIDER=gemini
- GEMINI_API_KEY=...
- GEMINI_IMAGE_MODEL=google/gemini-3.1-flash-image
- GEMINI_IMAGE_SIZE=1K
- GEMINI_IMAGE_ASPECT_RATIO=4:5
- AI_IMAGE_ENABLED=true

RSS remains the news source of record. GPT analyzes current feed candidates and
writes a grounded, engaging post; it does not invent live news. Gemini creates
one topic-specific editorial illustration. If a provider is rate-limited or temporarily unavailable, Andy tries the explicitly configured OpenRouter image models in order. HTTP 402 (insufficient account credits) stops immediately because switching models cannot fix an empty shared balance. Sharp normalizes the selected image to a 1200x1500
PNG for LinkedIn. WhatsApp approval and exact-ID publishing remain unchanged.

These are metered API services. ChatGPT and Gemini app subscriptions do not
automatically include API credits. Add valid API keys only after checking
account credit eligibility and billing. The app does not silently fall back to
a different provider or paid model. A failed image generation blocks approval
while images are enabled. Set AI_IMAGE_ENABLED=false only if intentionally
returning to text-only drafts.


## Multi-user Andy web workspace (foundation)

Run the separate multi-user management dashboard alongside the original
single-owner bot:

    npm run platform

Open http://localhost:4177. The first administrator is created through
Set up your administrator account using PLATFORM_SETUP_KEY from the private
.env. Use a unique password of at least 12 characters.

The platform stores users, hashed sessions, WhatsApp profile records, LinkedIn
OAuth accounts, account mappings, draft records and audit events in
store/platform.db. LinkedIn access tokens are encrypted at rest using
PLATFORM_ENCRYPTION_KEY. Keep both platform keys private and back them up
securely. The server binds to 127.0.0.1 by default; use a TLS reverse proxy
before exposing it to a network or the internet.

For LinkedIn OAuth, add this exact callback URL to the LinkedIn developer app:
http://localhost:4177/api/linkedin/callback. The platform uses the existing
LINKEDIN_CLIENT_ID and LINKEDIN_CLIENT_SECRET server-side, while each user
authorizes their own LinkedIn profile.

The current web workspace is the multi-tenant management foundation. It does
not yet replace the standalone npm start bot: the shared Andy Baileys session
is still owner-only, the WhatsApp one-time verification code is not yet
consumed by the live message router, and the draft/approval/publishing worker
has not yet been migrated to per-user account mappings. WhatsApp profiles
therefore remain pending until that adapter is completed. Do not treat the
dashboard account records as live connected sessions until the adapter is
enabled.
