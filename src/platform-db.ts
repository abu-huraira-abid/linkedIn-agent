import Database from 'better-sqlite3';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

export type PlatformRole = 'admin' | 'member';
export type RecordStatus = 'active' | 'pending' | 'suspended' | 'expired';

export interface PlatformUser {
  id: string;
  name: string;
  email: string;
  role: PlatformRole;
  status: RecordStatus;
  created_at: string;
  updated_at: string;
}

export interface WhatsAppProfile {
  id: string;
  user_id: string;
  user_name?: string;
  label: string;
  phone_jid: string | null;
  lid_jid: string | null;
  display_name: string | null;
  status: RecordStatus;
  verified_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface LinkedInAccount {
  id: string;
  user_id: string;
  user_name?: string;
  display_name: string;
  member_urn: string;
  token_expires_at: string | null;
  scopes: string;
  status: RecordStatus;
  created_at: string;
  updated_at: string;
}

export interface AccountMapping {
  id: string;
  user_id: string;
  whatsapp_profile_id: string;
  linkedin_account_id: string;
  whatsapp_label?: string;
  whatsapp_display_name?: string | null;
  linkedin_display_name?: string;
  is_default: number;
  created_at: string;
}

export interface PlatformDraft {
  id: string;
  user_id: string;
  linkedin_account_id: string;
  status: string;
  text: string;
  source_title: string | null;
  source_url: string | null;
  image_path: string | null;
  published_id: string | null;
  created_at: string;
  updated_at: string;
}

export interface AuditEvent {
  id: string;
  actor_user_id: string | null;
  target_user_id: string | null;
  action: string;
  details_json: string;
  created_at: string;
}

export interface SessionUser extends PlatformUser {
  session_id: string;
}

export class PlatformDatabase {
  private db: Database.Database;

  constructor(filename: string) {
    fs.mkdirSync(path.dirname(filename), { recursive: true, mode: 0o700 });
    this.db = new Database(filename);
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('foreign_keys = ON');
    this.db.exec(
      'CREATE TABLE IF NOT EXISTS platform_users (' +
        'id TEXT PRIMARY KEY, name TEXT NOT NULL, email TEXT NOT NULL COLLATE NOCASE UNIQUE, ' +
        "password_hash TEXT NOT NULL, role TEXT NOT NULL CHECK(role IN ('admin','member')), " +
        "status TEXT NOT NULL DEFAULT 'active', created_at TEXT NOT NULL, updated_at TEXT NOT NULL);" +
        'CREATE TABLE IF NOT EXISTS platform_sessions (' +
        'id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES platform_users(id) ON DELETE CASCADE, ' +
        'token_hash TEXT NOT NULL UNIQUE, expires_at TEXT NOT NULL, created_at TEXT NOT NULL);' +
        'CREATE INDEX IF NOT EXISTS idx_platform_sessions_expiry ON platform_sessions(expires_at);' +
        'CREATE TABLE IF NOT EXISTS whatsapp_profiles (' +
        'id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES platform_users(id) ON DELETE CASCADE, ' +
        "label TEXT NOT NULL, phone_jid TEXT, lid_jid TEXT, display_name TEXT, status TEXT NOT NULL DEFAULT 'pending', " +
        'verified_at TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);' +
        'CREATE INDEX IF NOT EXISTS idx_whatsapp_phone ON whatsapp_profiles(phone_jid);' +
        'CREATE INDEX IF NOT EXISTS idx_whatsapp_lid ON whatsapp_profiles(lid_jid);' +
        'CREATE TABLE IF NOT EXISTS whatsapp_link_challenges (' +
        'id TEXT PRIMARY KEY, profile_id TEXT NOT NULL REFERENCES whatsapp_profiles(id) ON DELETE CASCADE, ' +
        'code_hash TEXT NOT NULL, expires_at TEXT NOT NULL, used_at TEXT, created_at TEXT NOT NULL);' +
        'CREATE INDEX IF NOT EXISTS idx_whatsapp_challenge_hash ON whatsapp_link_challenges(code_hash, expires_at);' +
        'CREATE TABLE IF NOT EXISTS linkedin_accounts (' +
        'id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES platform_users(id) ON DELETE CASCADE, ' +
        'display_name TEXT NOT NULL, member_urn TEXT NOT NULL, access_token_enc TEXT NOT NULL, ' +
        "token_expires_at TEXT, scopes TEXT NOT NULL DEFAULT 'openid profile email w_member_social', " +
        "status TEXT NOT NULL DEFAULT 'active', created_at TEXT NOT NULL, updated_at TEXT NOT NULL, " +
        'UNIQUE(user_id, member_urn));' +
        'CREATE TABLE IF NOT EXISTS account_mappings (' +
        'id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES platform_users(id) ON DELETE CASCADE, ' +
        'whatsapp_profile_id TEXT NOT NULL REFERENCES whatsapp_profiles(id) ON DELETE CASCADE, ' +
        'linkedin_account_id TEXT NOT NULL REFERENCES linkedin_accounts(id) ON DELETE CASCADE, ' +
        'is_default INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL, ' +
        'UNIQUE(whatsapp_profile_id, linkedin_account_id));' +
        'CREATE INDEX IF NOT EXISTS idx_mappings_user ON account_mappings(user_id);' +
        'CREATE TABLE IF NOT EXISTS platform_drafts (' +
        'id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES platform_users(id) ON DELETE CASCADE, ' +
        'linkedin_account_id TEXT NOT NULL REFERENCES linkedin_accounts(id) ON DELETE CASCADE, ' +
        'status TEXT NOT NULL, text TEXT NOT NULL, source_title TEXT, source_url TEXT, image_path TEXT, ' +
        'published_id TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);' +
        'CREATE INDEX IF NOT EXISTS idx_platform_drafts_user ON platform_drafts(user_id, updated_at DESC);' +
        'CREATE TABLE IF NOT EXISTS platform_oauth_states (' +
        'state_hash TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES platform_users(id) ON DELETE CASCADE, ' +
        'expires_at TEXT NOT NULL, created_at TEXT NOT NULL);' +
        'CREATE TABLE IF NOT EXISTS platform_audit_events (' +
        'id TEXT PRIMARY KEY, actor_user_id TEXT REFERENCES platform_users(id) ON DELETE SET NULL, ' +
        'target_user_id TEXT REFERENCES platform_users(id) ON DELETE SET NULL, action TEXT NOT NULL, ' +
        "details_json TEXT NOT NULL DEFAULT '{}', created_at TEXT NOT NULL);" +
        'CREATE INDEX IF NOT EXISTS idx_platform_audit_created ON platform_audit_events(created_at DESC);',
    );
  }

