// Owner: B. REST DTOs (zod) for every route in PLAN §3. Server validates with these; web parses with these.
import { z } from 'zod';
import { AnalysisReport, BaseUnits, InvoiceSourceKind, IsoDateTime, LlmProviderName, Verdict } from './analysis.js';
import { AppEvent } from './events.js';
import type { AgentReply } from './llm.js';
import {
  ExecutionResultSchema,
  InvoiceStateSchema,
  JobSchema,
  LabelEntrySchema,
  type PaymentPlan,
  PaymentPlanSchema,
} from './orchestrator.js';
import { AssetBalanceSchema, TransferStatusSchema } from './wallet.js';

const InvoiceStateDto = InvoiceStateSchema;
const PaymentPlanDto = PaymentPlanSchema;
const ExecutionResultDto = ExecutionResultSchema;

export const ApiError = z.object({
  error: z.object({
    /** Stable machine code, e.g. INVALID_TRANSITION, VERDICT_BLOCK, NOT_FOUND. */
    code: z.string(),
    /** Plain-language message shown to the user as is. */
    message: z.string(),
  }),
});
export type ApiError = z.infer<typeof ApiError>;

// POST /api/invoices — multipart field `file`, or JSON body below for pasted text.
export const CreateInvoiceTextRequest = z.object({
  text: z.string().min(1).max(200_000),
  filename: z.string().optional(),
});
export type CreateInvoiceTextRequest = z.infer<typeof CreateInvoiceTextRequest>;

export const CreateInvoiceResponse = z.object({ invoiceId: z.string(), state: InvoiceStateDto });
export type CreateInvoiceResponse = z.infer<typeof CreateInvoiceResponse>;

// GET /api/invoices
export const InvoiceSummaryDto = z.object({
  id: z.string(),
  filename: z.string(),
  kind: InvoiceSourceKind,
  state: InvoiceStateDto,
  verdict: Verdict.optional(),
  issuerName: z.string().optional(),
  /** As printed on the invoice. */
  total: z.string().optional(),
  currency: z.string().optional(),
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
});
export type InvoiceSummaryDto = z.infer<typeof InvoiceSummaryDto>;

export const InvoiceListResponse = z.object({ invoices: z.array(InvoiceSummaryDto) });
export type InvoiceListResponse = z.infer<typeof InvoiceListResponse>;

// GET /api/invoices/:id
export const InvoiceDetailResponse = z.object({
  invoice: InvoiceSummaryDto,
  report: AnalysisReport.optional(),
  plan: PaymentPlanDto.optional(),
  /** Built by code from the plan: "Pay 25.00 TUSDT (asset rgb:…) to Acme Srl, now. Confirm?" */
  confirmationSentence: z.string().optional(),
  execution: ExecutionResultDto.optional(),
  /** Past events, so a page reload can rebuild the timeline before the SSE stream resumes. */
  events: z.array(AppEvent),
});
export type InvoiceDetailResponse = z.infer<typeof InvoiceDetailResponse>;

// GET /api/invoices/:id/events — SSE, `event: app`, data = AppEvent (see events.ts).

// POST /api/invoices/:id/confirm
export const ConfirmRequest = z.object({
  /** Must equal the planId the user saw (guards against a plan changed after display). */
  planId: z.string().min(1),
  /** Required true when verdict is `review`; ignored (refused) when `block`. */
  override: z.boolean().optional(),
  /** Schedule instead of paying now (ISO time, from the chat confirmation card). The plan is built with it. */
  executeAt: IsoDateTime.optional(),
});
export type ConfirmRequest = z.infer<typeof ConfirmRequest>;

export const ConfirmResponse = z.object({
  invoiceId: z.string(),
  state: InvoiceStateDto,
  planId: z.string(),
  execution: ExecutionResultDto.optional(),
});
export type ConfirmResponse = z.infer<typeof ConfirmResponse>;

