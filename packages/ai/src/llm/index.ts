import type { LlmProvider } from 'core';
import { MockLlm } from './mock.js';
import { OpenAiCompatProvider } from './openai.js';
import { QvacProvider, type QvacProviderOptions } from './qvac.js';

export * from './mock.js';
export * from './openai.js';
export * from './qvac.js';

export type LlmProviderKind = 'qvac' | 'openai' | 'mock';

/** Picks the provider from LLM_PROVIDER (qvac | openai | mock). Default mock, so nobody waits for a model. */
export function createLlm(
  kind = (process.env.LLM_PROVIDER ?? 'mock') as LlmProviderKind,
  qvac: QvacProviderOptions = {},
): LlmProvider {
  switch (kind) {
    case 'qvac':
      return new QvacProvider(qvac);
    case 'openai':
      return new OpenAiCompatProvider();
    case 'mock':
      return new MockLlm();
    default:
      throw new Error(`Unknown LLM_PROVIDER "${kind as string}" (expected qvac, openai or mock)`);
  }
}
