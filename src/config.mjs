import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/**
 * Tiny .env reader so the project needs zero npm dependencies.
 * Real environment variables always win over the file.
 */
function loadDotEnv() {
  const file = path.join(ROOT, '.env');
  if (!fs.existsSync(file)) return;
  for (const rawLine of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq === -1) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (process.env[key] === undefined) process.env[key] = value;
  }
}

loadDotEnv();

const asBool = (value, fallback = false) =>
  value === undefined || value === '' ? fallback : /^(1|true|yes|on)$/i.test(value);

const asNumber = (value, fallback) => {
  if (value === undefined || value === '') return fallback;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
};

/**
 * Temperature is optional: some reasoning models reject it outright.
 * Returns null when the setting should be left out of the request entirely.
 */
const optionalTemperature = () => {
  const raw = process.env.OPENAI_TEMPERATURE;
  if (raw === undefined || raw === '') return 0.9;
  if (/^(none|off|omit|skip)$/i.test(raw.trim())) return null;
  return asNumber(raw, 0.9);
};

export const config = {
  dryRun: asBool(process.env.DRY_RUN, false),
  force: asBool(process.env.FORCE, false),
  maxChars: asNumber(process.env.MAX_CHARS, 280),
  linkChance: asNumber(process.env.LINK_CHANCE, 0),
  // The workflow fires twice a day (08:00 and 17:00 IST). postsPerDay is the
  // hard cap; minGapMinutes is the quiet period that keeps a retried or manually
  // triggered run from posting twice in the same slot.
  postsPerDay: Math.max(1, Math.round(asNumber(process.env.POSTS_PER_DAY, 2))),
  minGapMinutes: Math.max(0, Math.round(asNumber(process.env.MIN_GAP_MINUTES, 120))),

  ai: {
    apiKey: process.env.OPENAI_API_KEY || '',
    baseUrl: (process.env.OPENAI_BASE_URL || 'https://api.openai.com/v1').replace(/\/+$/, ''),
    model: process.env.OPENAI_MODEL || 'gpt-5.4',
    // Tried in order if the preferred model is not available on the account.
    // Every id here is a real, currently-published OpenAI model.
    fallbackModels: [
      'gpt-5.4',
      'gpt-5.4-mini',
      'gpt-6-luna',
      'gpt-6.1-sol',
      'gpt-5.6-sol',
      'gpt-4.1',
      'gpt-4o',
      'gpt-4o-mini',
    ],
    // How many tokens the model may write. A post is a few hundred at most.
    maxOutputTokens: asNumber(process.env.OPENAI_MAX_TOKENS, 800),
    // Sent only if set. Reasoning models may reject or ignore some values.
    // Set OPENAI_TEMPERATURE=none to leave the parameter out of the request.
    temperature: optionalTemperature(),
    // Optional: none | low | medium | high. Leave unset to use the model default.
    reasoningEffort: process.env.OPENAI_REASONING_EFFORT || '',
  },

  x: {
    consumerKey: process.env.X_API_KEY || '',
    consumerSecret: process.env.X_API_SECRET || '',
    accessToken: process.env.X_ACCESS_TOKEN || '',
    accessTokenSecret: process.env.X_ACCESS_TOKEN_SECRET || '',
    // Optional and rarely needed. This is an OAuth 2.0 USER token, which is a
    // different thing from the app-only Bearer Token (that one cannot post).
    // User tokens expire in about two hours, so OAuth 1.0a is what a scheduled
    // job should use.
    userAccessToken: process.env.X_OAUTH2_USER_TOKEN || '',
    endpoint: process.env.X_ENDPOINT || 'https://api.x.com/2/tweets',
  },

  brand: {
    name: process.env.BRAND_NAME || 'InsuranceMentors.in',
    site: process.env.BRAND_SITE || 'https://www.insurancementors.in',
    whatsapp: process.env.BRAND_WHATSAPP || 'https://wa.me/918096769690',
    handle: (process.env.BRAND_HANDLE || '').replace(/^@/, ''),
  },
};

/** Throws a readable error listing everything that is missing. */
export function requireEnv(needs) {
  const missing = needs.filter((name) => !process.env[name]);
  if (missing.length) {
    throw new Error(
      `Missing required environment variable(s): ${missing.join(', ')}\n` +
        `Locally, add them to .env (copy .env.example).\n` +
        `On GitHub, add them under Settings -> Secrets and variables -> Actions.`
    );
  }
}
