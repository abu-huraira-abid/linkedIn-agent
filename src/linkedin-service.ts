import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {
  safeImageFile,
  type GeneratedImage,
  buildMetaAiImagePrompt,
  saveUserProvidedImage,
} from './linkedin-image.js';
import { generateGeminiImage } from './gemini-image.js';
import {
  buildResearchBrief,
  generateOpenAIContent,
  DEFAULT_OPENAI_MODEL,
} from './openai-content.js';
export type Status =
  | 'pending'
  | 'publishing'
  | 'published'
  | 'rejected'
  | 'failed';
export interface Source {
  title: string;
  url: string;
  date: string;
  summary?: string;
}
export interface Draft {
  id: string;
  status: Status;
  text: string;
  sources: Source[];
  createdAt: string;
  updatedAt: string;
  publishedId?: string;
  lastError?: string;
  image?: GeneratedImage;
  imageError?: string;
}
export interface Settings {
  openrouterKey: string;
  openrouterModel: string;
  openaiModel: string;
  geminiImageModel: string;
  geminiImageFallbacks: string[];
  geminiImageSize: string;
  geminiImageAspectRatio: string;
  linkedinToken: string;
  linkedinAuthor: string;
  linkedinVersion: string;
  dryRun: boolean;
  stateFile: string;
  feedUrls: string[];
  interests: string;
  imageEnabled?: boolean;
}
export type Request = (url: string, init?: RequestInit) => Promise<Response>;

