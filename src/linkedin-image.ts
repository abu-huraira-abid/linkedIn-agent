// @ts-nocheck
export interface GeneratedImage {
  path: string;
  model: string;
  prompt: string;
  mime: 'image/png' | 'image/jpeg' | 'image/webp';
}
import fs from 'node:fs';
import path from 'node:path';
import sharp from 'sharp';
// Deliberately hardcoded to prevent accidental paid image model substitutions.
export const FREE_IMAGE_MODEL = 'recraft/recraft-v4.1-flash-v2:free';
const MAX_IMAGE_BYTES = 12 * 1024 * 1024;
/**
 * Choose a visible story-specific scene, not an abstract "tech" motif.
 * A single local ruleset avoids extra LLM calls and paid prompt-generation APIs.
 */
export function linkedInVisualScene(source, post) {
  const subject = (
    source.title +
    ' ' +
    (source.summary || '') +
    ' ' +
    post
  ).toLowerCase();
  if (
    /agent.{0,45}(secur|authoriz|permission|govern|access|polic)|(?:secur|authoriz|permission|govern|access|polic).{0,45}agent|prompt injection/.test(
      subject,
    )
  )
    return "Show a recognizable AI software agent at an enterprise API gateway: a clear protective policy checkpoint evaluates the agent's proposed action before it can reach a database and business tools. Visually contrast ONE permitted green path with ONE blocked red path. Make the authorization decision the unmistakable subject of the image.";
  if (
    /cybersecur|ransomware|zero.trust|phishing|credential|vulnerab|infosec|encryption/.test(
      subject,
    )
  )
    return 'Show a real-world security operations workstation monitoring a network, with one clearly protected server and a visible attempted intrusion stopped by a digital shield. Make the security threat and protection visually understandable.';
  if (
    /cloud|aws|azure|kubernetes|container|devops|infrastructure|serverless/.test(
      subject,
    )
  )
    return 'Show a recognizable modern data-center server rack and an engineer overseeing a cloud deployment pipeline, with a few connected services and one clear reliability indicator. The cloud infrastructure is the main subject.';
  if (/robot|physical ai|autonomous vehicle|hardware/.test(subject))
    return 'Show one practical industrial robot working alongside a human engineer in a realistic modern lab or factory. The human-machine interaction and concrete technology are immediately recognizable.';
  if (
    /database|data engineer|analytics|warehouse|pipeline|observab/.test(subject)
  )
    return 'Show a data engineer working with a clear database-to-processing-to-dashboard data flow on a real workstation. Make the data pipeline physically and visually legible without readable text.';
  if (
    /coding|programming|developer|software|python|typescript|javascript|api|open.source/.test(
      subject,
    )
  )
    return 'Show a software engineer at a real workstation reviewing a code editor beside a simple, clearly connected application-service diagram. Make software development and its practical engineering challenge recognizable.';
  if (/ai agent|agentic|autonomous agent|multi.agent/.test(subject))
    return 'Show a human supervising a purposeful AI agent that uses a small set of recognizable software tools. Make the boundary between human control, agent decision, and tool execution easy to see.';
  if (
    /llm|model|generative ai|artificial intelligence|machine learning|inference/.test(
      subject,
    )
  )
    return 'Show a practical AI engineering environment: an engineer evaluates a machine-learning model on a workstation with visible model deployment infrastructure. Show the technology in action, not a generic glowing brain.';
  return 'Show an actual technology professional using or evaluating the specific software or system described in the article, with one concrete application and a clear cause-and-effect interaction. Avoid generic technology symbols.';
}
export function techImagePrompt(source, post) {
  const cleanPost = post.replace(/\n\s*Source:\s*https?:\/\/\S+\s*$/i, '');
  return [
    'Create a professional, story-specific image that will be published alongside a real LinkedIn technology-industry post.',
    'GOAL: In two seconds a viewer should recognize the central technology concept and what is happening.',
    'MAIN VISUAL SCENE: ' + linkedInVisualScene(source, cleanPost),
    'Article subject: ' + source.title.slice(0, 200),
    'Article context (not independently verified): ' +
      (source.summary || '').slice(0, 320),
    'Core insight in the accompanying post: ' + cleanPost.slice(0, 600),
    'Prioritize the MAIN VISUAL SCENE over visual style. One obvious subject, a clear action, and a realistic technology setting.',
    'LinkedIn editorial illustration quality: crisp, sophisticated, polished, human-scale, precise details and appealing natural lighting.',
    'Use a focused composition with foreground subject, simplified background, readable contrast and generous safe margins for a square feed crop.',
    'Realistic modern professional color palette with subtle blue accents, not blue geometric wallpaper.',
    'Do NOT make abstract art, floating ribbons, blob shapes, disconnected cubes, ornamental swooshes, random circuits or a generic AI poster.',
    'No writing, no logos, no brand impersonation, no made-up numerical charts, no watermarks.',
    'Aspect ratio 1:1. A specific meaningful illustration, not decoration or an infographic of invented claims.',
  ].join('\n');
}
function detectImageMime(bytes) {
  if (
    bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
  )
    return 'image/png';
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff)
    return 'image/jpeg';
  if (
    bytes.toString('ascii', 0, 4) === 'RIFF' &&
    bytes.toString('ascii', 8, 12) === 'WEBP'
  )
    return 'image/webp';
  throw new Error('Image provider returned an unsupported image format');
}
export function safeImageFile(imagePath, stateFile) {
  const base = path.resolve(path.dirname(stateFile), 'generated-images');
  const file = path.resolve(imagePath);
  if (!file.startsWith(base + path.sep))
    throw new Error(
      'Image path is outside the private generated-images folder',
    );
  const bytes = fs.readFileSync(file);
  if (!bytes.length || bytes.length > MAX_IMAGE_BYTES)
    throw new Error('Generated image is empty or too large');
  detectImageMime(bytes);
  return bytes;
}
/** @param {import('./linkedin-service.js').Request} http */
export async function generateFreeImage(
  source,
  post,
  draftId,
  openrouterKey,
  stateFile,
  http = fetch,
) {
  if (!/^[a-f0-9]{8}$/.test(draftId))
    throw new Error('Invalid draft identifier');
  if (!openrouterKey) throw new Error('OPENROUTER_API_KEY missing');
  const prompt = techImagePrompt(source, post);
  const response = await http('https://openrouter.ai/api/v1/images', {
    method: 'POST',
    signal: AbortSignal.timeout(90000),
    headers: {
      Authorization: 'Bearer ' + openrouterKey,
      'Content-Type': 'application/json',
      'X-Title': 'Personal LinkedIn Tech Agent',
    },
    body: JSON.stringify({
      model: FREE_IMAGE_MODEL,
      prompt,
      aspect_ratio: '1:1',
      n: 1,
      provider: { allow_fallbacks: false },
    }),
  });
  if (!response.ok)
    throw new Error(
      'Free image generation HTTP ' +
        response.status +
        ' (free model may be rate-limited or unavailable)',
    );
  const body = await response.json();
  if ((body.usage?.cost ?? 0) > 0)
    throw new Error(
      'Image API reported a charge; paid routing is not permitted',
    );
  const raw = body.data?.[0]?.b64_json;
  if (!raw || raw.length > MAX_IMAGE_BYTES * 1.4)
    throw new Error('No valid image data returned from the free model');
  let bytes = Buffer.from(raw, 'base64');
  if (!bytes.length || bytes.length > MAX_IMAGE_BYTES)
    throw new Error('Generated image exceeds size limit');
  let mime = detectImageMime(bytes);
  // The free Recraft endpoint currently returns WebP. LinkedIn Images API
  // supports JPEG/PNG/GIF, so convert WebP to PNG for both WhatsApp + LinkedIn.
  if (mime === 'image/webp') {
    bytes = await sharp(bytes).png().toBuffer();
    if (bytes.length > MAX_IMAGE_BYTES)
      throw new Error('Converted PNG exceeds size limit');
    mime = 'image/png';
  }
  const extension = mime === 'image/jpeg' ? '.jpg' : '.png';
  const folder = path.join(path.dirname(stateFile), 'generated-images');
  fs.mkdirSync(folder, { recursive: true, mode: 0o700 });
  const destination = path.join(folder, draftId + extension);
  const temporary = destination + '.tmp-' + process.pid;
  fs.writeFileSync(temporary, bytes, { mode: 0o600 });
  fs.renameSync(temporary, destination);
  return { path: destination, model: FREE_IMAGE_MODEL, prompt, mime };
}
//# sourceMappingURL=linkedin-image.js.map

