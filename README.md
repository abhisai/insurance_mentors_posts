# InsuranceMentors.in — daily X (Twitter) automation

Writes insurance posts with the OpenAI (ChatGPT) API and publishes them straight to
X — two a day, at 08:00 and 17:00 IST. Runs in GitHub Actions, so it works even when
your laptop is off. No API keys live in the code, and there are no npm dependencies.

```
GitHub Actions (08:00 and 17:00 IST)
        |
        v
data/topics.json  -->  pick today's topic (rotates by weekday theme)
        |
        v
src/generate.mjs  -->  OpenAI writes the post  -->  cleanup + rules check
        |
        v
src/x.mjs         -->  POST https://api.x.com/2/tweets  (OAuth 1.0a signed)
        |
        v
data/state.json   -->  history committed back, so topics never repeat
```

---

## Setup checklist

The whole thing on one screen. Run it top to bottom; the two steps marked **⚠** are
where almost everyone loses a day.

- [ ] **OpenAI key** — create one at <https://platform.openai.com/api-keys> and add
      credit under **Settings → Billing**. *Writes the post.* — step 2
- [ ] **X Project** — **⚠** your App must sit **inside a Project on the Pay Per Use
      plan**. X retired its free tier; an App left on "Free (deprecated)" returns
      `403 client-not-enrolled` forever, however often you regenerate its keys. — step 3
- [ ] **X credits** — add credits at **Billing / Credits** (saving a card earns free
      credits). Without a balance, posting returns `402 credits depleted`. — step 3
- [ ] **X permission** — set **User authentication settings → App permissions** to
      `Read and write`. — step 3
- [ ] **X token** — **⚠** *after* saving the permission, regenerate the **Access
      Token and Secret**. A token minted while the App was read-only can never write. — step 3
- [ ] **Values in place** — locally fill in `.env`; in GitHub add the same five as
      repository secrets. *Publishes the post.* — steps 3, 5
- [ ] **Verify** — `npm run preflight` ends with **0 failures** and prints the correct
      @handle. Nothing is posted. — step 6, Stage 1
- [ ] **Publish once** — `npm run post`, then `npm run reset` to clear the test
      history. — step 6, Stages 2–3
- [ ] **Go live** — push to GitHub and let the daily cron take over. — steps 4–5

---

## 1. What you need

