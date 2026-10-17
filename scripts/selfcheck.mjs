// Temporary self-check. Safe to delete.
import { loadTopics, pickTopic, themeForDate } from '../src/topics.mjs';
import { sanitize, weightedLength } from '../src/generate.mjs';

const topics = loadTopics();
const state = { version: 1, posts: [] };
const seen = [];

for (let i = 0; i < 21; i += 1) {
  const date = new Date(Date.UTC(2026, 9, 17 + i));
  const theme = themeForDate(date);
  const topic = pickTopic(topics, state, date);
  seen.push(topic.id);
  state.posts.push({
    date: date.toISOString().slice(0, 10),
    topicId: topic.id,
    category: topic.category,
    mode: 'live',
    text: '',
  });
  console.log(
    date.toISOString().slice(0, 10),
    date.toUTCString().slice(0, 3),
    '|',
    theme.label.padEnd(26),
    '|',
    topic.category.padEnd(7),
    '|',
    topic.id
  );
}

console.log('\nunique topics across 21 days:', new Set(seen).size);

const dirty = '```\n**Big myth:** you do NOT need cover.\n\n\n*See why*\n#HealthInsurance #India #viral\n"';
console.log('\nsanitize ->', JSON.stringify(sanitize(dirty, 280)));

console.log('sanitize heading  ->', JSON.stringify(sanitize('## Heading here\n\nBody text.', 280)));
console.log('sanitize bullets  ->', JSON.stringify(sanitize('- One\n- Two\n\nEnd', 280)));
console.log('sanitize emojis   ->', JSON.stringify(sanitize('Cover matters. \u{1F6E1}\u{FE0F} \u{1F4B0} \u{2705} Done.', 280)));
console.log('sanitize quotes   ->', JSON.stringify(sanitize('"A quoted post."', 280)));
console.log('sanitize wrapquote->', JSON.stringify(sanitize('"He said "no".', 280)));

const long = 'word '.repeat(100);
const trimmed = sanitize(long, 280);
console.log('trim to 280 ->', weightedLength(trimmed), 'weighted chars |', JSON.stringify(trimmed.slice(-30)));

console.log('url counts as 23 ->', weightedLength('Hi https://www.insurancementors.in bye'));

// Simulate 200 days to make sure nothing crashes once the library is exhausted.
const state2 = { version: 1, posts: [] };
const seen2 = [];
for (let i = 0; i < 200; i += 1) {
  const date = new Date(Date.UTC(2026, 0, 1 + i));
  const topic = pickTopic(topics, state2, date);
  seen2.push(topic.id);
  state2.posts.push({ date: date.toISOString().slice(0, 10), topicId: topic.id, mode: 'live', text: '' });
}
console.log('\nafter 200 days -> unique:', new Set(seen2).size, 'of', topics.length);
console.log('max gap between repeats check: first25 unique =', new Set(seen2.slice(0, 93)).size);
