import { afterEach, describe, expect, it } from 'vitest';
import {
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  utimesSync,
  readdirSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { WhatsAppRetryCache } from './whatsapp-retry-cache.js';

const dirs: string[] = [];
function setup(): { cache: WhatsAppRetryCache; directory: string } {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'whatsapp-retry-'));
  dirs.push(directory);
  return { cache: new WhatsAppRetryCache(directory), directory };
}
afterEach(() => {
  for (const dir of dirs.splice(0))
    rmSync(dir, { recursive: true, force: true });
});
describe('WhatsAppRetryCache', () => {
  it('retains original message contents across process instances', () => {
    const { cache, directory } = setup();
    cache.put('ABC123DEF456', { conversation: 'Andy: Status update' });
    const reopened = new WhatsAppRetryCache(directory);
    expect(reopened.get('ABC123DEF456')?.conversation).toBe(
      'Andy: Status update',
    );
    expect(
      statSync(path.join(directory, 'ABC123DEF456.bin')).mode & 0o777,
    ).toBe(0o600);
    expect(statSync(directory).mode & 0o777).toBe(0o700);
  });
  it('refuses path traversal or malformed message IDs', () => {
    const { cache, directory } = setup();
    cache.put('../../etc/passwd', { conversation: 'no' });
    expect(cache.get('../../etc/passwd')).toBeUndefined();
    expect(readdirSync(directory)).toEqual([]);
  });
  it('expires and prunes old messages', () => {
    const { cache, directory } = setup();
    cache.put('ABC123DEF456', { conversation: 'old' });
    const file = path.join(directory, 'ABC123DEF456.bin');
    const old = new Date(Date.now() - 10 * 24 * 60 * 60 * 1000);
    utimesSync(file, old, old);
    cache.prune();
    expect(cache.get('ABC123DEF456')).toBeUndefined();
    expect(readdirSync(directory)).toEqual([]);
  });
});
