// OpenAI-compatible provider for `qvac serve --openai` on localhost or a LAN machine (still on-device AI).
import {
  assertRequestShape,
  type CompletionRequest,
  type LlmEvent,
  type LlmInfo,
  type LlmProvider,
  type LlmResult,
  type LlmState,
  type ToolCall,
} from 'core';
import { parseJsonLoose } from './qvac.js';

export interface OpenAiCompatOptions {
  /** e.g. http://localhost:11434 or http://192.168.1.20:8080 (env OPENAI_COMPAT_BASE_URL). `/v1` is appended when missing. */
  baseUrl?: string;
  /** Model name the server expects (env QVAC_MODEL). */
  model?: string;
  apiKey?: string;
  timeoutMs?: number;
  fetch?: typeof fetch;
}

interface OaiToolCall {
  id?: string;
  index?: number;
  function?: { name?: string; arguments?: string };
}

export class OpenAiCompatProvider implements LlmProvider {
  private state: LlmState = 'ready';
  private error: string | undefined;
  readonly baseUrl: string;
  readonly model: string;

  constructor(private readonly opts: OpenAiCompatOptions = {}) {
    const raw = (opts.baseUrl ?? process.env.OPENAI_COMPAT_BASE_URL ?? 'http://localhost:11434').replace(/\/+$/, '');
    this.baseUrl = raw.endsWith('/v1') ? raw : `${raw}/v1`;
    this.model = opts.model ?? process.env.QVAC_MODEL ?? 'QWEN3_5_2B_MULTIMODAL_Q4_K_M';
  }

  info(): LlmInfo {
    return {
      provider: 'openai',
      model: this.model,
      state: this.state,
      onDevice: true,
      ...(this.error ? { error: this.error } : {}),
    };
  }

  async warmUp(): Promise<void> {
    await this.complete({ messages: [{ role: 'user', content: 'Hi' }], maxTokens: 1 });
  }

  async complete(req: CompletionRequest): Promise<LlmResult> {
    let result: LlmResult | undefined;
    for await (const e of this.stream(req)) if (e.type === 'done') result = e.result;
    if (!result) throw new Error('openai-compatible completion ended without a result');
    return result;
  }

  async *stream(req: CompletionRequest): AsyncIterable<LlmEvent> {
    assertRequestShape(req);
    const started = Date.now();
    let firstTokenAt: number | undefined;
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), this.opts.timeoutMs ?? 120_000);
    req.signal?.addEventListener('abort', () => ctrl.abort(), { once: true });

    try {
      const res = await (this.opts.fetch ?? fetch)(`${this.baseUrl}/chat/completions`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          ...(this.opts.apiKey ? { authorization: `Bearer ${this.opts.apiKey}` } : {}),
        },
        body: JSON.stringify(this.toBody(req)),
        signal: ctrl.signal,
      });
      if (!res.ok || !res.body) {
        throw new Error(`Local AI server answered ${res.status}: ${(await res.text().catch(() => '')).slice(0, 200)}`);
      }
      this.state = 'ready';
      this.error = undefined;

      let text = '';
      let finish: string | undefined;
      const calls = new Map<number, { id?: string; name: string; args: string }>();
      for await (const data of sseData(res.body)) {
        if (data === '[DONE]') break;
        const chunk = JSON.parse(data) as {
          choices?: { delta?: { content?: string; tool_calls?: OaiToolCall[] }; finish_reason?: string }[];
        };
        const choice = chunk.choices?.[0];
        if (!choice) continue;
        if (choice.delta?.content) {
          firstTokenAt ??= Date.now();
          text += choice.delta.content;
          yield { type: 'token', text: choice.delta.content };
        }
        for (const tc of choice.delta?.tool_calls ?? []) {
          const i = tc.index ?? 0;
          const cur = calls.get(i) ?? { name: '', args: '' };
          if (tc.id) cur.id = tc.id;
          if (tc.function?.name) cur.name += tc.function.name;
          if (tc.function?.arguments) cur.args += tc.function.arguments;
          calls.set(i, cur);
        }
        if (choice.finish_reason) finish = choice.finish_reason;
      }

      const toolCalls: ToolCall[] = [...calls.entries()].map(([i, c]) => {
        const parsed = parseJsonLoose(c.args || '{}');
        return {
          id: c.id ?? `call-${i}`,
          name: c.name,
          arguments: (parsed && typeof parsed === 'object' ? parsed : {}) as Record<string, unknown>,
        };
      });
      for (const call of toolCalls) yield { type: 'toolCall', call };
      const result: LlmResult = {
        text,
        toolCalls,
        stopReason: toolCalls.length ? 'tool' : finish === 'length' ? 'length' : 'eos',
        stats: { totalMs: Date.now() - started, ...(firstTokenAt ? { ttftMs: firstTokenAt - started } : {}) },
      };
      if (req.responseFormat) result.json = parseJsonLoose(text);
      yield { type: 'done', result };
    } catch (err) {
      this.state = 'error';
      this.error = err instanceof Error ? err.message : String(err);
      throw err;
    } finally {
      clearTimeout(timer);
    }
  }

  private toBody(req: CompletionRequest): Record<string, unknown> {
    return {
      model: this.model,
      stream: true,
      messages: req.messages.map((m) => ({
        role: m.role,
        content: m.content,
        ...(m.toolCallId ? { tool_call_id: m.toolCallId } : {}),
      })),
      ...(req.temperature !== undefined ? { temperature: req.temperature } : {}),
      ...(req.maxTokens !== undefined ? { max_tokens: req.maxTokens } : {}),
      ...(req.seed !== undefined ? { seed: req.seed } : {}),
      ...(req.responseFormat ? { response_format: req.responseFormat } : {}),
      ...(req.tools
        ? {
            tools: req.tools.map((t) => ({
              type: 'function',
              function: { name: t.name, description: t.description, parameters: t.parameters },
            })),
          }
        : {}),
      ...(req.tools && req.toolChoice
        ? {
            tool_choice:
              typeof req.toolChoice === 'string'
                ? req.toolChoice
                : { type: 'function', function: { name: req.toolChoice.name } },
          }
        : {}),
    };
  }
}

/** Yields the `data:` payloads of a server-sent-events body. */
async function* sseData(body: ReadableStream<Uint8Array>): AsyncIterable<string> {
  const decoder = new TextDecoder();
  let buf = '';
  for await (const chunk of body as unknown as AsyncIterable<Uint8Array>) {
    buf += decoder.decode(chunk, { stream: true });
    let nl = buf.indexOf('\n');
    while (nl >= 0) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (line.startsWith('data:')) yield line.slice(5).trim();
      nl = buf.indexOf('\n');
    }
  }
  const last = buf.trim();
  if (last.startsWith('data:')) yield last.slice(5).trim();
}
