import { describe, expect, it, vi } from 'vitest';
import { generateOpenAIContent, buildResearchBrief } from './openai-content.js';

describe('GPT through OpenRouter', () => {
  it('uses the same OpenRouter key and OpenAI GPT model slug', async () => {
    const http = vi.fn(async (url: string, init?: RequestInit) => {
      expect(url).toBe('https://openrouter.ai/api/v1/chat/completions');
      expect(init?.headers).toMatchObject({
        Authorization: 'Bearer shared-openrouter-key',
      });
      const body = JSON.parse(String(init?.body));
      expect(body.model).toBe('openai/gpt-6.1-terra');
      return new Response(
        JSON.stringify({
          choices: [
            { message: { content: 'A strong, grounded technology post.' } },
          ],
        }),
        { status: 200 },
      );
    });
    const result = await generateOpenAIContent(
      'shared-openrouter-key',
      'openai/gpt-6.1-terra',
      'system prompt',
      'user prompt',
      http,
    );
    expect(result).toBe('A strong, grounded technology post.');
  });
  it('requires only the OpenRouter key', async () => {
    await expect(
      generateOpenAIContent('', 'openai/gpt-6.1-terra', 's', 'u'),
    ).rejects.toThrow('OPENROUTER_API_KEY missing');
  });
  it('builds a source-grounded research brief', () => {
    const brief = buildResearchBrief(
      [
        {
          title: 'New AI developer tools',
          url: 'https://example.com/story',
          date: '2026-11-17',
          summary: 'A new tool for software teams.',
        },
      ],
      'AI and software engineering',
    );
    expect(brief).toContain('New AI developer tools');
    expect(brief).toContain('Do not invent facts');
  });
});
