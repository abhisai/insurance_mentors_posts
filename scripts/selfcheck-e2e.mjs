// End-to-end check with mock OpenAI + mock X servers. No real credentials needed.
// Run: node scripts/selfcheck-e2e.mjs
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { config } from '../src/config.mjs';
import { todayKey } from '../src/state.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
// Never point the suite at the real data/state.json. Once an actual post exists
// for today, the "already posted today" guard trips and the live-run checks all
// fail. The runners get this throwaway path through STATE_FILE instead.
const STATE = path.join(os.tmpdir(), `insurancementors-selfcheck-${process.pid}.json`);
fs.writeFileSync(STATE, '{\n  "version": 1,\n  "posts": []\n}\n', 'utf8');
// Regression guard: the suite must not modify the real history file. It used to
// rewrite it and restore a backup at the end, which both raced with a genuine
// post and left the file destroyed if the run was interrupted.
const REAL_STATE = path.join(ROOT, 'data', 'state.json');
const realStateBefore = fs.existsSync(REAL_STATE) ? fs.readFileSync(REAL_STATE, 'utf8') : null;
const MODEL = config.ai.model;

const AI_REPLY = `Myth: a Rs 3 lakh health cover is enough.

One week in a metro ICU can eat most of it.

Check the sum insured first. Compare premiums last.

#HealthInsurance`;

/** Controls how the mock AI behaves. Tests flip this between runs. */
const ai = { mode: 'ok', calls: [], failures: 0 };
const x = { calls: [] };

const listen = (server) =>
  new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server.address().port)));

const readBody = (req) =>
  new Promise((resolve) => {
    let body = '';
    req.on('data', (chunk) => (body += chunk));
    req.on('end', () => resolve(body));
  });

const send = (res, status, payload) => {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(payload));
};

const aiServer = http.createServer(async (req, res) => {
  let body = {};
  try {
    body = JSON.parse((await readBody(req)) || '{}');
  } catch {
    /* ignore */
  }
  ai.calls.push({ url: req.url, method: req.method, auth: req.headers.authorization, body });

  if (ai.mode === 'reject-temperature' && body.temperature !== undefined) {
    send(res, 400, {
      error: {
        message: "Unsupported parameter: 'temperature' is not supported with this model.",
        type: 'invalid_request_error',
        param: 'temperature',
        code: 'unsupported_parameter',
      },
    });
    return;
  }

  if (ai.mode === 'always-400') {
    send(res, 400, {
      error: { message: 'You do not have access to this model.', type: 'invalid_request_error' },
    });
    return;
  }

  // A transient OpenAI 5xx. The next attempt must succeed without a new run.
  if (ai.mode === 'flaky-500' && ai.failures > 0) {
    ai.failures -= 1;
    send(res, 500, {
      error: {
        message: 'The server had an error while processing your request. Sorry about that!',
        type: 'server_error',
      },
    });
    return;
  }

  // A valid key on an account with no billing. X's/OpenAI's 429 here is not a
  // rate limit, so the code must not treat it as "retry or try another model".
  if (ai.mode === 'no-credits' && req.url.includes('chat/completions')) {
    send(res, 429, {
      error: {
        message: 'You have no credits remaining. Add credits to continue using the API.',
        type: 'insufficient_quota',
        param: null,
        code: 'insufficient_quota',
      },
    });
    return;
  }

  // Mimics a reasoning model that spends its entire output budget on hidden
  // reasoning: empty content with finish_reason "length" whenever a cap is set.
  if (ai.mode === 'reasoning-budget') {
    const capped = body.max_completion_tokens !== undefined || body.max_tokens !== undefined;
    if (capped) {
      send(res, 200, { choices: [{ index: 0, finish_reason: 'length', message: { role: 'assistant', content: '' } }] });
      return;
    }
  }

  // A model that ignores the "no URL" instruction. The code must not publish it.
  if (ai.mode === 'reply-with-link') {
    send(res, 200, {
      choices: [
        {
          index: 0,
          finish_reason: 'stop',
          message: {
            role: 'assistant',
            content: `${AI_REPLY}\n\nFree advice, no pressure: https://www.insurancementors.in`,
          },
        },
      ],
    });
    return;
  }

  // A model that writes the domain without a scheme.
  if (ai.mode === 'reply-bare-domain') {
    send(res, 200, {
      choices: [
        {
          index: 0,
          finish_reason: 'stop',
          message: {
            role: 'assistant',
            content: 'Check the sum insured first, not the premium.\n\nAsk us anything at insurancementors.in',
          },
        },
      ],
    });
    return;
  }

  send(res, 200, { choices: [{ index: 0, finish_reason: 'stop', message: { role: 'assistant', content: AI_REPLY } }] });
});