  close(): void {
    this.db.close();
  }

  private now(): string {
    return new Date().toISOString();
  }
  private id(): string {
    return crypto.randomUUID();
  }

  private hash(value: string): string {
    return crypto.createHash('sha256').update(value).digest('hex');
  }

  audit(
    actorId: string | null,
    targetId: string | null,
    action: string,
    details: Record<string, unknown> = {},
  ): void {
    this.db
      .prepare(
        'INSERT INTO platform_audit_events (id, actor_user_id, target_user_id, action, details_json, created_at) VALUES (?, ?, ?, ?, ?, ?)',
      )
      .run(
        this.id(),
        actorId,
        targetId,
        action,
        JSON.stringify(details),
        this.now(),
      );
  }

  countUsers(): number {
    return (
      this.db.prepare('SELECT COUNT(*) AS count FROM platform_users').get() as {
        count: number;
      }
    ).count;
  }

  createUser(input: {
    name: string;
    email: string;
    passwordHash: string;
    role?: PlatformRole;
  }): PlatformUser {
    const now = this.now();
    const id = this.id();
    this.db
      .prepare(
        "INSERT INTO platform_users (id, name, email, password_hash, role, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, 'active', ?, ?)",
      )
      .run(
        id,
        input.name.trim(),
        input.email.trim().toLowerCase(),
        input.passwordHash,
        input.role || 'member',
        now,
        now,
      );
    return this.getUser(id)!;
  }

  getUser(id: string): PlatformUser | null {
    return (
      (this.db
        .prepare(
          'SELECT id, name, email, role, status, created_at, updated_at FROM platform_users WHERE id = ?',
        )
        .get(id) as PlatformUser | undefined) || null
    );
  }

  getUserByEmail(
    email: string,
  ): (PlatformUser & { password_hash: string }) | null {
    return (
      (this.db
        .prepare(
          'SELECT id, name, email, role, status, password_hash, created_at, updated_at FROM platform_users WHERE email = ? COLLATE NOCASE',
        )
        .get(email.trim()) as
        | (PlatformUser & { password_hash: string })
        | undefined) || null
    );
  }

