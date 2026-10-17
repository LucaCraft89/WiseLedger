// QVAC on-device provider: one loaded model shared by Analyst and Treasurer.
// Structured output: responseFormat json_schema + reasoning_budget 0. Never `/no_think` together with a schema.
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

export const DEFAULT_QVAC_MODEL = 'QWEN3_5_2B_MULTIMODAL_Q4_K_M';
export const SMALL_QVAC_MODEL = 'QWEN3_5_0_8B_MULTIMODAL_Q4_K_M';

export interface QvacProviderOptions {
  /** @qvac/sdk model constant name, e.g. QWEN3_5_2B_MULTIMODAL_Q4_K_M (env QVAC_MODEL). */
  model?: string;
  ctxSize?: number;
  /** Load the vision projector (MMPROJ_*_Q8_0) so messages can carry image attachments. */
  vision?: boolean;
  /** 'gpu' | 'cpu'; default lets QVAC decide. */
  device?: string;
  /** Per-call timeout. Default 120 s. */
  timeoutMs?: number;
  onProgress?: (percentage: number) => void;
}

type Sdk = typeof import('@qvac/sdk');

interface QvacFinal {
  contentText: string;
  toolCalls: { id?: string; name: string; arguments: Record<string, unknown> }[];
  stopReason?: string;
  stats?: { tokensPerSecond?: number; timeToFirstToken?: number; promptTokens?: number; generatedTokens?: number };
}

export class LlmTimeoutError extends Error {
  readonly code = 'LLM_TIMEOUT';
  constructor(ms: number) {
    super(`The local AI did not answer within ${Math.round(ms / 1000)} s.`);
    this.name = 'LlmTimeoutError';
  }
}

/** QWEN3_5_2B_MULTIMODAL_Q4_K_M → MMPROJ_QWEN3_5_2B_MULTIMODAL_Q8_0 */
export function projectionFor(model: string): string {
  return `MMPROJ_${model.replace(/_(Q\d.*|BF16|F16)$/, '')}_Q8_0`;
}

export class QvacProvider implements LlmProvider {
  private state: LlmState = 'unloaded';
  private error: string | undefined;
  private modelId: string | undefined;
  private loading: Promise<string> | undefined;
  private sdk: Sdk | undefined;
  readonly model: string;

  constructor(private readonly opts: QvacProviderOptions = {}) {
    this.model = opts.model ?? (process.env.QVAC_MODEL || DEFAULT_QVAC_MODEL); // empty QVAC_MODEL= (.env.example) = unset
  }

  info(): LlmInfo {
    return {
      provider: 'qvac',
      model: this.model,
      state: this.state,
      onDevice: true,
      ...(this.error ? { error: this.error } : {}),
    };
  }

  async warmUp(): Promise<void> {
    const modelId = await this.ensureLoaded();
    // One tiny generation so the first real request does not pay graph setup.
    const sdk = await this.loadSdk();
    await sdk.completion({
      modelId,
      history: [{ role: 'user', content: 'Hi' }],
      stream: false,
      generationParams: { predict: 1 },
    }).final;
  }

  async unload(): Promise<void> {
    if (!this.modelId) return;
    const sdk = await this.loadSdk();
    await sdk.unloadModel({ modelId: this.modelId, clearStorage: false });
    this.modelId = undefined;
    this.loading = undefined;
    this.state = 'unloaded';
  }

  async complete(req: CompletionRequest): Promise<LlmResult> {
    let result: LlmResult | undefined;
    for await (const e of this.stream(req)) if (e.type === 'done') result = e.result;
    if (!result) throw new Error('QVAC completion ended without a result');
    return result;
  }

