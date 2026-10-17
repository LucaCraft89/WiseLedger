// One contract for every LlmProvider. MockLlm always runs; QvacProvider only with LIVE_QVAC=1.
import type { LlmProvider } from 'core';
import { afterAll, describe, expect, it } from 'vitest';
import { MockLlm } from '../src/llm/mock.js';
import { QvacProvider } from '../src/llm/qvac.js';

const SCHEMA = {
  type: 'object',
  properties: { issuer: { type: 'string' }, total: { type: 'string' } },
  required: ['issuer', 'total'],
  additionalProperties: false,
};
const TOOL = {
  name: 'execute_plan',
  description: 'Execute the confirmed payment plan.',
  parameters: { type: 'object', properties: { planId: { type: 'string' } }, required: ['planId'] },
};
const INVOICE = 'Invoice from Acme Srl. Total: 25.00 TUSDT.';

function contract(name: string, make: () => LlmProvider, opts: { timeout: number; skip?: boolean }) {
  describe.skipIf(opts.skip)(`LlmProvider contract: ${name}`, () => {
    const llm = make();
    afterAll(async () => {
      await llm.unload?.();
    });

    it('streams tokens then a done event with the full text', { timeout: opts.timeout }, async () => {
      let streamed = '';
      let done: string | undefined;
      for await (const e of llm.stream({
        messages: [{ role: 'user', content: 'Say hello in one word.' }],
        maxTokens: 16,
      })) {
        if (e.type === 'token') streamed += e.text;
        if (e.type === 'done') done = e.result.text;
      }
      expect(done).toBeDefined();
      expect(done?.trim().length).toBeGreaterThan(0);
      expect(streamed.trim()).toBe(done?.trim());
    });

    it('returns JSON matching a json_schema', { timeout: opts.timeout }, async () => {
      const r = await llm.complete({
        messages: [
          { role: 'system', content: 'Extract issuer and total. Reply with JSON only.' },
          { role: 'user', content: INVOICE },
        ],
        temperature: 0,
        responseFormat: { type: 'json_schema', json_schema: { name: 'Mini', schema: SCHEMA } },
      });
      expect(r.json).toMatchObject({ issuer: expect.any(String), total: expect.any(String) });
      expect((r.json as { total: string }).total).toContain('25');
    });

    it('makes a forced tool call with the given arguments', { timeout: opts.timeout }, async () => {
      const r = await llm.complete({
        messages: [
          { role: 'system', content: 'You are the Treasurer. Execute the confirmed plan with the tool.' },
          { role: 'user', content: 'Confirmed plan id: p-42. Execute it now.' },
        ],
        temperature: 0,
        tools: [TOOL],
        toolChoice: { name: 'execute_plan' },
      });
      expect(r.toolCalls[0]?.name).toBe('execute_plan');
      expect(r.toolCalls[0]?.arguments.planId).toBe('p-42');
    });

    it('reports info with an on-device provider', () => {
      expect(llm.info().onDevice).toBe(true);
    });
  });
}

contract(
  'MockLlm',
  () =>
    new MockLlm({
      fallback: (req) => {
        if (req.responseFormat) return { json: { issuer: 'Acme Srl', total: '25.00' } };
        if (req.tools) return { toolCall: { name: 'execute_plan', arguments: { planId: 'p-42' } } };
        return { text: 'Hello' };
      },
    }),
  { timeout: 5_000 },
);

contract('QvacProvider', () => new QvacProvider(), { timeout: 240_000, skip: process.env.LIVE_QVAC !== '1' });
