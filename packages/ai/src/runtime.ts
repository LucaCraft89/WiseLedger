// One AI runtime per server: one loaded model shared by the Analyst and the Treasurer, warmed up at start.
import type { HistoryPort, LlmInfo, LlmProvider, PaymentGuard, WalletPort } from 'core';
import { Analyst } from './analyst/analyze.js';
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
          await llm.warmUp?.();
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