  listUsers(): PlatformUser[] {
    return this.db
      .prepare(
        'SELECT id, name, email, role, status, created_at, updated_at FROM platform_users ORDER BY created_at DESC',
      )
      .all() as PlatformUser[];
  }

  updateUser(
    id: string,
    changes: { name?: string; role?: PlatformRole; status?: RecordStatus },
  ): PlatformUser | null {
    const current = this.getUser(id);
    if (!current) return null;
    this.db
      .prepare(
        'UPDATE platform_users SET name = ?, role = ?, status = ?, updated_at = ? WHERE id = ?',
      )
      .run(
        changes.name?.trim() || current.name,
        changes.role || current.role,
        changes.status || current.status,
        this.now(),
        id,
      );
    return this.getUser(id);
  }

  createSession(userId: string, token: string, expiresAt: string): string {
    const id = this.id();
    this.db
      .prepare(
        'INSERT INTO platform_sessions (id, user_id, token_hash, expires_at, created_at) VALUES (?, ?, ?, ?, ?)',
      )
      .run(id, userId, this.hash(token), expiresAt, this.now());
    return id;
  }

  getSession(token: string): SessionUser | null {
    const row = this.db
      .prepare(
        'SELECT s.id AS session_id, u.id, u.name, u.email, u.role, u.status, u.created_at, u.updated_at ' +
          'FROM platform_sessions s JOIN platform_users u ON u.id = s.user_id ' +
          "WHERE s.token_hash = ? AND s.expires_at > ? AND u.status = 'active'",
      )
      .get(this.hash(token), this.now()) as SessionUser | undefined;
    return row || null;
  }

  deleteSession(token: string): void {
    this.db
      .prepare('DELETE FROM platform_sessions WHERE token_hash = ?')
      .run(this.hash(token));
  }

  cleanExpiredSessions(): void {
    this.db
      .prepare('DELETE FROM platform_sessions WHERE expires_at <= ?')
      .run(this.now());
    this.db
      .prepare('DELETE FROM platform_oauth_states WHERE expires_at <= ?')
      .run(this.now());
    this.db
      .prepare(
        'DELETE FROM whatsapp_link_challenges WHERE expires_at <= ? OR used_at IS NOT NULL',
      )
      .run(this.now());
  }

  createWhatsAppProfile(
    userId: string,
    label: string,
    phone: string,
  ): WhatsAppProfile {
    const digits = phone.replace(/[^0-9]/g, '');
    if (!/^\d{8,15}$/.test(digits))
      throw new Error(
        'Enter a WhatsApp number with country code (8-15 digits).',
      );
    const id = this.id();
    const now = this.now();
    this.db
      .prepare(
        "INSERT INTO whatsapp_profiles (id, user_id, label, phone_jid, status, created_at, updated_at) VALUES (?, ?, ?, ?, 'pending', ?, ?)",
      )
      .run(id, userId, label.trim(), digits + '@s.whatsapp.net', now, now);
    return this.getWhatsAppProfile(id)!;
  }

  getWhatsAppProfile(id: string): WhatsAppProfile | null {
    return (
      (this.db
        .prepare(
          'SELECT p.*, u.name AS user_name FROM whatsapp_profiles p JOIN platform_users u ON u.id = p.user_id WHERE p.id = ?',
        )
        .get(id) as WhatsAppProfile | undefined) || null
    );
  }

  listWhatsAppProfiles(userId?: string): WhatsAppProfile[] {
    const sql =
      'SELECT p.*, u.name AS user_name FROM whatsapp_profiles p JOIN platform_users u ON u.id = p.user_id ' +
      (userId ? 'WHERE p.user_id = ? ' : '') +
      'ORDER BY p.created_at DESC';
    return (
      userId ? this.db.prepare(sql).all(userId) : this.db.prepare(sql).all()
    ) as WhatsAppProfile[];
  }

