// Clears the posting history so your first production run starts clean.
// Any existing history is moved to data/state.archive.json rather than deleted.
// Run: node scripts/reset-history.mjs   (or: npm run reset)
import fs from 'node:fs';
import path from 'node:path';
import { ROOT } from '../src/config.mjs';

const STATE = path.join(ROOT, 'data', 'state.json');
const ARCHIVE = path.join(ROOT, 'data', 'state.archive.json');

const empty = { version: 1, posts: [] };

let current = empty;
try {
  current = JSON.parse(fs.readFileSync(STATE, 'utf8'));
} catch {
  /* missing or unreadable, treat as empty */
}

const posts = Array.isArray(current.posts) ? current.posts : [];

if (posts.length === 0) {
  fs.mkdirSync(path.dirname(STATE), { recursive: true });
  fs.writeFileSync(STATE, `${JSON.stringify(empty, null, 2)}\n`, 'utf8');
  console.log('History was already empty. Nothing to archive.');
  process.exit(0);
}

let archived = [];
try {
  archived = JSON.parse(fs.readFileSync(ARCHIVE, 'utf8'));
  if (!Array.isArray(archived)) archived = [];
} catch {
  archived = [];
}

fs.writeFileSync(ARCHIVE, `${JSON.stringify([...archived, ...posts], null, 2)}\n`, 'utf8');
fs.writeFileSync(STATE, `${JSON.stringify(empty, null, 2)}\n`, 'utf8');

console.log(`Archived ${posts.length} post(s) to data/state.archive.json`);
console.log('History is now empty, so every topic counts as unused again.');

const live = posts.filter((post) => post.mode === 'live');
if (live.length) {
  console.log('\nThese real posts were recorded. Delete them from X if they were only tests:');
  for (const post of live) console.log(`  ${post.date}  ${post.url}`);
}