const feeds = [
  'https://www.theverge.com/rss/index.xml',
  'https://techcrunch.com/feed/',
  'https://www.infoq.com/feed/',
  'https://huggingface.co/blog/feed.xml',
];
export function settingsFromEnv(
  e: Record<string, string | undefined>,
  dir: string,
): Settings {
  const selected = (e.LINKEDIN_RSS_FEEDS || '')
    .split(',')
    .map((x) => x.trim())
    .filter(Boolean);
  return {
    openrouterKey: e.OPENROUTER_API_KEY || '',
    openrouterModel: e.OPENROUTER_MODEL || 'nvidia/nemotron-3.5-lightning:free',
    openaiModel: e.OPENROUTER_TEXT_MODEL || DEFAULT_OPENAI_MODEL,
    geminiImageModel:
      e.OPENROUTER_IMAGE_MODEL || 'google/gemini-3.1-flash-lite-image',
    geminiImageFallbacks: (
      e.OPENROUTER_IMAGE_FALLBACKS ||
      'openai/gpt-5-image-mini,google/gemini-3.1-flash-image,openai/gpt-5-image'
    )
      .split(',')
      .map((model) => model.trim())
      .filter(Boolean),
    geminiImageSize: e.GEMINI_IMAGE_SIZE || '1K',
    geminiImageAspectRatio: e.GEMINI_IMAGE_ASPECT_RATIO || '4:5',
    linkedinToken: e.LINKEDIN_ACCESS_TOKEN || '',
    linkedinAuthor: e.LINKEDIN_PERSON_URN || '',
    linkedinVersion: e.LINKEDIN_API_VERSION || '202608',
    dryRun: e.LINKEDIN_PUBLISH_ENABLED !== 'true',
    stateFile: path.join(dir, 'linkedin-posts.json'),
    feedUrls: selected.length ? selected : feeds,
    interests:
      e.LINKEDIN_TOPICS ||
      'AI agents, LLMs, Python, Django, software architecture, RAG, developer tools, cloud, cybersecurity, SaaS, robotics, data engineering, devops, programming languages, infrastructure, automation',
    imageEnabled: e.AI_IMAGE_ENABLED !== 'false',
  };
}
export class DraftStore {
  constructor(private filename: string) {}
  load(): Draft | null {
    try {
      return JSON.parse(fs.readFileSync(this.filename, 'utf8')) as Draft;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw e;
    }
  }
  save(d: Draft): void {
    fs.mkdirSync(path.dirname(this.filename), { recursive: true, mode: 0o700 });
    const tmp = this.filename + '.' + process.pid + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(d, null, 2), { mode: 0o600 });
    fs.renameSync(tmp, this.filename);
  }
}
function strip(s: string): string {
  return s
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\s+/g, ' ')
    .trim();
}
function val(s: string, tag: string): string {
  const m = s.match(
    new RegExp('<' + tag + '(?:\\s[^>]*)?>([\\s\\S]*?)<\\/' + tag + '>', 'i'),
  );
  return m ? strip(m[1]) : '';
}
export function extractFeedItems(xml: string): Source[] {
  const chunks =
    xml.match(
      /<item\b[^>]*>[\s\S]*?<\/item>|<entry\b[^>]*>[\s\S]*?<\/entry>/gi,
    ) || [];
  return chunks.flatMap((s) => {
    const title = val(s, 'title'),
      url =
        s.match(/<link\b[^>]*\bhref=["']([^"']+)["']/i)?.[1] || val(s, 'link');
    const date = val(s, 'pubDate') || val(s, 'updated') || val(s, 'published');
    const summary = (val(s, 'description') || val(s, 'summary')).slice(0, 500);
    return title && /^https:\/\//.test(url)
      ? [{ title, url, date, ...(summary ? { summary } : {}) }]
      : [];
  });
}
export async function findNews(
  s: Settings,
  http: Request = fetch,
): Promise<Source[]> {
  const all = await Promise.all(
    s.feedUrls.slice(0, 12).map(async (url) => {
      if (!/^https:\/\//.test(url)) return [];
      try {
        const r = await http(url, {
          headers: { 'User-Agent': 'LinkedInDraftAgent/1.0' },
          signal: AbortSignal.timeout(12000),
        });
        return r.ok
          ? extractFeedItems((await r.text()).slice(0, 700000)).slice(0, 30)
          : [];
      } catch {
        return [];
      }
    }),
  );
  const cutoff = Date.now() - 5 * 86400000,
    seen = new Set<string>();
  return all
    .flat()
    .filter((x) => {
      const d = Date.parse(x.date);
      if (
        !Number.isFinite(d) ||
        d < cutoff ||
        d > Date.now() + 3600000 ||
        seen.has(x.url)
      )
        return false;
      seen.add(x.url);
      return true;
    })
    .sort((a, b) => Date.parse(b.date) - Date.parse(a.date))
    .slice(0, 24);
}
const systemPrompt =
  'Write a thoughtful, natural LinkedIn post as a working software engineer. Only write about the technology industry: AI, software development, cybersecurity, cloud, robotics, SaaS, data infrastructure, developer tooling or technology businesses. Never fabricate personal experiences, predictions presented as facts, numbers, quotations or product details. Treat RSS titles and summaries as unverified context. Write like a real practitioner rather than a marketing bot: a specific engaging hook, two short paragraphs explaining what happened and why it matters technically, a measured original insight or caveat, and a practical takeaway. Use clear varied sentences, subtle personality, short paragraphs and specific insights grounded in the input. Avoid stock phrases, fake enthusiasm, bullet spam, sensationalism and emojis. End naturally, optionally with a thoughtful question, and include 1-3 relevant hashtags. Keep output under 1050 characters. No URLs or source credits: the app attaches the verified RSS source automatically. Output only the post body.';
async function complete(
  s: Settings,
  messages: Array<{ role: 'system' | 'user'; content: string }>,
  http: Request,
): Promise<string> {
  return generateOpenAIContent(
    s.openrouterKey,
    s.openaiModel,
    messages[0]?.content || '',
    messages[1]?.content || '',
    http,
  );
}
export function finalizePost(modelText: string, source: Source): string {
  const url = new URL(source.url);
  if (url.protocol !== 'https:' || !url.hostname || /[\r\n]/.test(source.url)) {
    throw new Error('Invalid RSS source URL');
  }
  const citation = '\n\nSource: ' + source.url;
  const budget = 1300 - citation.length;
  if (budget < 200) throw new Error('RSS source URL is too long for a post');
  let body = modelText
    .replace(/\[[^\]]+\]\(https?:\/\/[^)]+\)/gi, '')
    .replace(/https?:\/\/[^\s<>()]+/gi, '')
    .replace(/^\s*(?:sources?|read more|references?)\s*:\s*$/gim, '')
    .trim();
  if (body.length > budget) {
    const shortened = body.slice(0, budget - 1);
    const sentenceEnd = [...shortened.matchAll(/[.!?](?=\s|$)/g)].at(-1)?.index;
    body =
      sentenceEnd !== undefined && sentenceEnd > budget / 2
        ? shortened.slice(0, sentenceEnd + 1)
        : shortened
            .slice(0, Math.max(shortened.lastIndexOf(' '), 1))
            .trimEnd() + '…';
  }
  if (!body) throw new Error('AI model provided no usable draft text');
  return body + citation;
}

