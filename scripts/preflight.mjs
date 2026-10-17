// Preflight: checks every key and permission BEFORE anything is posted.
// Run: node scripts/preflight.mjs   (or: npm run preflight)
//
// Nothing here publishes a post. The X check only reads your own account.
import fs from 'node:fs';
import path from 'node:path';
import { config, ROOT } from '../src/config.mjs';
import { oauthHeader } from '../src/x.mjs';
import { generatePost } from '../src/generate.mjs';
import { themeForDate } from '../src/topics.mjs';
import { loadState, postGate } from '../src/state.mjs';

const results = [];
const record = (status, label, detail = '', fix = '') => {
  results.push({ status, label, detail, fix });
  console.log(`${status.padEnd(5)} ${label}${detail ? `\n        ${detail}` : ''}${fix ? `\n        FIX: ${fix}` : ''}`);
};
const pass = (label, detail) => record('PASS', label, detail);
const fail = (label, detail, fix) => record('FAIL', label, detail, fix);
const warn = (label, detail, fix) => record('WARN', label, detail, fix);

console.log('InsuranceMentors X automation - preflight\n');

// --- 1. Node version -------------------------------------------------------
const major = Number(process.versions.node.split('.')[0]);
if (major >= 20) pass(`Node.js ${process.versions.node}`);
else fail(`Node.js ${process.versions.node} is too old`, '', 'Install Node 20 or newer from nodejs.org');

// --- 2. Configuration ------------------------------------------------------
if (!fs.existsSync(path.join(ROOT, '.env'))) {
  warn('.env file not found', 'Reading keys from the environment only.', 'Copy .env.example to .env if you are testing locally.');
}

// The developer console shows a "Bearer Token" right next to the OAuth 1.0a
// keys, which makes it easy to grab by mistake. It is app-only authentication:
// it identifies the app rather than your account, so X rejects every attempt to
// post with it. Catch that specific mistake with a clear message.
// App-only tokens are recognisable by the run of leading A's.
const appOnlyBearer = (process.env.X_OAUTH2_USER_TOKEN || '').trim();
if (/^AAAAAAAAAAAAAAAAAAAA/.test(appOnlyBearer)) {
  fail(
    'X_OAUTH2_USER_TOKEN is an app-only Bearer Token, not a user token',
    'This is the "Bearer Token" from the developer console. It identifies your app, not your account, and it cannot create posts on X.',
    'Remove X_OAUTH2_USER_TOKEN and use the four OAuth 1.0a values instead: X_API_KEY, X_API_SECRET, X_ACCESS_TOKEN, X_ACCESS_TOKEN_SECRET.'
  );
  finish();
}

const usesOAuth2Token = Boolean(process.env.X_OAUTH2_USER_TOKEN);
const xVariables = usesOAuth2Token
  ? ['X_OAUTH2_USER_TOKEN']
  : ['X_API_KEY', 'X_API_SECRET', 'X_ACCESS_TOKEN', 'X_ACCESS_TOKEN_SECRET'];

const missingOpenAi = process.env.OPENAI_API_KEY ? [] : ['OPENAI_API_KEY'];
const missingX = xVariables.filter((name) => !process.env[name]);
const canPublish = missingX.length === 0;

if (missingOpenAi.length === 0) {
  pass('OPENAI_API_KEY is set');
} else {
  fail(
    'OPENAI_API_KEY is missing',
    'This key writes the post text. Nothing can run without it.',
    'Add it to .env, or as a repository secret on GitHub.'
  );
}

if (canPublish) {
  pass('All 4 X credentials are set', `Auth: ${usesOAuth2Token ? 'OAuth 2.0 user token' : 'OAuth 1.0a'}`);
} else {
  warn(
    `X publishing credentials not set (${missingX.join(', ')})`,
    'OpenAI can still write posts and you can preview them. You just cannot publish to X yet.',
    'These are needed only for the final publishing step. Add them when you are ready to post for real.'
  );
}

// Without an OpenAI key there is nothing useful left to test.
if (missingOpenAi.length) {
  finish();
}

// --- 3. OpenAI: is the key valid, and which models can it reach? -----------
let availableModels = [];
try {
  const response = await fetch(`${config.ai.baseUrl}/models`, {
    headers: { Authorization: `Bearer ${config.ai.apiKey}` },
  });
  if (response.ok) {
    const { data } = await response.json();
    availableModels = (data || []).map((model) => model.id);
    pass('OpenAI API key works', `${availableModels.length} models visible to this key.`);
  } else {
    const body = await response.text();
    fail(
      `OpenAI key rejected (HTTP ${response.status})`,
      body.slice(0, 200),
      response.status === 401
        ? 'The key is wrong or revoked. Create a new one at platform.openai.com/api-keys'
        : 'Check your OpenAI account billing and region.'
    );
  }
} catch (error) {
  fail('Could not reach the OpenAI API', error.message, 'Check your internet connection or any proxy/firewall.');
}

