// Lists the models your OpenAI key can actually reach.
// Run: node scripts/list-models.mjs
import { config, requireEnv } from '../src/config.mjs';

requireEnv(['OPENAI_API_KEY']);

const response = await fetch(`${config.ai.baseUrl}/models`, {
  headers: { Authorization: `Bearer ${config.ai.apiKey}` },
});

if (!response.ok) {
  console.error(`Could not list models (HTTP ${response.status}).`);
  console.error((await response.text()).slice(0, 500));
  process.exit(1);
}

const { data } = await response.json();
const ids = (data || []).map((model) => model.id).sort();

const isText = (id) =>
  !/embed|tts|whisper|transcribe|audio|realtime|image|dall-e|moderation|sora|davinci|babbage/i.test(id);

const textModels = ids.filter(isText);

console.log(`${ids.length} models available to your key.\n`);
console.log('Likely text models:');
for (const id of textModels) console.log(`  ${id === config.ai.model ? '* ' : '  '}${id}`);

console.log('\nWanted for posting (in order):');
for (const id of [config.ai.model, ...config.ai.fallbackModels]) {
  console.log(`  ${ids.includes(id) ? 'available  ' : 'MISSING    '} ${id}`);
}

console.log('\nSet a preference with OPENAI_MODEL, or in GitHub as a repository variable.');