/** Prefer news close to the configured AI/developer topics, then recency. */
export function selectRelevantSource(
  sources: Source[],
  interests: string,
): Source {
  if (!sources.length) throw new Error('No RSS items available');
  const tokens = (interests.toLowerCase().match(/[a-z0-9]+/g) || []).filter(
    (word) => word.length > 2,
  );
  const keywords = [
    ...new Set([
      ...tokens,
      'ai',
      'llm',
      'agent',
      'python',
      'django',
      'model',
      'developer',
      'inference',
      'openai',
      'engineering',
    ]),
  ];
  let best: Source | undefined,
    bestScore = 0;
  for (let index = 0; index < sources.length; index++) {
    const title = sources[index].title.toLowerCase();
    const summary = (sources[index].summary || '').toLowerCase();
    const score = keywords.reduce(
      (sum, word) =>
        sum + (title.includes(word) ? 3 : summary.includes(word) ? 1 : 0),
      0,
    );
    if (score > bestScore) {
      best = sources[index];
      bestScore = score;
    }
  }
  if (!best)
    throw new Error('No relevant technology story found in recent feeds');
  return best;
}
export async function createDraft(
  s: Settings,
  store: DraftStore,
  http: Request = fetch,
): Promise<Draft> {
  const prior = store.load();
  if (prior && ['pending', 'publishing', 'failed'].includes(prior.status))
    throw new Error('Unresolved draft ' + prior.id + ' exists; review first.');
  const sources = await findNews(s, http);
  if (!sources.length)
    throw new Error('No recent dated RSS stories; no draft created');
  const selected = selectRelevantSource(sources, s.interests);
  const researchBrief = await generateOpenAIContent(
    s.openrouterKey,
    s.openaiModel,
    'You are a rigorous technology-industry research analyst. Produce a concise, source-grounded brief, identify what is and is not supported by the supplied RSS items, and suggest an engaging angle. Never invent facts.',
    buildResearchBrief(sources, s.interests),
    http,
  );
  const generated = await complete(
    s,
    [
      { role: 'system', content: systemPrompt },
      {
        role: 'user',
        content:
          'Write one energetic, human LinkedIn post about this selected technology story. Interests: ' +
          s.interests +
          '. Use this research brief as context, but never turn an unsupported claim into a fact:\\n' +
          researchBrief +
          '\\nSelected verified RSS source (the app attaches its URL):\\n' +
          JSON.stringify(selected) +
          '\\nCreate a strong curiosity-led hook, concise conversational paragraphs, a useful technical insight, practical takeaway, and a natural discussion question. Avoid generic AI phrasing, corporate hype, fabricated first-person experience, and invented statistics.',
      },
    ],
    http,
  );
  const text = finalizePost(generated, selected);
  const now = new Date().toISOString(),
    d: Draft = {
      id: crypto.randomBytes(4).toString('hex'),
      status: 'pending',
      text,
      sources: [selected],
      createdAt: now,
      updatedAt: now,
    };
  store.save(d);
  return d;
}
export async function reviseDraft(
  s: Settings,
  store: DraftStore,
  instruction: string,
  http: Request = fetch,
): Promise<Draft> {
  const d = store.load();
  if (!d || d.status !== 'pending') throw new Error('No pending draft');
  if (!instruction.trim() || instruction.length > 450)
    throw new Error('Instruction must be 1-450 chars');
  const text = await complete(
    s,
    [
      { role: 'system', content: systemPrompt },
      {
        role: 'user',
        content:
          'Revise draft using this request, without inventing facts. Sources: ' +
          JSON.stringify(d.sources) +
          '\nDraft: ' +
          d.text +
          '\nRequest: ' +
          instruction,
      },
    ],
    http,
  );
  const selected = d.sources[0];
  if (!selected) throw new Error('No verified RSS source on this draft');
  const sourcedText = finalizePost(text, selected);
  const edited: Draft = {
    ...d,
    id: crypto.randomBytes(4).toString('hex'),
    text: sourcedText,
    image: undefined,
    imageError: undefined,
    updatedAt: new Date().toISOString(),
  };
  store.save(edited);
  return edited;
}
export function rejectDraft(store: DraftStore, id: string): Draft {
  const d = store.load();
  if (!d || d.status !== 'pending' || d.id !== id)
    throw new Error('Pending ID mismatch');
  const out: Draft = {
    ...d,
    status: 'rejected',
    updatedAt: new Date().toISOString(),
  };
  store.save(out);
  return out;
}
async function uploadLinkedInImage(
  s: Settings,
  draft: Draft,
  http: Request,
): Promise<string> {
  if (!draft.image) throw new Error('No image on draft');
  const bytes = safeImageFile(draft.image.path, s.stateFile);
  // LinkedIn Images API documents PNG/JPEG/GIF, not WebP.
  if (draft.image.mime === 'image/webp')
    throw new Error(
      'LinkedIn cannot upload WebP; generate a PNG/JPEG image instead',
    );
  const commonHeaders = {
    Authorization: 'Bearer ' + s.linkedinToken,
    'X-Restli-Protocol-Version': '2.0.0',
    'Linkedin-Version': s.linkedinVersion,
  };
  const init = await http(
    'https://api.linkedin.com/rest/images?action=initializeUpload',
    {
      method: 'POST',
      signal: AbortSignal.timeout(20000),
      headers: { ...commonHeaders, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        initializeUploadRequest: { owner: s.linkedinAuthor },
      }),
    },
  );
  if (init.status !== 200)
    throw new Error('LinkedIn image initialize HTTP ' + init.status);
  const payload = (await init.json()) as {
    value?: { image?: string; uploadUrl?: string; uploadUrlExpiresAt?: number };
  };
  const asset = payload.value?.image;
  const uploadUrl = payload.value?.uploadUrl;
  if (!asset || !/^urn:li:image:[\w-]+$/.test(asset) || !uploadUrl)
    throw new Error('Invalid LinkedIn image upload response');
  const url = new URL(uploadUrl);
  if (
    url.protocol !== 'https:' ||
    (url.hostname !== 'linkedin.com' && !url.hostname.endsWith('.linkedin.com'))
  )
    throw new Error('Untrusted LinkedIn image upload URL');
  if (
    payload.value?.uploadUrlExpiresAt &&
    Date.now() >= payload.value.uploadUrlExpiresAt
  )
    throw new Error('LinkedIn image upload URL already expired');
  const upload = await http(uploadUrl, {
    method: 'PUT',
    signal: AbortSignal.timeout(60000),
    headers: {
      Authorization: 'Bearer ' + s.linkedinToken,
      'Content-Type': draft.image.mime,
    },
    body: new Uint8Array(bytes),
  });
  if (!upload.ok)
    throw new Error('LinkedIn image upload HTTP ' + upload.status);
  return asset;
}

