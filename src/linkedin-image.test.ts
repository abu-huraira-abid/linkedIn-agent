import { describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {
  generateFreeImage,
  FREE_IMAGE_MODEL,
  safeImageFile,
  linkedInVisualScene,
  techImagePrompt,
} from './linkedin-image.js';
import type { Request } from './linkedin-service.js';
const source = {
  title: 'Cloud engineering release',
  summary: 'New reliability tooling for cloud teams',
  url: 'https://example.com/tech',
  date: new Date().toISOString(),
};
const png = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aH+0AAAAASUVORK5CYII=',
  'base64',
);
describe('free Recraft image integration', () => {
  it('uses ONLY the exact free model and stores image in private data folder', async () => {
    const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'recraft-image-'));
    try {
      const http = vi.fn(async (url: string, init?: RequestInit) => {
        expect(url).toBe('https://openrouter.ai/api/v1/images');
        const payload = JSON.parse(String(init?.body));
        expect(payload.model).toBe(FREE_IMAGE_MODEL);
        return new Response(
          JSON.stringify({
            data: [{ b64_json: png.toString('base64') }],
            usage: { cost: 0 },
          }),
          { status: 200 },
        );
      }) as Request;
      const im = await generateFreeImage(
        source,
        'A useful engineering takeaway',
        'aabbccdd',
        'test-key',
        path.join(folder, 'draft.json'),
        http as unknown as typeof fetch,
      );
      expect(im.mime).toBe('image/png');
      expect(safeImageFile(im.path, path.join(folder, 'draft.json'))).toEqual(
        png,
      );
      expect(http).toHaveBeenCalledOnce();
    } finally {
      fs.rmSync(folder, { force: true, recursive: true });
    }
  });
  it('fails without a paid fallback when free provider is unavailable', async () => {
    const http = vi.fn(
      async () => new Response('no free capacity', { status: 429 }),
    ) as Request;
    await expect(
      generateFreeImage(
        source,
        'some post',
        'aabbccdd',
        'test-key',
        '/tmp/draft.json',
        http as unknown as typeof fetch,
      ),
    ).rejects.toThrow('429');
    expect(http).toHaveBeenCalledOnce();
  });
});

describe('LinkedIn topic-specific image direction', () => {
  const agentSource = {
    title: 'Secure AI framework governs autonomous agents',
    summary:
      'Authorization requires the agent purpose, user intent and tool permissions.',
    url: 'https://example.com/ai-agents',
    date: new Date().toISOString(),
  };
  it('depicts a concrete security decision instead of abstract art', () => {
    const scene = linkedInVisualScene(
      agentSource,
      'AI agents should be checked before performing actions against internal APIs.',
    );
    expect(scene).toContain('policy checkpoint');
    expect(scene).toContain('blocked red path');
    const prompt = techImagePrompt(
      agentSource,
      'Agent access should reflect user intent.',
    );
    expect(prompt).toContain('MAIN VISUAL SCENE');
    expect(prompt).toContain('Do NOT make abstract art');
    expect(prompt).toContain('LinkedIn');
  });
  it('chooses a visible cloud-infrastructure scene when relevant', () => {
    const scene = linkedInVisualScene(
      {
        ...agentSource,
        title: 'Kubernetes cloud deployment reliability',
        summary: '',
      },
      'A production outage shows the importance of reliable deployments.',
    );
    expect(scene).toContain('server rack');
  });
});
