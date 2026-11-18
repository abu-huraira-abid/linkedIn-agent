import { exec } from 'child_process';
import fs from 'fs';
import path from 'path';

import {
  makeWASocket,
  downloadMediaMessage,
  decryptPollVote,
  getAggregateVotesInPollMessage,
  getKeyAuthor,
  jidNormalizedUser,
  Browsers,
  DisconnectReason,
  fetchLatestWaWebVersion,
  makeCacheableSignalKeyStore,
  normalizeMessageContent,
  useMultiFileAuthState,
} from '@whiskeysockets/baileys';
import type {
  GroupMetadata,
  WAMessageKey,
  WASocket,
  proto as ProtoTypes,
} from '@whiskeysockets/baileys';
// proto is not statically analyzable as a named ESM export from this CJS module
import { createRequire } from 'module';
const { proto } = createRequire(import.meta.url)('@whiskeysockets/baileys') as {
  proto: typeof ProtoTypes;
};

import {
  ASSISTANT_HAS_OWN_NUMBER,
  ASSISTANT_NAME,
  STORE_DIR,
  WHATSAPP_OWNER_SEND_MODE,
} from '../config.js';
import {
  getLastGroupSync,
  getMessageContentById,
  storeMessageDirect,
  setLastGroupSync,
  updateChatName,
} from '../db.js';
import { logger } from '../logger.js';
import { WhatsAppRetryCache } from '../whatsapp-retry-cache.js';
import { OwnerLidVerification } from '../whatsapp-owner-verification.js';
import { PlatformDatabase } from '../platform-db.js';
import pino from 'pino';

// Baileys requires a pino-compatible logger instance
const baileysLogger = pino({ level: process.env.BAILEYS_LOG_LEVEL || 'warn' });
import {
  Channel,
  OnInboundMessage,
  OnChatMetadata,
  RegisteredGroup,
} from '../types.js';
import { registerChannel, ChannelOpts } from './registry.js';

const GROUP_SYNC_INTERVAL_MS = 24 * 60 * 60 * 1000; // 24 hours

export interface WhatsAppChannelOpts {
  /** Reject self-chat when the bot must have its own WhatsApp account. */
  ownerJid?: string;
  onMessage: OnInboundMessage;
  onChatMetadata: OnChatMetadata;
  onPollVote?: (
    chatJid: string,
    pollMessageId: string,
    selectedOptions: string[],
  ) => void;
  registeredGroups: () => Record<string, RegisteredGroup>;
}

export class WhatsAppChannel implements Channel {
  name = 'whatsapp';

  private sock!: WASocket;
  private connected = false;
  private lidToPhoneMap: Record<string, string> = {};
  private outgoingQueue: Array<{ jid: string; text: string }> = [];
  private flushing = false;
  private groupSyncTimerStarted = false;
  /** Cache of recently sent messages for retry requests (max 256 entries). */
  private sentMessageCache = new Map<string, ProtoTypes.IMessage>();
  private retryCache = new WhatsAppRetryCache(
    path.join(STORE_DIR, 'outbound-retry'),
  );
  /** Short-lived cache of phone-normalized group metadata for outbound sends. */
  private groupMetadataCache = new Map<
    string,
    { metadata: GroupMetadata; expiresAt: number }
  >();
  /** Bot's LID user ID (e.g. "80355281346633") for normalizing group mentions. */
  private botLidUser?: string;
  /** Resolve the initial connect() once the first successful open happens. */
  private pendingFirstOpen?: () => void;

  private opts: WhatsAppChannelOpts;
  private ownerVerification?: OwnerLidVerification;
  private platformDb = new PlatformDatabase(
    path.join(STORE_DIR, 'platform.db'),
  );

  constructor(opts: WhatsAppChannelOpts) {
    this.opts = opts;
    if (ASSISTANT_HAS_OWN_NUMBER && opts.ownerJid) {
      this.ownerVerification = new OwnerLidVerification(
        STORE_DIR,
        opts.ownerJid,
      );
    }
  }

  async connect(): Promise<void> {
    this.retryCache.prune();
    return new Promise<void>((resolve, reject) => {
      this.pendingFirstOpen = resolve;
      this.connectInternal().catch(reject);
    });
  }