// POST /api/invoices/:id/reject
export const RejectRequest = z.object({ reason: z.string().max(500).optional() });
export type RejectRequest = z.infer<typeof RejectRequest>;
export const RejectResponse = z.object({ invoiceId: z.string(), state: InvoiceStateDto });
export type RejectResponse = z.infer<typeof RejectResponse>;

// GET /api/wallet
export const BalanceDto = AssetBalanceSchema;
export const WalletAssetDto = z.object({
  assetId: z.string(),
  ticker: z.string(),
  name: z.string(),
  precision: z.number().int().min(0).max(18),
  balance: BalanceDto,
});
export type WalletAssetDto = z.infer<typeof WalletAssetDto>;

export const WalletResponse = z.object({
  backend: z.enum(['mock', 'wdk-rgb', 'rgb-lib']),
  network: z.enum(['mutinynet', 'regtest', 'mock']),
  ready: z.boolean(),
  /** BTC receive address (fees, UTXOs). */
  address: z.string().optional(),
  /** BTC balance in sats as a decimal string. */
  btcBalanceSats: BaseUnits.optional(),
  assets: z.array(WalletAssetDto),
});
export type WalletResponse = z.infer<typeof WalletResponse>;

// POST /api/wallet/receive
export const WalletReceiveRequest = z.object({
  assetId: z.string().optional(),
  amount: BaseUnits.optional(),
  expiryMinutes: z
    .number()
    .int()
    .positive()
    .max(60 * 24 * 7)
    .optional(),
});
export type WalletReceiveRequest = z.infer<typeof WalletReceiveRequest>;

export const WalletReceiveResponse = z.object({
  rgbInvoice: z.string(),
  expiresAt: IsoDateTime,
  assetId: z.string().optional(),
  amount: BaseUnits.optional(),
});
export type WalletReceiveResponse = z.infer<typeof WalletReceiveResponse>;

// GET /api/transfers
export const TransferDto = z.object({
  transferId: z.string(),
  /** Absent for transfers where the wallet does not know the asset yet (wallet.ts TransferInfo). */
  assetId: z.string().optional(),
  amount: BaseUnits,
  direction: z.enum(['in', 'out']),
  status: TransferStatusSchema,
  txid: z.string().optional(),
  explorerUrl: z.string().optional(),
  invoiceId: z.string().optional(),
  labels: z.array(z.string()),
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime.optional(),
});
export type TransferDto = z.infer<typeof TransferDto>;

export const TransfersResponse = z.object({ transfers: z.array(TransferDto) });
export type TransfersResponse = z.infer<typeof TransfersResponse>;

// POST /api/agent/chat
export const ChatRequest = z.object({
  message: z.string().min(1).max(2000),
  history: z
    .array(z.object({ role: z.enum(['user', 'assistant']), text: z.string() }))
    .max(20)
    .optional(),
});
export type ChatRequest = z.infer<typeof ChatRequest>;

export const ChatResponse = z.object({
  text: z.string(),
  toolCalls: z.array(
    z.object({
      name: z.string(),
      args: z.record(z.string(), z.unknown()),
      ok: z.boolean(),
      result: z.unknown().optional(),
      error: z.string().optional(),
    }),
  ),
  needsConfirmation: z
    .object({
      needsConfirmation: z.literal(true),
      kind: z.enum(['payment', 'schedule']),
      planId: z.string().optional(),
      invoiceId: z.string().optional(),
      sentence: z.string(),
    })
    .optional(),
});
export type ChatResponse = z.infer<typeof ChatResponse>;
// ChatResponse and AgentReply must stay the same shape.
const _chatShape: (r: AgentReply) => ChatResponse = (r) => r;
void _chatShape;

