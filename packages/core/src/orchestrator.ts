// Orchestrator contract (lane A): invoice lifecycle, payment plan, confirmation, execution result,
// and the ports the scheduler (lane B) and the server (lane A) build against.
import { z } from 'zod';
import { AmountSchema, type TransferInfo } from './wallet.js';

export const InvoiceStateSchema = z.enum([
  'UPLOADED',
  'EXTRACTED',
  'ANALYZED',
  'AWAITING_CONFIRMATION',
  'CONFIRMED',
  'EXECUTING',
  'SCHEDULED',
  'PAID',
  'FAILED',
  'REJECTED',
  'BLOCKED',
]);
export type InvoiceState = z.infer<typeof InvoiceStateSchema>;

/** Legal transitions. PAID and REJECTED are terminal; FAILED and BLOCKED only allow REJECTED (archive). */
export const INVOICE_TRANSITIONS: Readonly<Record<InvoiceState, readonly InvoiceState[]>> = {
  UPLOADED: ['EXTRACTED', 'FAILED'],
  EXTRACTED: ['ANALYZED', 'FAILED'],
  ANALYZED: ['AWAITING_CONFIRMATION', 'BLOCKED', 'FAILED'],
  AWAITING_CONFIRMATION: ['CONFIRMED', 'REJECTED'],
  CONFIRMED: ['EXECUTING', 'BLOCKED', 'REJECTED'],
  EXECUTING: ['SCHEDULED', 'PAID', 'FAILED', 'BLOCKED'],
  SCHEDULED: ['EXECUTING', 'REJECTED'],
  PAID: [],
  FAILED: ['REJECTED'],
  REJECTED: [],
  BLOCKED: ['REJECTED'],
};

export function canTransition(from: InvoiceState, to: InvoiceState): boolean {
  return INVOICE_TRANSITIONS[from].includes(to);
}

export class IllegalTransition extends Error {
  constructor(
    readonly from: InvoiceState,
    readonly to: InvoiceState,
  ) {
    super(`Illegal invoice transition ${from} → ${to}`);
    this.name = 'IllegalTransition';
  }
}

export function assertTransition(from: InvoiceState, to: InvoiceState): void {
  if (!canTransition(from, to)) throw new IllegalTransition(from, to);
}

export const PlanPayeeSchema = z.object({
  name: z.string(),
  /** RGB recipient ID decoded from the invoice, used by the payee book. */
  recipientId: z.string().optional(),
});
export type PlanPayee = z.infer<typeof PlanPayeeSchema>;

export const PaymentPlanInputSchema = z.object({
  invoiceId: z.string(),
  rgbInvoice: z.string(),
  assetId: z.string(),
  amount: AmountSchema,
  payee: PlanPayeeSchema,
  /** 'now' or an ISO timestamp for a scheduled payment */
  executeAt: z.union([z.literal('now'), z.iso.datetime({ offset: true })]),
  labels: z.array(z.string()),
});
export type PaymentPlanInput = z.infer<typeof PaymentPlanInputSchema>;

export const PaymentPlanSchema = PaymentPlanInputSchema.extend({
  /** sha256 (hex) of the canonical JSON of every other field */
  planId: z.string().regex(/^[0-9a-f]{64}$/),
});
export type PaymentPlan = z.infer<typeof PaymentPlanSchema>;

export const ConfirmationSchema = z.object({
  planId: z.string(),
  /** ISO timestamp */
  confirmedAt: z.string(),
});
export type Confirmation = z.infer<typeof ConfirmationSchema>;

export const ExecutionResultSchema = z.object({
  planId: z.string(),
  status: z.enum(['submitted', 'settled', 'scheduled', 'failed']),
  transferId: z.string().optional(),
  txid: z.string().optional(),
  error: z.object({ code: z.string(), message: z.string() }).optional(),
});
export type ExecutionResult = z.infer<typeof ExecutionResultSchema>;