  private async connectInternal(): Promise<void> {
    const authDir = path.join(STORE_DIR, 'auth');
    fs.mkdirSync(authDir, { recursive: true });

    const { state, saveCreds } = await useMultiFileAuthState(authDir);
    // Fail before connecting if existing auth belongs to the owner.
    // It must be an entirely separate WhatsApp account for dedicated mode.
    const existingPhone = state.creds.me?.id.split(':')[0].split('@')[0];
    const ownerPhone = this.opts.ownerJid?.split('@')[0];
    if (existingPhone && ownerPhone && existingPhone === ownerPhone) {
      throw new Error(
        'WhatsApp auth belongs to the owner. Pair a different account with npm run auth.',
      );
    }

    const { version } = await fetchLatestWaWebVersion({}).catch((err) => {
      logger.warn(
        { err },
        'Failed to fetch latest WA Web version, using default',
      );
      return { version: undefined };
    });
    this.sock = makeWASocket({
      version,
      auth: {
        creds: state.creds,
        keys: makeCacheableSignalKeyStore(state.keys, baileysLogger),
      },
      printQRInTerminal: false,
      logger: baileysLogger,
      browser: Browsers.macOS('Chrome'),
      cachedGroupMetadata: async (jid: string) =>
        this.getNormalizedGroupMetadata(jid),
      getMessage: async (key: WAMessageKey) => {
        const cached = this.sentMessageCache.get(key.id || '');
        if (cached) {
          if (
            cached.pollCreationMessage ||
            cached.pollCreationMessageV2 ||
            cached.pollCreationMessageV3
          ) {
            logger.info(
              {
                pollMessageFound: true,
                hasMessageSecret: !!cached.messageContextInfo?.messageSecret,
              },
              'Baileys poll vote lookup resolved creation message',
            );
          }
          return cached;
        }
        // Preserve original protocol content for mobile retries across restarts.
        const retained = key.id ? this.retryCache.get(key.id) : undefined;
        if (retained) return retained;
        // Backward compatibility with older chat database messages.
        const content =
          key.id && key.remoteJid
            ? getMessageContentById(key.id, key.remoteJid)
            : undefined;
        if (content) {
          logger.debug(
            { id: key.id },
            'getMessage: returning DB message for retry',
          );
          return proto.Message.fromObject({ conversation: content });
        }
        // An empty proto is truthy: Baileys may re-encrypt it as a real
        // message and consume the phone's retry attempt without content.
        // Returning undefined correctly signals "message unavailable".
        return undefined;
      },
    });

    this.sock.ev.on('connection.update', (update) => {
      const { connection, lastDisconnect, qr } = update;

      if (qr) {
        const msg =
          'WhatsApp authentication required. Run /setup in Claude Code.';
        logger.error(msg);
        exec(
          `osascript -e 'display notification "${msg}" with title "NanoClaw" sound name "Basso"'`,
        );
        setTimeout(() => process.exit(1), 1000);
      }

      if (connection === 'close') {
        this.connected = false;
        const reason = (
          lastDisconnect?.error as { output?: { statusCode?: number } }
        )?.output?.statusCode;
        const shouldReconnect = reason !== DisconnectReason.loggedOut;
        logger.info(
          {
            reason,
            shouldReconnect,
            queuedMessages: this.outgoingQueue.length,
          },
          'Connection closed',
        );

        if (shouldReconnect) {
          logger.info('Reconnecting...');
          this.connectInternal().catch((err) => {
            logger.error({ err }, 'Failed to reconnect, retrying in 5s');
            setTimeout(() => {
              this.connectInternal().catch((err2) => {
                logger.error({ err: err2 }, 'Reconnection retry failed');
              });
            }, 5000);
          });
        } else {
          logger.info('Logged out. Run /setup to re-authenticate.');
          process.exit(0);
        }
      } else if (connection === 'open') {
        // Dedicated bot must never send owner messages to its own account.
        // This runs before flushing queued messages or resolving connect().
        const connectedPhone = this.sock.user?.id.split(':')[0].split('@')[0];
        const ownerPhone = this.opts.ownerJid?.split('@')[0];
        if (ownerPhone && connectedPhone === ownerPhone) {
          logger.error(
            'Andy is linked to the owner WhatsApp account. Stop and pair a separate bot account.',
          );
          this.connected = false;
          // Do not attempt to send, flush, or reconnect under the owner's account.
          process.exit(1);
          return;
        }
        this.connected = true;
        logger.info('Connected to WhatsApp');
        if (this.ownerVerification) {
          const existingLid = this.ownerVerification.verifiedLid;
          if (existingLid && this.opts.ownerJid) {
            this.setLidPhoneMapping(
              existingLid.split('@')[0],
              this.opts.ownerJid,
            );
            logger.info('Verified owner LID restored from private binding');
          } else {
            const code = this.ownerVerification.begin();
            if (code) {
              console.log('\nOWNER WHATSAPP VERIFICATION REQUIRED');
              console.log(
                'From YOUR PERSONAL WhatsApp, send this exact command to Andy:',
              );
              console.log('verify ' + code);
              console.log('Code expires after 15 minutes. Do not share it.\n');
            }
          }
        }

        // Announce availability so WhatsApp relays subsequent presence updates (typing indicators)
        this.sock.sendPresenceUpdate('available').catch((err) => {
          logger.warn({ err }, 'Failed to send presence update');
        });

        // Build LID to phone mapping from auth state for self-chat translation
        if (this.sock.user) {
          const phoneUser = this.sock.user.id.split(':')[0];
          const lidUser = this.sock.user.lid?.split(':')[0];
          if (lidUser && phoneUser) {
            this.setLidPhoneMapping(lidUser, `${phoneUser}@s.whatsapp.net`);
            this.botLidUser = lidUser;
            logger.debug({ lidUser, phoneUser }, 'LID to phone mapping set');
          }
        }

        // Flush any messages queued while disconnected
        this.flushOutgoingQueue().catch((err) =>
          logger.error({ err }, 'Failed to flush outgoing queue'),
        );

        // Sync group metadata on startup (respects 24h cache)
        this.syncGroupMetadata().catch((err) =>
          logger.error({ err }, 'Initial group sync failed'),
        );
        // Set up daily sync timer (only once)
        if (!this.groupSyncTimerStarted) {
          this.groupSyncTimerStarted = true;
          setInterval(() => {
            this.syncGroupMetadata().catch((err) =>
              logger.error({ err }, 'Periodic group sync failed'),
            );
          }, GROUP_SYNC_INTERVAL_MS);
        }

        // Signal first connection to caller
        if (this.pendingFirstOpen) {
          this.pendingFirstOpen();
          this.pendingFirstOpen = undefined;
        }
      }
    });

    this.sock.ev.on('creds.update', saveCreds);

    this.sock.ev.on('chats.phoneNumberShare', ({ lid, jid }) => {
      const lidUser = lid?.split('@')[0].split(':')[0];
      if (lidUser && jid) {
        this.setLidPhoneMapping(lidUser, jid);
      }
    });

    // Baileys decrypts poll votes and emits them as messages.update entries.
    // Only votes in the configured owner DM are forwarded to the approval bot.
    this.sock.ev.on('messages.update', async (updates) => {
      for (const item of updates) {
        const pollId = item.key.id;
        const rawChatJid = item.key.remoteJid || '';
        const chatJid = rawChatJid ? await this.translateJid(rawChatJid) : '';
        const pollUpdates = item.update.pollUpdates;
        logger.info(
          {
            hasPollId: !!pollId,
            chatIsOwner:
              chatJid === this.opts.ownerJid ||
              rawChatJid === this.opts.ownerJid,
            jidType: rawChatJid.endsWith('@lid') ? 'lid' : 'phone',
            pollUpdateCount: pollUpdates?.length || 0,
          },
          'WhatsApp message update received',
        );
        if (
          !pollId ||
          (chatJid !== this.opts.ownerJid &&
            rawChatJid !== this.opts.ownerJid) ||
          !pollUpdates?.length
        ) {
          continue;
        }
        const creationMessage =
          this.sentMessageCache.get(pollId) || this.retryCache.get(pollId);
        if (!creationMessage) {
          logger.warn(
            { pollId },
            'Poll vote received but creation message is unavailable',
          );
          continue;
        }
        try {
          const votes = getAggregateVotesInPollMessage(
            { message: creationMessage, pollUpdates },
            this.sock.user?.id,
          );
          const ownerPhone = this.opts.ownerJid?.split('@')[0];
          const ownerLid = this.ownerVerification?.verifiedLid;
          const ownerSelections: string[] = [];
          for (const option of votes) {
            let ownerVoted = false;
            for (const voter of option.voters) {
              const voterUser = voter.split('@')[0].split(':')[0];
              const normalizedVoter = voter.endsWith('@lid')
                ? await this.translateJid(voter)
                : voter;
              if (
                voter === this.opts.ownerJid ||
                normalizedVoter === this.opts.ownerJid ||
                voterUser === ownerPhone ||
                (!!ownerLid &&
                  (voter === ownerLid || voterUser === ownerLid.split('@')[0]))
              ) {
                ownerVoted = true;
                break;
              }
            }
            if (ownerVoted) ownerSelections.push(option.name);
          }
          logger.info(
            {
              pollId,
              optionCount: votes.length,
              ownerSelectionCount: ownerSelections.length,
            },
            'WhatsApp poll vote aggregation completed',
          );
          if (ownerSelections.length) {
            this.opts.onPollVote?.(chatJid, pollId, ownerSelections);
          }
        } catch (err) {
          logger.error({ err, pollId }, 'Failed to decode WhatsApp poll vote');
        }
      }
    });

    this.sock.ev.on('messages.upsert', async ({ messages, type }) => {
      // These counts contain no message bodies, account numbers or JIDs.
      logger.info(
        {
          count: messages.length,
          type,
          decoded: messages.filter((message) => !!message.message).length,
        },
        'WhatsApp incoming batch',
      );
      for (const msg of messages) {
        try {
          if (!msg.message) continue;
          // Unwrap container types (viewOnceMessageV2, ephemeralMessage,
          // editedMessage, etc.) so that conversation, extendedTextMessage,
          // imageMessage, etc. are accessible at the top level.
          const normalized = normalizeMessageContent(msg.message);
          if (!normalized) continue;
          const rawJid = msg.key.remoteJid;
          if (!rawJid || rawJid === 'status@broadcast') continue;

          // Work around Baileys 6.17.x poll-key normalization in LID DMs.
          // The built-in processMessage mutates pollCreationMessageKey before
          // deriving pollCreatorJid, which can produce an AES-GCM auth failure.
          // This listener runs synchronously before Baileys' processMessage.
          const rawPollUpdate = normalized.pollUpdateMessage;
          const pollCreationKey = rawPollUpdate?.pollCreationMessageKey;
          const rawPollId = pollCreationKey?.id;
          if (rawPollUpdate?.vote && rawPollId) {
            const ownerLid = this.ownerVerification?.verifiedLid;
            const senderIsOwner =
              rawJid === this.opts.ownerJid ||
              (!!ownerLid && rawJid === ownerLid) ||
              (!!this.lidToPhoneMap[rawJid.split('@')[0]] &&
                this.lidToPhoneMap[rawJid.split('@')[0]] ===
                  this.opts.ownerJid);
            if (!senderIsOwner || msg.key.fromMe) {
              logger.warn(
                {
                  senderIsOwner,
                  jidType: rawJid.endsWith('@lid') ? 'lid' : 'phone',
                },
                'Ignoring poll vote outside verified owner DM',
              );
            } else {
              const creationMessage =
                this.sentMessageCache.get(rawPollId) ||
                this.retryCache.get(rawPollId);
              const pollSecret =
                creationMessage?.messageContextInfo?.messageSecret;
              const botJid = this.sock.user?.id
                ? jidNormalizedUser(this.sock.user.id)
                : '';
              if (!creationMessage || !pollSecret || !botJid) {
                logger.error(
                  {
                    pollCached: !!creationMessage,
                    pollSecretPresent: !!pollSecret,
                    botIdentityPresent: !!botJid,
                  },
                  'Cannot manually decrypt approval poll vote: poll context incomplete',
                );
              } else {
                try {
                  const voterJid = getKeyAuthor(msg.key, botJid);
                  // The poll was created by this bot account. Use its actual
                  // sending identity rather than the LID-rewritten chat key.
                  const pollCreatorJid = botJid;
                  const decryptedVote = decryptPollVote(rawPollUpdate.vote, {
                    pollCreatorJid,
                    pollMsgId: rawPollId,
                    pollEncKey: pollSecret,
                    voterJid,
                  });
                  const senderTimestampMs = Number(
                    rawPollUpdate.senderTimestampMs?.toString?.() ||
                      rawPollUpdate.senderTimestampMs ||
                      Date.now(),
                  );
                  const votes = getAggregateVotesInPollMessage(
                    {
                      message: creationMessage,
                      pollUpdates: [
                        {
                          pollUpdateMessageKey: msg.key,
                          vote: decryptedVote,
                          senderTimestampMs,
                        },
                      ],
                    },
                    botJid,
                  );
                  const ownerSelections = votes
                    .filter((option) =>
                      option.voters.some(
                        (voter) =>
                          voter === this.opts.ownerJid ||
                          voter === ownerLid ||
                          voter === rawJid,
                      ),
                    )
                    .map((option) => option.name)
                    .filter((name) => name !== 'Unknown');
                  logger.info(
                    {
                      pollId: rawPollId,
                      decrypted: true,
                      selectionCount: ownerSelections.length,
                    },
                    'Owner approval poll vote manually decrypted',
                  );
                  if (ownerSelections.length) {
                    this.opts.onPollVote?.(
                      this.opts.ownerJid!,
                      rawPollId,
                      ownerSelections,
                    );
                  }
                } catch (err) {
                  logger.error(
                    {
                      err,
                      pollId: rawPollId,
                      pollCreatorIdentity: 'bot-account',
                      voterIdentity: 'verified-owner',
                    },
                    'Manual approval poll vote decryption failed',
                  );
                }
              }
            }
          }

          // Translate LID JID to phone JID if applicable.
          // Prefer senderPn from the message key (available in newer WA protocol)
          // since translateJid may fail to resolve LID→phone via signalRepository.
          let chatJid = await this.translateJid(rawJid);
          // senderPn is an authoritative phone-number identity supplied by WA
          // on some LID messages. Prefer it to possibly stale cached mappings.
          if (rawJid.endsWith('@lid') && (msg.key as any).senderPn) {
            const pn = (msg.key as any).senderPn as string;
            const phoneUser = pn.split('@')[0].split(':')[0];
            if (/^\d+$/.test(phoneUser)) {
              const phoneJid = `${phoneUser}@s.whatsapp.net`;
              this.setLidPhoneMapping(
                rawJid.split('@')[0].split(':')[0],
                phoneJid,
              );
              chatJid = phoneJid;
            }
          }

          // Shared-number multi-user registration. This must run before the
          // legacy single-owner verification handler and before group routing.
          const inboundText =
            normalized.conversation ||
            normalized.extendedTextMessage?.text ||
            '';
          const connectMatch = inboundText.trim().match(/^connect\s+(\d{6})$/i);
          if (type === 'notify' && connectMatch && !msg.key.fromMe) {
            const phoneJid = chatJid.endsWith('@s.whatsapp.net') ? chatJid : '';
            if (!phoneJid) {
              logger.warn(
                { jidType: rawJid.endsWith('@lid') ? 'lid' : 'other' },
                'WhatsApp registration code received but sender phone could not be resolved',
              );
              await this.sendMessage(
                rawJid,
                'I received your code, but WhatsApp did not provide your phone identity. Please send a normal WhatsApp message again or share your contact with the Andy administrator.',
              );
              continue;
            }
            const profile = this.platformDb.verifyWhatsAppChallenge(
              connectMatch[1],
              phoneJid,
              rawJid.endsWith('@lid') ? rawJid : null,
              msg.pushName || phoneJid.split('@')[0],
            );
            if (profile) {
              if (rawJid.endsWith('@lid')) {
                this.setLidPhoneMapping(
                  rawJid.split('@')[0].split(':')[0],
                  phoneJid,
                );
              }
              logger.info(
                { profileId: profile.id, userId: profile.user_id },
                'Multi-user WhatsApp profile verified',
              );
              await this.sendMessage(
                phoneJid,
                'WhatsApp connected successfully! Your Andy profile is now active. You can return to the dashboard.',
              );
            } else {
              logger.warn(
                { phoneResolved: true },
                'Invalid, expired, already-used or phone-mismatched WhatsApp connection code',
              );
              await this.sendMessage(
                phoneJid,
                'That connection code is invalid, expired, already used, or belongs to another phone number. Generate a new code from your Andy dashboard and try again.',
              );
            }
            continue;
          }

          // In dedicated-number mode, WhatsApp syncs the bot's own messages
          // under its LID as well as phone JID. Those are not owner commands.
          // Ignore them before the registered-chat lookup to avoid false
          // "JID not found" warnings and accidental command processing.
          if (ASSISTANT_HAS_OWN_NUMBER) {
            const ownPhone = this.sock.user?.id.split(':')[0].split('@')[0];
            const ownLid = this.sock.user?.lid?.split(':')[0].split('@')[0];
            const rawUser = rawJid.split(':')[0].split('@')[0];
            const chatUser = chatJid.split(':')[0].split('@')[0];
            if (
              msg.key.fromMe ||
              (ownPhone && chatUser === ownPhone) ||
              (rawJid.endsWith('@lid') && ownLid && rawUser === ownLid)
            ) {
              if (type === 'notify') {
                logger.info('Ignored sync message belonging to Andy account');
              }
              continue;
            }
          }

          // Unknown LIDs are never owner-authorized automatically. Require
          // a one-time code shown only on the operator's local terminal.
          if (
            this.ownerVerification &&
            type === 'notify' &&
            rawJid.endsWith('@lid')
          ) {
            const challengeText =
              normalized.conversation ||
              normalized.extendedTextMessage?.text ||
              '';
            if (
              this.ownerVerification.tryVerify(
                rawJid,
                challengeText,
                !!msg.key.fromMe,
              )
            ) {
              if (this.opts.ownerJid) {
                chatJid = this.opts.ownerJid;
                this.setLidPhoneMapping(
                  rawJid.split('@')[0].split(':')[0],
                  chatJid,
                );
              }
              if (/^verify\s+/i.test(challengeText.trim())) {
                logger.info('Personal WhatsApp LID verified and saved');
                void this.sendMessage(
                  chatJid,
                  'Andy: Your WhatsApp is verified. Send status to continue.',
                );
                continue;
              }
            } else if (/^verify\s+/i.test(challengeText.trim())) {
              logger.warn(
                'Invalid or expired WhatsApp owner verification attempt',
              );
              continue;
            }
          }

          const timestamp = new Date(
            Number(msg.messageTimestamp) * 1000,
          ).toISOString();

          // Always notify about chat metadata for group discovery
          const isGroup = chatJid.endsWith('@g.us');
          this.opts.onChatMetadata(
            chatJid,
            timestamp,
            undefined,
            'whatsapp',
            isGroup,
          );

          // Only deliver full message for registered groups
          const groups = this.opts.registeredGroups();
          if (type === 'notify') {
            logger.info(
              {
                recognizedOwner: !!groups[chatJid],
                jidType: rawJid.endsWith('@lid') ? 'lid' : 'phone_or_other',
                phoneResolved: chatJid.endsWith('@s.whatsapp.net'),
                hasSenderPn: !!(msg.key as any).senderPn,
                fromMe: !!msg.key.fromMe,
              },
              'WhatsApp incoming message routing',
            );
          }
          if (groups[chatJid]) {
            let content =
              normalized.conversation ||
              normalized.extendedTextMessage?.text ||
              normalized.imageMessage?.caption ||
              normalized.videoMessage?.caption ||
              (normalized.imageMessage ? 'image' : '');

            // WhatsApp group mentions use the LID in raw text (e.g. "@80355281346633")
            // instead of the display name. Normalize to @AssistantName for trigger matching.
            if (this.botLidUser && content.includes(`@${this.botLidUser}`)) {
              content = content.replace(
                `@${this.botLidUser}`,
                `@${ASSISTANT_NAME}`,
              );
            }

            // Skip protocol messages with no text content (encryption keys, read receipts, etc.)
            if (!content) continue;

            const sender = msg.key.participant || msg.key.remoteJid || '';
            const senderName = msg.pushName || sender.split('@')[0];

            const fromMe = msg.key.fromMe || false;
            // Detect bot messages: with own number, fromMe is reliable
            // since only the bot sends from that number.
            // With shared number, bot messages carry the assistant name prefix
            // (even in DMs/self-chat) so we check for that.
            const isBotMessage = ASSISTANT_HAS_OWN_NUMBER
              ? fromMe
              : content.startsWith(`${ASSISTANT_NAME}:`);

            let imageData: Buffer | undefined;
            let imageMimeType: string | undefined;
            // Only download media in the configured owner control chat.
            if (chatJid === this.opts.ownerJid && normalized.imageMessage) {
              imageData = (await downloadMediaMessage(
                msg,
                'buffer',
                {},
                {
                  logger: baileysLogger,
                  reuploadRequest: this.sock.updateMediaMessage,
                },
              )) as Buffer;
              imageMimeType = normalized.imageMessage.mimetype || 'image/jpeg';
            }
            this.opts.onMessage(chatJid, {
              id: msg.key.id || '',
              chat_jid: chatJid,
              sender,
              sender_name: senderName,
              content,
              timestamp,
              is_from_me: fromMe,
              is_bot_message: isBotMessage,
              imageData,
              imageMimeType,
            });
          } else if (chatJid !== rawJid) {
            // LID translation produced a JID that doesn't match any registered group
            logger.warn(
              {
                rawJid,
                translatedJid: chatJid,
                registeredJids: Object.keys(groups),
              },
              'Message JID not found in registered groups after translation',
            );
          }
        } catch (err) {
          logger.error(
            { err, remoteJid: msg.key?.remoteJid },
            'Error processing incoming message',
          );
        }
      }
    });
  }

