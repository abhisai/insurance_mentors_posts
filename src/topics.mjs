import fs from 'node:fs';
import path from 'node:path';
import { ROOT } from './config.mjs';
import { lastUsedByTopic } from './state.mjs';

const TOPICS_FILE = path.join(ROOT, 'data', 'topics.json');

/**
 * A light weekly rhythm so the account feels curated rather than random.
 * Saturday deliberately draws from any category with a "quick tip" treatment.
 */
const WEEKLY_THEME = {
  0: { category: 'travel', label: 'Travel & awareness' },
  1: { category: 'myth', label: 'Myth-buster Monday' },
  2: { category: 'term', label: 'Term insurance Tuesday' },
  3: { category: 'health', label: 'Health cover Wednesday' },
  4: { category: 'claims', label: 'Claims & service Thursday' },
  5: { category: 'money', label: 'Family finance Friday' },
  6: { category: null, label: 'Weekend quick tip' },
};

export function loadTopics() {
  const topics = JSON.parse(fs.readFileSync(TOPICS_FILE, 'utf8'));
  if (!Array.isArray(topics) || topics.length === 0) {
    throw new Error('data/topics.json must contain a non-empty array of topics.');
  }
  return topics;
}

export function themeForDate(date) {
  return WEEKLY_THEME[date.getUTCDay()];
}

/**
 * Chooses today's topic.
 *
 * Order of preference:
 *   1. Never used, and matches today's weekly theme
 *   2. Never used, any category
 *   3. Least recently used, matching today's theme
 *   4. Least recently used overall
 *
 * This means the library cycles smoothly instead of restarting from topic #1.
 */
export function pickTopic(topics, state, date = new Date(), forcedId = null) {
  if (forcedId) {
    const forced = topics.find((topic) => topic.id === forcedId);
    if (!forced) {
      const known = topics.map((topic) => topic.id).join(', ');
      throw new Error(`Unknown topic id "${forcedId}". Available: ${known}`);
    }
    return forced;
  }

  const theme = themeForDate(date);
  const lastUsed = lastUsedByTopic(state);
  const neverUsed = topics.filter((topic) => !lastUsed.has(topic.id));

  if (theme.category) {
    const themedUnused = neverUsed.filter((topic) => topic.category === theme.category);
    if (themedUnused.length) return themedUnused[0];
  }
  if (neverUsed.length) return neverUsed[0];

  const byOldestUse = [...topics].sort((a, b) =>
    (lastUsed.get(a.id) || '').localeCompare(lastUsed.get(b.id) || '')
  );

  if (theme.category) {
    const themed = byOldestUse.filter((topic) => topic.category === theme.category);
    if (themed.length) return themed[0];
  }
  return byOldestUse[0];
}

export function topicStats(topics, state) {
  const lastUsed = lastUsedByTopic(state);
  const used = topics.filter((topic) => lastUsed.has(topic.id)).length;
  return { total: topics.length, used, remaining: topics.length - used };
}
