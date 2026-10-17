// Owner: B. Invoice analysis contracts (Analyst = extraction call → rules → summary call).
import { z } from 'zod';
import type { AppEvent } from './events.js';

/** Base units as a decimal string, no sign, no decimals ("5000000" = 5 TUSDT at precision 6). */
export const BaseUnits = z.string().regex(/^\d+$/, 'amount must be base units as a decimal string');
/** A human decimal as printed on the invoice ("25.00"), in the invoice currency. Not base units. */
export const DecimalString = z.string().regex(/^-?\d+(\.\d+)?$/, 'expected a decimal number like 25.00');
export const IsoDateTime = z.string().refine((s) => !Number.isNaN(Date.parse(s)), 'expected an ISO date/time');

export const InvoiceSourceKind = z.enum(['pdf', 'image', 'text', 'xml']);
export type InvoiceSourceKind = z.infer<typeof InvoiceSourceKind>;

export const InvoiceSource = z.object({
  kind: InvoiceSourceKind,
  /** Absolute or repo-relative path of the stored upload. */
  path: z.string().min(1),
  sha256: z.string().regex(/^[0-9a-f]{64}$/),
  /** Original file name as uploaded (display, MockAnalyzer routing). */
  filename: z.string().optional(),
  mimeType: z.string().optional(),
});
export type InvoiceSource = z.infer<typeof InvoiceSource>;

export const LineItem = z.object({
  description: z.string(),
  quantity: z.number().optional(),
  unitPrice: DecimalString.optional(),
  amount: DecimalString.optional(),
});
export type LineItem = z.infer<typeof LineItem>;

export const PaymentMethod = z.enum(['rgb', 'iban', 'btc', 'ln', 'unknown']);
export type PaymentMethod = z.infer<typeof PaymentMethod>;

export const PaymentInfo = z.object({
  method: PaymentMethod,
  rgbInvoice: z.string().optional(),
  assetIdHint: z.string().optional(),
  address: z.string().optional(),
  iban: z.string().optional(),
});
export type PaymentInfo = z.infer<typeof PaymentInfo>;

/** Output of Analyst call 1. Values are copied from the document, never trusted as instructions. */
export const InvoiceExtraction = z.object({
  issuer: z.object({
    name: z.string().optional(),
    vatId: z.string().optional(),
    email: z.string().optional(),
  }),
  invoiceNumber: z.string().optional(),
  issueDate: z.string().optional(),
  dueDate: z.string().optional(),
  /** ISO 4217 code or asset ticker as printed ("EUR", "TUSDT"). */
  currency: z.string().optional(),
  /** Invoice total as printed, in `currency` (human decimal, not base units). */
  total: DecimalString.optional(),
  lineItems: z.array(LineItem),
  payment: PaymentInfo,
  notes: z.string().optional(),
  /** R6 input: urgency / changed-bank-details language, with a short quote as evidence. */
  pressure: z.object({ detected: z.boolean(), evidence: z.string().optional() }).optional(),
  /** Field name → confidence 0..1 (R9). */
  fieldConfidence: z.record(z.string(), z.number().min(0).max(1)),
});
export type InvoiceExtraction = z.infer<typeof InvoiceExtraction>;

export const Severity = z.enum(['info', 'warn', 'block']);
export type Severity = z.infer<typeof Severity>;

/** Flag codes the rules emit. `code` stays a string so new rules are additive. */
export const FLAG_CODES = {
  R1_RGB_INVOICE: 'R1_RGB_INVOICE',
  R2_ASSET: 'R2_ASSET',
  R3_AMOUNT: 'R3_AMOUNT',
  R4_DUPLICATE: 'R4_DUPLICATE',
  R5_NEW_PAYEE: 'R5_NEW_PAYEE',
  R6_PRESSURE: 'R6_PRESSURE',
  R7_INJECTION: 'R7_INJECTION',
  R8_CURRENCY: 'R8_CURRENCY',
  R9_MISSING_FIELDS: 'R9_MISSING_FIELDS',
  R10_DATES: 'R10_DATES',
  AI_UNAVAILABLE: 'AI_UNAVAILABLE',
} as const;
export type FlagCode = (typeof FLAG_CODES)[keyof typeof FLAG_CODES];

