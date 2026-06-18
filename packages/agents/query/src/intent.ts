import type { ModelProvider } from '@aptkit/runtime';
import type { Intent } from './types.js';

export function parseIntent(raw: string): Intent {
  const text = raw.trim().toLowerCase();
  if (text.includes('monitoring')) return 'monitoring';
  if (text.includes('recommendation')) return 'recommendation';
  if (text.includes('diagnostic')) return 'diagnostic';
  return 'diagnostic';
}

export async function classifyIntent(
  model: ModelProvider,
  query: string,
  options: { signal?: AbortSignal } = {},
): Promise<Intent> {
  const response = await model.complete({
    system:
      'Classify the user query as exactly one word: monitoring (what changed / what is new), diagnostic (why did something happen), or recommendation (what should I do). Reply with ONLY the one word.',
    messages: [{ role: 'user', content: query }],
    maxTokens: 16,
    signal: options.signal,
  });
  const text = response.content
    .filter((block): block is Extract<(typeof response.content)[number], { type: 'text' }> => block.type === 'text')
    .map((block) => block.text)
    .join('');
  return parseIntent(text);
}