  createWhatsAppChallenge(profileId: string): string {
    const profile = this.getWhatsAppProfile(profileId);
    if (!profile) throw new Error('WhatsApp profile not found.');
    if (profile.status === 'suspended')
      throw new Error('This WhatsApp profile is suspended.');
    const code = String(crypto.randomInt(100000, 1000000));
    const now = this.now();
    this.db
      .prepare(
        'UPDATE whatsapp_link_challenges SET used_at = ? WHERE profile_id = ? AND used_at IS NULL',
      )
      .run(now, profileId);
    this.db
      .prepare(
        'INSERT INTO whatsapp_link_challenges (id, profile_id, code_hash, expires_at, created_at) VALUES (?, ?, ?, ?, ?)',
      )
      .run(
        this.id(),
        profileId,
        this.hash(code),
        new Date(Date.now() + 15 * 60 * 1000).toISOString(),
        now,
      );
    return code;
  }

  verifyWhatsAppChallenge(
    code: string,
    phoneJid: string,
    lidJid: string | null,
    displayName: string,
  ): WhatsAppProfile | null {
    const hash = this.hash(code.trim());
    const now = this.now();
    const tx = this.db.transaction(() => {
      const row = this.db
        .prepare(
          'SELECT c.id AS challenge_id, p.id AS profile_id, p.phone_jid AS expected_phone ' +
            'FROM whatsapp_link_challenges c JOIN whatsapp_profiles p ON p.id = c.profile_id ' +
            "WHERE c.code_hash = ? AND c.used_at IS NULL AND c.expires_at > ? AND p.status = 'pending'",
        )
        .get(hash, now) as
        | {
            challenge_id: string;
            profile_id: string;
            expected_phone: string | null;
          }
        | undefined;
      if (!row || (row.expected_phone && row.expected_phone !== phoneJid))
        return null;
      this.db
        .prepare('UPDATE whatsapp_link_challenges SET used_at = ? WHERE id = ?')
        .run(now, row.challenge_id);
      this.db
        .prepare(
          "UPDATE whatsapp_profiles SET phone_jid = ?, lid_jid = ?, display_name = ?, status = 'active', verified_at = ?, updated_at = ? WHERE id = ?",
        )
        .run(phoneJid, lidJid, displayName, now, now, row.profile_id);
      return this.getWhatsAppProfile(row.profile_id);
    });
    return tx();
  }

  findWhatsAppProfileByJid(jid: string): WhatsAppProfile | null {
    return (
      (this.db
        .prepare(
          "SELECT * FROM whatsapp_profiles WHERE status = 'active' AND (phone_jid = ? OR lid_jid = ?) LIMIT 1",
        )
        .get(jid, jid) as WhatsAppProfile | undefined) || null
    );
  }

  createLinkedInAccount(input: {
    userId: string;
    displayName: string;
    memberUrn: string;
    encryptedToken: string;
    tokenExpiresAt: string | null;
    scopes: string;
  }): LinkedInAccount {
    const now = this.now();
    const id = this.id();
    this.db
      .prepare(
        'INSERT INTO linkedin_accounts (id, user_id, display_name, member_urn, access_token_enc, token_expires_at, scopes, status, created_at, updated_at) ' +
          "VALUES (?, ?, ?, ?, ?, ?, ?, 'active', ?, ?) " +
          "ON CONFLICT(user_id, member_urn) DO UPDATE SET display_name = excluded.display_name, access_token_enc = excluded.access_token_enc, token_expires_at = excluded.token_expires_at, scopes = excluded.scopes, status = 'active', updated_at = excluded.updated_at",
      )
      .run(
        id,
        input.userId,
        input.displayName,
        input.memberUrn,
        input.encryptedToken,
        input.tokenExpiresAt,
        input.scopes,
        now,
        now,
      );
    return this.getLinkedInAccountByUrn(input.userId, input.memberUrn)!;
  }

  getLinkedInAccountByUrn(
    userId: string,
    memberUrn: string,
  ): LinkedInAccount | null {
    return (
      (this.db
        .prepare(
          'SELECT id, user_id, display_name, member_urn, token_expires_at, scopes, status, created_at, updated_at FROM linkedin_accounts WHERE user_id = ? AND member_urn = ?',
        )
        .get(userId, memberUrn) as LinkedInAccount | undefined) || null
    );
  }

  getLinkedInAccount(
    id: string,
  ): (LinkedInAccount & { access_token_enc: string }) | null {
    return (
      (this.db
        .prepare(
          'SELECT id, user_id, display_name, member_urn, access_token_enc, token_expires_at, scopes, status, created_at, updated_at FROM linkedin_accounts WHERE id = ?',
        )
        .get(id) as
        | (LinkedInAccount & { access_token_enc: string })
        | undefined) || null
    );
  }

