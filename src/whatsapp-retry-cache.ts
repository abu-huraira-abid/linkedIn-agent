import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import type { proto as ProtoTypes } from '@whiskeysockets/baileys';

// Baileys 6.x is CommonJS, so its `proto` object cannot be named-imported
// by Node's ESM runtime (even when TypeScript accepts the source import).
const { proto } = createRequire(import.meta.url)('@whiskeysockets/baileys') as {
  proto: typeof ProtoTypes;
};

const MAX_FILES = 512;
const MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * Outgoing message retry cache. Baileys may ask for the original protocol
 * message when a recipient (especially another linked device) cannot decrypt.
 * Keep a bounded copy across process restarts, separate from NanoClaw's chat DB.
 */
export class WhatsAppRetryCache {
  constructor(private readonly directory: string) {
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
    try {
      fs.chmodSync(directory, 0o700);
    } catch {
      // Restricted files remain protected by the user's process permissions.
    }
  }

  private file(id: string): string | undefined {
    // Baileys message ids are opaque. Never allow filesystem traversal.
    if (!/^[A-Za-z0-9_-]{6,160}$/.test(id)) return undefined;
    return path.join(this.directory, id + '.bin');
  }

  get(id: string): ProtoTypes.IMessage | undefined {
    const file = this.file(id);
    if (!file) return undefined;
    try {
      const stat = fs.statSync(file);
      if (Date.now() - stat.mtimeMs > MAX_AGE_MS) {
        fs.unlinkSync(file);
        return undefined;
      }
      return proto.Message.decode(fs.readFileSync(file));
    } catch {
      return undefined;
    }
  }

  put(id: string, message: ProtoTypes.IMessage): void {
    const file = this.file(id);
    if (!file) return;
    const encoded = proto.Message.encode(message).finish();
    const temp = file + '.tmp-' + process.pid;
    try {
      fs.writeFileSync(temp, Buffer.from(encoded), { mode: 0o600, flag: 'w' });
      fs.renameSync(temp, file);
    } finally {
      try {
        if (fs.existsSync(temp)) fs.unlinkSync(temp);
      } catch {
        // Ignore temporary file cleanup errors.
      }
    }
  }

  prune(): void {
    const entries = fs
      .readdirSync(this.directory, { withFileTypes: true })
      .filter((e) => e.isFile() && /^[A-Za-z0-9_-]{6,160}\.bin$/.test(e.name))
      .flatMap((e) => {
        try {
          return [
            {
              path: path.join(this.directory, e.name),
              mtimeMs: fs.statSync(path.join(this.directory, e.name)).mtimeMs,
            },
          ];
        } catch {
          return [];
        }
      })
      .sort((a, b) => b.mtimeMs - a.mtimeMs);
    for (const [index, entry] of entries.entries()) {
      if (index >= MAX_FILES || Date.now() - entry.mtimeMs > MAX_AGE_MS) {
        try {
          fs.unlinkSync(entry.path);
        } catch {
          /* best effort */
        }
      }
    }
  }
}