export const InvoiceRecordSchema = z.object({
  id: z.string(),
  state: InvoiceStateSchema,
  filename: z.string(),
  kind: z.enum(['pdf', 'image', 'text', 'xml']),
  sha256: z.string(),
  /** Stored upload path (server side) */
  path: z.string(),
  /** AnalysisReport from core/analysis.ts once ANALYZED (typed loosely here to keep the two contract files independent) */
  report: z.unknown().optional(),
  plan: PaymentPlanSchema.optional(),
  confirmation: ConfirmationSchema.optional(),
  result: ExecutionResultSchema.optional(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type InvoiceRecord = z.infer<typeof InvoiceRecordSchema>;

/** JSON with object keys sorted recursively and undefined fields dropped. Stable across runs and machines. */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(sortKeys(value));
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value !== null && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value).sort()) {
      const v = (value as Record<string, unknown>)[key];
      if (v !== undefined) out[key] = sortKeys(v);
    }
    return out;
  }
  return value;
}

/** sha256 hex via Web Crypto, so this works in Node and in the browser. */
export async function sha256Hex(text: string): Promise<string> {
  const digest = await globalThis.crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0')).join('');
}

export async function computePlanId(input: PaymentPlanInput): Promise<string> {
  const { planId: _ignored, ...rest } = input as PaymentPlanInput & { planId?: string };
  return sha256Hex(canonicalJson(rest));
}

export async function makePlan(input: PaymentPlanInput): Promise<PaymentPlan> {
  const parsed = PaymentPlanInputSchema.parse(input);
  return { ...parsed, planId: await computePlanId(parsed) };
}

/** True when the plan's fields still hash to its planId (tamper check used by PaymentGuard). */
export async function verifyPlanId(plan: PaymentPlan): Promise<boolean> {
  return (await computePlanId(plan)) === plan.planId;
}

// ---- Ports (stubs in M0.S1; in-memory versions in mocks, real ones in apps/server) ----

export const JobStatusSchema = z.enum(['pending', 'running', 'done', 'cancelled', 'failed']);
export type JobStatus = z.infer<typeof JobStatusSchema>;

export const JobSchema = z.object({
  jobId: z.string(),
  planId: z.string(),
  invoiceId: z.string(),
  /** ISO timestamp */
  runAt: z.string(),
  status: JobStatusSchema,
  createdAt: z.string(),
  updatedAt: z.string(),
  result: ExecutionResultSchema.optional(),
  lastError: z.string().optional(),
});
export type Job = z.infer<typeof JobSchema>;

/** Scheduled payments. The scheduler (lane B) runs due jobs through lane A's PaymentGuard. */
export interface JobStore {
  put(job: Job): Promise<void>;
  list(filter?: { status?: JobStatus; dueBefore?: string }): Promise<Job[]>;
  cancel(jobId: string): Promise<boolean>;
  markDone(jobId: string, result: ExecutionResult): Promise<void>;
}

export const LabelEntrySchema = z.object({
  /** transferId (or invoiceId for unpaid invoices) */
  targetId: z.string(),
  labels: z.array(z.string()),
  note: z.string().optional(),
  updatedAt: z.string(),
});
export type LabelEntry = z.infer<typeof LabelEntrySchema>;

export interface LabelStore {
  set(targetId: string, labels: string[], note?: string): Promise<LabelEntry>;
  get(targetId: string): Promise<LabelEntry | null>;
  list(): Promise<LabelEntry[]>;
}

export type FiscalFormat = 'csv' | 'json';

export interface FiscalRow {
  date: string;
  transferId: string;
  direction: TransferInfo['direction'];
  assetId: string;
  ticker: string;
  /** base units */
  amount: string;
  /** human units, e.g. "5.000000" */
  amountDisplay: string;
  counterparty?: string;
  invoiceNumber?: string;
  labels: string[];
  txid?: string;
  status: TransferInfo['status'];
}

export interface FiscalReport {
  format: FiscalFormat;
  filename: string;
  /** CSV text or JSON text */
  content: string;
  rows: FiscalRow[];
}

export interface FiscalService {
  /** from/to are ISO dates (inclusive) */
  report(from: string, to: string, format: FiscalFormat): Promise<FiscalReport>;
}
