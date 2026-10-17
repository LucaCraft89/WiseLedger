// Owner: B. Scripted LlmProvider: a queue of canned replies (text, JSON or tool call).
import {
  assertRequestShape,
  type CompletionRequest,
  type LlmEvent,
  type LlmInfo,
  type LlmProvider,
  type LlmResult,
  type ToolCall,
} from '../llm.js';

export type MockReply =
  | { text: string }
  | { json: unknown }
  | { toolCall: { name: string; arguments: Record<string, unknown> } }
  | { error: string };

export interface MockLlmOptions {
  replies?: MockReply[];
  /** Used when the queue is empty. Default: `{ text: 'ok' }`. */
  fallback?: MockReply | ((req: CompletionRequest) => MockReply);
  model?: string;
  /** Delay between streamed tokens. Default 0. */
  tokenDelayMs?: number;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export class MockLlm implements LlmProvider {
  /** Every request received, in order (tests assert on prompts with this). */
  readonly calls: CompletionRequest[] = [];
  private queue: MockReply[];
  private toolSeq = 0;

  constructor(private readonly opts: MockLlmOptions = {}) {
    this.queue = [...(opts.replies ?? [])];
  }

  info(): LlmInfo {
    return { provider: 'mock', model: this.opts.model ?? 'mock-llm', state: 'ready', onDevice: true };
  }

  push(...replies: MockReply[]): this {
    this.queue.push(...replies);
    return this;
  }

  get pending(): number {
    return this.queue.length;
  }

  async complete(req: CompletionRequest): Promise<LlmResult> {
    assertRequestShape(req);
    this.calls.push(req);
    return this.toResult(this.next(req));
  }

  async *stream(req: CompletionRequest): AsyncIterable<LlmEvent> {
    const result = await this.complete(req);
    for (const piece of result.text.match(/\S+\s*/g) ?? []) {
      if (this.opts.tokenDelayMs) await sleep(this.opts.tokenDelayMs);
      yield { type: 'token', text: piece };
    }
    for (const call of result.toolCalls) yield { type: 'toolCall', call };
    yield { type: 'done', result };
  }

  private next(req: CompletionRequest): MockReply {
    const queued = this.queue.shift();
    if (queued) return queued;
    const fb = this.opts.fallback;
    if (typeof fb === 'function') return fb(req);
    return fb ?? { text: 'ok' };
  }

  private toResult(reply: MockReply): LlmResult {
    if ('error' in reply) throw new Error(reply.error);
    if ('json' in reply) {
      return { text: JSON.stringify(reply.json), json: reply.json, toolCalls: [], stopReason: 'eos' };
    }
    if ('toolCall' in reply) {
      const call: ToolCall = { id: `mock-call-${++this.toolSeq}`, ...reply.toolCall };
      return { text: '', toolCalls: [call], stopReason: 'tool' };
    }
    return { text: reply.text, toolCalls: [], stopReason: 'eos' };
  }
}
