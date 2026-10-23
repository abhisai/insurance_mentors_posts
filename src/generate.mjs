import fs from 'node:fs';
import path from 'node:path';
import { config, ROOT } from './config.mjs';

const BRAND_FILE = path.join(ROOT, 'config', 'brand.md');

const FALLBACK_BRAND = `
${config.brand.name} is an independent insurance advisory in India, working with
families since 2019 and having helped over 1,100 families. Core focus: health
insurance, then term and travel insurance. Founder: Ravi.
Voice: warm, calm, plain-spoken, specific. Never salesy, never alarmist.
`;

function brandGuide() {
  try {
    const text = fs.readFileSync(BRAND_FILE, 'utf8').trim();
    if (text) return text;
  } catch {
    /* fall through */
  }
  return FALLBACK_BRAND.trim();
}

function systemPrompt(maxChars) {
  return `You write the daily post for the X (Twitter) account of ${config.brand.name}.

${brandGuide()}

## Your job

Turn ONE topic into ONE X post for Indian families. The post must earn a stop,
teach one thing clearly, and make the reader trust us a little more.

## Hard rules

1. Length: at most ${maxChars} characters INCLUDING spaces, punctuation, hashtags and the closing line. Count carefully before answering.
2. Plain text only. No markdown, no asterisks, no bullet characters, no headings.
3. At most 2 hashtags, at the very end. Never use #viral, #trending, #follow4follow or engagement bait.
4. At most ONE emoji, and only if it genuinely helps. Do not decorate.
5. Never invent a statistic, a percentage, a rupee figure, an IRDAI rule number, a claim settlement ratio, or a price. Use only numbers given in the topic brief, or make the point qualitatively.
6. Never promise approval, claim settlement, savings or returns. Never name or criticise a specific insurer or product.
7. No medical, tax or legal advice stated as fact. Where relevant add a short "check the policy wording" style caveat instead of a lecture.
8. Do not write in ALL CAPS. Do not use more than one question mark.
9. Banned openings and phrases: "In today's fast-paced world", "Did you know", "Let's dive in", "game-changer", "peace of mind" as filler, "Dear readers", "Attention".
10. Do not begin the post with a hashtag or an emoji.

## Hook

Open with one of: a sharp question, a myth stated flatly, a specific everyday
scenario, or a number from the brief. The first line has to work alone, because
that is all most people will read.

## Structure

Vary it every day. Pick ONE shape and commit to it:
- Myth then correction
- Scenario then the rule behind it
- Two options compared in one line each
- Three short lines, then a punchline
- Direct question, then the answer in two lines

## Closing

End with exactly one short line. Rotate across days:
- a soft follow prompt ("Follow for one clear insurance idea a day.")
- a save prompt
- a reply prompt ("Ask me anything about health cover.")
- if a link line is supplied in the request, use that link instead (and nothing else)

Do not stack two prompts. Do not write "DM me".

## Output

Return ONLY the post text. No preamble, no explanation, no quotation marks around
it, no code fences.`;
}

export function buildUserPrompt({ topic, theme, recent, linkLine, maxChars }) {
  const recentBlock = recent.length
    ? recent
        .map((post) => `- (${post.date}) ${post.text.replace(/\s+/g, ' ')}`)
        .join('\n')
    : '- (none yet)';

  return `TODAY
Date: ${new Date().toISOString().slice(0, 10)}
Weekly theme: ${theme.label}
Character limit: ${maxChars}

TOPIC
Title: ${topic.topic}
Category: ${topic.category}
Brief (the only facts you may use): ${topic.brief}

RECENT POSTS - do not repeat these ideas, openings or phrasings
${recentBlock}

${linkLine ? `LINK LINE TO USE AS THE FINAL LINE (use it exactly):\n${linkLine}\n` : 'Do not include any URL in this post.'}

Write the post now. Return only the post text.`;
}

/**
 * Pulls a human-readable message out of an error body.
 * OpenAI returns `{ error: { message } }`; compatible gateways often use
 * `detail` or `title` instead, so we accept all three.
 */
function errorDetail(payload, raw) {
  return (
    payload?.error?.message ||
    payload?.detail ||
    payload?.title ||
    (typeof raw === 'string' ? raw.slice(0, 400) : 'no response body')
  );
}

