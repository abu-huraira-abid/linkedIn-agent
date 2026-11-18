import { afterEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { generateGeminiImage } from './gemini-image.js';

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0))
    fs.rmSync(d, { recursive: true, force: true });
});
const source = {
  title: 'AI agent authorization and security',
  summary: 'Engineering teams evaluate actions against intent and policy.',
  url: 'https://example.com/ai-security',
  date: '2026-11-17',
};
const png = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aH+0AAAAASUVORK5CYII=',
  'base64',
);
const options = {
  model: 'google/gemini-3.1-flash-lite-image',
  fallbackModels: ['openai/gpt-5-image-mini', 'google/gemini-3.1-flash-image'],
  size: '1K',
  aspectRatio: '4:5',
};
const ok = () =>
  new Response(
    JSON.stringify({
      data: [{ b64_json: png.toString('base64'), media_type: 'image/png' }],
      usage: { cost: 0.002 },
    }),
    { status: 200 },
  );

describe('OpenRouter image fallback', () => {
  it('uses the primary image model and returns its image', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gemini-image-test-'));
    dirs.push(dir);
    const http = vi.fn(async (url: string, init?: RequestInit) => {
      expect(url).toBe('https://openrouter.ai/api/v1/images');
      expect(init?.headers).toMatchObject({
        Authorization: 'Bearer shared-openrouter-key',
      });
      expect(JSON.parse(String(init?.body)).model).toBe(options.model);
      return ok();
    });
    const result = await generateGeminiImage(
      source,
      'AI actions need context-aware authorization.',
      'aabbccdd',
      'shared-openrouter-key',
      path.join(dir, 'linkedin-posts.json'),
      options,
      http,
    );
    expect(result.image.mime).toBe('image/png');
    expect(fs.existsSync(result.image.path)).toBe(true);
    expect(result.image.model).toBe(options.model);
    expect(result.attempts).toHaveLength(1);
  });

  it('falls through on provider rate limit and records the successful model', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gemini-image-test-'));
    dirs.push(dir);
    const seen: string[] = [];
    const http = vi.fn(async (_url: string, init?: RequestInit) => {
      const model = JSON.parse(String(init?.body)).model as string;
      seen.push(model);
      return model === options.model
        ? new Response('rate limited', { status: 429 })
        : ok();
    });
    const result = await generateGeminiImage(
      source,
      'post',
      'aabbccdd',
      'key',
      path.join(dir, 'linkedin-posts.json'),
      options,
      http,
    );
    expect(seen).toEqual([options.model, 'openai/gpt-5-image-mini']);
    expect(result.image.model).toBe('openai/gpt-5-image-mini');
    expect(result.attempts.map((x) => x.status)).toEqual(['failed', 'success']);
  });

  it('does not try other models when account credits are exhausted (HTTP 402)', async () => {
    const http = vi.fn(
      async () => new Response('Insufficient credits', { status: 402 }),
    );
    await expect(
      generateGeminiImage(
        source,
        'post',
        'aabbccdd',
        'key',
        '/tmp/d.json',
        options,
        http,
      ),
    ).rejects.toThrow('insufficient credits');
    expect(http).toHaveBeenCalledTimes(1);
  });

  it('rejects missing key, unsupported model and size without requests', async () => {
    const http = vi.fn();
    await expect(
      generateGeminiImage(
        source,
        'post',
        'aabbccdd',
        '',
        '/tmp/d.json',
        options,
        http,
      ),
    ).rejects.toThrow('OPENROUTER_API_KEY missing');
    await expect(
      generateGeminiImage(
        source,
        'post',
        'aabbccdd',
        'key',
        '/tmp/d.json',
        { ...options, model: 'google/other-image' },
        http,
      ),
    ).rejects.toThrow('Unsupported OpenRouter image model');
    await expect(
      generateGeminiImage(
        source,
        'post',
        'aabbccdd',
        'key',
        '/tmp/d.json',
        { ...options, size: '4K' },
        http,
      ),
    ).rejects.toThrow('1K or 2K');
    expect(http).not.toHaveBeenCalled();
  });
});
