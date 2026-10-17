// The Analyst (no tools): extract (call 1) → rules (code) → verdict (code) → summary (call 2, fields + flags only).
import {
  type AnalysisReport,
  type AnalyzeContext,
  type DecodedInvoice,
  type EmitFn,
  FLAG_CODES,
  type HistoryPort,
  type InvoiceAnalyzer,
  type InvoiceSource,
  type LlmProvider,
  type ProposedPayment,
  type RiskFlag,
  type Stage,
  type WalletPort,
} from 'core';
import { loadInvoice } from '../extract/text.js';
import { paymentAmount, paymentAsset, type RuleConfig, type RuleInput, runRules } from '../rules/index.js';
import { extractInvoice } from './extract.js';
import { summarize } from './summarize.js';

export interface AnalystDeps {
  llm: LlmProvider;
  wallet: Pick<WalletPort, 'decodeInvoice' | 'assetBalance'>;
  history: HistoryPort;
  config: RuleConfig;
  now?: () => Date;
  /** Stream model tokens as `token` events (UI "reading…" effect). Default true. */
  streamTokens?: boolean;
}

export class Analyst implements InvoiceAnalyzer {
  constructor(private readonly deps: AnalystDeps) {}

  async analyze(src: InvoiceSource, ctx: AnalyzeContext, emit: EmitFn): Promise<AnalysisReport> {
    const { llm, wallet, history, config } = this.deps;
    const now = this.deps.now ?? (() => new Date());
    const at = () => now().toISOString();
    const { invoiceId } = ctx;
    const onToken =
      this.deps.streamTokens === false
        ? undefined
        : (text: string) => emit({ type: 'token', invoiceId, at: at(), agent: 'analyst', text });
    const stage = async <T>(s: Stage, fn: () => Promise<T>): Promise<T> => {
      emit({ type: 'stage', invoiceId, at: at(), stage: s, status: 'start' });
      try {
        const out = await fn();
        emit({ type: 'stage', invoiceId, at: at(), stage: s, status: 'end' });
        return out;
      } catch (err) {
        emit({
          type: 'stage',
          invoiceId,
          at: at(),
          stage: s,
          status: 'error',
          message: err instanceof Error ? err.message : String(err),
        });
        throw err;
      }
    };

    const input = await stage('reading', () => loadInvoice(src));
    let extracted: Pick<Awaited<ReturnType<typeof extractInvoice>>, 'extraction' | 'ms'>;
    try {
      const t0 = Date.now();
      extracted = await stage('extracting', async () =>
        input.mode === 'text' && input.structured
          ? { extraction: input.structured, ms: Date.now() - t0 } // FatturaPA: tagged fields, no model call
          : extractInvoice(input, llm, {
              ...(ctx.signal ? { signal: ctx.signal } : {}),
              ...(onToken ? { onToken } : {}),
            }),
      );
    } catch (err) {
      // Never a silent pass: without a reliable extraction the user must review, and there is nothing to pay.
      return this.unavailable(invoiceId, err, emit, at);
    }
    const { extraction, ms: extractMs } = extracted;

    const rulesStarted = Date.now();
    const { flags, verdict, ruleInput } = await stage('checking', async () => {
      const rgbInvoice = extraction.payment.rgbInvoice;
      let decoded: RuleInput['decoded'];
      if (rgbInvoice) {
        decoded = await wallet
          .decodeInvoice(rgbInvoice)
          .catch((e: unknown) => ({ error: e instanceof Error ? e.message : String(e) }));
      }
      const partial: RuleInput = {
        extraction,
        ...(decoded ? { decoded } : {}),
        history: await history.seen({
          ...(extraction.issuer.name ? { issuer: extraction.issuer.name } : {}),
          ...(extraction.invoiceNumber ? { number: extraction.invoiceNumber } : {}),
          sha256: src.sha256,
          ...(rgbInvoice ? { rgbInvoice } : {}),
          excludeInvoiceId: invoiceId,
        }),
        payees: await history.payeeBook().catch(() => []),
        ...(input.mode === 'text' ? { sourceText: input.text, removed: input.removed } : {}),
        config,
        now: now(),
      };
      const asset = paymentAsset(partial);
      if (asset && config.assetAllowlist.includes(asset)) {
        const balance = await wallet.assetBalance(asset).catch(() => undefined);
        if (balance) partial.balance = balance;
      }
      const result = runRules(partial);
      for (const flag of result.flags) emit({ type: 'flag', invoiceId, at: at(), flag });
      return { ...result, ruleInput: partial };
    });
    const rulesMs = Date.now() - rulesStarted;

    const summary = await stage('summarizing', () =>
      summarize(extraction, flags, verdict, llm, {
        ...(ctx.signal ? { signal: ctx.signal } : {}),
        ...(onToken ? { onToken } : {}),
      }),
    );

    const proposedPayment = verdict === 'block' ? undefined : buildProposedPayment(ruleInput);
    const report: AnalysisReport = {
      invoiceId,
      extraction,
      flags,
      verdict,
      ...(proposedPayment ? { proposedPayment } : {}),
      summary: summary.summary,
      questionsForUser: withRuleQuestions(summary.questionsForUser, flags),
      model: { name: llm.info().model, provider: llm.info().provider },
      timings: { extractMs, rulesMs, summaryMs: summary.ms },
      createdAt: at(),
    };
    emit({ type: 'report', invoiceId, at: at(), report });
    emit({ type: 'stage', invoiceId, at: at(), stage: 'analyzed', status: 'end' });
    return report;
  }