  listLinkedInAccounts(userId?: string): LinkedInAccount[] {
    const sql =
      'SELECT a.id, a.user_id, u.name AS user_name, a.display_name, a.member_urn, a.token_expires_at, a.scopes, a.status, a.created_at, a.updated_at ' +
      'FROM linkedin_accounts a JOIN platform_users u ON u.id = a.user_id ' +
      (userId ? 'WHERE a.user_id = ? ' : '') +
      'ORDER BY a.created_at DESC';
    return (
      userId ? this.db.prepare(sql).all(userId) : this.db.prepare(sql).all()
    ) as LinkedInAccount[];
  }

  createMapping(
    userId: string,
    whatsappProfileId: string,
    linkedinAccountId: string,
    isDefault: boolean,
  ): AccountMapping {
    const wa = this.db
      .prepare(
        "SELECT id, user_id FROM whatsapp_profiles WHERE id = ? AND status = 'active'",
      )
      .get(whatsappProfileId) as { id: string; user_id: string } | undefined;
    const li = this.db
      .prepare(
        "SELECT id, user_id FROM linkedin_accounts WHERE id = ? AND status = 'active'",
      )
      .get(linkedinAccountId) as { id: string; user_id: string } | undefined;
    if (!wa || !li || wa.user_id !== userId || li.user_id !== userId)
      throw new Error(
        'WhatsApp and LinkedIn accounts must belong to the same user and be active.',
      );
    const id = this.id();
    const now = this.now();
    const tx = this.db.transaction(() => {
      if (isDefault)
        this.db
          .prepare(
            'UPDATE account_mappings SET is_default = 0 WHERE user_id = ? AND whatsapp_profile_id = ?',
          )
          .run(userId, whatsappProfileId);
      this.db
        .prepare(
          'INSERT INTO account_mappings (id, user_id, whatsapp_profile_id, linkedin_account_id, is_default, created_at) VALUES (?, ?, ?, ?, ?, ?) ' +
            'ON CONFLICT(whatsapp_profile_id, linkedin_account_id) DO UPDATE SET is_default = excluded.is_default',
        )
        .run(
          id,
          userId,
          whatsappProfileId,
          linkedinAccountId,
          isDefault ? 1 : 0,
          now,
        );
    });
    tx();
    return this.listMappings(userId).find(
      (x) =>
        x.whatsapp_profile_id === whatsappProfileId &&
        x.linkedin_account_id === linkedinAccountId,
    )!;
  }

  createMappingForAccounts(
    whatsappProfileId: string,
    linkedinAccountId: string,
    isDefault: boolean,
  ): AccountMapping {
    const wa = this.db
      .prepare('SELECT user_id FROM whatsapp_profiles WHERE id = ?')
      .get(whatsappProfileId) as { user_id: string } | undefined;
    const li = this.db
      .prepare('SELECT user_id FROM linkedin_accounts WHERE id = ?')
      .get(linkedinAccountId) as { user_id: string } | undefined;
    if (!wa || !li || wa.user_id !== li.user_id)
      throw new Error(
        'WhatsApp and LinkedIn accounts must belong to the same user.',
      );
    return this.createMapping(
      wa.user_id,
      whatsappProfileId,
      linkedinAccountId,
      isDefault,
    );
  }

  listMappings(userId?: string): AccountMapping[] {
    const sql =
      'SELECT m.*, w.label AS whatsapp_label, w.display_name AS whatsapp_display_name, l.display_name AS linkedin_display_name, u.name AS user_name ' +
      'FROM account_mappings m JOIN whatsapp_profiles w ON w.id = m.whatsapp_profile_id JOIN linkedin_accounts l ON l.id = m.linkedin_account_id JOIN platform_users u ON u.id = m.user_id ' +
      (userId ? 'WHERE m.user_id = ? ' : '') +
      'ORDER BY m.is_default DESC, m.created_at DESC';
    return (
      userId ? this.db.prepare(sql).all(userId) : this.db.prepare(sql).all()
    ) as AccountMapping[];
  }