const xServer = http.createServer(async (req, res) => {
  let body = {};
  try {
    body = JSON.parse((await readBody(req)) || '{}');
  } catch {
    /* ignore */
  }
  x.calls.push({ url: req.url, method: req.method, auth: req.headers.authorization, body });

  if (!req.headers.authorization) {
    send(res, 401, { detail: 'Unauthorized' });
    return;
  }

  // Read-only identity lookup used by the preflight check.
  if (req.method === 'GET' && req.url.startsWith('/2/users/me')) {
    if (ai.mode === 'bad-x-auth') {
      send(res, 401, { title: 'Unauthorized', detail: 'Unauthorized' });
      return;
    }
    // A standalone app that is not inside a Project. X answers every v2 call
    // with this, regardless of how good the credentials are.
    if (ai.mode === 'x-not-enrolled') {
      // Copied verbatim from a real X response.
      send(res, 403, {
        client_id: '30095110',
        detail:
          'When authenticating requests to the X API v2 endpoints, you must use keys and tokens from a developer App that is attached to a Project. You can create a project via the developer portal.',
        reason: 'client-not-enrolled',
        registration_url: 'https://developer.x.com/en/docs/projects/overview',
        required_enrollment: 'Appropriate Level of API Access',
        title: 'Client Forbidden',
        type: 'https://api.x.com/2/problems/client-forbidden',
      });
      return;
    }
    send(res, 200, { data: { id: '1234567890', name: 'Insurance Mentors', username: 'InsuranceMentors' } });
    return;
  }

  if (req.method === 'POST') {
    // A read-only token: X refuses the write outright, before looking at the body.
    if (ai.mode === 'x-read-only') {
      send(res, 403, {
        title: 'Forbidden',
        detail: 'This client application does not have permission to make write requests.',
      });
      return;
    }
    // A valid, writable token on an account with no X credits. X refuses at the
    // billing step, which means the permission check already passed.
    if (ai.mode === 'x-no-credits') {
      send(res, 402, {
        detail: 'credits depleted',
        status: 402,
        title: 'Payment Required',
        type: 'https://api.x.com/2/problems/credits-depleted',
      });
      return;
    }
    // Real X rejects an empty post with 400 before creating anything. Mocking
    // that faithfully is what makes preflight's write probe safe to assert on.
    if (typeof body.text !== 'string' || !body.text.trim()) {
      send(res, 400, {
        title: 'Invalid Request',
        detail: 'Invalid Request',
        errors: [{ message: 'Invalid Request' }],
      });
      return;
    }
    send(res, 201, { data: { id: '1999999999999999999', text: body.text } });
    return;
  }

  send(res, 201, { data: { id: '1999999999999999999', text: 'ok' } });
});

const aiPort = await listen(aiServer);
const xPort = await listen(xServer);

function run(args, script = path.join('src', 'index.mjs'), envOverride = {}) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [script, ...args], {
      cwd: ROOT,
      env: {
        ...process.env,
        OPENAI_API_KEY: 'sk-test-key',
        OPENAI_BASE_URL: `http://127.0.0.1:${aiPort}/v1`,
        OPENAI_MODEL: MODEL,
        X_API_KEY: 'testkey',
        X_API_SECRET: 'testsecret',
        X_ACCESS_TOKEN: 'testtoken',
        X_ACCESS_TOKEN_SECRET: 'testtokensecret',
        X_ENDPOINT: `http://127.0.0.1:${xPort}/2/tweets`,
        STATE_FILE: STATE,
        LINK_CHANCE: '0',
        // Old, single-post-per-day semantics by default; the two-a-day tests
        // below override these.
        POSTS_PER_DAY: '1',
        MIN_GAP_MINUTES: '0',
        GITHUB_STEP_SUMMARY: '',
        ...envOverride,
      },
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => (stdout += chunk));
    child.stderr.on('data', (chunk) => (stderr += chunk));
    child.on('close', (status) => resolve({ status, stdout, stderr }));
  });
}

const checks = [];
const check = (name, condition, detail = '') => {
  checks.push({ name, ok: Boolean(condition), detail });
  console.log(`${condition ? 'PASS' : 'FAIL'}  ${name}${detail ? `  -> ${detail}` : ''}`);
};
const reset = () => {
  ai.calls.length = 0;
  x.calls.length = 0;
};
const clearHistory = () => fs.writeFileSync(STATE, '{\n  "version": 1,\n  "posts": []\n}\n', 'utf8');