export async function approveDraft(
  s: Settings,
  store: DraftStore,
  id: string,
  http: Request = fetch,
): Promise<Draft> {
  const d = store.load();
  if (!d || d.status !== 'pending' || d.id !== id)
    throw new Error('Pending ID mismatch. Nothing published.');
  if (!d.image)
    throw new Error(
      'Image required. Send your Meta AI image to Andy in WhatsApp before approval.',
    );
  if (s.dryRun)
    throw new Error(
      'Publishing disabled. Set LINKEDIN_PUBLISH_ENABLED=true after testing.',
    );
  if (!s.linkedinToken || !/^urn:li:person:[\w-]+$/.test(s.linkedinAuthor))
    throw new Error('LinkedIn token/member URN invalid or missing');
  if (!/^20\d{4}$/.test(s.linkedinVersion))
    throw new Error('Invalid LINKEDIN_API_VERSION');
  const pending: Draft = {
    ...d,
    status: 'publishing',
    updatedAt: new Date().toISOString(),
  };
  store.save(pending);
  try {
    const mediaId = d.image ? await uploadLinkedInImage(s, d, http) : undefined;
    const r = await http('https://api.linkedin.com/rest/posts', {
      method: 'POST',
      signal: AbortSignal.timeout(20000),
      headers: {
        Authorization: 'Bearer ' + s.linkedinToken,
        'Content-Type': 'application/json',
        'X-Restli-Protocol-Version': '2.0.0',
        'Linkedin-Version': s.linkedinVersion,
      },
      body: JSON.stringify({
        author: s.linkedinAuthor,
        commentary: d.text,
        ...(mediaId
          ? {
              content: {
                media: {
                  id: mediaId,
                  altText:
                    d.sources[0]?.title.slice(0, 118) ||
                    'Technology illustration',
                },
              },
            }
          : {}),
        visibility: 'PUBLIC',
        distribution: {
          feedDistribution: 'MAIN_FEED',
          targetEntities: [],
          thirdPartyDistributionChannels: [],
        },
        lifecycleState: 'PUBLISHED',
        isReshareDisabledByAuthor: false,
      }),
    });
    if (r.status !== 201)
      throw new Error(
        'LinkedIn HTTP ' + r.status + ' ' + (await r.text()).slice(0, 200),
      );
    const done: Draft = {
      ...pending,
      status: 'published',
      publishedId: r.headers.get('x-restli-id') || 'created',
      updatedAt: new Date().toISOString(),
    };
    store.save(done);
    return done;
  } catch (e) {
    store.save({
      ...pending,
      status: 'failed',
      lastError: String(e),
      updatedAt: new Date().toISOString(),
    });
    throw new Error(
      'Publishing uncertain; inspect LinkedIn manually before reattempting. ' +
        String(e),
      { cause: e },
    );
  }
}
/**
 * Add an image to an existing pending draft without changing its ID, text or
 * approval status. Also useful for regenerating an image that failed earlier.
 */
