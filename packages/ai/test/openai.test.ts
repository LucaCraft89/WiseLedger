import { describe, expect, it } from 'vitest';
import { OpenAiCompatProvider } from '../src/llm/openai.js';

function sse(chunks: unknown[]): Response {
  const body = `${chunks.map((c) => `data: ${JSON.stringify(c)}\n\n`).join('')}data: [DONE]\n\n`;
  return new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' } });
}

describe('OpenAiCompatProvider', () => {
  it('streams content and parses json_schema output', async () => {
    let sent: Record<string, unknown> = {};
    const llm = new OpenAiCompatProvider({
      baseUrl: 'http://localhost:9999',
      fetch: async (_url, init) => {
        sent = JSON.parse(String(init?.body));
        return sse([
          { choices: [{ delta: { content: '{"total":' } }] },
          { choices: [{ delta: { content: '"25.00"}' }, finish_reason: 'stop' }] },
        ]);
      },
    });
    const r = await llm.complete({
      messages: [{ role: 'user', content: 'x' }],
      responseFormat: { type: 'json_schema', json_schema: { name: 'X', schema: {} } },
    });
    expect(r.json).toEqual({ total: '25.00' });
    expect(sent.response_format).toBeDefined();
    expect(sent.tools).toBeUndefined();
  });

  it('assembles streamed tool-call fragments and forces the tool by name', async () => {
    let sent: Record<string, unknown> = {};
    const llm = new OpenAiCompatProvider({
      baseUrl: 'http://localhost:9999/v1',
      fetch: async (url, init) => {
        expect(String(url)).toBe('http://localhost:9999/v1/chat/completions');
        sent = JSON.parse(String(init?.body));
        return sse([
          {
            choices: [
              {
                delta: {
                  tool_calls: [{ index: 0, id: 'c1', function: { name: 'execute_plan', arguments: '{"plan' } }],
                },
              },
            ],
          },
          {
            choices: [
              {
                delta: { tool_calls: [{ index: 0, function: { arguments: 'Id":"p-42"}' } }] },
                finish_reason: 'tool_calls',
              },
            ],
          },
        ]);
      },
    });
    const r = await llm.complete({
      messages: [{ role: 'user', content: 'x' }],
      tools: [{ name: 'execute_plan', description: 'd', parameters: { type: 'object' } }],
      toolChoice: { name: 'execute_plan' },
    });
    expect(r.toolCalls).toEqual([{ id: 'c1', name: 'execute_plan', arguments: { planId: 'p-42' } }]);
    expect(sent.tool_choice).toEqual({ type: 'function', function: { name: 'execute_plan' } });
  });

  it('turns an HTTP error into a plain error and error state', async () => {
    const llm = new OpenAiCompatProvider({ fetch: async () => new Response('down', { status: 503 }) });
    await expect(llm.complete({ messages: [{ role: 'user', content: 'x' }] })).rejects.toThrow(/503/);
    expect(llm.info().state).toBe('error');
  });
});