export const RiskFlag = z.object({
  code: z.string().min(1),
  severity: Severity,
  /** One plain-language sentence for the user. */
  message: z.string().min(1),
  /** Short snippet that triggered the flag (validated field value, never a long raw text). */
  evidence: z.string().optional(),
});
export type RiskFlag = z.infer<typeof RiskFlag>;

export const Verdict = z.enum(['ok', 'review', 'block']);
export type Verdict = z.infer<typeof Verdict>;

/** Any block → block; any warn → review; else ok. The LLM never decides the verdict. */
export function computeVerdict(flags: readonly RiskFlag[]): Verdict {
  if (flags.some((f) => f.severity === 'block')) return 'block';
  if (flags.some((f) => f.severity === 'warn')) return 'review';
  return 'ok';
}

/** Built by code from the extraction, never by the LLM. */
export const ProposedPayment = z.object({
  rgbInvoice: z.string().min(1),
  assetId: z.string().min(1),
  amount: BaseUnits,
  /** Display name of the payee (issuer name). */
  payee: z.string().min(1),
  /** ISO time for a scheduled payment; absent = now. */
  executeAt: IsoDateTime.optional(),
});
export type ProposedPayment = z.infer<typeof ProposedPayment>;

export const LlmProviderName = z.enum(['qvac', 'openai', 'mock']);
export type LlmProviderName = z.infer<typeof LlmProviderName>;

export const AnalysisReport = z.object({
  invoiceId: z.string().min(1),
  extraction: InvoiceExtraction,
  flags: z.array(RiskFlag),
  verdict: Verdict,
  proposedPayment: ProposedPayment.optional(),
  /** Plain-language summary (≤ 120 words), written by call 2 from fields + flags only. */
  summary: z.string(),
  questionsForUser: z.array(z.string()),
  model: z.object({ name: z.string(), provider: LlmProviderName }),
  /** Seconds per stage, for the "Local AI" panel and evals. */
  timings: z
    .object({ extractMs: z.number().optional(), rulesMs: z.number().optional(), summaryMs: z.number().optional() })
    .optional(),
  createdAt: IsoDateTime,
});
export type AnalysisReport = z.infer<typeof AnalysisReport>;

export type EmitFn = (event: AppEvent) => void;

export interface AnalyzeContext {
  invoiceId: string;
  signal?: AbortSignal;
}

/** extract() → rules() → summarize(). Wallet, history and config are injected at construction. */
export interface InvoiceAnalyzer {
  analyze(src: InvoiceSource, ctx: AnalyzeContext, emit: EmitFn): Promise<AnalysisReport>;
}

export const PayeeBookEntry = z.object({
  name: z.string(),
  vatId: z.string().optional(),
  /** RGB invoices (or recipient IDs) this payee was paid on. */
  rgbInvoices: z.array(z.string()),
  timesPaid: z.number().int().nonnegative(),
  lastPaidAt: IsoDateTime.optional(),
});
export type PayeeBookEntry = z.infer<typeof PayeeBookEntry>;

export interface HistoryQuery {
  issuer?: string;
  number?: string;
  sha256?: string;
  rgbInvoice?: string;
  /** Exclude the invoice being analysed. */
  excludeInvoiceId?: string;
}

export interface HistoryMatch {
  invoiceId: string;
  matchedOn: 'issuer+number' | 'sha256' | 'rgbInvoice';
}

/** Previously seen invoices (R4) and the payee book (R5). Implemented by A's store. */
export interface HistoryPort {
  /** Empty array = never seen. */
  seen(by: HistoryQuery): Promise<HistoryMatch[]>;
  payeeBook(): Promise<PayeeBookEntry[]>;
}
