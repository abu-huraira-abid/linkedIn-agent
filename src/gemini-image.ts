import fs from 'node:fs';
import path from 'node:path';
import sharp from 'sharp';
import type { GeneratedImage } from './linkedin-image.js';
import { techImagePrompt } from './linkedin-image.js';
import type { Request, Source } from './linkedin-service.js';

const MAX_IMAGE_BYTES = 12 * 1024 * 1024;
export const ALLOWED_IMAGE_MODELS = [
  'google/gemini-3.1-flash-lite-image',
  'openai/gpt-5-image-mini',
  'google/gemini-3.1-flash-image',
  'openai/gpt-5-image',
] as const;
const ALLOWED_MODELS = new Set<string>(ALLOWED_IMAGE_MODELS);
const ALLOWED_SIZES = new Set(['1K', '2K']);
const ALLOWED_RATIOS = new Set(['1:1', '4:5', '5:4', '16:9', '3:2']);

export interface GeminiImageOptions {
  model: string;
  fallbackModels?: string[];
  size: string;
  aspectRatio: string;
}

export interface ImageAttempt {
  model: string;
  status: 'success' | 'failed' | 'skipped';
  reason?: string;
}

export interface ImageGenerationResult {
  image: GeneratedImage;
  attempts: ImageAttempt[];
}

function shouldTryNextModel(status: number, detail: string): boolean {
  // 402 is account-level credit exhaustion: switching models cannot fix it.
  if (status === 402) return false;
  // Invalid request/auth/policy errors should not be retried against other models.
  if ([400, 401, 403, 404, 422].includes(status)) return false;
  // Rate limits, unavailable providers and transient server errors may recover
  // with another explicitly configured model.
  return (
    status === 408 ||
    status === 409 ||
    status === 429 ||
    status >= 500 ||
    /no provider|temporarily unavailable|capacity|overloaded/i.test(detail)
  );
}

async function generateWithModel(
  source: Source,
  post: string,
  draftId: string,
  openrouterKey: string,
  stateFile: string,
  model: string,
  size: string,
  aspectRatio: string,
  http: Request,
): Promise<GeneratedImage> {
  const prompt = [
    techImagePrompt(source, post),
    'Final art direction: premium editorial illustration for a professional LinkedIn technology audience.',
    'Make the main subject large, recognizable and emotionally engaging. Use a confident visual hierarchy, strong focal point, refined contrast and a dynamic but uncluttered composition.',
    'The image must communicate the specific idea in the post at a glance. Do not create generic technology wallpaper or a fake software screenshot.',
    'Avoid garbled text. Do not include typography; the LinkedIn caption carries the written message.',
  ].join('\n\n');

  const response = await http('https://openrouter.ai/api/v1/images', {
    method: 'POST',
    signal: AbortSignal.timeout(120000),
    headers: {
      Authorization: 'Bearer ' + openrouterKey,
      'Content-Type': 'application/json',
      'X-Title': 'Andy LinkedIn Content Agent',
    },
    body: JSON.stringify({
      model,
      prompt,
      aspect_ratio: aspectRatio,
      resolution: size,
      n: 1,
      provider: { allow_fallbacks: false },
    }),
  });

  if (!response.ok) {
    const detail = (await response.text()).slice(0, 240);
    throw Object.assign(
      new Error(
        'OpenRouter image ' +
          model +
          ' HTTP ' +
          response.status +
          ': ' +
          detail,
      ),
      { status: response.status, detail },
    );
  }

  const body = (await response.json()) as {
    data?: Array<{ b64_json?: string; media_type?: string }>;
    usage?: { cost?: number };
  };
  const encoded = body.data?.[0]?.b64_json;
  if (!encoded)
    throw new Error('OpenRouter returned no image data for ' + model);

  const raw = Buffer.from(encoded, 'base64');
  if (!raw.length || raw.length > MAX_IMAGE_BYTES)
    throw new Error('Generated image is empty or exceeds 12 MB');
  const metadata = await sharp(raw).metadata();
  if (!metadata.width || !metadata.height)
    throw new Error('Generated image is invalid');

  const normalized = await sharp(raw)
    .resize(1200, 1500, {
      fit: 'cover',
      position: 'centre',
      withoutEnlargement: false,
    })
    .png({ compressionLevel: 8 })
    .toBuffer();
  if (!normalized.length || normalized.length > MAX_IMAGE_BYTES)
    throw new Error('Normalized image exceeds 12 MB');

  const folder = path.join(path.dirname(stateFile), 'generated-images');
  fs.mkdirSync(folder, { recursive: true, mode: 0o700 });
  const destination = path.join(folder, draftId + '.png');
  const temporary = destination + '.tmp-' + process.pid;
  fs.writeFileSync(temporary, normalized, { mode: 0o600 });
  fs.renameSync(temporary, destination);

  return {
    path: destination,
    model,
    prompt:
      prompt +
      (body.usage?.cost !== undefined
        ? '\nOpenRouter image cost USD: ' + body.usage.cost
        : ''),
    mime: 'image/png',
  };
}

export async function generateGeminiImage(
  source: Source,
  post: string,
  draftId: string,
  openrouterKey: string,
  stateFile: string,
  options: GeminiImageOptions,
  http: Request = fetch,
): Promise<ImageGenerationResult> {
  if (!/^[a-f0-9]{8}$/.test(draftId))
    throw new Error('Invalid draft identifier');
  if (!openrouterKey) throw new Error('OPENROUTER_API_KEY missing');
  if (!ALLOWED_SIZES.has(options.size))
    throw new Error('Image size must be 1K or 2K');
  if (!ALLOWED_RATIOS.has(options.aspectRatio))
    throw new Error('Unsupported image aspect ratio');

  const candidates = [
    ...new Set([options.model, ...(options.fallbackModels || [])]),
  ];
  if (candidates.some((model) => !ALLOWED_MODELS.has(model)))
    throw new Error(
      'Unsupported OpenRouter image model in primary/fallback list',
    );

  const attempts: ImageAttempt[] = [];
  for (const model of candidates) {
    try {
      const image = await generateWithModel(
        source,
        post,
        draftId,
        openrouterKey,
        stateFile,
        model,
        options.size,
        options.aspectRatio,
        http,
      );
      attempts.push({ model, status: 'success' });
      return { image, attempts };
    } catch (error) {
      const status = Number((error as { status?: number })?.status || 0);
      const reason = String(
        error instanceof Error ? error.message : error,
      ).slice(0, 260);
      attempts.push({ model, status: 'failed', reason });
      if (status === 402) {
        throw new Error(
          'OpenRouter account has insufficient credits (HTTP 402). No other model can run until the shared balance is funded. ' +
            reason,
        );
      }
      if (!shouldTryNextModel(status, reason)) break;
    }
  }
  throw new Error(
    'All configured OpenRouter image models failed: ' +
      attempts.map((x) => x.model + ': ' + (x.reason || x.status)).join(' | '),
  );
}
