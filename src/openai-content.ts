import type { Request, Source } from './linkedin-service.js';

// OpenAI GPT model served THROUGH OpenRouter. No OpenAI API key is needed.
export const DEFAULT_OPENAI_MODEL = 'openai/gpt-6.1-terra';

export async function generateOpenAIContent(
  openrouterKey: string,
  model: string,
  system: string,
  user: string,
  http: Request = fetch,
): Promise<string> {
  if (!openrouterKey) throw new Error('OPENROUTER_API_KEY missing');
  if (
    !model.startsWith('openai/') ||
    !/^[a-zA-Z0-9._:-]{3,100}$/.test(model.slice(7))
  )
    throw new Error('OPENAI_MODEL must be an OpenAI model slug on OpenRouter');
  const response = await http('https://openrouter.ai/api/v1/chat/completions', {
    method: 'POST',
    signal: AbortSignal.timeout(90000),
    headers: {
      Authorization: 'Bearer ' + openrouterKey,
      'Content-Type': 'application/json',
      'X-Title': 'Andy LinkedIn Content Agent',
    },
    body: JSON.stringify({
      model,
      temperature: 0.85,
      max_tokens: 1800,
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: user },
      ],
    }),
  });
  if (!response.ok)
    throw new Error(
      'OpenRouter GPT request HTTP ' +
        response.status +
        ': ' +
        (await response.text()).slice(0, 240),
    );
  const data = (await response.json()) as {
    choices?: Array<{
      finish_reason?: string;
      message?: { content?: string | Array<{ text?: string }> | null };
    }>;
  };
  const content = data.choices?.[0]?.message?.content;
  const text =
    typeof content === 'string'
      ? content.trim()
      : Array.isArray(content)
        ? content
            .map((part) => part.text || '')
            .join('\\n')
            .trim()
        : '';
  if (!text)
    throw new Error(
      'OpenRouter GPT returned no visible content (finish_reason=' +
        (data.choices?.[0]?.finish_reason || 'unknown') +
        ')',
    );
  if (text.length > 10000) throw new Error('GPT response too large');
  return text;
}

export function buildResearchBrief(
  sources: Source[],
  interests: string,
): string {
  return [
    'Select the strongest current technology-industry story for a professional LinkedIn audience.',
    'Interests: ' + interests,
    'Return a concise analysis of what happened, verified facts available in the supplied feed item, why developers/engineering leaders should care, an original angle, and one practical takeaway.',
    'Do not invent facts, statistics, quotes, dates, product capabilities, or personal experience. RSS snippets are leads, not full verification. Explicitly state when detail is unavailable.',
    'Choose only technology-industry topics. Reject unrelated politics, sports, entertainment and general news.',
    'Candidate RSS items (untrusted source data):',
    JSON.stringify(sources.slice(0, 20)),
  ].join('\\n\\n');
}