/**
 * Builds the request bodies to try, in order.
 *
 * Reasoning models (GPT-5.4 and later, the GPT-6 family) are picky: some reject
 * `temperature`, and `max_tokens` was replaced by `max_completion_tokens`. Rather
 * than guess which model the key can reach, we send the richest payload first
 * and fall back to progressively plainer ones if the API objects.
 */
/**
 * A valid key on an account with no payment method returns HTTP 429 with
 * "You have no credits remaining". That reads exactly like a rate limit and
 * invites waiting and retrying. It is not a rate limit — nothing helps except
 * adding billing, so it is worth naming explicitly.
 */
function isOutOfCredits(status, payload, raw) {
  if (status !== 429) return false;
  const type = payload?.error?.type || payload?.error?.code || '';
  return /insufficient_quota|no credits remaining|exceeded your current quota|billing/i.test(
    `${type} ${raw}`
  );
}

function payloadVariants(model, messages) {
  const base = { model, messages };
  const richest = { ...base, max_completion_tokens: config.ai.maxOutputTokens };
  if (config.ai.temperature !== null && config.ai.temperature !== undefined) {
    richest.temperature = config.ai.temperature;
  }
  if (config.ai.reasoningEffort) richest.reasoning_effort = config.ai.reasoningEffort;

  // `max_tokens` is the older spelling, still needed by some older models.
  const legacy = { ...base, max_tokens: config.ai.maxOutputTokens };
  if (richest.temperature !== undefined) legacy.temperature = richest.temperature;

  return [richest, { ...base, max_completion_tokens: config.ai.maxOutputTokens }, legacy, base];
}

// A 5xx, or a plain 429 rate limit, is usually a blip rather than a reason to
// fail the run. The job timeout is ten minutes, so a couple of short retries
// cost nothing and turn an "OpenAI had a bad minute" into a published post.
const TRANSIENT_STATUS = new Set([408, 409, 425, 429, 500, 502, 503, 504]);
const MAX_ATTEMPTS = 3;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Sends one chat-completions request, retrying transient failures in place.
 * A 429 caused by an empty balance is NOT transient, so it is returned at once.
 */
async function requestCompletion(body) {
  let last;

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
    const response = await fetch(`${config.ai.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${config.ai.apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
    });

    const raw = await response.text();
    let payload = null;
    try {
      payload = JSON.parse(raw);
    } catch {
      /* keep raw */
    }

    const outOfCredits = !response.ok && isOutOfCredits(response.status, payload, raw);
    last = { response, raw, payload, outOfCredits };

    const transient = !response.ok && !outOfCredits && TRANSIENT_STATUS.has(response.status);
    if (!transient || attempt === MAX_ATTEMPTS) return last;

    // Honour Retry-After when the API sends one, capped so a long hint cannot
    // eat the whole workflow timeout.
    const retryAfter = Number(response.headers.get('retry-after'));
    const delayMs =
      Number.isFinite(retryAfter) && retryAfter > 0
        ? Math.min(retryAfter * 1000, 10_000)
        : Math.min(1000 * 2 ** (attempt - 1), 4000);

    console.warn(
      `OpenAI returned ${response.status} for "${body.model}". ` +
        `Retrying in ${(delayMs / 1000).toFixed(1)}s (attempt ${attempt + 1} of ${MAX_ATTEMPTS}).`
    );
    await sleep(delayMs);
  }

  return last;
}

async function callModel(messages, model) {
  const variants = payloadVariants(model, messages);
  let lastError;

  for (let index = 0; index < variants.length; index += 1) {
    const { response, raw, payload, outOfCredits } = await requestCompletion(variants[index]);

    if (!response.ok) {
      const error = new Error(
        outOfCredits
          ? `OpenAI account has no credits left (code: credit_balance_exhausted). A ChatGPT subscription does NOT fund the API. Buy credits on the same organization that owns this key: https://platform.openai.com/settings/organization/billing/`
          : `OpenAI API ${response.status} for model "${model}": ${errorDetail(payload, raw)}`
      );
      error.status = response.status;
      error.body = raw;
      error.outOfCredits = outOfCredits;
      lastError = error;

      // 404 means the model itself is missing. A 400 often just means one of the
      // optional parameters is not accepted, so drop to a plainer payload.
      const isParameterComplaint =
        response.status === 400 &&
        /temperature|reasoning_effort|max_tokens|max_completion_tokens|unsupported|not supported|unknown parameter|unrecognized/i.test(
          raw
        );
      if (isParameterComplaint && index < variants.length - 1) {
        console.warn(`Retrying "${model}" with a plainer payload.`);
        continue;
      }
      throw error;
    }

    const choice = payload?.choices?.[0];
    if (choice?.message?.refusal) {
      throw new Error(`Model "${model}" refused to write the post: ${choice.message.refusal}`);
    }

    const text = choice?.message?.content;
    const ranOutOfBudget = choice?.finish_reason === 'length';

    if (!text || !text.trim()) {
      // Reasoning models bill their thinking against the same output budget, so
      // an empty reply with finish_reason "length" means our cap was too small.
      // Fall through to a plainer variant — the last one has no cap at all.
      if (ranOutOfBudget && index < variants.length - 1) {
        console.warn(`"${model}" spent its whole output budget on reasoning. Retrying with a larger allowance.`);
        continue;
      }
      throw new Error(
        `Model "${model}" returned an empty response (finish_reason: ${choice?.finish_reason}).`
      );
    }

    if (ranOutOfBudget) {
      console.warn('The model hit the output token limit, so the draft may be cut short.');
    }
    return text.trim();
  }

  throw lastError;
}