  /**
   * Use the LID Signal session already verified by the owner when replying.
   * Older Baileys versions sometimes encrypt to PN while the handset expects
   * LID, yielding an unreadable message on mobile. The explicit 'pn' setting
   * can restore the previous path if a particular handset requires it.
   */
  private resolveOutboundJid(jid: string): string {
    if (
      ASSISTANT_HAS_OWN_NUMBER &&
      WHATSAPP_OWNER_SEND_MODE === 'lid' &&
      jid === this.opts.ownerJid
    ) {
      const verifiedLid = this.ownerVerification?.verifiedLid;
      if (verifiedLid) return verifiedLid;
    }
    return jid;
  }

  async sendImage(
    jid: string,
    imagePath: string,
    caption: string,
  ): Promise<void> {
    if (!this.connected)
      throw new Error('WhatsApp disconnected; image preview not sent');
    const file = fs.readFileSync(imagePath);
    if (!file.length || file.length > 12 * 1024 * 1024)
      throw new Error('WhatsApp image file is empty or too large');
    const recipient = this.resolveOutboundJid(jid);
    const sent = await this.sock.sendMessage(recipient, {
      image: file,
      caption: caption.slice(0, 180),
    });
    if (sent?.key?.id && sent.message) {
      this.sentMessageCache.set(sent.key.id, sent.message);
      try {
        this.retryCache.put(sent.key.id, sent.message);
      } catch (e) {
        logger.warn({ err: e }, 'Unable to cache WhatsApp image retry');
      }
    }
    logger.info('WhatsApp draft image preview sent');
  }

