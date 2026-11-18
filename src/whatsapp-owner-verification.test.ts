import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { OwnerLidVerification } from './whatsapp-owner-verification.js';

const dirs: string[] = [];
const owner = '923000000000@s.whatsapp.net';
function create() {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'owner-lid-'));
  dirs.push(dir);
  return { dir, verifier: new OwnerLidVerification(dir, owner) };
}
afterEach(() => {
  for (const dir of dirs.splice(0))
    rmSync(dir, { recursive: true, force: true });
});
describe('OwnerLidVerification', () => {
  it('never automatically authorizes an unknown LID', () => {
    const { verifier } = create();
    expect(verifier.verifiedLid).toBeUndefined();
    expect(verifier.tryVerify('123456789@lid', 'status', false)).toBe(false);
  });
  it('binds an LID only with the generated code from an inbound message', () => {
    const { dir, verifier } = create();
    const code = verifier.begin()!;
    expect(verifier.tryVerify('123456789@lid', 'verify ' + code, true)).toBe(
      false,
    );
    expect(
      verifier.tryVerify('123456789@lid', 'verify ' + '0'.repeat(16), false),
    ).toBe(false);
    expect(verifier.tryVerify('123456789@lid', 'verify ' + code, false)).toBe(
      true,
    );
    expect(
      new OwnerLidVerification(dir, owner).isVerified('123456789@lid'),
    ).toBe(true);
    expect(
      new OwnerLidVerification(dir, '923111111111@s.whatsapp.net').isVerified(
        '123456789@lid',
      ),
    ).toBe(false);
    expect(verifier.isVerified('987654321@lid')).toBe(false);
  });
  it('rejects malformed identifiers and non-verification commands', () => {
    const { verifier } = create();
    const code = verifier.begin()!;
    expect(verifier.tryVerify('../bad', 'verify ' + code, false)).toBe(false);
    expect(verifier.tryVerify('123456789@lid', 'approve 12345678', false)).toBe(
      false,
    );
    expect(verifier.isVerified('123456789@lid')).toBe(false);
  });
});
