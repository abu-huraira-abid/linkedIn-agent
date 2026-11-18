/**
 * WhatsApp Authentication Script
 *
 * Run this during setup to authenticate with WhatsApp.
 * Displays QR code, waits for scan, saves credentials, then exits.
 *
 * Usage: npx tsx src/whatsapp-auth.ts
 */
import fs from 'fs';
import path from 'path';
import pino from 'pino';
// @ts-expect-error no type declarations
import qrcode from 'qrcode-terminal';
import readline from 'readline';

import {
  makeWASocket,
  Browsers,
  DisconnectReason,
  fetchLatestWaWebVersion,
  makeCacheableSignalKeyStore,
  useMultiFileAuthState,
} from '@whiskeysockets/baileys';

// Fix Baileys 6.x bug: getPlatformId sends charCode (49) instead of enum value (1).
// Fixed in Baileys 7.x but not backported. Without this, pairing codes fail with
// "couldn't link device" because WhatsApp receives an invalid platform ID.
// NOTE: Must use createRequire — ESM `import *` creates a read-only namespace.
import { createRequire } from 'module';
const _require = createRequire(import.meta.url);
const _generics = _require(
  '@whiskeysockets/baileys/lib/Utils/generics',
) as Record<string, unknown>;
const { proto } = _require('@whiskeysockets/baileys') as { proto: any };
_generics.getPlatformId = (browser: string): string => {
  const platformType =
    proto.DeviceProps.PlatformType[
      browser.toUpperCase() as keyof typeof proto.DeviceProps.PlatformType
    ];
  return platformType ? platformType.toString() : '1';
};

const AUTH_DIR = './store/auth';
const QR_FILE = './store/qr-data.txt';
const STATUS_FILE = './store/auth-status.txt';

// Baileys error objects can include complete encrypted packet buffers and IDs.
// The auth CLI prints sanitized connection statuses instead of protocol payloads.
const logger = pino({ level: 'silent' });
let socketGeneration = 0;
let restartAttempts = 0;
const delay = (ms: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, ms));

// Check for --pairing-code flag and phone number
const usePairingCode = process.argv.includes('--pairing-code');
const phoneArg = process.argv.find((_, i, arr) => arr[i - 1] === '--phone');

function askQuestion(prompt: string): Promise<string> {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });
  return new Promise((resolve) => {
    rl.question(prompt, (answer) => {
      rl.close();
      resolve(answer.trim());
    });
  });
}