  async sendPoll(
    jid: string,
    question: string,
    options: string[],
  ): Promise<string> {
    if (!this.connected)
      throw new Error('WhatsApp disconnected; poll not sent');
    if (options.length < 2 || options.length > 12)
      throw new Error('WhatsApp poll must have 2-12 options');
    const recipient = this.resolveOutboundJid(jid);
    const sent = await this.sock.sendMessage(recipient, {
      poll: {
        name: question.slice(0, 250),
        values: options.map((option) => option.slice(0, 100)),
        selectableCount: 1,
      },
    });
    const id = sent?.key?.id;
    if (!id || !sent.message)
      throw new Error('WhatsApp did not return the poll message ID');
    this.sentMessageCache.set(id, sent.message);
    this.retryCache.put(id, sent.message);
    logger.info(
      {
        pollMessageCached: true,
        hasMessageSecret: !!sent.message.messageContextInfo?.messageSecret,
        hasPollCreation: !!(
          sent.message.pollCreationMessage ||
          sent.message.pollCreationMessageV2 ||
          sent.message.pollCreationMessageV3
        ),
      },
      'WhatsApp approval poll cache initialized',
    );
    if (this.sentMessageCache.size > 256) {
      const oldest = this.sentMessageCache.keys().next().value;
      if (oldest) this.sentMessageCache.delete(oldest);
    }
    logger.info(
      { pollId: id, optionCount: options.length },
      'WhatsApp approval poll sent',
    );
    return id;
  }