// GET /api/health
export const HealthResponse = z.object({
  ok: z.boolean(),
  time: IsoDateTime,
  llm: z.object({
    provider: LlmProviderName,
    model: z.string(),
    state: z.enum(['unloaded', 'loading', 'ready', 'error']),
    onDevice: z.boolean(),
  }),
  wallet: z.object({
    backend: z.enum(['mock', 'wdk-rgb', 'rgb-lib']),
    network: z.enum(['mutinynet', 'regtest', 'mock']),
    ready: z.boolean(),
    blockHeight: z.number().int().optional(),
  }),
  /** Plain-language problems found at startup ("No TUSDT yet: run pnpm demo:prepare"). */
  problems: z.array(z.string()),
});
export type HealthResponse = z.infer<typeof HealthResponse>;

// GET /api/schedule · POST /api/schedule/:jobId/cancel
export const ScheduleListResponse = z.object({ jobs: z.array(JobSchema) });
export type ScheduleListResponse = z.infer<typeof ScheduleListResponse>;
export const ScheduleCancelResponse = z.object({ ok: z.boolean() });
export type ScheduleCancelResponse = z.infer<typeof ScheduleCancelResponse>;

// PUT /api/labels/:transferId
export const LabelsPutRequest = z.object({ labels: z.array(z.string().trim().min(1).max(40)).max(10) });
export type LabelsPutRequest = z.infer<typeof LabelsPutRequest>;
export const LabelsPutResponse = LabelEntrySchema;
export type LabelsPutResponse = z.infer<typeof LabelsPutResponse>;

// GET /api/fiscal?from=YYYY-MM-DD&to=YYYY-MM-DD&format=csv|json → file download (Content-Disposition attachment)
export const FiscalQuery = z.object({
  from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  format: z.enum(['csv', 'json']).default('csv'),
});
export type FiscalQuery = z.infer<typeof FiscalQuery>;

/** Route table, for clients and docs. */
export const API_ROUTES = {
  createInvoice: 'POST /api/invoices',
  listInvoices: 'GET /api/invoices',
  getInvoice: 'GET /api/invoices/:id',
  invoiceEvents: 'GET /api/invoices/:id/events',
  confirmInvoice: 'POST /api/invoices/:id/confirm',
  rejectInvoice: 'POST /api/invoices/:id/reject',
  wallet: 'GET /api/wallet',
  walletReceive: 'POST /api/wallet/receive',
  transfers: 'GET /api/transfers',
  agentChat: 'POST /api/agent/chat',
  scheduleList: 'GET /api/schedule',
  scheduleCancel: 'POST /api/schedule/:jobId/cancel',
  labelsPut: 'PUT /api/labels/:transferId',
  fiscal: 'GET /api/fiscal',
  health: 'GET /api/health',
} as const;

/** Base units → display decimal: at least 2 decimals, trailing zeros trimmed ("25000000", 6 → "25.00"; "1234567", 6 → "1.234567"). */
export function formatAssetAmount(baseUnits: string, precision: number): string {
  if (!/^\d+$/.test(baseUnits)) return baseUnits;
  if (precision === 0) return baseUnits;
  const padded = baseUnits.padStart(precision + 1, '0');
  const int = padded.slice(0, -precision).replace(/^0+(?=\d)/, '');
  const frac = padded.slice(-precision).replace(/0+$/, '').padEnd(Math.min(2, precision), '0');
  return frac ? `${int}.${frac}` : int;
}

/**
 * The one sentence the user confirms, built by code from the plan (never by the LLM). Server and web both use this.
 * "Pay 25.00 TUSDT (asset rgb:…) to Acme Srl, now. Confirm?"
 */
export function buildConfirmationSentence(
  plan: Pick<PaymentPlan, 'amount' | 'assetId' | 'payee' | 'executeAt'>,
  asset: { ticker: string; precision: number } | undefined,
): string {
  const amount = asset
    ? `${formatAssetAmount(plan.amount, asset.precision)} ${asset.ticker}`
    : `${plan.amount} base units`;
  const when =
    plan.executeAt === 'now' ? 'now' : `on ${new Date(plan.executeAt).toUTCString().replace(/:\d\d GMT$/, ' UTC')}`;
  return `Pay ${amount} (asset ${plan.assetId}) to ${plan.payee.name}, ${when}. Confirm?`;
}
