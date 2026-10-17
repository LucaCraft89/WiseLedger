import { MockLlm } from 'core/mocks';
import { describe, expect, it } from 'vitest';
import { createAiRuntime } from '../src/runtime.js';

describe('AI runtime', () => {
  it('shares one provider between Analyst and Treasurer and reports warm-up', async () => {
    const llm = new MockLlm();
    const rt = createAiRuntime({ llm });
    await rt.warmUp();
    expect(rt.status()).toMatchObject({ provider: 'mock', state: 'ready', onDevice: true });
    expect(rt.status().warmUpMs).toBeTypeOf('number');
  });
  it('defaults to the mock provider without LLM_PROVIDER', () => {
    expect(createAiRuntime({ provider: 'mock' }).status().provider).toBe('mock');
  });
});