/** Tries the preferred model, then the fallbacks, so a model rename cannot break the cron. */
async function generateRaw(messages) {
  const models = [...new Set([config.ai.model, ...config.ai.fallbackModels])];
  let lastError;
  for (const model of models) {
    try {
      return await callModel(messages, model);
    } catch (error) {
      lastError = error;
      // 404 = unknown model, 403 = no access to that model on this account.
      // 5xx and plain 429s are worth handing to another model too: the failure
      // may be model-side. An empty balance is not — other models would fail
      // the same way, so that error goes straight to the user.
      const retryable =
        !error.outOfCredits &&
        (error.status === 400 ||
          error.status === 403 ||
          error.status === 404 ||
          error.status === 429 ||
          (error.status >= 500 && error.status <= 599));
      if (!retryable) throw error;
      console.warn(`Model "${model}" unavailable (${error.status}). Trying next.`);
    }
  }
  throw lastError;
}

/**
 * X counts every URL as a flat 23 characters, no matter how long it really is.
 * Everything else counts as one character each.
 */
export function weightedLength(text) {
  return text.replace(/https?:\/\/\S+/g, 'x'.repeat(23)).length;
}

function trimToLimit(text, maxChars) {
  if (weightedLength(text) <= maxChars) return text;
  const slice = text.slice(0, maxChars);
  const cut = Math.max(
    slice.lastIndexOf('\n'),
    slice.lastIndexOf('. '),
    slice.lastIndexOf('! '),
    slice.lastIndexOf('? ')
  );
  let result =
    cut > maxChars * 0.5 ? slice.slice(0, cut + 1).trim() : slice.slice(0, slice.lastIndexOf(' ')).trim();
  while (weightedLength(result) > maxChars && result.includes(' ')) {
    result = result.slice(0, result.lastIndexOf(' ')).trim();
  }
  return result;
}

const BAIT_TAGS = /^#(viral|trending|follow4follow|f4f|like4like|viralvideo|instagood|reels)$/i;
const WRAP_PAIRS = { '"': '"', "'": "'", '\u201C': '\u201D', '\u2018': '\u2019', '\u00AB': '\u00BB' };