export function buildMetaAiImagePrompt(source: any, post: string): string {
  return [
    techImagePrompt(source, post),
    'Create a premium, energetic editorial illustration for LinkedIn.',
    'Use a vertical 4:5 composition, strong focal point, clear visual hierarchy, vivid but professional colors, realistic lighting, and a sophisticated magazine-art direction.',
    'Keep the image clean and immediately understandable on a mobile feed.',
    'No text, letters, logos, watermarks, random geometric decoration, or generic glowing AI brain.',
    'Export the finished image at the highest available quality.',
  ].join('\n\n');
}

export async function saveUserProvidedImage(
  input: Buffer,
  mimeType: string | undefined,
  draftId: string,
  stateFile: string,
): Promise<GeneratedImage> {
  if (!/^[a-f0-9]{8}$/.test(draftId))
    throw new Error('Invalid draft identifier');
  if (!input.length || input.length > MAX_IMAGE_BYTES)
    throw new Error('Image must be under 12 MB');
  if (!/^image\/(png|jpeg|webp)$/.test(mimeType || ''))
    throw new Error('Please send a PNG, JPEG or WebP image');
  const metadata = await sharp(input).metadata();
  if (!metadata.width || !metadata.height)
    throw new Error('WhatsApp image is invalid or unsupported');
  const output = await sharp(input)
    .resize(1200, 1500, { fit: 'cover', position: 'centre' })
    .png({ compressionLevel: 8 })
    .toBuffer();
  if (!output.length || output.length > MAX_IMAGE_BYTES)
    throw new Error('Processed image exceeds 12 MB');
  const folder = path.join(path.dirname(stateFile), 'generated-images');
  fs.mkdirSync(folder, { recursive: true, mode: 0o700 });
  const destination = path.join(folder, draftId + '.png');
  const temporary = destination + '.tmp-' + process.pid;
  fs.writeFileSync(temporary, output, { mode: 0o600 });
  fs.renameSync(temporary, destination);
  return {
    path: destination,
    model: 'Meta AI (user supplied via WhatsApp)',
    prompt: 'Generated by Meta AI and supplied by the owner in WhatsApp.',
    mime: 'image/png',
  };
}
