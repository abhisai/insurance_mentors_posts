import crypto from 'node:crypto';
import fs from 'node:fs';
import { config, requireEnv } from './config.mjs';
import { loadState, saveState, recordPost, postGate, recentPosts, todayKey } from './state.mjs';
import { loadTopics, pickTopic, themeForDate, topicStats } from './topics.mjs';
import { generatePost, weightedLength } from './generate.mjs';
import { postToX } from './x.mjs';

function parseArgs(argv) {
  const args = { dryRun: config.dryRun, force: config.force, topic: null, previewOnly: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--dry-run' || arg === '-n') args.dryRun = true;
    else if (arg === '--preview') args.previewOnly = true;
    else if (arg === '--force' || arg === '-f') args.force = true;
    else if (arg === '--topic') args.topic = argv[++i] ?? null;
    else if (arg.startsWith('--topic=')) args.topic = arg.slice('--topic='.length);
    else console.warn(`Ignoring unknown argument: ${arg}`);
  }
  if (args.previewOnly) args.dryRun = true;
  return args;
}

function summary(lines) {
  const text = `${lines.join('\n')}\n`;
  if (process.env.GITHUB_STEP_SUMMARY) {
    fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, text);
  }
  console.log(text);
}

/** A link goes out on a fraction of posts only: links reduce reach on X. */
function decideLinkLine(args) {
  if (args.previewOnly) return null;
  const roll = crypto.randomInt(0, 1000) / 1000;
  if (roll >= config.linkChance) return null;
  return `Free advice, no pressure: ${config.brand.site}`;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));

  const state = loadState();
  const topics = loadTopics();
  const date = new Date();
  const theme = themeForDate(date);
  const stats = topicStats(topics, state);

  console.log(`Theme for today (UTC ${date.toISOString().slice(0, 10)}): ${theme.label}`);
  console.log(`Topic library: ${stats.total} topics, ${stats.used} used, ${stats.remaining} fresh.`);

  const gate = postGate(state, {
    postsPerDay: config.postsPerDay,
    minGapMinutes: config.minGapMinutes,
    now: date,
  });
  console.log(`Posts today: ${gate.count} of ${config.postsPerDay} already used.`);

  if (!args.dryRun && !gate.allowed && !args.force) {
    summary([
      '### Skipped',
      '',
      gate.reason,
      '',
      `Use \`--force\` to post anyway, or run with \`--dry-run\` to preview.`,
    ]);
    return;
  }

  const topic = pickTopic(topics, state, date, args.topic);
  console.log(`Today's topic: ${topic.id} (${topic.category})`);

  requireEnv(['OPENAI_API_KEY']);
  if (!args.dryRun) {
    requireEnv(
      config.x.userAccessToken
        ? ['X_OAUTH2_USER_TOKEN']
        : ['X_API_KEY', 'X_API_SECRET', 'X_ACCESS_TOKEN', 'X_ACCESS_TOKEN_SECRET']
    );
  }

  const recent = recentPosts(state, 20);
  const linkLine = decideLinkLine(args);
  const { text, warnings } = await generatePost({ topic, theme, recent, linkLine });

  console.log('\n--- Draft ---');
  console.log(text);
  console.log(`--- ${weightedLength(text)}/${config.maxChars} characters ---\n`);
  for (const warning of warnings) console.warn(`Warning: ${warning}`);

  if (args.dryRun) {
    summary([
      '### Dry run - nothing was published',
      '',
      `**Topic:** ${topic.topic}`,
      `**Theme:** ${theme.label}`,
      `**Length:** ${weightedLength(text)}/${config.maxChars}`,
      '',
      '```',
      text,
      '```',
      warnings.length ? `\nWarnings: ${warnings.join(' ')}` : '',
    ]);
    return;
  }

  const published = await postToX(text);
  console.log(`Published: ${published.url}`);

  recordPost(state, {
    date: todayKey(date),
    topicId: topic.id,
    category: topic.category,
    theme: theme.label,
    mode: 'live',
    postId: published.id,
    url: published.url,
    length: weightedLength(text),
    text,
    warnings,
    postedAt: new Date().toISOString(),
  });
  saveState(state);

  const after = topicStats(topics, state);
  summary([
    '### Posted to X',
    '',
    `**${topic.topic}**`,
    '',
    '```',
    text,
    '```',
    '',
    `${published.url} (${weightedLength(text)}/${config.maxChars} characters)`,
    '',
    `Topic library: ${after.remaining} of ${after.total} topics not yet used.`,
  ]);
}

main().catch((error) => {
  console.error(`\nFailed: ${error.message}`);
  summary(['### Failed', '', '```', error.message, '```']);
  process.exitCode = 1;
});