async function connectSocket(
  phoneNumber?: string,
  isReconnect = false,
): Promise<void> {
  const { state, saveCreds } = await useMultiFileAuthState(AUTH_DIR);

  // In Baileys 6.x, QR-paired sessions may retain registered=false.
  // Reuse and validate existing credentials by connecting; do not infer that
  // registered=true is the only success signal.
  const generation = ++socketGeneration;
  const isCurrent = () => generation === socketGeneration;

  const { version } = await fetchLatestWaWebVersion({}).catch((err) => {
    logger.warn(
      { err },
      'Failed to fetch latest WA Web version, using default',
    );
    return { version: undefined };
  });
  const sock = makeWASocket({
    version,
    auth: {
      creds: state.creds,
      keys: makeCacheableSignalKeyStore(state.keys, logger),
    },
    printQRInTerminal: false,
    logger,
    browser: Browsers.macOS('Chrome'),
  });

  if (usePairingCode && phoneNumber && !state.creds.me) {
    // Request pairing code after a short delay for connection to initialize
    // Only on first connect (not reconnect after 515)
    setTimeout(async () => {
      try {
        const code = await sock.requestPairingCode(phoneNumber!);
        console.log(`\n🔗 Your pairing code: ${code}\n`);
        console.log('  1. Open WhatsApp on your phone');
        console.log('  2. Tap Settings → Linked Devices → Link a Device');
        console.log('  3. Tap "Link with phone number instead"');
        console.log(`  4. Enter this code: ${code}\n`);
        fs.writeFileSync(STATUS_FILE, `pairing_code:${code}`);
      } catch (err: any) {
        console.error('Failed to request pairing code:', err.message);
        process.exit(1);
      }
    }, 3000);
  }

  sock.ev.on('creds.update', saveCreds);

  sock.ev.on('connection.update', (update) => {
    if (!isCurrent()) return;
    const { connection, lastDisconnect, qr } = update;

    if (qr) {
      // Write raw QR data to file so the setup skill can render it
      fs.writeFileSync(QR_FILE, qr);
      console.log('Scan this QR code with WhatsApp:\n');
      console.log('  1. Open WhatsApp on your phone');
      console.log('  2. Tap Settings → Linked Devices → Link a Device');
      console.log('  3. Point your camera at the QR code below\n');
      qrcode.generate(qr, { small: true });
    }

    if (connection === 'close') {
      const reason = (lastDisconnect?.error as any)?.output?.statusCode;

      if (reason === DisconnectReason.loggedOut) {
        fs.writeFileSync(STATUS_FILE, 'failed:logged_out');
        console.log('\n✗ Logged out. Delete store/auth and try again.');
        process.exit(1);
      } else if (reason === DisconnectReason.timedOut) {
        fs.writeFileSync(STATUS_FILE, 'failed:qr_timeout');
        console.log('\n✗ QR code timed out. Please try again.');
        process.exit(1);
      } else if (reason === 515) {
        // A 515 restart is expected immediately following successful pairing.
        // Persist the new identity before creating the next socket. Older
        // socket events must not tear down the newly connected instance.
        if (++restartAttempts > 3) {
          fs.writeFileSync(STATUS_FILE, 'failed:too_many_pairing_restarts');
          console.error(
            'Pairing restarted repeatedly. Check Linked Devices before retrying.',
          );
          process.exit(1);
        }
        console.log(
          '\nWhatsApp requested restart after pairing; saving credentials...',
        );
        void (async () => {
          await saveCreds();
          await delay(500);
          if (isCurrent()) await connectSocket(phoneNumber, true);
        })().catch(() => {
          fs.writeFileSync(STATUS_FILE, 'failed:restart');
          console.error('Unable to restart the WhatsApp handshake.');
          process.exit(1);
        });
      } else {
        fs.writeFileSync(STATUS_FILE, `failed:${reason || 'unknown'}`);
        console.log('\n✗ Connection failed. Please try again.');
        process.exit(1);
      }
    }

    if (connection === 'open') {
      // Baileys QR pairing does not always set registered=true in 6.x.
      // Successful server connection and a persisted signed account identity
      // confirm that the linked-device handshake reached the open state.
      void (async () => {
        await saveCreds();
        const saved = JSON.parse(
          fs.readFileSync(path.join(AUTH_DIR, 'creds.json'), 'utf8'),
        ) as {
          me?: { id?: string };
          account?: unknown;
          signalIdentities?: unknown[];
        };
        if (!isCurrent()) return;
        if (
          !saved.me?.id ||
          !saved.account ||
          !saved.signalIdentities?.length
        ) {
          fs.writeFileSync(STATUS_FILE, 'failed:missing_identity');
          console.error('WhatsApp opened but account identity was not saved.');
          process.exit(1);
        }
        fs.writeFileSync(STATUS_FILE, 'authenticated');
        try {
          fs.unlinkSync(QR_FILE);
        } catch {}
        console.log('\nSuccessfully connected and saved WhatsApp identity.');
        console.log(
          'The first new messages still need to be tested for decryption.',
        );
        setTimeout(() => process.exit(0), 1200);
      })().catch(() => {
        fs.writeFileSync(STATUS_FILE, 'failed:credential_save');
        console.error('Could not save WhatsApp credentials.');
        process.exit(1);
      });
    }
  });
}

async function authenticate(): Promise<void> {
  fs.mkdirSync(AUTH_DIR, { recursive: true });

  // Clean up any stale QR/status files from previous runs
  try {
    fs.unlinkSync(QR_FILE);
  } catch {}
  try {
    fs.unlinkSync(STATUS_FILE);
  } catch {}

  let phoneNumber = phoneArg;
  if (usePairingCode && !phoneNumber) {
    phoneNumber = await askQuestion(
      'Enter your phone number (with country code, no + or spaces, e.g. 14155551234): ',
    );
  }

  console.log('Starting WhatsApp authentication...\n');

  await connectSocket(phoneNumber);
}

authenticate().catch((err) => {
  console.error('Authentication failed:', err.message);
  process.exit(1);
});
