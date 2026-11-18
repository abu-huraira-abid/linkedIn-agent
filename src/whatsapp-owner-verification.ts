import fs from 'node:fs';
import path from 'node:path';
import { randomBytes, timingSafeEqual } from 'node:crypto';

interface VerifiedOwner {
  ownerJid: string;
  lidJid: string;
  verifiedAt: string;
}

const EXPIRES_MS = 15 * 60 * 1000;
const MAX_ATTEMPTS = 8;

/**
 * An LID cannot safely be assumed to belong to an owner's phone number.
 * The operator must prove access to this laptop's terminal and the sending
 * WhatsApp account by replying with the one-time code printed at startup.
 * An approved binding is persisted and restricted to the configured owner.
 */
export class OwnerLidVerification {
  private readonly file: string;
  private approved?: string;
  private code?: string;
  private expiresAt = 0;
  private attempts = 0;

  constructor(
    private readonly directory: string,
    private readonly ownerJid: string,
  ) {
    this.file = path.join(directory, 'verified-owner-lid.json');
    try {
      const parsed = JSON.parse(
        fs.readFileSync(this.file, 'utf8'),
      ) as VerifiedOwner;
      if (
        parsed.ownerJid === ownerJid &&
        /^\d+@lid$/.test(parsed.lidJid) &&
        typeof parsed.verifiedAt === 'string'
      ) {
        this.approved = parsed.lidJid;
      }
    } catch {
      // No verified binding yet; never auto-trust unknown senders.
    }
  }

  get verifiedLid(): string | undefined {
    return this.approved;
  }

  isVerified(lid: string): boolean {
    return this.approved === lid;
  }

  begin(): string | undefined {
    if (this.approved) return undefined;
    this.code = randomBytes(8).toString('hex').toUpperCase();
    this.expiresAt = Date.now() + EXPIRES_MS;
    this.attempts = 0;
    return this.code;
  }

  tryVerify(lid: string, text: string, fromMe: boolean): boolean {
    if (fromMe || !/^\d+@lid$/.test(lid)) return false;
    if (this.approved === lid) return true;
    const match = text.trim().match(/^verify\s+([0-9a-f]{16})$/i);
    if (
      !match ||
      !this.code ||
      Date.now() > this.expiresAt ||
      this.attempts >= MAX_ATTEMPTS
    ) {
      return false;
    }
    this.attempts++;
    const expected = Buffer.from(this.code, 'hex');
    const provided = Buffer.from(match[1], 'hex');
    if (
      expected.length !== provided.length ||
      !timingSafeEqual(expected, provided)
    )
      return false;
    const previous = this.approved;
    this.approved = lid;
    this.code = undefined;
    try {
      fs.mkdirSync(this.directory, { recursive: true, mode: 0o700 });
      const target = this.file + '.tmp-' + process.pid;
      fs.writeFileSync(
        target,
        JSON.stringify({
          ownerJid: this.ownerJid,
          lidJid: lid,
          verifiedAt: new Date().toISOString(),
        }),
        { mode: 0o600 },
      );
      fs.renameSync(target, this.file);
    } catch (err) {
      this.approved = previous;
      throw err;
    }
    return true;
  }
}