  deleteMapping(id: string, userId?: string): boolean {
    const sql =
      'DELETE FROM account_mappings WHERE id = ?' +
      (userId ? ' AND user_id = ?' : '');
    const result = userId
      ? this.db.prepare(sql).run(id, userId)
      : this.db.prepare(sql).run(id);
    return result.changes > 0;
  }

  upsertDraft(draft: PlatformDraft): void {
    this.db
      .prepare(
        'INSERT INTO platform_drafts (id, user_id, linkedin_account_id, status, text, source_title, source_url, image_path, published_id, created_at, updated_at) ' +
          'VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ' +
          'ON CONFLICT(id) DO UPDATE SET status = excluded.status, text = excluded.text, source_title = excluded.source_title, source_url = excluded.source_url, image_path = excluded.image_path, published_id = excluded.published_id, updated_at = excluded.updated_at',
      )
      .run(
        draft.id,
        draft.user_id,
        draft.linkedin_account_id,
        draft.status,
        draft.text,
        draft.source_title,
        draft.source_url,
        draft.image_path,
        draft.published_id,
        draft.created_at,
        draft.updated_at,
      );
  }

  listDrafts(userId?: string): PlatformDraft[] {
    const sql =
      'SELECT d.*, a.display_name AS linkedin_display_name, u.name AS user_name ' +
      'FROM platform_drafts d JOIN linkedin_accounts a ON a.id = d.linkedin_account_id JOIN platform_users u ON u.id = d.user_id ' +
      (userId ? 'WHERE d.user_id = ? ' : '') +
      'ORDER BY d.updated_at DESC LIMIT 200';
    return (
      userId ? this.db.prepare(sql).all(userId) : this.db.prepare(sql).all()
    ) as PlatformDraft[];
  }

  listAuditEvents(limit = 100): AuditEvent[] {
    return this.db
      .prepare(
        'SELECT * FROM platform_audit_events ORDER BY created_at DESC LIMIT ?',
      )
      .all(Math.min(Math.max(limit, 1), 500)) as AuditEvent[];
  }

  createOAuthState(userId: string, state: string): void {
    this.db
      .prepare(
        'INSERT INTO platform_oauth_states (state_hash, user_id, expires_at, created_at) VALUES (?, ?, ?, ?)',
      )
      .run(
        this.hash(state),
        userId,
        new Date(Date.now() + 10 * 60 * 1000).toISOString(),
        this.now(),
      );
  }

  consumeOAuthState(state: string): string | null {
    const hash = this.hash(state);
    const now = this.now();
    const row = this.db
      .prepare(
        'SELECT user_id FROM platform_oauth_states WHERE state_hash = ? AND expires_at > ?',
      )
      .get(hash, now) as { user_id: string } | undefined;
    if (!row) return null;
    this.db
      .prepare('DELETE FROM platform_oauth_states WHERE state_hash = ?')
      .run(hash);
    return row.user_id;
  }

  dashboardSummary(userId?: string): Record<string, number> {
    const scoped = userId ? ' WHERE user_id = ?' : '';
    const count = (table: string): number => {
      const row = (
        userId
          ? this.db
              .prepare('SELECT COUNT(*) AS count FROM ' + table + scoped)
              .get(userId)
          : this.db.prepare('SELECT COUNT(*) AS count FROM ' + table).get()
      ) as { count: number };
      return row.count;
    };
    const users = userId ? 1 : this.countUsers();
    return {
      users,
      whatsappProfiles: count('whatsapp_profiles'),
      activeWhatsApp: (
        (userId
          ? this.db
              .prepare(
                "SELECT COUNT(*) AS count FROM whatsapp_profiles WHERE user_id = ? AND status = 'active'",
              )
              .get(userId)
          : this.db
              .prepare(
                "SELECT COUNT(*) AS count FROM whatsapp_profiles WHERE status = 'active'",
              )
              .get()) as { count: number }
      ).count,
      linkedinAccounts: count('linkedin_accounts'),
      mappings: count('account_mappings'),
      drafts: count('platform_drafts'),
      published: (
        (userId
          ? this.db
              .prepare(
                "SELECT COUNT(*) AS count FROM platform_drafts WHERE user_id = ? AND status = 'published'",
              )
              .get(userId)
          : this.db
              .prepare(
                "SELECT COUNT(*) AS count FROM platform_drafts WHERE status = 'published'",
              )
              .get()) as { count: number }
      ).count,
    };
  }
}