| Thing | Where | Notes |
| --- | --- | --- |
| OpenAI API key | [platform.openai.com/api-keys](https://platform.openai.com/api-keys) | Looks like `sk-proj-...`. **Writes** the post. Required. |
| X API keys | [developer.x.com](https://developer.x.com) → your App → Keys and tokens | 4 values, see step 3. **Publishes** the post. The App must sit inside a Project on the **Pay Per Use** plan — X has no free tier any more. |
| A little X credit | [console.x.com](https://console.x.com) → Billing / Credits | ~$0.90/month at two posts a day with no links. New accounts get free credits. |
| A GitHub repo | github.com | Free account is fine |

> **You do not need the X keys to start.** OpenAI writes the text; X delivers it to
> your timeline. With only the OpenAI key you can already run the offline suite,
> `npm run preflight` and `npm run preview` and see exactly what would be posted.
> The X keys are needed only for the final publishing step.

---

## 2. Add the OpenAI key

1. Sign in at <https://platform.openai.com/api-keys>.
2. **Create new secret key** and copy it. It is shown only once.
3. Make sure the account has credit under **Settings → Billing**. A daily post costs
   a fraction of a cent, so even $5 lasts years.

### Which model is used?

The default is **`gpt-5.4`** — a flagship model with a 1.05M context window, and at
$2.50 / $15.00 per million tokens a daily post costs well under a hundredth of a
cent.

If your key cannot reach that model, the script automatically walks down a list:
`gpt-5.4-mini` → `gpt-6-luna` → `gpt-6.1-sol` → `gpt-5.6-sol` → `gpt-4.1` →
`gpt-4o` → `gpt-4o-mini`. You do not have to do anything for that to work.

To see what your key can actually reach:

```bash
node scripts/list-models.mjs
```

To pin a model, either set `OPENAI_MODEL` in `.env` locally, or in GitHub create a
**repository variable** named `OPENAI_MODEL` (Settings → Secrets and variables →
Actions → **Variables** tab) with the model id as the value.

Two things worth knowing about reasoning models, since `gpt-5.4` is one:

- **`temperature` may be rejected.** The script detects that exact error and retries
  with a plainer request automatically.
- **Reasoning tokens are billed against the output limit.** If a model spends its
  whole allowance thinking and returns nothing, the script notices the empty reply
  and retries without a token cap. This is handled, not a failure you have to fix.

`gpt-5.4` also supports `reasoning.effort` values `none` (its default), `low`,
`medium`, `high` and `xhigh`. Set `OPENAI_REASONING_EFFORT` if you want to raise it,
though a 280-character post does not need deep reasoning.


---

## 3. Add the X API keys

### Read this first: X has no free tier

As of February 2026 X replaced its tiers with **pay-per-usage**. The old free
tier is closed to new signups and **deprecated**. An App still enrolled in it gets
`403 client-not-enrolled` on every v2 call — *no matter how many times you
regenerate its keys*. That error is not a rate limit; it means the App has no
access level at all. This is the single biggest time-sink in setting this up.

To post, the App must be all three of:

1. **inside a Project** — an App listed under "Standalone Apps" can never call v2,
   and regenerating its keys will not move it into a Project;
2. in a Project whose badge reads **Pay Per Use** — a Project still on
   "Free (deprecated)" / "Standard Basic" will never work;
3. backed by a **credit balance** — otherwise X answers `402 credits depleted`.

You do not need to change anything in the code for this. It is purely how the X
account is arranged.

#### What it actually costs

Billing is per request, not per month:

| Operation | Unit cost |
| --- | --- |
| Create a post | `$0.015` |
| **Create a post containing a URL** | `$0.200` |
| Owned read | `$0.001` |

At the 280-character limit each post is a single request, so the maths is simple:

| Link rate | Posts a month | Cost a month |
| --- | --- | --- |
| **0% (the default)** | 60 | **~$0.90** |
| 25% | 60 | ~$3.70 |

This project posts **no links at all** (`LINK_CHANCE=0`), so at two posts a day the
bill is about **`$0.90` a month** — and your free credits cover far more than a year
of that. The mechanism is still there if you ever want it, but note what the second
row shows: at a 25% link rate those 15 link posts cost `$3.00` on their own, while
the other 45 together cost `$0.68`. Links are also suppressed in reach by X, so a
plain post is both cheaper and seen by more people. Your site and WhatsApp number
belong in your X bio instead.

New pay-per-use accounts earn **free credits**: X advertises up to `$70` — `$20`
for saving a first payment card plus a match of your first auto-recharge, up to
`$50`. At two posts a day, that is still many months of posting for nothing.

#### Set up the Project and plan

1. Sign in at <https://console.x.com> as **the account you want the posts on**.
2. Open **Projects & Apps**. Note which Project holds your App and what its badge
   says.
3. If your App sits under **Standalone Apps**, or in a Project badged
   **Free (deprecated)**, move it into the **Pay Per Use** Project:
   *Projects & Apps → the Pay Per Use Project → View apps → move / attach the App.*
   If the console offers no such action, post in the X developer forum
   (<https://devcommunity.x.com>, category **Developer Portal**) asking staff to
   migrate the App, and quote the numeric **App ID** from the console URL
   (`/apps/<id>`). They have done this many times and it is the only way when the
   button is missing.
4. Note the **App ID** in that URL. This is the number X reports as `client_id` in
   errors — it is *not* any of the key strings, so regenerating keys never changes it.
5. Open **Billing / Credits** and add credits, or save a payment card to claim the
   free credits. `preflight` fails with a clear message if this step is missing.

### Open the App and make it writable

Sign in at <https://console.x.com> and open your App.

The app is read-only by default, which cannot post. Go to **User authentication
settings**, choose `Read and write`, and fill the form in like this:

| Field | What to enter |
| --- | --- |
| App permissions | `Read and write` ← the only one that matters |
| Type of App | `Web App, Automated App or Bot` |
| App name | `InsuranceMentors` (anything sensible) |
| Callback URI / Redirect URL | `https://www.insurancementors.in/` |
| Website URL | `https://www.insurancementors.in` |
| Organization name | `InsuranceMentors` (anything) |
| Organization description | `Insurance advisory for Indian families.` (anything) |
| Terms of service / Privacy policy | Your site URL, or leave them out if optional |

> **Why does it demand a website and a callback URL?** X requires these for *any*
> app that can write, because the interactive OAuth flow needs somewhere to send
> the user back to. This project posts with **OAuth 1.0a** using static tokens
> generated in the dashboard, so no redirect ever happens and the callback URL is
> **never called**. Any valid HTTPS URL is accepted — use your own site so X has
> nothing to object to. You do not need a web server, a public host, or any
> deployment.

Save, **then** go to **Keys and tokens** and **regenerate** the Access Token and Secret.

> One more X quirk: permissions occasionally **revert to `Read only`** on their own.
> After saving, reload the page and confirm it still says `Read and write`. If it
> reverted, set it again and regenerate the token.

> **The order matters.** If the access token was created while the app was still
> read-only, posting fails with `401/403` forever. Regenerating it after saving the
> permission fixes it. This is the single most common setup mistake.

### Then: copy exactly these four values

The Keys and tokens page shows five things. You need four of them:

| Portal field | Env / secret name | Needed? |
| --- | --- | --- |
| API Key | `X_API_KEY` | ✅ |
| API Key Secret | `X_API_SECRET` | ✅ |
| Access Token | `X_ACCESS_TOKEN` | ✅ |
| Access Token Secret | `X_ACCESS_TOKEN_SECRET` | ✅ |
| Bearer Token | — | ❌ **do not use** |

> **Do not use the Bearer Token.** It is *application-only* authentication — it
> identifies your **app**, not your **account**. X accepts it only on read-only
> endpoints. Posting with it always fails, however correct it looks. It is on the
> same page as the keys you do need, which is why people grab it by accident.
> `preflight` will detect it and tell you if you do.
>
> Note the two **secrets**. The Access Token and API Key are useless without their
> secrets, and the secrets are shown only once — if you did not save them, use
> **Regenerate**.

> The access token must belong to the account you want the posts to appear on. If you
> post on behalf of a different brand account, generate the token while logged in as
> that account. `preflight` prints the @handle so you can confirm.

---

## 4. Put this folder in a GitHub repo

From this folder:

```bash
git init
git add .
git commit -m "Add daily X post automation"
git branch -M main
git remote add origin https://github.com/<your-username>/<your-repo>.git
git push -u origin main
```

`.env` is gitignored, so no secrets are pushed. `data/state.json` is committed
on purpose — that is how the bot remembers what it already posted.

---

## 5. Add the secrets

In GitHub: **Settings → Secrets and variables → Actions → New repository secret**.
Add these five:

- `OPENAI_API_KEY`
- `X_API_KEY`
- `X_API_SECRET`
- `X_ACCESS_TOKEN`
- `X_ACCESS_TOKEN_SECRET`

---

## 6. Testing it end to end

Four stages. Each proves something the previous one cannot, so run them in order —
do not jump to the last one.

| Stage | What it proves | Posts to X? | Needs keys? |
| --- | --- | --- | --- |
| 0. Offline suite | The logic is correct | No | No |
| 1. Preflight | Your keys and permissions work | No | Yes |
| 2. Local post | A real post appears on X | **Yes** | Yes |
| 3. GitHub runs | The cloud schedule works | Optional | Yes |

### Stage 0 — offline proof of the logic

```bash
npm test
```

On Windows, if PowerShell blocks `npm`, use `cmd /c "npm test"` or run the three
scripts directly:

```bash
node scripts/selfcheck-oauth.mjs
node scripts/selfcheck.mjs
node scripts/selfcheck-e2e.mjs
```

That is 48 checks against mock OpenAI and mock X servers: the OAuth 1.0a signature
against X's own published test vector, topic rotation over 200 simulated days, the
character limit, the markdown/hashtag cleanup, the double-post guard, and recovery
from reasoning models that reject `temperature`. Nothing leaves your machine. If this
fails, the problem is in the code, not your credentials.

**This stage needs no keys at all.** You can run it before you sign up for anything.

> The suite points itself at a throwaway history file via `STATE_FILE`, so it is safe
> to run even after you have posted for real — and it asserts that it never modified
> `data/state.json`. (`npm test` used to fail every day after 9am for exactly that
> reason.)

### Stage 1 — check your real keys (nothing is posted)

```bash
npm run preflight
```

This is the step worth doing carefully. It verifies, in order:

- your Node version
- that the **OpenAI key works**, and which models it can reach
- that a **real post actually generates**, through the exact same code path the daily
  run uses — so a problem here is a real problem
- that your **X credentials authenticate**, using `GET /2/users/me`, which is a
  read-only call and publishes nothing
- the **@handle it would post as**, so you can confirm it is the right account
- how many of today's slots have been used, and whether another post would go out now

Nothing is published. If a key is wrong, or your X app is still read-only, you find
out here instead of at 9am in a cron job you cannot watch.

> **Still waiting on your X API access?** The script notices and skips the X check
> with a warning instead of failing. You get the full OpenAI verification, the real
> generated draft, and `npm run preview` keeps working. Come back and add the X keys
> when you have them.

### Stage 2 — the first real post (this one publishes)

```bash
npm run preview     # generates and prints the post, publishes nothing
npm run post        # generates and publishes for real
```

`npm run post` prints the tweet URL on success. Open it on X and check it looks right.

Then confirm the double-post guard:

```bash
npm run post
```

It should refuse, saying the last post went out a moment ago and the minimum gap is
120 minutes. Two limits do that work: a **daily cap** (`POSTS_PER_DAY`, default 2)
and a **quiet period** (`MIN_GAP_MINUTES`, default 120). The cap allows the two
scheduled slots; the gap stops a retry or a manual run from posting twice inside one.

If you want to post again immediately anyway (different topic, fresh text):

```bash
npm run force
```

### Stage 3 — decide what to keep

Your history now records what you published. There are two cases:

- **The Stage 2 posts were real and should stay** — keep the history. It is accurate,
  it advances the topic rotation, and it stops the next scheduled run from posting a
  duplicate. Nothing to do.
- **They were throwaway test posts** — delete them on X, then:

  ```bash
  npm run reset
  ```

  This moves the history to `data/state.archive.json` (gitignored) rather than
  deleting it, and prints the URLs of any real posts so you can find them on X.

> Only reset if you are also removing the posts. Clearing the history while the posts
> stay up means the next run can publish an extra one that day.

### Stage 4 — deploy, then test in the cloud

Push the repo and add the secrets (see steps 4 and 5), then:

1. **Actions** tab → **Insurance posts to X** → **Run workflow**.
2. Leave **dry_run** ticked (`true`), click **Run workflow**.
3. Open the finished run and read the summary: topic, character count, and the exact
   post text.
4. Optionally type a topic id from `data/topics.json` into the **topic** box to force
   a specific subject.
5. When you are happy, run it again with **dry_run** unticked to publish for real —
   and check that a new commit appears touching `data/state.json`. That commit is
   how the cloud run remembers what it posted.

After that, the cron takes over and you do not need to touch it again.

---

## 7. The daily schedule

Two slots, both in UTC because GitHub cron has no other option:

| Cron | UTC | IST |
| --- | --- | --- |
| `30 2 * * *` | 02:30 | **08:00** |
| `30 11 * * *` | 11:30 | **17:00** |

They are written as one line in `.github/workflows/daily-post.yml`:

```yaml
schedule:
  - cron: '30 2,11 * * *'
```

Edit that line to move them. GitHub's scheduler is UTC-only and can start a few
minutes late under load — which is harmless, because the daily cap and the minimum
gap are enforced in code rather than by the clock.

Two things to keep in mind if you change the slots:

- **Keep `MIN_GAP_MINUTES` well below the gap between slots** so the second one is not
  blocked by the quiet period. The defaults (2 posts, 120 minutes) are sized for the
  540 minutes between 08:00 and 17:00 IST.
- **`POSTS_PER_DAY` is the real limit.** The cron only decides *when* the bot tries;
  the counter decides whether it may. Adding a third cron line without raising
  `POSTS_PER_DAY` produces a run that does nothing.

After each successful post the workflow commits the updated `data/state.json`.
That also keeps the repository active, which matters because GitHub disables
scheduled workflows on repos with no activity for 60 days.

---

## 8. Customising it

| I want to... | Edit |
| --- | --- |
| Change the voice, add facts about the business | `config/brand.md` |
| Add, remove or reword topics | `data/topics.json` |
| Change the weekday themes | `WEEKLY_THEME` in `src/topics.mjs` |
| Use a different OpenAI model | `OPENAI_MODEL` (see step 2) |
| Make the writing more/less varied | `OPENAI_TEMPERATURE` in the workflow env |
| Allow longer posts | `MAX_CHARS` in the workflow env |
| Put a link in posts | `LINK_CHANCE` in the workflow env — `0` by default, meaning never. Raising it costs `$0.20` per link post and reduces reach. |
| Change the link a link post would carry | `BRAND_SITE` / `BRAND_WHATSAPP` — only used when `LINK_CHANCE` is above `0` |
| Run the tests against another history file | `STATE_FILE` (defaults to `data/state.json`) |
| Post more or fewer times a day | `POSTS_PER_DAY` in the workflow env |
| Give two slots more/less breathing room | `MIN_GAP_MINUTES` in the workflow env |
| Change the posting times | the `cron:` line in the workflow (see step 7) |

To add a topic:

```json
{
  "id": "health-new-topic",
  "category": "health",
  "topic": "Short title used in the prompt",
  "brief": "The only facts the AI is allowed to use. Numbers go here, so it cannot invent any."
}
```

Categories in use: `health`, `term`, `travel`, `claims`, `money`, `myth`.

### Weekday rhythm

| Day | Theme |
| --- | --- |
| Sun | Travel & awareness |
| Mon | Myth-buster Monday |
| Tue | Term insurance Tuesday |
| Wed | Health cover Wednesday |
| Thu | Claims & service Thursday |
| Fri | Family finance Friday |
| Sat | Weekend quick tip (any category) |

---

## 9. Running it locally

New here? Follow the staged walkthrough in **section 6** instead — this is just the
command reference.

```bash
copy .env.example .env          # then paste your keys into .env

npm run preflight               # check keys and permissions (posts nothing)
npm run preview                 # preview the post for today
npm run post                    # publish for real
npm run force                   # publish anyway, past the daily cap and the quiet period
npm run reset                   # clear history before going to production
npm run models                  # list the models your OpenAI key can reach
npm test                        # the full offline suite
```

Equivalent direct commands:

```bash
node src/index.mjs --dry-run
node src/index.mjs
node src/index.mjs --force
node src/index.mjs --topic term-human-life-value
```

Useful flags: `--dry-run` / `-n`, `--preview`, `--force` / `-f`, `--topic <id>`.

> On Windows, if `npm` is blocked by a PowerShell execution policy error, either use
> `cmd /c "npm test"` or run the underlying `node scripts/...` file directly.

---

## 10. Safety rails already built in

- **Never double-posts.** Two limits guard each day: `POSTS_PER_DAY` (default 2) caps
  how many posts go out, and `MIN_GAP_MINUTES` (default 120) is a quiet period after
  the most recent one. A retried, delayed or manual run inside a slot is skipped
  unless you pass `--force`.
- **Never repeats a topic.** 93 topics rotate and cycle by least-recently-used.
- **Never drifts in tone.** Recent posts are fed back to the model to avoid
  repeating openings and phrasings.
- **Never posts a link.** The prompt forbids URLs, and any that slip through are
  stripped in code before publishing — a line that existed only to carry a link is
  dropped with it. Set `LINK_CHANCE` above `0` if you ever want links back.
- **Never overflows the limit.** The post is trimmed and re-checked against the
  280-character limit, counting URLs as 23 characters the way X does.
- **Never invents numbers.** The prompt forbids statistics, prices and ratios that
  are not in the topic brief, and the AI cannot invent claims about IRDAI rules.
- **Fails loudly.** A bad key or a rejected post exits non-zero and posts a
  formatted error to the run summary, so GitHub emails you.

---

## 11. If something goes wrong

| Symptom | Cause and fix |
| --- | --- |
| `401` from X | App permissions are not `Read and Write`, or the access token was generated before you changed them. Regenerate the token after saving the permission. |
| `403` `client-not-enrolled` from X | The App has no usable API access. Two causes: **(a)** the App sits under "Standalone Apps" — only an App inside a Project can call v2, and regenerating keys does not move it, so create an App inside the Project; **(b)** the App *is* connected to a Project, but that Project still shows **Free (deprecated)** — a known X fault with no self-serve fix, so ask X staff to migrate the App to Pay Per Use in the developer forum (category Developer Portal), quoting the numeric App ID. Regenerating keys fixes neither. |
| `403` from X (any other) | The access token lacks write permission. Set `Read and Write`, then regenerate. |
| `402` from X | `credits depleted` — the Pay Per Use account has no credit balance. Add credits at console.x.com under Billing / Credits. Saving a payment card earns new pay-per-use accounts free credits (X advertises up to $70). This is a **billing** problem, not a permissions one: X reached the payment step, which means the write permission already passed. |
| `429` from X | Rate limited. A once-a-day schedule is far below the limit, so another tool on the same app is likely using the quota. |
| `Missing required environment variable(s)` | A secret name is misspelled or missing in GitHub. |
| `OpenAI API 401` | The API key is wrong, revoked, or has a typo. Re-copy it from the dashboard. |
| `OpenAI API 404` | A model name is unavailable on your account. The script already falls back through several models; run `npm run models` and pin a working one with `OPENAI_MODEL`. |
| `429` `credit_balance_exhausted` | The organization has no **spendable** prepaid credits. Buy credits (minimum $5) on the billing page and allow a few minutes. A ChatGPT Plus/Pro subscription does **not** fund the API, purchased credits expire after a year, and usage processed after a balance hits zero can leave a negative balance that eats the next purchase. |
| `OpenAI API 429` (rate limit) | Too many requests in a short window. A daily job never hits this — retry. |
| `Model ... refused to write` | The safety filter rejected the draft. Re-run; the topic rotates. |
| Forbidden push in Actions | The workflow needs `permissions: contents: write`, which is already set in the YAML. |
| `preflight` warns *"No post would go out right now"* | Expected, not an error — it reports the guard accurately, e.g. the daily limit is reached or the last post was inside the 120-minute quiet period. Use `--force` to post anyway. |
| Workflow never runs on schedule | Scheduled workflows are disabled after 60 days of repo inactivity. Run it once manually to re-enable. |

---

## 12. A note on compliance

The prompt already forbids guaranteeing claims or returns, naming or criticising
insurers, and giving medical, tax or legal advice as fact. Please still read the
first week of output before leaving it unattended, and keep `config/brand.md`
aligned with what your advisory can legally say.
