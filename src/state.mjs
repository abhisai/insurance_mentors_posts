import fs from 'node:fs';
import path from 'node:path';
import { ROOT } from './config.mjs';

// Overridable with STATE_FILE so the test suite can run against a throwaway
// file. Without this, running the tests after a real post fails half the suite:
// the real history contains a live post for today, so the "already posted
// today" guard trips and the live-run checks never see X.
const defaultStateFile = path.join(ROOT, 'data', 'state.json');
const stateFile = () => process.env.STATE_FILE || defaultStateFile;
const EMPTY_STATE = () => ({ version: 1, posts: [] });

export function loadState() {
  const file = stateFile();
  if (!fs.existsSync(file)) return EMPTY_STATE();
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (!parsed || !Array.isArray(parsed.posts)) return EMPTY_STATE();
    return parsed;
  } catch (error) {
    console.warn(`Could not read ${file} (${error.message}). Starting fresh.`);
    return EMPTY_STATE();
  }
}

export function saveState(state) {
  const file = stateFile();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(state, null, 2)}\n`, 'utf8');
}

export const todayKey = (date = new Date()) => date.toISOString().slice(0, 10);

export function livePostsToday(state, now = new Date()) {
  const today = todayKey(now);
  return state.posts.filter((post) => post.date === today && post.mode === 'live');
}

/**
 * Decides whether another post may go out right now.
 *
 * Two limits work together:
 *   postsPerDay    how many posts are allowed in one UTC day
 *   minGapMinutes  the quiet period after the most recent post. This is what
 *                  stops a retried, delayed or manually triggered run from
 *                  posting twice inside the same slot.
 */
export function postGate(state, { postsPerDay = 1, minGapMinutes = 0, now = new Date() } = {}) {
  const today = livePostsToday(state, now);

  if (today.length >= postsPerDay) {
    return {
      allowed: false,
      count: today.length,
      reason: `Already posted ${today.length} time(s) today, which is the daily limit of ${postsPerDay}.`,
    };
  }

  const lastAt = today
    .map((post) => Date.parse(post.postedAt))
    .filter((ms) => Number.isFinite(ms))
    .sort((a, b) => b - a)[0];

  if (lastAt !== undefined && minGapMinutes > 0) {
    const elapsed = (now.getTime() - lastAt) / 60_000;
    if (elapsed < minGapMinutes) {
      return {
        allowed: false,
        count: today.length,
        reason:
          `The last post went out ${Math.max(0, Math.round(elapsed))} minute(s) ago, ` +
          `and the minimum gap is ${minGapMinutes} minute(s).`,
      };
    }
  }

  return { allowed: true, count: today.length };
}

/**
 * topicId -> date of the most recent post that used it.
 */
export function lastUsedByTopic(state) {
  const map = new Map();
  for (const post of state.posts) {
    const previous = map.get(post.topicId);
    if (!previous || post.date > previous) map.set(post.topicId, post.date);
  }
  return map;
}

export function recentPosts(state, count = 20) {
  return [...state.posts]
    .filter((post) => typeof post.text === 'string' && post.text.length > 0)
    .sort((a, b) => (a.date < b.date ? 1 : -1))
    .slice(0, count);
}

export function recordPost(state, entry) {
  state.posts.push(entry);
  // Keep the file small: the full text of old posts is no longer needed after
  // it has served its purpose of avoiding repetition.
  const MAX_HISTORY = 400;
  if (state.posts.length > MAX_HISTORY) {
    state.posts = state.posts.slice(-MAX_HISTORY);
  }
  return state;
}
