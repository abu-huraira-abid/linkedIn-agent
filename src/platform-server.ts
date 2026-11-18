import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { promisify } from 'node:util';
import { PlatformDatabase, PlatformUser } from './platform-db.js';
import { readEnvFile } from './env.js';

const platformEnv = readEnvFile([
  'PLATFORM_PORT',
  'PLATFORM_ENCRYPTION_KEY',
  'PLATFORM_SETUP_KEY',
  'LINKEDIN_CLIENT_ID',
  'LINKEDIN_CLIENT_SECRET',
  'LINKEDIN_REDIRECT_URI',
  'LINKEDIN_PERSON_URN',
  'NODE_ENV',
]);
for (const [key, value] of Object.entries(platformEnv))
  if (process.env[key] === undefined) process.env[key] = value;

const scrypt = promisify(crypto.scrypt);
const ROOT = process.cwd();
const PUBLIC_DIR = path.join(ROOT, 'public');
const PORT = Number(process.env.PLATFORM_PORT || 4177);
const SESSION_HOURS = 24 * 7;
const db = new PlatformDatabase(path.join(ROOT, 'store', 'platform.db'));
const encKey = process.env.PLATFORM_ENCRYPTION_KEY || '';
const clientId = process.env.LINKEDIN_CLIENT_ID || '';
const clientSecret = process.env.LINKEDIN_CLIENT_SECRET || '';
const redirectUri =
  process.env.LINKEDIN_REDIRECT_URI ||
  'http://localhost:' + PORT + '/api/linkedin/callback';

function json(res: http.ServerResponse, status: number, data: unknown): void {
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
  });
  res.end(JSON.stringify(data));
}
function cookie(res: http.ServerResponse, value: string, maxAge: number): void {
  res.setHeader(
    'Set-Cookie',
    'andy_session=' +
      value +
      '; HttpOnly; SameSite=Strict; Path=/; Max-Age=' +
      maxAge +
      (process.env.NODE_ENV === 'production' ? '; Secure' : ''),
  );
}
function getCookie(req: http.IncomingMessage, name: string): string {
  const raw = req.headers.cookie || '';
  const pair = raw
    .split(';')
    .map((x) => x.trim())
    .find((x) => x.startsWith(name + '='));
  return pair ? decodeURIComponent(pair.slice(name.length + 1)) : '';
}
async function body(
  req: http.IncomingMessage,
): Promise<Record<string, unknown>> {
  let raw = '';
  for await (const chunk of req) {
    raw += chunk.toString();
    if (raw.length > 1024 * 1024) throw new Error('Request too large');
  }
  return raw ? (JSON.parse(raw) as Record<string, unknown>) : {};
}
function safeEqual(a: string, b: string): boolean {
  const aa = Buffer.from(a);
  const bb = Buffer.from(b);
  return aa.length === bb.length && crypto.timingSafeEqual(aa, bb);
}
async function hashPassword(password: string): Promise<string> {
  const salt = crypto.randomBytes(16);
  const derived = (await scrypt(password, salt, 64)) as Buffer;
  return 'scrypt$' + salt.toString('hex') + '$' + derived.toString('hex');
}
async function checkPassword(
  password: string,
  stored: string,
): Promise<boolean> {
  const parts = stored.split('$');
  if (parts.length !== 3 || parts[0] !== 'scrypt') return false;
  const derived = (await scrypt(
    password,
    Buffer.from(parts[1], 'hex'),
    64,
  )) as Buffer;
  return safeEqual(derived.toString('hex'), parts[2]);
}
function encryptToken(token: string): string {
  if (!encKey) throw new Error('PLATFORM_ENCRYPTION_KEY is not configured');
  const key = crypto.createHash('sha256').update(encKey).digest();
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const ciphertext = Buffer.concat([
    cipher.update(token, 'utf8'),
    cipher.final(),
  ]);
  return [
    iv.toString('base64url'),
    cipher.getAuthTag().toString('base64url'),
    ciphertext.toString('base64url'),
  ].join('.');
}
function decryptToken(value: string): string {
  if (!encKey) throw new Error('PLATFORM_ENCRYPTION_KEY is not configured');
  const [iv, tag, ciphertext] = value.split('.');
  const key = crypto.createHash('sha256').update(encKey).digest();
  const decipher = crypto.createDecipheriv(
    'aes-256-gcm',
    key,
    Buffer.from(iv, 'base64url'),
  );
  decipher.setAuthTag(Buffer.from(tag, 'base64url'));
  return Buffer.concat([
    decipher.update(Buffer.from(ciphertext, 'base64url')),
    decipher.final(),
  ]).toString('utf8');
}
function userView(user: PlatformUser): Record<string, unknown> {
  return {
    id: user.id,
    name: user.name,
    email: user.email,
    role: user.role,
    status: user.status,
    created_at: user.created_at,
  };
}
async function authenticate(
  req: http.IncomingMessage,
): Promise<(PlatformUser & { session_id: string }) | null> {
  const token = getCookie(req, 'andy_session');
  return token ? db.getSession(token) : null;
}
function requireAdmin(user: PlatformUser): void {
  if (user.role !== 'admin')
    throw Object.assign(new Error('Administrator access required'), {
      status: 403,
    });
}
interface BotDraftFile {
  id: string;
  status: string;
  text: string;
  sources?: Array<{ title?: string; url?: string }>;
  createdAt: string;
  updatedAt: string;
  publishedId?: string;
  image?: { path?: string };
}