if (availableModels.length) {
  const preferred = config.ai.model;
  if (availableModels.includes(preferred)) {
    pass(`Preferred model "${preferred}" is available`);
  } else {
    const next = config.ai.fallbackModels.find((id) => availableModels.includes(id));
    warn(
      `Preferred model "${preferred}" is NOT available to this key`,
      next ? `The script will fall back to "${next}", so posting still works.` : 'None of the fallback models are available either.',
      'Optionally set OPENAI_MODEL to a model that is available.'
    );
  }
}

// --- 4. OpenAI: does a real post actually generate? ------------------------
// This runs the true generation path: same prompt, same parameters, same
// fallback handling. Nothing is published to X.
const today = new Date();
const theme = themeForDate(today);
try {
  const started = Date.now();
  const { text, warnings } = await generatePost({
    topic: {
      id: 'preflight',
      category: 'health',
      topic: 'A short preflight test of the posting pipeline',
      brief: 'Just confirm the pipeline works. Say something simple and true about checking your health insurance sum insured each year.',
    },
    theme,
    recent: [],
    linkLine: null,
  });
  const seconds = ((Date.now() - started) / 1000).toFixed(1);
  pass('Generated a real draft end to end', `${seconds}s, ${text.length} characters`);
  console.log('\n-------- the draft it produced --------');
  console.log(text);
  console.log('---------------------------------------\n');
  for (const warning of warnings) warn(`Quality warning: ${warning}`);
} catch (error) {
  if (error.outOfCredits) {
    fail(
      'OpenAI account has no credits',
      'OpenAI answered HTTP 429 "credit_balance_exhausted". The key itself is fine — a GET to /v1/models succeeds with it. Only the prepaid balance is empty.',
      'Open https://platform.openai.com/settings/organization/billing and buy credits (minimum $5, then allow a few minutes). If that page already shows a balance, then it is not SPENDABLE: purchased credits expire after 1 year, and usage processed after a balance hits zero can leave a negative balance that eats the next purchase. Also confirm the organization shown top-left is the one that owns this key — a ChatGPT Plus/Pro subscription does NOT fund the API.'
    );
  } else {
    fail('Generation failed', error.message, 'This is the same path the daily run uses, so fix this before deploying.');
  }
}

// --- 5. X: can we authenticate as the right account? (read-only) -----------
// GET /2/users/me verifies the OAuth signature and the token without posting.
// It is the closest thing to "will posting work?" that costs nothing.
//
// Skipped when the X credentials are not set yet, so the OpenAI half of the
// pipeline can be tested and previewed on its own.
/**
 * Proves the token can WRITE, without publishing anything.
 *
 * X checks permissions before it validates the body, so an intentionally empty
 * post answers the question and can never be created:
 *   - 400 -> permission is fine; the empty body was rejected (expected, harmless)
 *   - 403 -> the token is read-only, so posting will always fail
 * This is the only way to know for certain before the first real post. It also
 * exercises the POST signing path, which the GET above does not.
 */
async function probeWritePermission() {
  const authorization = usesOAuth2Token
    ? `Bearer ${config.x.userAccessToken}`
    : oauthHeader({
        method: 'POST',
        url: config.x.endpoint,
        consumerKey: config.x.consumerKey,
        consumerSecret: config.x.consumerSecret,
        token: config.x.accessToken,
        tokenSecret: config.x.accessTokenSecret,
      });

  const response = await fetch(config.x.endpoint, {
    method: 'POST',
    headers: { Authorization: authorization, 'Content-Type': 'application/json' },
    body: JSON.stringify({}),
  });
  const raw = await response.text();
  let payload = null;
  try {
    payload = JSON.parse(raw);
  } catch {
    /* keep raw */
  }

  if (response.status === 400) {
    pass('The token can write', 'Write permission confirmed by a deliberate 400. Nothing was posted.');
  } else if (response.status === 403) {
    fail(
      'The token cannot post (read-only)',
      payload?.detail || payload?.title || raw.slice(0, 200),
      'Set App permissions to "Read and write" in User authentication settings, SAVE, then REGENERATE the Access Token and Secret. Permission is fixed at the moment a token is created, so an older token stays read-only forever.'
    );
  } else if (response.status === 402) {
    fail(
      'X account has no API credits (HTTP 402)',
      `${payload?.detail || payload?.title || raw.slice(0, 200)} — the write permission itself is fine, X got as far as billing.`,
      'Add credits to the Pay Per Use plan at https://console.x.com under Billing / Credits. Alternatively, saving a payment card earns new pay-per-use accounts free credits (X advertises up to $70) — and at two posts a day, any small balance lasts a long time.'
    );
  } else if (response.ok) {
    fail(
      `Unexpected: an empty post was accepted (HTTP ${response.status})`,
      raw.slice(0, 200),
      'Stop and investigate before running a live post.'
    );
  } else {
    fail(
      `Write check returned HTTP ${response.status}`,
      raw.slice(0, 200),
      'Re-check the four X values and the app permissions.'
    );
  }
}

