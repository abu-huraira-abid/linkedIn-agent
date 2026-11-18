# LinkedIn Daily Post Workflow

## Setup
- **Owner:** the person who owns this WhatsApp chat (referred to as "the owner" below)
- **Schedule:** Daily at 9:00 AM (owner's timezone, set via `TZ` in `.env`)
- **Config file:** `/workspace/group/linkedin_config.json` (copy `linkedin_config.example.json` and fill in real values; never commit it)

## How it works
1. Every day at 9am, a scheduled agent searches for AI & business news, writes a LinkedIn post in the owner's voice, saves it to `/workspace/group/linkedin_draft.md`, and sends a WhatsApp preview here.
2. When the owner replies **"post it"**, post the draft to LinkedIn immediately.
3. If the owner replies with edits ("shorter", "drop the second story", "make the take sharper"), rewrite the draft, overwrite `linkedin_draft.md`, and send a new preview. Do not post until the owner says "post it".

## Posting to LinkedIn ("post it" trigger)
When the owner says "post it":
1. Read the draft from `/workspace/group/linkedin_draft.md`
2. Read LinkedIn credentials from `/workspace/group/linkedin_config.json`
3. POST to LinkedIn API:
   ```
   POST https://api.linkedin.com/v2/ugcPosts
   Authorization: Bearer {token}
   Content-Type: application/json
   X-Restli-Protocol-Version: 2.0.0

   {
     "author": "{person_urn}",
     "lifecycleState": "PUBLISHED",
     "specificContent": {
       "com.linkedin.ugc.ShareContent": {
         "shareCommentary": { "text": "{post_text}" },
         "shareMediaCategory": "NONE"
       }
     },
     "visibility": { "com.linkedin.ugc.MemberNetworkVisibility": "PUBLIC" }
   }
   ```
4. Confirm success and delete/archive the draft.

## Post format (owner's voice)
- Hook opening line
- Key news summary (2-3 sentences)
- Business impact
- Personal take starting with "My two cents:"
- NO emojis
- Cite sources with links
- 3 hashtags at the end
- Under 1,300 characters