function syncBotDraft(): void {
  const filename = path.join(ROOT, 'data', 'linkedin-posts.json');
  if (!fs.existsSync(filename)) return;
  let draft: BotDraftFile;
  try {
    draft = JSON.parse(fs.readFileSync(filename, 'utf8')) as BotDraftFile;
  } catch {
    return;
  }
  if (
    !draft.id ||
    !draft.text ||
    !draft.createdAt ||
    !draft.updatedAt ||
    !['pending', 'publishing', 'published', 'rejected', 'failed'].includes(
      draft.status,
    )
  )
    return;

  const accounts = db.listLinkedInAccounts();
  const configuredUrn = process.env.LINKEDIN_PERSON_URN || '';
  const account = configuredUrn
    ? accounts.find((item) => item.member_urn === configuredUrn)
    : accounts.length === 1
      ? accounts[0]
      : undefined;
  // Never attach a bot draft to an arbitrary profile when multiple LinkedIn
  // accounts exist and the bot's configured author cannot be identified.
  if (!account) return;

  const source = draft.sources?.[0];
  db.upsertDraft({
    id: draft.id,
    user_id: account.user_id,
    linkedin_account_id: account.id,
    status: draft.status,
    text: draft.text,
    source_title: source?.title || null,
    source_url: source?.url || null,
    image_path: draft.image?.path || null,
    published_id: draft.publishedId || null,
    created_at: draft.createdAt,
    updated_at: draft.updatedAt,
  });
}

