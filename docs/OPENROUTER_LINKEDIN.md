# OpenRouter LinkedIn bot (standalone mode)

This repository now includes a separate LinkedIn posting mode powered by OpenRouter. It reuses WhatsApp but does not require Claude, OneCLI, or Docker agent containers. The legacy NanoClaw runtime remains accessible with the nanoclaw:start npm script.

## Workflow
- Collects headlines dated within the last five days from configurable RSS feeds.
- Generates practical software and AI engineering posts using OpenRouter (default model: openrouter/free).
- Sends a WhatsApp preview with a unique eight-character draft ID.
- Commands: draft, status, edit <instructions>, reject <draft-id>, approve <draft-id>, help.
- Invalidates old approval IDs after revisions and never retries an uncertain LinkedIn post.
- Uses LinkedIn's /rest/posts endpoint.
- Publishing is disabled by default, even when an approval message is received.

## Local setup
1. Run: npm ci
2. Run: cp .env.example .env
3. Edit .env, set OPENROUTER_API_KEY from https://openrouter.ai/settings/keys, and run: chmod 600 .env
4. Set LINKEDIN_OWNER_JID to your international number followed by @s.whatsapp.net, e.g. 923001234567@s.whatsapp.net. The number in the example is a placeholder; use your own.
5. Keep TZ=Asia/Karachi and LINKEDIN_DAILY_TIME=09:00 or change to your preferred time.
6. Run: npm run auth. Scan the QR from WhatsApp > Linked devices. Credentials are stored in gitignored store/auth.
7. Run: npm run build
8. Run: npm start. In WhatsApp, message your own chat: draft. Use status, edit, and reject to test.
9. By default, the bot cannot publish to LinkedIn. Only turn on publishing after reviewing the configuration and tests.

## LinkedIn OAuth setup
1. Create a LinkedIn developer app and enable Share on LinkedIn and Sign In with LinkedIn using OpenID Connect. Required permission includes w_member_social.
2. Register http://localhost:8080/callback as an OAuth redirect URI.
3. Install Python requests into a virtual environment, if missing.
4. Set LINKEDIN_CLIENT_ID and LINKEDIN_CLIENT_SECRET in your shell only. Run: python3 scripts/linkedin_get_token.py
5. Copy the returned access token and person URN into LINKEDIN_ACCESS_TOKEN and LINKEDIN_PERSON_URN in .env. Never commit tokens or share them in chat.
6. Use a currently supported LINKEDIN_API_VERSION, e.g. 202608 at the time of this implementation.
7. When ready, set LINKEDIN_PUBLISH_ENABLED=true and restart the service. Reply with exactly approve <draft-id> on the WhatsApp draft preview. The phrase post it alone is not accepted.

## Warnings
- Headlines are leads, not verified full news articles. Independently check important claims before approving.
- Only text-only posts are supported. There is no automatic image generation or engagement analytics.
- If publishing times out or returns an error, the post is marked failed. Check your LinkedIn profile manually before taking any further action; there is no automatic retry.
- Only one draft can be pending or failed at a time. After an uncertain publish, manual state reconciliation is needed.
- The linked WhatsApp account uses unofficial Baileys and may need reconnection. WhatsApp restrictions can apply.
- This uses local SQLite and JSON state; a hosted PostgreSQL database such as Neon is not required.
- An always-running machine is required for scheduling and WhatsApp. Vercel is unsuitable. A Linux VPS with systemd is a suitable hosting environment.
- Do not use the older nanoclaw:start script for this posting workflow: the old approval instructions were only prompt-level.
- The current code has been tested with simulated AI and LinkedIn responses, not real credentials.

## Verification
Run: npm run linkedin:check
Run: npm run typecheck
Run: npm run build