  async sendMessage(jid: string, text: string): Promise<void> {
    // Prefix bot messages with assistant name so users know who's speaking.
    // On a shared number, prefix is also needed in DMs (including self-chat)
    // to distinguish bot output from user messages.
    // Skip only when the assistant has its own dedicated phone number.
    const prefixed = ASSISTANT_HAS_OWN_NUMBER
      ? text
      : `${ASSISTANT_NAME}: ${text}`;

    if (!this.connected) {
      this.outgoingQueue.push({ jid, text: prefixed });
      logger.info(
        { jid, length: prefixed.length, queueSize: this.outgoingQueue.length },
        'WA disconnected, message queued',
      );
      return;
    }
    try {
      const recipient = this.resolveOutboundJid(jid);
      logger.info(
        { routing: recipient.endsWith('@lid') ? 'verified-lid' : 'phone-jid' },
        'WhatsApp outbound recipient identity',
      );
      const sent = await this.sock.sendMessage(recipient, { text: prefixed });
      // WhatsApp may request re-encryption well after a bot restart.
      // Cache the exact protocol message in memory, and persist plaintext
      // locally for the existing getMessage DB fallback across restarts.
      if (sent?.key?.id && sent.message) {
        this.sentMessageCache.set(sent.key.id, sent.message);
        try {
          this.retryCache.put(sent.key.id, sent.message);
        } catch (err) {
          logger.warn({ err }, 'Unable to persist WhatsApp retry message');
        }
        // Chat history is optional here. Do not retry an already-sent
        // WhatsApp message if the local SQLite history write fails.
        try {
          storeMessageDirect({
            id: sent.key.id,
            chat_jid: sent.key.remoteJid || jid,
            sender: this.sock.user?.id || jid,
            sender_name: ASSISTANT_NAME,
            content: prefixed,
            timestamp: new Date().toISOString(),
            is_from_me: true,
            is_bot_message: true,
          });
        } catch (err) {
          logger.warn({ err }, 'Unable to persist WhatsApp chat history');
        }
        if (this.sentMessageCache.size > 256) {
          const oldest = this.sentMessageCache.keys().next().value!;
          this.sentMessageCache.delete(oldest);
        }
      }
      logger.info({ jid, length: prefixed.length }, 'Message sent');
    } catch (err) {
      // If send fails, queue it for retry on reconnect
      this.outgoingQueue.push({ jid, text: prefixed });
      logger.warn(
        { jid, err, queueSize: this.outgoingQueue.length },
        'Failed to send, message queued',
      );
    }
  }