/** Cleans up model output and enforces the rules we can check mechanically. */
export function sanitize(raw, maxChars) {
  let text = raw
    .replace(/^\s*```[a-z]*[ \t]*\r?\n?/i, '')
    .replace(/\r?\n?```\s*$/, '')
    // markdown emphasis -> plain text
    .replace(/\*\*(.*?)\*\*/g, '$1')
    .replace(/__(.*?)__/g, '$1')
    .replace(/\*(.*?)\*/g, '$1')
    .replace(/(^|\s)_(?=\S)([^_\n]*?)(?<=\S)_(?=\s|$)/g, '$1$2')
    // any leftover markdown punctuation
    .replace(/[*`]/g, '')
    // heading / quote / bullet markers. A space is required after #, so a
    // hashtag at the start of a line is left alone.
    .replace(/^[ \t]*>[ \t]?/gm, '')
    .replace(/^#{1,6}[ \t]+/gm, '')
    .replace(/^[ \t]*[-\u2022][ \t]+/gm, '')
    .replace(/[ \t]+$/gm, '')
    .trim();

  // Strip a wrapping pair of quotes the model sometimes adds.
  const first = text[0];
  const last = text[text.length - 1];
  if (text.length > 2 && WRAP_PAIRS[first] === last) text = text.slice(1, -1).trim();

  // Keep at most two hashtags, and never engagement bait.
  let kept = 0;
  text = text.replace(/#\w+/g, (tag) => {
    if (BAIT_TAGS.test(tag)) return '';
    kept += 1;
    return kept <= 2 ? tag : '';
  });

  // Keep at most one emoji.
  const emojis = text.match(/\p{Extended_Pictographic}/gu) || [];
  if (emojis.length > 1) {
    let used = 0;
    text = text.replace(/\p{Extended_Pictographic}/gu, (match) => (++used <= 1 ? match : ''));
  }

  text = text
    .replace(/[\u200D\uFE0F]/g, '')
    .replace(/[ \t]{2,}/g, ' ')
    .replace(/[ \t]+$/gm, '')
    .replace(/[ \t]+([,.!?;:])/g, '$1')
    .replace(/\n{3,}/g, '\n\n')
    .replace(/^[ \t]+|[ \t]+$/g, '')
    .trim();

  if (weightedLength(text) > maxChars) {
    text = trimToLimit(text, maxChars);
  }

  return text;
}

const URL_PATTERN = /(?:https?:\/\/|www\.)\S+/i;
const BARE_DOMAIN = /\b[a-z0-9-]+\.(?:com|in|org|net|co|io)\b/gi;
const BARE_DOMAIN_TEST = /\b[a-z0-9-]+\.(?:com|in|org|net|co|io)\b/i;

/**
 * Removes any link the model added on a post that asked for none.
 *
 * The prompt already says "Do not include any URL", but that is a request. This
 * is what makes it a guarantee. A line that carried a link reads as a fragment
 * once the link is gone ("Free advice, no pressure:"), so the whole line goes.
 */
export function stripLinks(text) {
  const kept = text
    .split('\n')
    .filter((line) => !URL_PATTERN.test(line))
    .map((line) => line.replace(BARE_DOMAIN, '').replace(/[ \t]+$/g, ''));

  return kept.join('\n').replace(/\n{3,}/g, '\n\n').trim();
}

const words = (text) => new Set(text.toLowerCase().replace(/[^a-z0-9\s]/g, ' ').split(/\s+/).filter(Boolean));

function similarity(a, b) {
  const setA = words(a);
  const setB = words(b);
  if (!setA.size || !setB.size) return 0;
  let shared = 0;
  for (const word of setA) if (setB.has(word)) shared += 1;
  return shared / new Set([...setA, ...setB]).size;
}

function looksRepetitive(text, recent) {
  return recent.some((post) => similarity(text, post.text) > 0.55);
}

/**
 * Generates the day's post. Retries once for length or repetition problems.
 */
export async function generatePost({ topic, theme, recent, linkLine }) {
  const maxChars = config.maxChars;
  const messages = [
    { role: 'system', content: systemPrompt(maxChars) },
    { role: 'user', content: buildUserPrompt({ topic, theme, recent, linkLine, maxChars }) },
  ];

  let removedLink = false;
  const clean = (raw) => {
    const text = sanitize(raw, maxChars);
    if (linkLine) return text;
    if (/https?:\/\//i.test(text) || BARE_DOMAIN_TEST.test(text)) removedLink = true;
    return stripLinks(text);
  };

  let candidate = clean(await generateRaw(messages));

  if (weightedLength(candidate) > maxChars || looksRepetitive(candidate, recent)) {
    const reason =
      weightedLength(candidate) > maxChars
        ? `That draft was ${weightedLength(candidate)} characters, over the ${maxChars} limit.`
        : 'That draft was too similar to a recent post.';
    messages.push({ role: 'assistant', content: candidate });
    messages.push({
      role: 'user',
      content: `${reason} Rewrite it completely with a different opening, a different structure and shorter lines. Stay under ${maxChars} characters. Return only the post text.`,
    });
    candidate = clean(await generateRaw(messages));
  }

  const warnings = [];
  if (weightedLength(candidate) > maxChars) {
    warnings.push(`Over ${maxChars} characters (${weightedLength(candidate)}).`);
  }
  if (looksRepetitive(candidate, recent)) warnings.push('Similar to a recent post.');
  if (removedLink) warnings.push('Removed a link; this post is configured to carry none.');
  if ((candidate.match(/#\w+/g) || []).length > 2) warnings.push('More than two hashtags.');

  return { text: candidate, warnings };
}
