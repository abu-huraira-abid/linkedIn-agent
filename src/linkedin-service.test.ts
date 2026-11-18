import { afterEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  approveDraft,
  createDraft,
  DraftStore,
  extractFeedItems,
  finalizePost,
  selectRelevantSource,
  rejectDraft,
  reviseDraft,
  settingsFromEnv,
  type Request,
  type Draft,
} from './linkedin-service.js';
const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0))
    fs.rmSync(d, { recursive: true, force: true });
});
function fixtures() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'linkedin-agent-test-'));
  dirs.push(dir);
  const settings = settingsFromEnv(
    {
      OPENROUTER_API_KEY: 'test-ai-key',
      AI_TEXT_PROVIDER: 'openrouter',
      AI_IMAGE_PROVIDER: 'recraft',
      AI_IMAGE_ENABLED: 'false',
      LINKEDIN_ACCESS_TOKEN: 'test-linkedin-token',
      LINKEDIN_PERSON_URN: 'urn:li:person:abc123',
      LINKEDIN_PUBLISH_ENABLED: 'true',
      LINKEDIN_RSS_FEEDS: 'https://example.com/feed.xml',
    },
    dir,
  );
  const store = new DraftStore(settings.stateFile);
  const draft: Draft = {
    id: 'test1234',
    status: 'pending',
    text: 'A useful draft with verified sources.',
    sources: [
      {
        title: 'AI models in production',
        url: 'https://example.com/source',
        date: new Date().toISOString(),
      },
    ],
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
  store.save(draft);
  return { settings, store, draft };
}
describe('RSS parsing', () => {
  it('reads RSS and Atom links while filtering invalid items', () => {
    expect(
      extractFeedItems(
        '<rss><item><title><![CDATA[New AI &amp; Tools]]></title><link>https://example.com/a</link><pubDate>Mon, 16 Nov 2026 08:00:00 GMT</pubDate></item></rss>',
      ),
    ).toEqual([
      {
        title: 'New AI & Tools',
        url: 'https://example.com/a',
        date: 'Mon, 16 Nov 2026 08:00:00 GMT',
      },
    ]);
    expect(
      extractFeedItems(
        '<feed><entry><title>New</title><link href="https://example.com/atom"/><updated>2026-11-16T08:00:00Z</updated></entry></feed>',
      ),
    ).toHaveLength(1);
  });
});
describe('approval safety', () => {
  it('rejects an unknown id without calling LinkedIn', async () => {
    const { settings, store } = fixtures();
    const http = vi.fn();
    await expect(approveDraft(settings, store, 'wrong', http)).rejects.toThrow(
      'ID mismatch',
    );
    expect(http).not.toHaveBeenCalled();
    expect(store.load()?.status).toBe('pending');
  });
  it('requires publishing opt-in', async () => {
    const { settings, store } = fixtures();
    settings.dryRun = true;
    const http = vi.fn();
    await expect(
      approveDraft(settings, store, 'test1234', http),
    ).rejects.toThrow('disabled');
    expect(http).not.toHaveBeenCalled();
  });
  it('publishes once via current Posts API and blocks repeated approvals', async () => {
    const { settings, store } = fixtures();
    const http = vi.fn(async (_url: string, init?: RequestInit) => {
      expect(init?.method).toBe('POST');
      return new Response('', {
        status: 201,
        headers: { 'x-restli-id': 'urn:li:share:123' },
      });
    }) as Request;
    const d = await approveDraft(settings, store, 'test1234', http);
    expect(d.status).toBe('published');
    expect(d.publishedId).toBe('urn:li:share:123');
    expect(http).toHaveBeenCalledTimes(1);
    expect(http).toHaveBeenCalledWith(
      'https://api.linkedin.com/rest/posts',
      expect.objectContaining({
        headers: expect.objectContaining({ 'Linkedin-Version': '202608' }),
      }),
    );
    await expect(
      approveDraft(settings, store, 'test1234', http),
    ).rejects.toThrow('ID mismatch');
    expect(http).toHaveBeenCalledTimes(1);
  });
  it('marks uncertain network failures without retrying automatically', async () => {
    const { settings, store } = fixtures();
    const http = vi.fn(async () => {
      throw Error('timeout');
    }) as Request;
    await expect(
      approveDraft(settings, store, 'test1234', http),
    ).rejects.toThrow('uncertain');
    expect(store.load()?.status).toBe('failed');
    await expect(
      approveDraft(settings, store, 'test1234', http),
    ).rejects.toThrow('ID mismatch');
    expect(http).toHaveBeenCalledTimes(1);
  });
  it('rejects drafts by exact id', () => {
    const { store } = fixtures();
    expect(() => rejectDraft(store, 'bad')).toThrow();
    expect(rejectDraft(store, 'test1234').status).toBe('rejected');
  });
  it('invalidates the previous approval id after editing', async () => {
    const { settings, store } = fixtures();
    const http = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            choices: [
              {
                message: { content: 'A revised, sourced engineering insight.' },
              },
            ],
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        ),
    ) as Request;
    const next = await reviseDraft(
      settings,
      store,
      'Make the hook more specific',
      http,
    );
    expect(next.id).not.toBe('test1234');
    await expect(
      approveDraft(settings, store, 'test1234', http),
    ).rejects.toThrow('ID mismatch');
  });
});