function validateText(value: unknown, max: number): string {
  if (typeof value !== 'string' || !value.trim() || value.length > max)
    throw new Error('Invalid input');
  return value.trim();
}
async function linkedinConnect(
  user: PlatformUser,
  res: http.ServerResponse,
): Promise<void> {
  if (!clientId || !clientSecret)
    throw new Error(
      'LinkedIn OAuth app credentials are not configured on the server',
    );
  const state = crypto.randomBytes(32).toString('base64url');
  db.createOAuthState(user.id, state);
  const params = new URLSearchParams({
    response_type: 'code',
    client_id: clientId,
    redirect_uri: redirectUri,
    scope: 'w_member_social openid profile email',
    state,
  });
  res.writeHead(302, {
    Location:
      'https://www.linkedin.com/oauth/v2/authorization?' + params.toString(),
    'Cache-Control': 'no-store',
  });
  res.end();
}
async function api(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  url: URL,
): Promise<void> {
  const method = req.method || 'GET';
  const route = url.pathname;
  if (route === '/api/health' && method === 'GET')
    return json(res, 200, { ok: true, service: 'andy-platform' });
  if (route === '/api/auth/login' && method === 'POST') {
    const input = await body(req);
    const email = validateText(input.email, 254);
    const password = validateText(input.password, 256);
    const user = db.getUserByEmail(email);
    if (
      !user ||
      user.status !== 'active' ||
      !(await checkPassword(password, user.password_hash))
    )
      return json(res, 401, { error: 'Email or password is incorrect' });
    const token = crypto.randomBytes(32).toString('base64url');
    db.createSession(
      user.id,
      token,
      new Date(Date.now() + SESSION_HOURS * 3600000).toISOString(),
    );
    cookie(res, token, SESSION_HOURS * 3600);
    db.audit(user.id, user.id, 'auth.login');
    return json(res, 200, { user: userView(user) });
  }
  if (route === '/api/auth/logout' && method === 'POST') {
    const token = getCookie(req, 'andy_session');
    if (token) db.deleteSession(token);
    cookie(res, '', 0);
    return json(res, 200, { ok: true });
  }
  if (route === '/api/auth/bootstrap' && method === 'POST') {
    if (db.countUsers() > 0)
      return json(res, 409, { error: 'Initial administrator already exists' });
    const input = await body(req);
    const setupKey = process.env.PLATFORM_SETUP_KEY || '';
    if (!setupKey || !safeEqual(String(input.setupKey || ''), setupKey))
      return json(res, 403, { error: 'Invalid setup key' });
    const name = validateText(input.name, 100);
    const email = validateText(input.email, 254);
    const password = validateText(input.password, 256);
    if (password.length < 12)
      return json(res, 400, {
        error: 'Use a password with at least 12 characters',
      });
    const user = db.createUser({
      name,
      email,
      passwordHash: await hashPassword(password),
      role: 'admin',
    });
    db.audit(user.id, user.id, 'admin.bootstrap');
    return json(res, 201, { user: userView(user) });
  }

  if (route === '/api/linkedin/callback' && method === 'GET') {
    const state = url.searchParams.get('state') || '';
    const code = url.searchParams.get('code') || '';
    const userId = db.consumeOAuthState(state);
    if (!userId || !code)
      return json(res, 400, {
        error: 'Invalid or expired LinkedIn OAuth state',
      });
    const tokenResponse = await fetch(
      'https://www.linkedin.com/oauth/v2/accessToken',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          grant_type: 'authorization_code',
          code,
          redirect_uri: redirectUri,
          client_id: clientId,
          client_secret: clientSecret,
        }),
      },
    );
    if (!tokenResponse.ok)
      throw new Error(
        'LinkedIn token exchange failed: HTTP ' + tokenResponse.status,
      );
    const tokenData = (await tokenResponse.json()) as {
      access_token?: string;
      expires_in?: number;
    };
    if (!tokenData.access_token)
      throw new Error('LinkedIn did not return an access token');
    const profileResponse = await fetch(
      'https://api.linkedin.com/v2/userinfo',
      { headers: { Authorization: 'Bearer ' + tokenData.access_token } },
    );
    if (!profileResponse.ok)
      throw new Error(
        'LinkedIn profile lookup failed: HTTP ' + profileResponse.status,
      );
    const profileData = (await profileResponse.json()) as {
      sub?: string;
      name?: string;
    };
    if (!profileData.sub)
      throw new Error('LinkedIn profile did not include a member ID');
    db.createLinkedInAccount({
      userId,
      displayName: profileData.name || 'LinkedIn member',
      memberUrn: 'urn:li:person:' + profileData.sub,
      encryptedToken: encryptToken(tokenData.access_token),
      tokenExpiresAt: tokenData.expires_in
        ? new Date(Date.now() + tokenData.expires_in * 1000).toISOString()
        : null,
      scopes: 'w_member_social openid profile email',
    });
    db.audit(userId, userId, 'linkedin.connected', { member: profileData.sub });
    res.writeHead(302, {
      Location: '/?connected=linkedin',
      'Cache-Control': 'no-store',
    });
    res.end();
    return;
  }

  const user = await authenticate(req);
  if (!user) return json(res, 401, { error: 'Please sign in' });
  if (route === '/api/auth/me' && method === 'GET')
    return json(res, 200, { user: userView(user) });

  if (route === '/api/dashboard' && method === 'GET') {
    syncBotDraft();
    return json(res, 200, {
      summary: db.dashboardSummary(user.role === 'admin' ? undefined : user.id),
      recentDrafts: db
        .listDrafts(user.role === 'admin' ? undefined : user.id)
        .slice(0, 8),
      whatsappProfiles: db.listWhatsAppProfiles(
        user.role === 'admin' ? undefined : user.id,
      ),
      linkedinAccounts: db.listLinkedInAccounts(
        user.role === 'admin' ? undefined : user.id,
      ),
      mappings: db.listMappings(user.role === 'admin' ? undefined : user.id),
      audit: user.role === 'admin' ? db.listAuditEvents(12) : [],
    });
  }
  if (route === '/api/users' && method === 'GET') {
    requireAdmin(user);
    return json(res, 200, { users: db.listUsers() });
  }
  if (route === '/api/users' && method === 'POST') {
    requireAdmin(user);
    const input = await body(req);
    const name = validateText(input.name, 100);
    const email = validateText(input.email, 254);
    const password = validateText(input.password, 256);
    if (password.length < 12)
      throw new Error('Password must contain at least 12 characters');
    const created = db.createUser({
      name,
      email,
      passwordHash: await hashPassword(password),
      role: input.role === 'admin' ? 'admin' : 'member',
    });
    db.audit(user.id, created.id, 'user.created');
    return json(res, 201, { user: userView(created) });
  }
  const userMatch = route.match(/^\/api\/users\/([a-f0-9-]+)$/);
  if (userMatch && method === 'PATCH') {
    requireAdmin(user);
    const input = await body(req);
    if (userMatch[1] === user.id && input.status === 'suspended')
      throw new Error('You cannot suspend your own administrator account');
    const updated = db.updateUser(userMatch[1], {
      ...(typeof input.name === 'string' ? { name: input.name } : {}),
      ...(input.role === 'admin' || input.role === 'member'
        ? { role: input.role }
        : {}),
      ...(input.status === 'active' || input.status === 'suspended'
        ? { status: input.status }
        : {}),
    });
    if (!updated) return json(res, 404, { error: 'User not found' });
    db.audit(user.id, updated.id, 'user.updated');
    return json(res, 200, { user: userView(updated) });
  }

  if (route === '/api/whatsapp-profiles' && method === 'GET') {
    return json(res, 200, {
      profiles: db.listWhatsAppProfiles(
        user.role === 'admin' ? undefined : user.id,
      ),
    });
  }
  if (route === '/api/whatsapp-profiles' && method === 'POST') {
    const input = await body(req);
    const targetUser =
      user.role === 'admin' && typeof input.userId === 'string'
        ? input.userId
        : user.id;
    if (user.role !== 'admin' && targetUser !== user.id)
      throw new Error('Forbidden');
    const profile = db.createWhatsAppProfile(
      targetUser,
      validateText(input.label, 80),
      validateText(input.phone, 30),
    );
    db.audit(user.id, targetUser, 'whatsapp.profile.created', {
      profileId: profile.id,
    });
    return json(res, 201, { profile });
  }
  const challengeMatch = route.match(
    /^\/api\/whatsapp-profiles\/([a-f0-9-]+)\/challenge$/,
  );
  if (challengeMatch && method === 'POST') {
    const profile = db.getWhatsAppProfile(challengeMatch[1]);
    if (!profile || (user.role !== 'admin' && profile.user_id !== user.id))
      return json(res, 404, { error: 'WhatsApp profile not found' });
    const code = db.createWhatsAppChallenge(profile.id);
    db.audit(user.id, profile.user_id, 'whatsapp.verification.started', {
      profileId: profile.id,
    });
    return json(res, 200, {
      code,
      expiresInMinutes: 15,
      instruction:
        'Send this code from the registered WhatsApp number to the shared Andy number using: connect CODE. The code expires in 15 minutes and can be used once.',
    });
  }

  if (route === '/api/linkedin/connect' && method === 'GET')
    return linkedinConnect(user, res);

  if (route === '/api/mappings' && method === 'GET')
    return json(res, 200, {
      mappings: db.listMappings(user.role === 'admin' ? undefined : user.id),
    });
  if (route === '/api/mappings' && method === 'POST') {
    const input = await body(req);
    const whatsappProfileId = validateText(input.whatsappProfileId, 64);
    const linkedinAccountId = validateText(input.linkedinAccountId, 64);
    const mapping =
      user.role === 'admin'
        ? db.createMappingForAccounts(
            whatsappProfileId,
            linkedinAccountId,
            input.isDefault === true,
          )
        : db.createMapping(
            user.id,
            whatsappProfileId,
            linkedinAccountId,
            input.isDefault === true,
          );
    db.audit(user.id, user.id, 'account.mapping.created', {
      mappingId: mapping.id,
    });
    return json(res, 201, { mapping });
  }
  const mappingMatch = route.match(/^\/api\/mappings\/([a-f0-9-]+)$/);
  if (mappingMatch && method === 'DELETE') {
    if (
      !db.deleteMapping(
        mappingMatch[1],
        user.role === 'admin' ? undefined : user.id,
      )
    )
      return json(res, 404, { error: 'Mapping not found' });
    db.audit(user.id, user.id, 'account.mapping.deleted', {
      mappingId: mappingMatch[1],
    });
    return json(res, 200, { ok: true });
  }

  if (route === '/api/drafts' && method === 'GET') {
    syncBotDraft();
    return json(res, 200, {
      drafts: db.listDrafts(user.role === 'admin' ? undefined : user.id),
    });
  }
  return json(res, 404, { error: 'Route not found' });
}

