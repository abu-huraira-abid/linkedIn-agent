/**
 * Standalone OpenRouter LinkedIn drafting service.
 * No Claude SDK, NanoClaw agent containers or OneCLI required.
 * Publishing is disabled unless explicitly enabled in .env.
 */
import fs from 'node:fs';
import path from 'node:path';
import { WhatsAppChannel } from './channels/whatsapp.js';
import { initDatabase } from './db.js';
import { readEnvFile } from './env.js';
import {
  createDraft,
  attachProvidedImage,
  getMetaAiPrompt,
  approveDraft,
  rejectDraft,
  reviseDraft,
  preview,
  DraftStore,
  settingsFromEnv,
} from './linkedin-service.js';
const keys = [
  'OPENROUTER_API_KEY',
  'OPENROUTER_TEXT_MODEL',
  'OPENROUTER_IMAGE_MODEL',
  'OPENROUTER_IMAGE_FALLBACKS',
  'GEMINI_IMAGE_SIZE',
  'GEMINI_IMAGE_ASPECT_RATIO',
  'AI_IMAGE_ENABLED',
  'LINKEDIN_ACCESS_TOKEN',
  'LINKEDIN_PERSON_URN',
  'LINKEDIN_API_VERSION',
  'LINKEDIN_PUBLISH_ENABLED',
  'LINKEDIN_OWNER_JID',
  'LINKEDIN_RSS_FEEDS',
  'LINKEDIN_TOPICS',
  'TZ',
  'LINKEDIN_DAILY_TIME',
];
// The project .env is authoritative for this standalone bot. Previously,
// stale empty values exported by `source .env` overrode newly saved OAuth
// credentials even after restarting the process.
const config = {
  ...Object.fromEntries(
    keys
      .filter((k) => process.env[k] !== undefined)
      .map((k) => [k, process.env[k]!]),
  ),
  ...readEnvFile(keys),
};
const owner = (config.LINKEDIN_OWNER_JID || '').trim();
const schedule = (config.LINKEDIN_DAILY_TIME || '09:00').trim();
if (!/^\d+@s\.whatsapp\.net$/.test(owner)) {
  console.error(
    'Set LINKEDIN_OWNER_JID=countrycodephonenumber@s.whatsapp.net in .env',
  );
  process.exit(1);
}
if (!/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(schedule)) {
  console.error('LINKEDIN_DAILY_TIME must be HH:MM');
  process.exit(1);
}
const zone = config.TZ || 'Asia/Karachi';
try {
  new Intl.DateTimeFormat('en-US', { timeZone: zone });
} catch {
  console.error('Invalid TZ');
  process.exit(1);
}
const settings = settingsFromEnv(config, path.join(process.cwd(), 'data'));
const store = new DraftStore(settings.stateFile);
let busy = false;
let awaitingEditDraftId: string | null = null;
interface ApprovalPollState {
  pollMessageId: string;
  draftId: string;
  handled: boolean;
  createdAt: string;
}
const approvalPollFile = path.join(
  process.cwd(),
  'data',
  'linkedin-approval-poll.json',
);
function readApprovalPoll(): ApprovalPollState | null {
  try {
    return JSON.parse(
      fs.readFileSync(approvalPollFile, 'utf8'),
    ) as ApprovalPollState;
  } catch {
    return null;
  }
}
function saveApprovalPoll(state: ApprovalPollState): void {
  fs.mkdirSync(path.dirname(approvalPollFile), {
    recursive: true,
    mode: 0o700,
  });
  const temp = approvalPollFile + '.' + process.pid + '.tmp';
  fs.writeFileSync(temp, JSON.stringify(state, null, 2), { mode: 0o600 });
  fs.renameSync(temp, approvalPollFile);
}
const tasksFile = path.join(process.cwd(), 'data', 'linkedin-schedule.json');
function scheduledDay(): string {
  try {
    return JSON.parse(fs.readFileSync(tasksFile, 'utf8')).day || '';
  } catch {
    return '';
  }
}
function saveScheduledDay(day: string): void {
  fs.mkdirSync(path.dirname(tasksFile), { recursive: true });
  fs.writeFileSync(tasksFile, JSON.stringify({ day }), { mode: 0o600 });
}
const opts = {
  ownerJid: owner,
  onMessage: (
    jid: string,
    msg: {
      content: string;
      is_bot_message?: boolean;
      sender: string;
      is_from_me?: boolean;
      imageData?: Buffer;
      imageMimeType?: string;
    },
  ) => {
    // Dedicated Andy account receives commands FROM the owner, never fromMe.
    // The chat JID is the authenticated owner; sender LIDs can differ.
    if (jid !== owner || msg.is_bot_message || msg.is_from_me) return;
    void handle(msg.content, msg.imageData, msg.imageMimeType);
  },
  onChatMetadata: () => {},
  onPollVote: (jid: string, pollMessageId: string, selections: string[]) => {
    void handlePollVote(jid, pollMessageId, selections);
  },
  registeredGroups: () => ({
    [owner]: {
      name: 'LinkedIn owner',
      folder: 'whatsapp_main',
      trigger: '',
      added_at: new Date().toISOString(),
      requiresTrigger: false,
      isMain: true,
    },
  }),
};
const whatsapp = new WhatsAppChannel(opts);
async function reply(text: string): Promise<void> {
  await whatsapp.sendMessage(owner, text);
}
async function deliverDraft(
  d: import('./linkedin-service.js').Draft,
): Promise<void> {
  await reply(preview(d));
  if (d.image) {
    try {
      await whatsapp.sendImage(
        owner,
        d.image.path,
        'Draft ' + d.id + ' visual preview',
      );
      const active = readApprovalPoll();
      if (d.status === 'pending' && (!active || active.draftId !== d.id)) {
        const pollMessageId = await whatsapp.sendPoll(
          owner,
          'What should Andy do with draft ' + d.id + '?',
          ['Approve & Publish', 'Reject Draft', 'Request Changes'],
        );
        saveApprovalPoll({
          pollMessageId,
          draftId: d.id,
          handled: false,
          createdAt: new Date().toISOString(),
        });
      }
    } catch (e) {
      await reply(
        'WhatsApp image/poll delivery failed: ' +
          String(e instanceof Error ? e.message : e),
      );
    }
  } else if (d.status === 'pending') {
    await reply(
      'Send the Meta AI image to this chat to attach it. Approval poll appears after the image is attached.',
    );
  }
}
async function generate(): Promise<void> {
  const d = await createDraft(settings, store);
  await deliverDraft(d);
}
async function handle(
  raw: string,
  imageData?: Buffer,
  imageMimeType?: string,
): Promise<void> {
  const message = raw.trim();
  if (!message || busy) return;
  const isCommand = [
    'draft',
    'status',
    'help',
    'image',
    'approve',
    'reject',
    'edit',
  ].some(
    (name) =>
      message.toLowerCase() === name ||
      message.toLowerCase().startsWith(name + ' '),
  );
  if (awaitingEditDraftId && !imageData && !isCommand) {
    const expectedId = awaitingEditDraftId;
    awaitingEditDraftId = null;
    busy = true;
    try {
      const current = store.load();
      if (!current || current.id !== expectedId || current.status !== 'pending')
        throw new Error(
          'The draft changed before your edit arrived. Send status to check the current draft.',
        );
      await reply('Updating your draft...');
      await deliverDraft(await reviseDraft(settings, store, message));
    } catch (e) {
      await reply('Edit failed: ' + String(e instanceof Error ? e.message : e));
    } finally {
      busy = false;
    }
    return;
  }
  const command = message.match(
    /^(draft|status|help|image|approve|reject|edit)(?:\s+([\s\S]+))?$/i,
  );
  if (!command) return;
  busy = true;
  try {
    switch (command[1].toLowerCase()) {
      case 'draft':
        await reply('Checking recent tech headlines and preparing a draft...');
        await generate();
        break;
      case 'status': {
        const d = store.load();
        if (d) await deliverDraft(d);
        else await reply('No draft yet. Reply draft to create one.');
        break;
      }
      case 'image':
        if (imageData) {
          await reply('Image received. Attaching it to your pending draft...');
          await deliverDraft(
            await attachProvidedImage(
              settings,
              store,
              imageData,
              imageMimeType,
            ),
          );
        } else {
          await reply(
            'Create this image in Meta AI, then send the generated image back here:\\n\\n' +
              getMetaAiPrompt(store) +
              '\\n\\nSend the image as a normal WhatsApp photo.',
          );
        }
        break;
      case 'help':
        await reply(
          'Commands: draft | status | image | edit <instructions> | approve <draft-id> | reject <draft-id>. Nothing publishes without an exact ID and enabled publishing.',
        );
        break;
      case 'edit':
        await deliverDraft(
          await reviseDraft(settings, store, command[2] || ''),
        );
        break;
      case 'reject': {
        const d = rejectDraft(store, (command[2] || '').trim());
        await reply('Rejected draft ' + d.id + '. No LinkedIn post created.');
        break;
      }
      case 'approve': {
        const d = await approveDraft(
          settings,
          store,
          (command[2] || '').trim(),
        );
        await reply(
          'Published on LinkedIn. Post ID: ' + (d.publishedId || 'unknown'),
        );
        break;
      }
    }
  } catch (e) {
    await reply('Action failed: ' + String(e instanceof Error ? e.message : e));
  } finally {
    busy = false;
  }
}
async function handlePollVote(
  jid: string,
  pollMessageId: string,
  selections: string[],
): Promise<void> {
  if (jid !== owner || busy) return;
  const poll = readApprovalPoll();
  if (!poll || poll.pollMessageId !== pollMessageId || poll.handled) {
    await reply(
      'This approval poll is expired or already handled. Send status for the current draft.',
    );
    return;
  }
  const selected = selections.length === 1 ? selections[0] : '';
  const draft = store.load();
  if (!draft || draft.id !== poll.draftId || draft.status !== 'pending') {
    saveApprovalPoll({ ...poll, handled: true });
    await reply(
      'This poll no longer matches the pending draft. Nothing was published.',
    );
    return;
  }
  if (
    !['Approve & Publish', 'Reject Draft', 'Request Changes'].includes(selected)
  ) {
    await reply('Please choose one option from Andy’s approval poll.');
    return;
  }
  // Mark first to make duplicate WhatsApp poll updates idempotent.
  saveApprovalPoll({ ...poll, handled: true });
  busy = true;
  try {
    if (selected === 'Approve & Publish') {
      await reply(
        'Approval received for draft ' +
          draft.id +
          '. Publishing to LinkedIn...',
      );
      const published = await approveDraft(settings, store, draft.id);
      await reply(
        'Published on LinkedIn. Post ID: ' +
          (published.publishedId || 'unknown'),
      );
    } else if (selected === 'Reject Draft') {
      rejectDraft(store, draft.id);
      await reply('Draft ' + draft.id + ' rejected. Nothing was published.');
    } else {
      awaitingEditDraftId = draft.id;
      await reply(
        'What would you like changed in draft ' +
          draft.id +
          '? Send your edit instructions as your next message.',
      );
    }
  } catch (error) {
    await reply(
      'Action failed: ' +
        String(error instanceof Error ? error.message : error),
    );
  } finally {
    busy = false;
  }
}

function tick(): void {
  if (busy) return;
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('en-US', {
      timeZone: zone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      hourCycle: 'h23',
    })
      .formatToParts(new Date())
      .map((p) => [p.type, p.value]),
  );
  const day = parts.year + '-' + parts.month + '-' + parts.day,
    time = parts.hour + ':' + parts.minute;
  if (time !== schedule || scheduledDay() === day) return;
  saveScheduledDay(day);
  void handle('draft');
}
console.log(
  'LinkedIn OpenRouter bot starting. Publish enabled: ' +
    !settings.dryRun +
    '. Timezone: ' +
    zone +
    '. Schedule: ' +
    schedule,
);
initDatabase();
await whatsapp.connect();
console.log(
  'WhatsApp connected. Commands are accepted only from configured owner account.',
);
setInterval(tick, 30000);
tick();
process.on('SIGINT', () => {
  void whatsapp.disconnect().finally(() => process.exit(0));
});
process.on('SIGTERM', () => {
  void whatsapp.disconnect().finally(() => process.exit(0));
});
