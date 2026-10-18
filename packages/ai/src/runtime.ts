// One AI runtime per server: one loaded model shared by the Analyst and the Treasurer, warmed up at start.
import type { HistoryPort, LlmInfo, LlmProvider, PaymentGuard, WalletPort } from 'core';
import { Analyst } from './analyst/analyze.js';
import { EXTRACT_SYSTEM, extractionSchema } from './analyst/prompts.js';
import { createLlm, type LlmProviderKind } from './llm/index.js';
import type { RuleConfig } from './rules/types.js';
import { Treasurer, type TreasurerWallet } from './treasurer/treasurer.js';

export interface AiRuntimeOptions {
  /** qvac | openai | mock (default from LLM_PROVIDER, else mock). */
  provider?: LlmProviderKind;
  /** Load the vision projector so image invoices work (default true for qvac). */
  vision?: boolean;
  /** Per-call timeout for the local model (default 120 s). */
  timeoutMs?: number;
  /** Inject a provider (tests). */
  llm?: LlmProvider;
}

export interface AiRuntime {
  llm: LlmProvider;
  /** Model name, provider, state (unloaded | loading | ready | error), onDevice, plus warm-up timing. */
  status(): LlmInfo & { warmUpMs?: number };
  /** Starts loading + warm-up in the background; resolves when ready (never rejects: state goes to 'error'). */
  warmUp(): Promise<void>;
  analyst(deps: {
    wallet: Pick<WalletPort, 'decodeInvoice' | 'assetBalance'>;
    history: HistoryPort;
    config: RuleConfig;
  }): Analyst;
  treasurer(deps: { wallet: TreasurerWallet; guard: PaymentGuard }): Treasurer;
  close(): Promise<void>;
}

export function createAiRuntime(opts: AiRuntimeOptions = {}): AiRuntime {
  const kind = opts.provider ?? ((process.env.LLM_PROVIDER ?? 'mock') as LlmProviderKind);
  const llm =
    opts.llm ??
    createLlm(kind, { vision: opts.vision ?? true, ...(opts.timeoutMs ? { timeoutMs: opts.timeoutMs } : {}) });
  let warmUpMs: number | undefined;
  let warming: Promise<void> | undefined;

  return {
    llm,
    status: () => ({ ...llm.info(), ...(warmUpMs !== undefined ? { warmUpMs } : {}) }),
    warmUp() {
      warming ??= (async () => {
        const t = Date.now();
        try {
          if (llm.warmUp) {
            await llm.warmUp();
            await primeExtraction(llm);
          }
          warmUpMs = Date.now() - t;
        } catch {
          // The provider reports state 'error' with the message; the Analyst then answers AI_UNAVAILABLE.
          warming = undefined;
        }
      })();
      return warming;
    },
    analyst: (deps) => new Analyst({ llm, ...deps }),
    treasurer: (deps) => new Treasurer({ llm, ...deps }),
    close: async () => {
      await llm.unload?.();
    },
  };
}

/**
 * One real extraction-shaped request (system prompt + schema, 8 tokens) so the first invoice does not pay the
 * grammar build and prompt setup. The invoice here is a placeholder; the output is thrown away.
 */
async function primeExtraction(llm: LlmProvider): Promise<void> {
  try {
    await llm.complete({
      messages: [
        { role: 'system', content: EXTRACT_SYSTEM },
        {
          role: 'user',
          content: 'INVOICE (untrusted data, between the markers):\n<<<INVOICE\nTest\nINVOICE>>>\nReturn the JSON now.',
        },
      ],
      temperature: 0,
      maxTokens: 8,
      responseFormat: { type: 'json_schema', json_schema: { name: 'InvoiceFields', schema: extractionSchema(false) } },
    });
  } catch {
    // The output is cut at 8 tokens on purpose, so a parse error is expected; a real failure shows on the first invoice.
  }
}