  private unavailable(invoiceId: string, err: unknown, emit: EmitFn, at: () => string): AnalysisReport {
    const detail = err instanceof Error ? err.message : String(err);
    const flag = {
      code: FLAG_CODES.AI_UNAVAILABLE,
      severity: 'warn' as const,
      message: AI_UNAVAILABLE_MESSAGE,
      evidence: detail.slice(0, 120),
    };
    emit({ type: 'flag', invoiceId, at: at(), flag });
    const report: AnalysisReport = {
      invoiceId,
      extraction: { issuer: {}, lineItems: [], payment: { method: 'unknown' }, fieldConfidence: {} },
      flags: [flag],
      verdict: 'review',
      summary: AI_UNAVAILABLE_MESSAGE,
      questionsForUser: [],
      model: { name: this.deps.llm.info().model, provider: this.deps.llm.info().provider },
      createdAt: at(),
    };
    emit({ type: 'report', invoiceId, at: at(), report });
    emit({ type: 'stage', invoiceId, at: at(), stage: 'analyzed', status: 'end' });
    return report;
  }
}

export const AI_UNAVAILABLE_MESSAGE =
  'The local AI could not read this invoice, so nothing was checked. Check it yourself or try again in a minute.';

/** Questions the rules ask in their own words (R8 rate question) go first; at most 3 in total. */
export function withRuleQuestions(questions: string[], flags: RiskFlag[]): string[] {
  const fromRules = flags
    .filter((f) => f.code === FLAG_CODES.R8_CURRENCY)
    .map((f) => f.message.slice(f.message.lastIndexOf('. ') + 2));
  return [...new Set([...fromRules, ...questions])].slice(0, 3);
}

/** Built by code from validated data only: the RGB invoice as printed, the asset and amount the rules checked. */
export function buildProposedPayment(input: RuleInput): ProposedPayment | undefined {
  const rgbInvoice = input.extraction.payment.rgbInvoice;
  const assetId = paymentAsset(input);
  const amount = paymentAmount(input);
  if (!rgbInvoice || !assetId || !amount || !input.decoded || 'error' in input.decoded) return undefined;
  return { rgbInvoice, assetId, amount, payee: input.extraction.issuer.name ?? 'Unknown supplier' };
}

export type { DecodedInvoice };