export function getMetaAiPrompt(store: DraftStore): string {
  const draft = store.load();
  if (!draft || draft.status !== 'pending') throw new Error('No pending draft');
  const source = draft.sources[0];
  if (!source) throw new Error('Draft has no verified RSS source');
  return buildMetaAiImagePrompt(source, draft.text);
}

export async function attachProvidedImage(
  s: Settings,
  store: DraftStore,
  bytes: Buffer,
  mimeType: string | undefined,
): Promise<Draft> {
  const draft = store.load();
  if (!draft || draft.status !== 'pending')
    throw new Error('No pending draft to attach an image to');
  const image = await saveUserProvidedImage(
    bytes,
    mimeType,
    draft.id,
    s.stateFile,
  );
  const latest = store.load();
  if (
    !latest ||
    latest.id !== draft.id ||
    latest.status !== 'pending' ||
    latest.text !== draft.text
  )
    throw new Error(
      'Draft changed while image was processed; image not attached',
    );
  const updated: Draft = {
    ...latest,
    image,
    imageError: undefined,
    updatedAt: new Date().toISOString(),
  };
  store.save(updated);
  return updated;
}

export function preview(d: Draft): string {
  return (
    'Draft ID: ' +
    d.id +
    '\\nStatus: ' +
    d.status +
    '\\n\\n' +
    d.text +
    (d.image
      ? '\\n\\nImage: ready (' + d.image.model + ')'
      : d.imageError
        ? '\\n\\nImage unavailable: ' + d.imageError
        : '\\n\\nImage: not generated') +
    '\\n\\nCommands: approve ' +
    d.id +
    ' | reject ' +
    d.id +
    ' | image | edit <instruction> | status'
  );
}

/** Meta AI is used manually: send the generated image to Andy to attach it. */
export async function attachImageToDraft(
  _s: Settings,
  _store: DraftStore,
): Promise<Draft> {
  throw new Error(
    'Generate the image with Meta AI, then send the image to Andy in this WhatsApp chat.',
  );
}