  isConnected(): boolean {
    return this.connected;
  }

  ownsJid(jid: string): boolean {
    return jid.endsWith('@g.us') || jid.endsWith('@s.whatsapp.net');
  }

  async disconnect(): Promise<void> {
    this.connected = false;
    this.sock?.end(undefined);
  }

  async setTyping(jid: string, isTyping: boolean): Promise<void> {
    try {
      const status = isTyping ? 'composing' : 'paused';
      logger.debug({ jid, status }, 'Sending presence update');
      await this.sock.sendPresenceUpdate(status, jid);
    } catch (err) {
      logger.debug({ jid, err }, 'Failed to update typing status');
    }
  }

  async syncGroups(force: boolean): Promise<void> {
    return this.syncGroupMetadata(force);
  }

  /**
   * Sync group metadata from WhatsApp.
   * Fetches all participating groups and stores their names in the database.
   * Called on startup, daily, and on-demand via IPC.
   */
  async syncGroupMetadata(force = false): Promise<void> {
    if (!force) {
      const lastSync = getLastGroupSync();
      if (lastSync) {
        const lastSyncTime = new Date(lastSync).getTime();
        if (Date.now() - lastSyncTime < GROUP_SYNC_INTERVAL_MS) {
          logger.debug({ lastSync }, 'Skipping group sync - synced recently');
          return;
        }
      }
    }

    try {
      logger.info('Syncing group metadata from WhatsApp...');
      const groups = await this.sock.groupFetchAllParticipating();

      let count = 0;
      for (const [jid, metadata] of Object.entries(groups)) {
        if (metadata.subject) {
          updateChatName(jid, metadata.subject);
          count++;
        }
      }

      setLastGroupSync();
      logger.info({ count }, 'Group metadata synced');
    } catch (err) {
      logger.error({ err }, 'Failed to sync group metadata');
    }
  }

