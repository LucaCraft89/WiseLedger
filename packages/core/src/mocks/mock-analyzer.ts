// Owner: B. Canned InvoiceAnalyzer: verdict by file name (*scam* / *inject* → block, *eur* → review, else ok).
import {
  type AnalysisReport,
  type AnalyzeContext,
  computeVerdict,
  type EmitFn,
  FLAG_CODES,
  type InvoiceAnalyzer,
  type InvoiceExtraction,
  type InvoiceSource,
  type RiskFlag,
} from '../analysis.js';
import type { Stage } from '../events.js';
import { MOCK_ASSET_ID, mockInvoice } from './mock-wallet.js';

export interface MockAnalyzerOptions {
  /** Gap between stage events. Default 300 ms; 0 in tests. */
  stageDelayMs?: number;
  /** Asset paid by the canned proposedPayment. Default MockWallet's `rgb:mock-tusdt`. */
  assetId?: string;
  /** Base units for the canned payment. Default "25000000" (25 TUSDT). */
  amount?: string;
  now?: () => Date;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function baseName(src: InvoiceSource): string {
  return (src.filename ?? src.path.split(/[\\/]/).pop() ?? '').toLowerCase();
}

export function mockFlagsFor(name: string): RiskFlag[] {
  if (name.includes('inject')) {
    return [
      {
        code: FLAG_CODES.R7_INJECTION,
        severity: 'block',
        message: 'The invoice contains text that tries to give orders to the AI. We stopped here.',
        evidence: 'ignore previous instructions…',
      },
    ];
  }
  if (name.includes('scam')) {
    return [
      {
        code: FLAG_CODES.R6_PRESSURE,
        severity: 'block',
        message: 'The invoice says the bank details changed and asks to pay urgently. This is a common fraud.',
        evidence: 'our bank details have changed',
      },
      { code: FLAG_CODES.R5_NEW_PAYEE, severity: 'warn', message: 'You have never paid this supplier before.' },
    ];
  }
  if (name.includes('eur')) {
    return [
      {
        code: FLAG_CODES.R8_CURRENCY,
        severity: 'warn',
        message: 'The invoice is in EUR but the payment is in TUSDT. Check the exchange rate.',
        evidence: 'EUR',
      },
    ];
  }
  return [];
}

export class MockAnalyzer implements InvoiceAnalyzer {
  constructor(private readonly opts: MockAnalyzerOptions = {}) {}

  async analyze(src: InvoiceSource, ctx: AnalyzeContext, emit: EmitFn): Promise<AnalysisReport> {
    const delay = this.opts.stageDelayMs ?? 300;
    const now = this.opts.now ?? (() => new Date());
    const at = () => now().toISOString();
    const { invoiceId } = ctx;
    const stage = async (s: Stage) => {
      emit({ type: 'stage', invoiceId, at: at(), stage: s, status: 'start' });
      if (delay) await sleep(delay);
      emit({ type: 'stage', invoiceId, at: at(), stage: s, status: 'end' });
    };

    const name = baseName(src);
    const assetId = this.opts.assetId ?? MOCK_ASSET_ID;
    const amount = this.opts.amount ?? '25000000';
    const isEur = name.includes('eur');
    const rgbInvoice = mockInvoice(assetId, amount, Math.floor(now().getTime() / 1000) + 24 * 3600);

    await stage('reading');
    await stage('extracting');
    const extraction: InvoiceExtraction = {
      issuer: { name: name.includes('scam') ? 'Acme S.r.l. Billing Dept' : 'Acme Srl', vatId: 'IT01234567890' },
      invoiceNumber: '2026-042',
      issueDate: '2026-10-10',
      dueDate: '2026-11-09',
      currency: isEur ? 'EUR' : 'TUSDT',
      total: '25.00',
      lineItems: [{ description: 'Web hosting, October', quantity: 1, unitPrice: '25.00', amount: '25.00' }],
      payment: { method: 'rgb', rgbInvoice, assetIdHint: assetId },
      fieldConfidence: { issuer: 0.95, total: 0.97, 'payment.rgbInvoice': 0.99 },
    };

    emit({ type: 'stage', invoiceId, at: at(), stage: 'checking', status: 'start' });
    const flags = mockFlagsFor(name);
    for (const flag of flags) emit({ type: 'flag', invoiceId, at: at(), flag });
    if (delay) await sleep(delay);
    emit({ type: 'stage', invoiceId, at: at(), stage: 'checking', status: 'end' });
    const verdict = computeVerdict(flags);

    await stage('summarizing');
    const summary =
      verdict === 'ok'
        ? 'Acme Srl asks 25.00 TUSDT for web hosting in October. Everything we checked looks normal.'
        : verdict === 'review'
          ? 'Acme Srl asks 25.00 for web hosting. Some details need your attention before paying.'
          : 'This invoice looks dangerous. We recommend not paying it.';

    const report: AnalysisReport = {
      invoiceId,
      extraction,
      flags,
      verdict,
      proposedPayment: verdict === 'block' ? undefined : { rgbInvoice, assetId, amount, payee: 'Acme Srl' },
      summary,
      questionsForUser: verdict === 'review' ? ['Do you agree with the exchange rate used for this payment?'] : [],
      model: { name: 'mock-analyzer', provider: 'mock' },
      createdAt: at(),
    };
    emit({ type: 'report', invoiceId, at: at(), report });
    emit({ type: 'stage', invoiceId, at: at(), stage: 'analyzed', status: 'end' });
    return report;
  }
}