  async *stream(req: CompletionRequest): AsyncIterable<LlmEvent> {
    assertRequestShape(req);
    const modelId = await this.ensureLoaded();
    const sdk = await this.loadSdk();
    const started = Date.now();
    let firstTokenAt: number | undefined;

    const run = sdk.completion(this.toParams(modelId, req) as Parameters<Sdk['completion']>[0]);
    const timeoutMs = this.opts.timeoutMs ?? 120_000;
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      void sdk.cancel({ requestId: run.requestId } as never).catch(() => {});
    }, timeoutMs);
    const onAbort = () => void sdk.cancel({ requestId: run.requestId } as never).catch(() => {});
    req.signal?.addEventListener('abort', onAbort, { once: true });

    try {
      for await (const ev of run.events as AsyncIterable<{ type: string; text?: string; call?: ToolCall }>) {
        if (ev.type === 'contentDelta' && ev.text) {
          firstTokenAt ??= Date.now();
          yield { type: 'token', text: ev.text };
        } else if (ev.type === 'toolCall' && ev.call) {
          yield { type: 'toolCall', call: normalizeCall(ev.call, 0) };
        }
      }
      const final = (await run.final) as unknown as QvacFinal;
      if (timedOut) throw new LlmTimeoutError(timeoutMs);
      const toolCalls = (final.toolCalls ?? []).map(normalizeCall);
      const text = final.contentText ?? '';
      const result: LlmResult = {
        text,
        toolCalls,
        stopReason: toolCalls.length ? 'tool' : mapStop(final.stopReason),
        stats: {
          totalMs: Date.now() - started,
          ...(firstTokenAt ? { ttftMs: firstTokenAt - started } : {}),
          ...(final.stats?.tokensPerSecond !== undefined ? { tokensPerSecond: final.stats.tokensPerSecond } : {}),
          ...(final.stats?.promptTokens !== undefined ? { promptTokens: final.stats.promptTokens } : {}),
          ...(final.stats?.generatedTokens !== undefined ? { completionTokens: final.stats.generatedTokens } : {}),
        },
      };
      if (req.responseFormat) result.json = parseJsonLoose(text);
      yield { type: 'done', result };
    } finally {
      clearTimeout(timer);
      req.signal?.removeEventListener('abort', onAbort);
    }
  }

  private toParams(modelId: string, req: CompletionRequest): Record<string, unknown> {
    const generationParams: Record<string, unknown> = {};
    if (req.temperature !== undefined) generationParams.temp = req.temperature;
    if (req.maxTokens !== undefined) generationParams.predict = req.maxTokens;
    if (req.seed !== undefined) generationParams.seed = req.seed;
    if (req.tools && req.toolChoice) {
      generationParams.tool_choice = typeof req.toolChoice === 'string' ? req.toolChoice : req.toolChoice.name;
    }
    return {
      modelId,
      stream: true,
      history: req.messages.map((m) => ({
        role: m.role,
        content: m.content,
        ...(m.attachments?.length ? { attachments: m.attachments } : {}),
      })),
      ...(req.kvCacheKey ? { kvCache: req.kvCacheKey } : {}),
      ...(req.responseFormat ? { responseFormat: req.responseFormat } : {}),
      ...(req.tools
        ? {
            tools: req.tools.map((t) => ({
              type: 'function',
              name: t.name,
              description: t.description,
              parameters: t.parameters,
            })),
          }
        : {}),
      ...(Object.keys(generationParams).length ? { generationParams } : {}),
    };
  }

  private async loadSdk(): Promise<Sdk> {
    this.sdk ??= await import('@qvac/sdk');
    return this.sdk;
  }

  private ensureLoaded(): Promise<string> {
    if (this.modelId) return Promise.resolve(this.modelId);
    this.loading ??= this.load().catch((err: unknown) => {
      this.loading = undefined;
      this.state = 'error';
      this.error = err instanceof Error ? err.message : String(err);
      throw err;
    });
    return this.loading;
  }

  private async load(): Promise<string> {
    this.state = 'loading';
    const sdk = await this.loadSdk();
    const constants = sdk as unknown as Record<string, unknown>;
    const modelSrc = constants[this.model];
    if (!modelSrc) throw new Error(`Unknown QVAC model constant ${this.model}`);
    const modelConfig: Record<string, unknown> = {
      ctx_size: this.opts.ctxSize ?? 4096,
      // A number, not false: disables thinking so json_schema output starts immediately.
      reasoning_budget: 0,
      tools: true,
    };
    if (this.opts.device) modelConfig.device = this.opts.device;
    if (this.opts.vision) {
      const proj = constants[projectionFor(this.model)];
      if (!proj) throw new Error(`No vision projector for ${this.model}`);
      modelConfig.projectionModelSrc = proj;
    }
    const loadModel = sdk.loadModel as unknown as (o: Record<string, unknown>) => Promise<string>;
    const modelId = await loadModel({
      modelSrc,
      modelType: 'llamacpp-completion',
      modelConfig,
      ...(this.opts.onProgress
        ? { onProgress: (p: { percentage: number }) => this.opts.onProgress?.(p.percentage) }
        : {}),
    });
    this.modelId = modelId;
    this.state = 'ready';
    this.error = undefined;
    return this.modelId;
  }
}

function normalizeCall(c: { id?: string; name: string; arguments: unknown }, i: number): ToolCall {
  let args = c.arguments;
  if (typeof args === 'string') args = parseJsonLoose(args) ?? {};
  return {
    id: c.id ?? `call-${i}`,
    name: c.name,
    arguments: (args && typeof args === 'object' ? args : {}) as Record<string, unknown>,
  };
}

function mapStop(s: string | undefined): LlmResult['stopReason'] {
  if (s === 'length' || s === 'cancelled' || s === 'error') return s;
  return 'eos';
}

/** Parses JSON, tolerating code fences or text around a single object. Returns undefined on failure. */
export function parseJsonLoose(text: string): unknown {
  const t = text.trim();
  try {
    return JSON.parse(t);
  } catch {
    const start = t.indexOf('{');
    const end = t.lastIndexOf('}');
    if (start >= 0 && end > start) {
      try {
        return JSON.parse(t.slice(start, end + 1));
      } catch {
        return undefined;
      }
    }
    return undefined;
  }
}