  private async translateJid(jid: string): Promise<string> {
    if (!jid.endsWith('@lid')) return jid;
    const lidUser = jid.split('@')[0].split(':')[0];

    // Check local cache first
    const cached = this.lidToPhoneMap[lidUser];
    if (cached) {
      logger.debug(
        { lidJid: jid, phoneJid: cached },
        'Translated LID to phone JID (cached)',
      );
      return cached;
    }

    // Query Baileys' signal repository for the mapping
    try {
      const pn = await (
        this.sock.signalRepository as any
      )?.lidMapping?.getPNForLID(jid);
      if (pn) {
        const phoneJid = `${pn.split('@')[0].split(':')[0]}@s.whatsapp.net`;
        this.setLidPhoneMapping(lidUser, phoneJid);
        logger.info(
          { lidJid: jid, phoneJid },
          'Translated LID to phone JID (signalRepository)',
        );
        return phoneJid;
      }
    } catch (err) {
      logger.debug({ err, jid }, 'Failed to resolve LID via signalRepository');
    }

    return jid;
  }

  private setLidPhoneMapping(lidUser: string, phoneJid: string): void {
    if (this.lidToPhoneMap[lidUser] === phoneJid) return;
    this.lidToPhoneMap[lidUser] = phoneJid;
    // Participant IDs in cached group metadata depend on this mapping.
    this.groupMetadataCache.clear();
  }