function serveStatic(
  req: http.IncomingMessage,
  res: http.ServerResponse,
): void {
  const pathname = new URL(req.url || '/', 'http://localhost').pathname;
  const requested = pathname === '/' ? 'index.html' : pathname.slice(1);
  const file = path.resolve(PUBLIC_DIR, requested);
  if (!file.startsWith(PUBLIC_DIR + path.sep))
    return json(res, 403, { error: 'Forbidden' });
  if (!fs.existsSync(file) || !fs.statSync(file).isFile())
    return json(res, 404, { error: 'Not found' });
  const ext = path.extname(file);
  const types: Record<string, string> = {
    '.html': 'text/html; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.js': 'text/javascript; charset=utf-8',
    '.svg': 'image/svg+xml',
  };
  res.writeHead(200, {
    'Content-Type': types[ext] || 'application/octet-stream',
    'X-Content-Type-Options': 'nosniff',
    'Cache-Control': 'no-cache',
  });
  fs.createReadStream(file).pipe(res);
}

export function startPlatformServer(): http.Server {
  const server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url || '/', 'http://localhost');
      if (url.pathname.startsWith('/api/')) await api(req, res, url);
      else serveStatic(req, res);
    } catch (error) {
      const status = Number((error as { status?: number }).status || 400);
      json(res, status, {
        error: error instanceof Error ? error.message : 'Unexpected error',
      });
    }
  });
  server.listen(PORT, '127.0.0.1', () =>
    console.log('Andy platform listening on http://localhost:' + PORT),
  );
  return server;
}

export function platformEncryptionKeyReady(): boolean {
  return encKey.length >= 32;
}

startPlatformServer();
