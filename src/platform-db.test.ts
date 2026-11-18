import { afterEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PlatformDatabase } from './platform-db.js';

const folders: string[] = [];
function fixture() {
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'andy-platform-'));
  folders.push(folder);
  return new PlatformDatabase(path.join(folder, 'platform.db'));
}
afterEach(() => {
  for (const folder of folders.splice(0))
    fs.rmSync(folder, { recursive: true, force: true });
});

describe('multi-tenant platform database', () => {
  it('keeps users, WhatsApp profiles and LinkedIn accounts isolated', () => {
    const db = fixture();
    const a = db.createUser({
      name: 'User A',
      email: 'a@example.com',
      passwordHash: 'hash-a',
    });
    const b = db.createUser({
      name: 'User B',
      email: 'b@example.com',
      passwordHash: 'hash-b',
    });
    const waA = db.createWhatsAppProfile(a.id, 'A WhatsApp', '923001111111');
    const waB = db.createWhatsAppProfile(b.id, 'B WhatsApp', '923002222222');
    expect(db.listWhatsAppProfiles(a.id).map((x) => x.id)).toEqual([waA.id]);
    expect(db.listWhatsAppProfiles(b.id).map((x) => x.id)).toEqual([waB.id]);
    expect(db.findWhatsAppProfileByJid(waA.phone_jid!)).toBeNull();
    db.close();
  });

  it('activates a WhatsApp profile only when the one-time code comes from its registered phone', () => {
    const db = fixture();
    const user = db.createUser({
      name: 'User A',
      email: 'a@example.com',
      passwordHash: 'hash-a',
    });
    const profile = db.createWhatsAppProfile(
      user.id,
      'A WhatsApp',
      '923001111111',
    );
    const code = db.createWhatsAppChallenge(profile.id);

    expect(
      db.verifyWhatsAppChallenge(
        code,
        '923009999999@s.whatsapp.net',
        '123@lid',
        'Wrong phone',
      ),
    ).toBeNull();
    expect(db.getWhatsAppProfile(profile.id)?.status).toBe('pending');

    const verified = db.verifyWhatsAppChallenge(
      code,
      '923001111111@s.whatsapp.net',
      '123@lid',
      'User A',
    );
    expect(verified?.status).toBe('active');
    expect(verified?.phone_jid).toBe('923001111111@s.whatsapp.net');
    expect(verified?.lid_jid).toBe('123@lid');
    expect(
      db.verifyWhatsAppChallenge(
        code,
        '923001111111@s.whatsapp.net',
        '123@lid',
        'User A',
      ),
    ).toBeNull();
    db.close();
  });

  it('only allows a mapping when both active accounts belong to the same user', () => {
    const db = fixture();
    const a = db.createUser({
      name: 'User A',
      email: 'a@example.com',
      passwordHash: 'hash-a',
    });
    const b = db.createUser({
      name: 'User B',
      email: 'b@example.com',
      passwordHash: 'hash-b',
    });
    const wa = db.createWhatsAppProfile(a.id, 'A WhatsApp', '923001111111');
    const liA = db.createLinkedInAccount({
      userId: a.id,
      displayName: 'LinkedIn A',
      memberUrn: 'urn:li:person:a',
      encryptedToken: 'cipher-a',
      tokenExpiresAt: null,
      scopes: 'w_member_social',
    });
    const liB = db.createLinkedInAccount({
      userId: b.id,
      displayName: 'LinkedIn B',
      memberUrn: 'urn:li:person:b',
      encryptedToken: 'cipher-b',
      tokenExpiresAt: null,
      scopes: 'w_member_social',
    });
    db.verifyWhatsAppChallenge(
      db.createWhatsAppChallenge(wa.id),
      wa.phone_jid!,
      null,
      'User A',
    );
    const activeWa = db.getWhatsAppProfile(wa.id)!;
    const mapping = db.createMapping(a.id, activeWa.id, liA.id, true);
    expect(db.listMappings(a.id)).toHaveLength(1);
    expect(() => db.createMapping(a.id, activeWa.id, liB.id, false)).toThrow(
      /same user/,
    );
    expect(db.deleteMapping(mapping.id, b.id)).toBe(false);
    db.close();
  });

  it('returns numeric dashboard counters for every summary metric', () => {
    const db = fixture();
    db.createUser({
      name: 'Admin',
      email: 'admin@example.com',
      passwordHash: 'hash',
      role: 'admin',
    });
    const summary = db.dashboardSummary();
    expect(summary).toEqual({
      users: 1,
      whatsappProfiles: 0,
      activeWhatsApp: 0,
      linkedinAccounts: 0,
      mappings: 0,
      drafts: 0,
      published: 0,
    });
    for (const value of Object.values(summary)) {
      expect(typeof value).toBe('number');
    }
    db.close();
  });

  it('stores only a hash of session tokens and expires sessions', () => {
    const db = fixture();
    const user = db.createUser({
      name: 'User A',
      email: 'a@example.com',
      passwordHash: 'hash-a',
    });
    db.createSession(
      user.id,
      'plain-session-token',
      new Date(Date.now() + 60_000).toISOString(),
    );
    expect(db.getSession('plain-session-token')?.id).toBe(user.id);
    db.deleteSession('plain-session-token');
    expect(db.getSession('plain-session-token')).toBeNull();
    db.close();
  });
});