describe('deterministic source attribution', () => {
  it('appends the verified source when the model omits URLs', () => {
    const result = finalizePost('Practical AI engineering insight. #AI', {
      title: 'News',
      url: 'https://example.com/source',
      date: new Date().toISOString(),
    });
    expect(result).toContain('Source: https://example.com/source');
    expect(result).toContain('Practical AI engineering insight.');
    expect(result.length).toBeLessThanOrEqual(1300);
  });

  it('removes invented model links and appends only the RSS source', () => {
    const result = finalizePost(
      'See https://made-up.com/story for details. #AI',
      {
        title: 'News',
        url: 'https://example.com/source',
        date: new Date().toISOString(),
      },
    );
    expect(result).not.toContain('made-up.com');
    expect(result).toContain('https://example.com/source');
  });

  it('selects a relevant technical story over unrelated recent news', () => {
    const date = new Date().toISOString();
    const selected = selectRelevantSource(
      [
        { title: 'Travel tips', url: 'https://example.com/travel', date },
        {
          title: 'Python LLM inference agents',
          url: 'https://example.com/python',
          date,
        },
      ],
      'Python LLM',
    );
    expect(selected.url).toBe('https://example.com/python');
  });

  it('saves a complete draft when OpenRouter returns a post without a link', async () => {
    const { settings, store } = fixtures();
    store.save({ ...store.load()!, status: 'rejected' });
    const http = vi.fn(async (url: string) => {
      if (url.includes('/feed.xml')) {
        const now = new Date().toUTCString();
        return new Response(
          '<rss><item><title>Python agents update</title><link>https://example.com/source</link><pubDate>' +
            now +
            '</pubDate></item></rss>',
          { status: 200 },
        );
      }
      return new Response(
        JSON.stringify({
          choices: [
            {
              message: {
                content:
                  'Python agents are changing backend workflows. #AI #Python',
              },
            },
          ],
        }),
        { status: 200 },
      );
    }) as Request;
    const result = await createDraft(settings, store, http);
    expect(result.status).toBe('pending');
    expect(result.text).toContain('Source: https://example.com/source');
    expect(store.load()?.text).toBe(result.text);
    expect(http).toHaveBeenCalledTimes(3);
  });
});

describe('GPT via OpenRouter response handling', () => {
  it('fails clearly when GPT returns no visible content', async () => {
    const { settings, store } = fixtures();
    store.save({ ...store.load()!, status: 'rejected' });
    const date = new Date().toUTCString();
    const http = vi.fn(async (url: string) => {
      if (url.includes('/feed.xml')) {
        return new Response(
          '<rss><item><title>Python LLM engineering</title><link>https://example.com/source</link><pubDate>' +
            date +
            '</pubDate></item></rss>',
          { status: 200 },
        );
      }
      return new Response(
        JSON.stringify({
          choices: [{ finish_reason: 'length', message: { content: '' } }],
        }),
        { status: 200 },
      );
    }) as Request;
    await expect(createDraft(settings, store, http)).rejects.toThrow(
      'OpenRouter GPT returned no visible content',
    );
    expect(store.load()?.status).toBe('rejected');
    expect(http).toHaveBeenCalledTimes(2);
  });
});

describe('drafting', () => {
  it('never creates draft if feeds have no recent dated stories', async () => {
    const { settings, store } = fixtures();
    store.save({ ...store.load()!, status: 'rejected' });
    const http = vi.fn(
      async () =>
        new Response(
          '<rss><item><title>Old</title><link>https://example.com/story</link><pubDate>Tue, 01 Jan 2019 00:00:00 GMT</pubDate></item></rss>',
          { status: 200 },
        ),
    ) as Request;
    await expect(createDraft(settings, store, http)).rejects.toThrow(
      'No recent',
    );
    expect(http).toHaveBeenCalledTimes(1);
  });
});

describe('image publishing safety', () => {
  it('refuses an image-enabled draft when free image generation failed', async () => {
    const { settings, store, draft } = fixtures();
    settings.imageEnabled = true;
    store.save({ ...draft, imageError: 'free provider unavailable' });
    const http = vi.fn();
    await expect(approveDraft(settings, store, draft.id, http)).rejects.toThrow(
      'no image',
    );
    expect(http).not.toHaveBeenCalled();
  });
  it('uploads approved image and attaches its URN to the LinkedIn post', async () => {
    const { settings, store, draft } = fixtures();
    const folder = path.join(
      path.dirname(settings.stateFile),
      'generated-images',
    );
    fs.mkdirSync(folder, { recursive: true });
    const pathname = path.join(folder, draft.id + '.png');
    fs.writeFileSync(
      pathname,
      Buffer.from(
        'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aH+0AAAAASUVORK5CYII=',
        'base64',
      ),
    );
    store.save({
      ...draft,
      image: {
        path: pathname,
        model: 'recraft/recraft-v4.1-flash-v2:free',
        prompt: 'test',
        mime: 'image/png',
      },
    });
    const urls: string[] = [];
    const http = vi.fn(async (url: string, init?: RequestInit) => {
      urls.push(url);
      if (url.includes('initializeUpload'))
        return new Response(
          JSON.stringify({
            value: {
              image: 'urn:li:image:abc123',
              uploadUrl:
                'https://www.linkedin.com/dms-uploads/abc/uploaded-image',
            },
          }),
          { status: 200 },
        );
      if (url.includes('/dms-uploads/')) {
        expect(init?.method).toBe('PUT');
        return new Response('', { status: 201 });
      }
      const body = JSON.parse(String(init?.body));
      expect(body.content.media.id).toBe('urn:li:image:abc123');
      return new Response('', {
        status: 201,
        headers: { 'x-restli-id': 'urn:li:share:456' },
      });
    }) as Request;
    const result = await approveDraft(settings, store, draft.id, http);
    expect(result.status).toBe('published');
    expect(urls).toHaveLength(3);
  });
});