if (canPublish) {
  const origin = new URL(config.x.endpoint).origin;
  const meUrl = `${origin}/2/users/me`;
  try {
    const authorization = usesOAuth2Token
      ? `Bearer ${config.x.userAccessToken}`
      : oauthHeader({
          method: 'GET',
          url: meUrl,
          consumerKey: config.x.consumerKey,
          consumerSecret: config.x.consumerSecret,
          token: config.x.accessToken,
          tokenSecret: config.x.accessTokenSecret,
        });

    const response = await fetch(meUrl, { headers: { Authorization: authorization } });
    const body = await response.text();
    let payload = null;
    try {
      payload = JSON.parse(body);
    } catch {
      /* keep raw */
    }

    if (response.ok && payload?.data?.username) {
      pass(
        'X credentials are valid',
        `This will post as @${payload.data.username} (${payload.data.name}). Check that this is the account you want.`
      );
      await probeWritePermission();
    } else if (
      payload?.reason === 'client-not-enrolled' ||
      /attached to a Project/i.test(String(payload?.detail || ''))
    ) {
      // A distinctive 403. TWO conditions must both hold, and most people only
      // fix the first: the app has to live inside a Project, AND that Project
      // needs an API access level activated. X discloses the second half in
      // "required_enrollment" — "Appropriate Level of API Access" means the app
      // has no access tier attached at all.
      const wants = payload?.required_enrollment
        ? `X asks for: "${payload.required_enrollment}".`
        : '';
      fail(
        'This X app has no API access level (HTTP 403)',
        [payload?.client_id ? `App id ${payload.client_id}.` : '', wants, payload?.detail || '']
          .filter(Boolean)
          .join(' '),
        `Two known causes, and the app id above tells you which. (1) An app listed under "Standalone Apps" can never call v2 — but regenerating keys does NOT move it into a Project, so create a new App inside one. (2) An app that IS connected to a Project which still shows "Free (deprecated)" / "Standard Basic" hits this exact 403 with required_enrollment "Appropriate Level of API Access" — a known X fault with NO self-serve fix. X staff must migrate the app to Pay Per Use: post a new topic in the X developer forum (category Developer Portal) with the numeric App ID, the endpoints, and this error JSON. Regenerating keys fixes neither. Guide: ${payload?.registration_url || 'https://developer.x.com/en/docs/projects/overview'}`
      );
    } else if (response.status === 401 || response.status === 403) {
      fail(
        `X rejected the credentials (HTTP ${response.status})`,
        payload?.detail || payload?.title || body.slice(0, 200),
        'Set App permissions to "Read and Write" in the X developer portal, then REGENERATE the Access Token and Secret. A token created before that change cannot post. Also check you did not paste the app-only Bearer Token.'
      );
    } else {
      fail(
        `X returned HTTP ${response.status}`,
        body.slice(0, 200),
        'Re-check the four X values against the developer portal.'
      );
    }
  } catch (error) {
    fail('Could not reach the X API', error.message, 'Check your internet connection or any proxy/firewall.');
  }
} else {
  warn(
    'Skipped the X account check',
    'No X credentials to test with yet.',
    'Everything else above still proves the post will be written correctly. Add the X keys when you want to publish.'
  );
}

// --- 6. Local history state -------------------------------------------------
// Goes through the same state module the real run uses, so this reports exactly
// what a post would do right now rather than re-implementing the guard.
// STATE_FILE redirects it during tests.
try {
  const state = loadState();
  const gate = postGate(state, {
    postsPerDay: config.postsPerDay,
    minGapMinutes: config.minGapMinutes,
  });
  if (gate.allowed) {
    pass('Ready to post', `${gate.count} of ${config.postsPerDay} post(s) used today.`);
  } else {
    warn(
      'No post would go out right now',
      gate.reason,
      'That is the double-post guard working. Use --force to post anyway.'
    );
  }
} catch (error) {
  warn('Could not read the local posting history', error.message, 'It will be recreated automatically.');
}

finish();

function finish() {
  const failures = results.filter((r) => r.status === 'FAIL').length;
  const warnings = results.filter((r) => r.status === 'WARN').length;
  console.log(
    `\n${results.length - failures - warnings} passed, ${warnings} warning(s), ${failures} failure(s).`
  );
  if (failures) {
    console.log('\nFix the FAIL lines before deploying. Nothing was posted by this check.');
    process.exitCode = 1;
  } else if (canPublish) {
    console.log('\nEverything checks out. Nothing was posted by this check.');
    console.log('Next: preview with "npm run preview", then publish with "npm run post".');
  } else {
    console.log('\nGeneration is fully verified. Nothing was posted by this check.');
    console.log('Add your X credentials when you are ready to publish (README step 3).');
    console.log('Next: preview a real post with "npm run preview".');
  }
  process.exit(process.exitCode || 0);
}
