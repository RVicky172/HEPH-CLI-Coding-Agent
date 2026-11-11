import type { LLMProvider } from '../../llm/LLMProvider.js';
import type { Summarizer } from './ContextManager.js';

const INSTRUCTIONS = [
  'You compress a coding-assistant conversation so it can continue with less context.',
  'Write a concise summary (at most ~250 words) that preserves everything needed to continue:',
  "- the user's goals and requests, and decisions made",
  '- files that were read or changed (exact paths) and what was changed',
  '- commands that were run and their results (pass/fail, key errors)',
  '- open questions and what still needs to be done',
  'Use short bullet points. Do not add advice. Do not invent anything.',
].join('\n');

/** A Summarizer that asks the same model (no tools, low temperature). */
export function createLlmSummarizer(provider: LLMProvider, model: () => string): Summarizer {
  return async (transcript, signal) => {
    let summary = '';
    for await (const chunk of provider.chat(
      {
        model: model(),
        temperature: 0.1,
        messages: [
          { role: 'system', content: INSTRUCTIONS },
          { role: 'user', content: `Conversation to summarise:\n\n${transcript}` },
        ],
      },
      signal,
    )) {
      if (chunk.type === 'text') summary += chunk.delta;
    }
    return summary.trim() || '(no summary produced)';
  };
}