try {
  check(
    'daily cap uses IST date across UTC midnight',
    todayKey(new Date('2026-10-23T21:00:00Z')) === '2026-10-24',
    `date: ${todayKey(new Date('2026-10-23T21:00:00Z'))}`
  );

  // --- 1. Dry run must not touch X or the state file -----------------------
  reset();
  const dry = await run(['--dry-run']);
  check('dry run exits 0', dry.status === 0, dry.stderr.trim().split('\n').pop());
  check('dry run calls the AI once', ai.calls.length === 1, `AI calls: ${ai.calls.length}`);
  check('dry run does not post', x.calls.length === 0, `X calls: ${x.calls.length}`);
  check('dry run prints the draft', dry.stdout.includes('Myth: a Rs 3 lakh health cover'));
  check('dry run leaves the posting history untouched', JSON.parse(fs.readFileSync(STATE, 'utf8')).posts.length === 0);

  // --- 2. Live run posts and records --------------------------------------
  reset();
  const live = await run([]);
  check('live run exits 0', live.status === 0, live.stderr.trim().split('\n').pop());
  check('live run posts exactly once', x.calls.length === 1, `X calls: ${x.calls.length}`);
  check('post endpoint is correct', x.calls[0]?.url === '/2/tweets', x.calls[0]?.url);
  check('post uses POST', x.calls[0]?.method === 'POST');
  check('post sends the generated text as JSON', x.calls[0]?.body?.text === AI_REPLY);
  check('post is OAuth 1.0a signed', (x.calls[0]?.auth || '').startsWith('OAuth '), (x.calls[0]?.auth || '').slice(0, 40));
  check(
    'signature header has all oauth fields',
    [
      'oauth_consumer_key',
      'oauth_nonce',
      'oauth_signature',
      'oauth_signature_method',
      'oauth_timestamp',
      'oauth_token',
      'oauth_version',
    ].every((field) => (x.calls[0]?.auth || '').includes(field))
  );
  check('live run reports the published url', live.stdout.includes('https://x.com/i/web/status/1999999999999999999'));

  const state = JSON.parse(fs.readFileSync(STATE, 'utf8'));
  check('state records one post', state.posts.length === 1, `posts: ${state.posts.length}`);
  check('state records the topic id', Boolean(state.posts[0]?.topicId), state.posts[0]?.topicId);
  check('state records the post id', state.posts[0]?.postId === '1999999999999999999');
  check('state records mode=live', state.posts[0]?.mode === 'live');

  // --- 3. The same day must not be posted twice ---------------------------
  const before = x.calls.length;
  const again = await run([]);
  check('second run on the same day does not post', x.calls.length === before, `X calls: ${x.calls.length}`);
  check('second run explains the skip', again.stdout.includes('daily limit of 1'));

  // --- 3b. Three posts a day: the daily limit and the minimum gap ---------
  // The cap allows one post per scheduled slot; the gap blocks quick retries.
  clearHistory();
  reset();
  await run([], 'src/index.mjs', { POSTS_PER_DAY: '3', MIN_GAP_MINUTES: '0' });
  await run([], 'src/index.mjs', { POSTS_PER_DAY: '3', MIN_GAP_MINUTES: '0' });
  await run([], 'src/index.mjs', { POSTS_PER_DAY: '3', MIN_GAP_MINUTES: '0' });
  check('all three slots of the day may post', x.calls.length === 3, `X calls: ${x.calls.length}`);

  const overLimit = await run([], 'src/index.mjs', { POSTS_PER_DAY: '3', MIN_GAP_MINUTES: '0' });
  check('a fourth post is refused', x.calls.length === 3, `X calls: ${x.calls.length}`);
  check('it explains the daily limit', overLimit.stdout.includes('daily limit of 3'));

  clearHistory();
  reset();
  await run([], 'src/index.mjs', { POSTS_PER_DAY: '2', MIN_GAP_MINUTES: '0' });
  const tooSoon = await run([], 'src/index.mjs', { POSTS_PER_DAY: '2', MIN_GAP_MINUTES: '120' });
  check('the minimum gap blocks the next slot too early', x.calls.length === 1, `X calls: ${x.calls.length}`);
  check('it explains the minimum gap', tooSoon.stdout.includes('minimum gap is 120'));

  const forcedAgain = await run(['--force'], 'src/index.mjs', {
    POSTS_PER_DAY: '2',
    MIN_GAP_MINUTES: '120',
  });
  check('--force overrides the gap', x.calls.length === 2, `X calls: ${x.calls.length}`);
  check('the forced run really published', forcedAgain.stdout.includes('Published:'));
  clearHistory();

  // --- 3c. Links are off, and that is enforced rather than requested -------
  ai.mode = 'reply-with-link';
  clearHistory();
  reset();
  await run([], 'src/index.mjs', { LINK_CHANCE: '0', POSTS_PER_DAY: '2', MIN_GAP_MINUTES: '0' });
  const noLink = x.calls[0]?.body?.text || '';
  check('a URL the model sneaks in is stripped', !/https?:\/\//i.test(noLink), noLink.split('\n').pop());
  check('the dangling link line is dropped with it', !noLink.includes('Free advice'));
  check('and the run still publishes', x.calls.length === 1, `X calls: ${x.calls.length}`);

  clearHistory();
  reset();
  await run([], 'src/index.mjs', { LINK_CHANCE: '1', POSTS_PER_DAY: '2', MIN_GAP_MINUTES: '0' });
  check(
    'LINK_CHANCE=1 still lets a link through when you ask for one',
    (x.calls[0]?.body?.text || '').includes('https://www.insurancementors.in')
  );

  clearHistory();
  reset();
  ai.mode = 'reply-bare-domain';
  await run([], 'src/index.mjs', { LINK_CHANCE: '0', POSTS_PER_DAY: '2', MIN_GAP_MINUTES: '0' });
  const bare = x.calls[0]?.body?.text || '';
  check('a bare domain is stripped too', !/insurancementors\.in/i.test(bare), bare.split('\n').pop());
  check('the sentence around a bare domain survives', bare.includes('Ask us anything at'));
  ai.mode = 'ok';
  clearHistory();

  // --- 4. Topic override --------------------------------------------------
  reset();
  const forced = await run(['--dry-run', '--topic', 'term-human-life-value']);
  check('--topic selects the requested topic', forced.stdout.includes('term-human-life-value'));

  const bad = await run(['--dry-run', '--topic', 'nope-not-a-topic']);
  check('unknown topic id fails', bad.status === 1);
  check('unknown topic id explains why', bad.stderr.includes('Unknown topic id'));

  // --- 5. OpenAI request payload sanity -----------------------------------
  const payload = ai.calls[0]?.body;
  check('request uses the configured model', payload?.model === MODEL, payload?.model);
  check('request has system + user messages', payload?.messages?.length === 2);
  check('request carries the bearer key', ai.calls[0]?.auth === 'Bearer sk-test-key');
  check('request hits /chat/completions', ai.calls[0]?.url === '/v1/chat/completions', ai.calls[0]?.url);
  check('request uses max_completion_tokens', payload?.max_completion_tokens === 800, String(payload?.max_completion_tokens));
  check('request does not send the legacy max_tokens', payload?.max_tokens === undefined);
  check('request sends a temperature', payload?.temperature === 0.9, String(payload?.temperature));

  // --- 6. Reasoning models that reject temperature must still work --------
  // Clear today's history first: the mock always returns the same text, which
  // would otherwise trigger the separate anti-repetition retry and muddy the count.
  fs.writeFileSync(STATE, '{\n  "version": 1,\n  "posts": []\n}\n', 'utf8');
  ai.mode = 'reject-temperature';
  reset();
  const recovered = await run(['--dry-run']);
  check('recovers when the model rejects temperature', recovered.status === 0, recovered.stderr.trim().split('\n').pop());
  check('retried exactly once', ai.calls.length === 2, `AI calls: ${ai.calls.length}`);
  check('retry dropped the temperature param', ai.calls[1]?.body?.temperature === undefined);
  check('retry kept the model and messages', ai.calls[1]?.body?.model === MODEL && ai.calls[1]?.body?.messages.length === 2);
  ai.mode = 'ok';

  // --- 6b. A transient 5xx must be retried, not fail the run --------------
  ai.mode = 'flaky-500';
  ai.failures = 1;
  reset();
  const flaky = await run(['--dry-run']);
  check('a transient 500 is retried', flaky.status === 0, flaky.stderr.trim().split('\n').pop());
  check(
    'the retry used the same model',
    ai.calls.length === 2 && ai.calls[1]?.body?.model === MODEL,
    `AI calls: ${ai.calls.length}`
  );
  check('the retry is announced', flaky.stderr.includes('Retrying in'), flaky.stderr.trim().split('\n')[0]);
  ai.mode = 'ok';

  // --- 7. Real API errors must surface the OpenAI message and fail --------
  ai.mode = 'always-400';
  reset();
  const broken = await run(['--dry-run']);
  check('a genuine API error exits non-zero', broken.status === 1, `status: ${broken.status}`);
  check('the OpenAI error message is surfaced', broken.stderr.includes('You do not have access to this model.'));
  check('it tried the fallback models too', ai.calls.length > 1, `AI calls: ${ai.calls.length}`);
  ai.mode = 'ok';

  // --- 8. A reasoning model that burns its output budget must still work ---
  ai.mode = 'reasoning-budget';
  reset();
  const budget = await run(['--dry-run']);
  check('recovers when reasoning eats the output budget', budget.status === 0, budget.stderr.trim().split('\n').pop());
  check('eventually sent a request with no token cap', ai.calls.some((c) => c.body.max_completion_tokens === undefined && c.body.max_tokens === undefined));
  check('it did try a capped request first', ai.calls[0]?.body?.max_completion_tokens !== undefined);
  ai.mode = 'ok';

  // --- 9. The preflight check itself must work ----------------------------
  reset();
  fs.writeFileSync(STATE, '{\n  "version": 1,\n  "posts": []\n}\n', 'utf8');
  const pre = await run([], 'scripts/preflight.mjs');
  check('preflight exits 0 on a healthy setup', pre.status === 0, pre.stderr.trim().split('\n').pop());
  check('preflight validates the OpenAI key', pre.stdout.includes('OpenAI API key works'));
  check('preflight identifies the X account', pre.stdout.includes('@InsuranceMentors'));
  check('preflight generates a real draft', pre.stdout.includes('Generated a real draft end to end'));
  check('preflight confirms a post is still allowed', pre.stdout.includes('Ready to post'));
  check('preflight confirms write permission without posting', pre.stdout.includes('The token can write'));
  check(
    'the write probe never carries publishable text',
    !x.calls.some((c) => c.method === 'POST' && c.body?.text),
    `POSTs with text: ${x.calls.filter((c) => c.method === 'POST' && c.body?.text).length}`
  );
  check('preflight uses a read-only X call', x.calls.some((c) => c.method === 'GET' && c.url.startsWith('/2/users/me')));

  // --- 10. Preflight must fail loudly on bad X credentials ----------------
  ai.mode = 'bad-x-auth';
  reset();
  const preFail = await run([], 'scripts/preflight.mjs');
  check('preflight fails when X rejects the token', preFail.status === 1, `status: ${preFail.status}`);
  check('preflight explains the Read+Write fix', preFail.stdout.includes('REGENERATE the Access Token'));
  ai.mode = 'ok';
  reset();

  // --- 10b. Preflight must recognise the "not in a Project" 403 ------------
  // This 403 looks like an auth failure but is nothing of the sort, and the
  // generic Read+Write advice would send you down the wrong path for hours.
  ai.mode = 'x-not-enrolled';
  reset();
  const preEnroll = await run([], 'scripts/preflight.mjs');
  check('preflight fails on a client-not-enrolled app', preEnroll.status === 1, `status: ${preEnroll.status}`);
  check('it names the missing API access level', preEnroll.stdout.includes('no API access level'));
  check('it quotes the enrollment X wants', preEnroll.stdout.includes('Appropriate Level of API Access'));
  check('it reports the offending app id', preEnroll.stdout.includes('App id 30095110'));
  check('it does NOT blame the Read+Write permission', !preEnroll.stdout.includes('REGENERATE the Access Token'));
  check('it points at Standalone Apps as the trap', preEnroll.stdout.includes('Standalone Apps'));
  ai.mode = 'ok';
  reset();

  // --- 10c. A key on an account with no billing must be named, not "429" ---
  // A 429 here is not a rate limit, so it must not be retried or handed to the
  // next fallback model. One attempt, one clear message.
  ai.mode = 'no-credits';
  reset();
  const noCredits = await run([], 'scripts/preflight.mjs');
  check('preflight fails when the account has no credits', noCredits.status === 1, `status: ${noCredits.status}`);
  check('it names the missing credits', noCredits.stdout.includes('OpenAI account has no credits'));
  check(
    'it links to the OpenAI billing page',
    noCredits.stdout.includes('platform.openai.com/settings/organization/billing')
  );
  check(
    'a quota error does not cycle through fallback models',
    ai.calls.filter((c) => c.url.includes('chat/completions')).length === 1,
    `chat calls: ${ai.calls.filter((c) => c.url.includes('chat/completions')).length}`
  );
  ai.mode = 'ok';
  reset();

  // --- 10d. A read-only token must be caught before the first real post ----
  // The probe sends an empty post, which X rejects with 400. A read-only token
  // is refused earlier with 403. Either way, nothing is ever published.
  ai.mode = 'x-read-only';
  reset();
  const readOnly = await run([], 'scripts/preflight.mjs');
  check('preflight detects a read-only token', readOnly.status === 1, `status: ${readOnly.status}`);
  check('it says the token cannot post', readOnly.stdout.includes('cannot post (read-only)'));
  check('it tells you to regenerate the token', readOnly.stdout.includes('REGENERATE the Access Token'));
  check(
    'even the failing probe sends no publishable text',
    !x.calls.some((c) => c.method === 'POST' && c.body?.text),
    `POSTs with text: ${x.calls.filter((c) => c.method === 'POST' && c.body?.text).length}`
  );
  ai.mode = 'ok';
  reset();

  // --- 10e. X with no credits is a billing problem, not a key problem ------
  ai.mode = 'x-no-credits';
  reset();
  const broke = await run([], 'scripts/preflight.mjs');
  check('preflight detects X with no credits', broke.status === 1, `status: ${broke.status}`);
  check('it names the X credit problem', broke.stdout.includes('X account has no API credits'));
  check('it says the write permission is fine', broke.stdout.includes('write permission itself is fine'));
  check('it points at X billing', broke.stdout.includes('Billing / Credits'));
  ai.mode = 'ok';
  reset();

  // --- 11. OpenAI-only setup: previewable, but not publishable ------------
  const noXKeys = { X_API_KEY: '', X_API_SECRET: '', X_ACCESS_TOKEN: '', X_ACCESS_TOKEN_SECRET: '', X_OAUTH2_USER_TOKEN: '' };
  reset();
  const openAiOnly = await run([], 'scripts/preflight.mjs', noXKeys);
  check('preflight passes with only an OpenAI key', openAiOnly.status === 0, `status: ${openAiOnly.status}`);
  check('it warns that X credentials are missing', openAiOnly.stdout.includes('X publishing credentials not set'));
  check('it still verifies OpenAI and generates', openAiOnly.stdout.includes('Generated a real draft end to end'));
  check('it says generation is verified but publishing is not', openAiOnly.stdout.includes('Generation is fully verified'));
  check('it never tries to publish', !x.calls.some((c) => c.method === 'POST'), `X calls: ${x.calls.length}`);

  reset();
  const previewOnly = await run(['--dry-run'], 'src/index.mjs', noXKeys);
  check('preview works with only an OpenAI key', previewOnly.status === 0, previewOnly.stderr.trim().split('\n').pop());
  check('preview prints a draft', previewOnly.stdout.includes('Myth: a Rs 3 lakh health cover'));

  const publishOnly = await run([], 'src/index.mjs', noXKeys);
  check('publishing without X keys fails clearly', publishOnly.status === 1);
  check('it names the missing X variables', publishOnly.stderr.includes('X_API_KEY'));

  // --- 12. Pasting the app-only Bearer Token must be caught ----------------
  reset();
  const bearerTrap = await run([], 'scripts/preflight.mjs', {
    X_OAUTH2_USER_TOKEN: 'AAAAAAAAAAAAAAAAAAAAAMLheAAAAAAA0%2BuSeid%2BULvsea4JtiGRiSDSJSI%3D',
  });
  check('preflight rejects the app-only Bearer Token', bearerTrap.status === 1, `status: ${bearerTrap.status}`);
  check('it explains why the Bearer Token cannot post', bearerTrap.stdout.includes('cannot create posts on X'));
  check('it points at the OAuth 1.0a values instead', bearerTrap.stdout.includes('use the four OAuth 1.0a values instead'));
  reset();
} finally {
  aiServer.close();
  xServer.close();
  fs.rmSync(STATE, { force: true });
}

check(
  'the suite never modifies the real posting history',
  (fs.existsSync(REAL_STATE) ? fs.readFileSync(REAL_STATE, 'utf8') : null) === realStateBefore
);

const failed = checks.filter((c) => !c.ok);
console.log(`\n${checks.length - failed.length}/${checks.length} checks passed`);
if (failed.length) {
  console.log('Failures:', failed.map((c) => c.name).join('; '));
  process.exitCode = 1;
}