  private async getNormalizedGroupMetadata(
    jid: string,
    forceRefresh = false,
  ): Promise<GroupMetadata | undefined> {
    if (!jid.endsWith('@g.us')) return undefined;

    const cached = this.groupMetadataCache.get(jid);
    if (!forceRefresh && cached && cached.expiresAt > Date.now()) {
      return cached.metadata;
    }

    const metadata = await this.sock.groupMetadata(jid);
    const participants = await Promise.all(
      metadata.participants.map(async (participant) => ({
        ...participant,
        id: await this.translateJid(participant.id),
      })),
    );
    const normalized = { ...metadata, participants };
    const mappedCount = participants.filter(
      (participant, index) =>
        participant.id !== metadata.participants[index]?.id,
    ).length;

    logger.info(
      { jid, participantCount: participants.length, mappedCount },
      'Prepared normalized group metadata for send',
    );

    this.groupMetadataCache.set(jid, {
      metadata: normalized,
      expiresAt: Date.now() + 60_000,
    });
    return normalized;
  }

  private async flushOutgoingQueue(): Promise<void> {
    if (this.flushing || this.outgoingQueue.length === 0) return;
    this.flushing = true;
    try {
      logger.info(
        { count: this.outgoingQueue.length },
        'Flushing outgoing message queue',
      );
      while (this.outgoingQueue.length > 0) {
        const item = this.outgoingQueue.shift()!;
        // Send directly — queued items are already prefixed by sendMessage
        const recipient = this.resolveOutboundJid(item.jid);
        const sent = await this.sock.sendMessage(recipient, {
          text: item.text,
        });
        if (sent?.key?.id && sent.message) {
          this.sentMessageCache.set(sent.key.id, sent.message);
          try {
            this.retryCache.put(sent.key.id, sent.message);
          } catch (err) {
            logger.warn(
              { err },
              'Unable to persist queued WhatsApp retry message',
            );
          }
          try {
            storeMessageDirect({
              id: sent.key.id,
              chat_jid: sent.key.remoteJid || item.jid,
              sender: this.sock.user?.id || item.jid,
              sender_name: ASSISTANT_NAME,
              content: item.text,
              timestamp: new Date().toISOString(),
              is_from_me: true,
              is_bot_message: true,
            });
          } catch (err) {
            logger.warn(
              { err },
              'Unable to persist queued WhatsApp chat history',
            );
          }
          if (this.sentMessageCache.size > 256) {
            const oldest = this.sentMessageCache.keys().next().value!;
            this.sentMessageCache.delete(oldest);
          }
        }
        logger.info(
          { jid: item.jid, length: item.text.length },
          'Queued message sent',
        );
      }
    } finally {
      this.flushing = false;
    }
  }
}

registerChannel('whatsapp', (opts: ChannelOpts) => new WhatsAppChannel(opts));
