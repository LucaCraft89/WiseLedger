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

// POST /api/invoices/:id/amount — open-amount payment request: the user types the amount before confirming.
// Validated by the server (> 0, ≤ payment cap, ≤ spendable); returns the plan and sentence to confirm.
export const SetAmountRequest = z.object({ amount: BaseUnits });
export type SetAmountRequest = z.infer<typeof SetAmountRequest>;
export const SetAmountResponse = z.object({
  invoiceId: z.string(),
  plan: PaymentPlanDto,
  confirmationSentence: z.string(),
});
export type SetAmountResponse = z.infer<typeof SetAmountResponse>;

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
  /** The spending rules every payment must pass (WDK policy engine on the real wallet, PaymentGuard everywhere). */
  spending: z
    .object({
      /** Max per payment, base units. */
      paymentCap: BaseUnits,
      /** Max per asset in any 24 h, base units. */
      dailyCap: BaseUnits.optional(),
      /** Approved asset IDs; empty = any asset. */
      assetAllowlist: z.array(z.string()),
      /** Sent (not failed) in the last 24 h, per asset, base units. */
      spentLast24h: z.array(z.object({ assetId: z.string(), amount: BaseUnits })),
      /** 'wdk-policy' when the Tether WDK policy engine also enforces the rules on the wallet itself. */
      enforcedBy: z.enum(['wdk-policy', 'guard']),
    })
    .optional(),
});
export type WalletResponse = z.infer<typeof WalletResponse>;

// GET /api/wallet/btc: on-chain Bitcoin (sats) movements of the wallet, newest first. Sats pay network fees and
// carry the RGB tokens; they are not the TUSDT balance.
export const BtcTransactionDto = z.object({
  txid: z.string(),
  /** received = test bitcoin came in; sent = test bitcoin went out to someone else; internal = only the fee left. */
  direction: z.enum(['received', 'sent', 'internal']),
  /** Why the wallet made it: a token payment, preparing coins for tokens, emptying the wallet, or a plain send. */
  purpose: z.enum(['token_payment', 'utxo_setup', 'drain', 'bitcoin']),
  /** Sats that moved to or from the wallet, fee excluded. Decimal string. */
  amountSats: BaseUnits,
  /** Network fee in sats. Decimal string; "0" when the wallet did not pay it. */
  feeSats: BaseUnits,
  confirmed: z.boolean(),
  /** Absent while unconfirmed. */
  createdAt: IsoDateTime.optional(),
});
export type BtcTransactionDto = z.infer<typeof BtcTransactionDto>;

export const BtcTransactionsResponse = z.object({ transactions: z.array(BtcTransactionDto) });
export type BtcTransactionsResponse = z.infer<typeof BtcTransactionsResponse>;

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
  /** Who should pay or what for ("Acme, refund October"); shown in the payment request list (M4). */
  note: z.string().trim().max(120).optional(),
  /** Who pays you ("Acme Srl"); `note` is then filled as "payer · purpose" for older readers. */
  payer: z.string().trim().max(80).optional(),
  /** What it is for ("October hosting"). */
  purpose: z.string().trim().max(120).optional(),
  /** How long the request stays valid, in seconds (1 h … 30 days; outside → 400). Wins over expiryMinutes. */
  expirySec: z.number().int().positive().optional(),
  /** Valid until this ISO time (1 h … 30 days from now; outside → 400). Use either this or expirySec. */
  validUntil: IsoDateTime.optional(),
  /** Where the request is made (default form; the web's invoice PDF says invoice_pdf). */
  madeIn: z.enum(['form', 'invoice_pdf']).optional(),
});
export type WalletReceiveRequest = z.infer<typeof WalletReceiveRequest>;

export const WalletReceiveResponse = z.object({
  rgbInvoice: z.string(),
  expiresAt: IsoDateTime,
  assetId: z.string().optional(),
  amount: BaseUnits.optional(),
  /** The stored request (open it again under Wallet › Get paid, #/wallet/get-paid/<receiveId>). */
  receiveId: z.string().optional(),
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
  /** Lightning payments: no txid, the payment hash identifies the payment. */
  paymentHash: z.string().optional(),
  explorerUrl: z.string().optional(),
  invoiceId: z.string().optional(),
  labels: z.array(z.string()),
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime.optional(),
});
export type TransferDto = z.infer<typeof TransferDto>;

export const TransfersResponse = z.object({ transfers: z.array(TransferDto) });
export type TransfersResponse = z.infer<typeof TransfersResponse>;

// GET /api/transfers/:id — one transfer with everything the "How this was settled" card shows, in one call.
export const TransferDetailResponse = z.object({
  transfer: TransferDto.extend({
    /** wallet.ts TransferInfo.direction (the DTO's in/out folds issuance into in). */
    kind: z.enum(['outgoing', 'incoming', 'issuance']),
    rail: z.enum(['onchain', 'lightning']),
    sealType: z.enum(['blinded', 'witness']).optional(),
    recipientId: z.string().optional(),
    transportEndpoints: z.array(z.string()).optional(),
    expiresAt: IsoDateTime.optional(),
    settledAt: IsoDateTime.optional(),
  }),
  asset: z
    .object({
      assetId: z.string(),
      ticker: z.string(),
      name: z.string(),
      precision: z.number().int(),
      schema: z.literal('NIA'),
    })
    .optional(),
  /** When each status was first seen (server events; WaitingCounterparty = created, Settled = rgb-lib settle time). */
  statusTimes: z.partialRecord(TransferStatusSchema, IsoDateTime),
  invoice: z
    .object({
      invoiceId: z.string(),
      filename: z.string(),
      issuerName: z.string().optional(),
      invoiceNumber: z.string().optional(),
    })
    .optional(),
  /** Lightning only: the channel the payment used (from the node's channels for this asset). */
  lightning: z
    .object({ paymentHash: z.string(), channelId: z.string().optional(), peer: z.string().optional() })
    .optional(),
});
export type TransferDetailResponse = z.infer<typeof TransferDetailResponse>;

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

/** One line of the chat stream (newline-delimited JSON). */
export const ChatStreamLine = z.discriminatedUnion('t', [
  z.object({ t: z.literal('token'), text: z.string() }),
  /** The model starts a new turn (after a tool call): drop the live text shown so far. */
  z.object({ t: z.literal('reset') }),
  z.object({ t: z.literal('reply'), reply: ChatResponse }),
  z.object({ t: z.literal('error'), code: z.string(), message: z.string() }),
]);
export type ChatStreamLine = z.infer<typeof ChatStreamLine>;
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
    /** Time the model took to load, once warm (optional, M3). */
    warmUpMs: z.number().optional(),
  }),
  wallet: z.object({
    backend: z.enum(['mock', 'wdk-rgb', 'rgb-lib']),
    network: z.enum(['mutinynet', 'regtest', 'mock']),
    ready: z.boolean(),
    blockHeight: z.number().int().optional(),
  }),
  /** Plain-language problems found at startup ("No TUSDT yet: run pnpm demo:prepare"). */
  problems: z.array(z.string()),
  // M3 additions, optional so an older server still parses.
  /** First-run state of the wallet (see GET /api/onboarding). */
  onboarding: z.enum(['needs_setup', 'locked', 'ready']).optional(),
  network: z.enum(['mutinynet', 'regtest', 'mock']).optional(),
  /** Getting-started hints in plain words (faucet, issue the test asset, regtest mining). */
  hints: z.array(z.string()).optional(),
});
export type HealthResponse = z.infer<typeof HealthResponse>;

// First run (M3). While not `ready`, wallet routes answer 409 WALLET_NOT_READY.
export const OnboardingState = z.enum(['needs_setup', 'locked', 'ready']);
export type OnboardingState = z.infer<typeof OnboardingState>;

// GET /api/onboarding
export const OnboardingStatusResponse = z.object({
  state: OnboardingState,
  /** True once the recovery words were shown to the user. */
  seedShown: z.boolean(),
  network: z.enum(['mutinynet', 'regtest', 'mock']),
  walletBackend: z.string(),
  /** Minimum passphrase length (an empty passphrase means none). */
  minPassphrase: z.number().int().min(0),
});
export type OnboardingStatusResponse = z.infer<typeof OnboardingStatusResponse>;

// POST /api/onboarding/create → 201; the words are returned ONCE (409 ALREADY_SET_UP afterwards).
export const OnboardingCreateRequest = z.object({ passphrase: z.string().optional() });
export type OnboardingCreateRequest = z.infer<typeof OnboardingCreateRequest>;
export const OnboardingCreateResponse = z.object({ mnemonic: z.string(), words: z.array(z.string()) });
export type OnboardingCreateResponse = z.infer<typeof OnboardingCreateResponse>;

// POST /api/onboarding/seed-confirmed
export const OnboardingSeedConfirmedRequest = z.object({ confirmed: z.literal(true) });
export type OnboardingSeedConfirmedRequest = z.infer<typeof OnboardingSeedConfirmedRequest>;
export const OnboardingOkResponse = z.object({ ok: z.boolean() });
export type OnboardingOkResponse = z.infer<typeof OnboardingOkResponse>;

// POST /api/onboarding/restore · 400 INVALID_MNEMONIC
export const OnboardingRestoreRequest = z.object({ mnemonic: z.string().min(1), passphrase: z.string().optional() });
export type OnboardingRestoreRequest = z.infer<typeof OnboardingRestoreRequest>;
export const OnboardingRestoreResponse = z.object({ ok: z.boolean(), note: z.string().optional() });
export type OnboardingRestoreResponse = z.infer<typeof OnboardingRestoreResponse>;

// POST /api/onboarding/unlock · 401 WalletLocked (wrong passphrase) · 429 after 5 tries
export const OnboardingUnlockRequest = z.object({ passphrase: z.string() });
export type OnboardingUnlockRequest = z.infer<typeof OnboardingUnlockRequest>;

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

/** The product's one character: the owl. Every screen and prompt takes the name from here. */
export const OWL_NAME = 'Wise';
/** What the owl is doing, shown as a status chip next to the existing owl image (never a new drawing). */
export const OwlMood = z.enum(['reading', 'thinking', 'all_good', 'stopped', 'waiting_bitcoin', 'paid']);
export type OwlMood = z.infer<typeof OwlMood>;

/** Route table, for clients and docs. */
// GET /api/wallet/receives (M4): payment requests handed out, newest first, with their incoming transfer.
export const ReceiveStatus = z.enum(['waiting', 'incoming', 'received', 'expired', 'failed', 'cancelled']);
export type ReceiveStatus = z.infer<typeof ReceiveStatus>;
export const ReceiveRequestDto = z.object({
  receiveId: z.string(),
  rgbInvoice: z.string(),
  recipientId: z.string(),
  assetId: z.string().optional(),
  amount: BaseUnits.optional(),
  note: z.string().optional(),
  status: ReceiveStatus,
  transferId: z.string().optional(),
  txid: z.string().optional(),
  receivedAmount: BaseUnits.optional(),
  createdAt: z.string(),
  expiresAt: z.string(),
  updatedAt: z.string(),
  /** Set when the user cancelled it; with status `received` the money arrived after the cancel. */
  cancelledAt: z.string().optional(),
  /** Set when the user archived it (it then lists under "Older requests"). */
  archivedAt: z.string().optional(),
  /** True when it lists under "Older requests" (archived, closed > 24 h ago, or received > 7 days ago). */
  older: z.boolean().optional(),
  /** Who pays (Get paid form "Who pays you?"). */
  payer: z.string().optional(),
  /** What it is for. */
  purpose: z.string().optional(),
  /** Where it was made: the Get paid form, the chat, or an invoice PDF. Absent on requests made before M5. */
  madeIn: z.enum(['form', 'chat', 'invoice_pdf']).optional(),
});
export type ReceiveRequestDto = z.infer<typeof ReceiveRequestDto>;

/** Filter groups for GET /api/wallet/receives?status=: open = waiting + incoming, paid = received, closed = the rest. */
export const ReceiveFilter = z.enum(['open', 'paid', 'closed', 'all']);
export type ReceiveFilter = z.infer<typeof ReceiveFilter>;
// GET /api/wallet/receives?status=&archived=&limit=&before= — newest first, cursor = createdAt of the last row.
export const ReceivesListQuery = z.object({
  status: ReceiveFilter.optional(),
  /** "1" = only "Older requests", "0" (default) = the main list. */
  archived: z.enum(['0', '1']).optional(),
  /** Default 20, max 100. */
  limit: z.coerce.number().int().min(1).max(100).optional(),
  before: z.string().optional(),
});
export type ReceivesListQuery = z.infer<typeof ReceivesListQuery>;
export const ReceivesListResponse = z.object({
  receives: z.array(ReceiveRequestDto),
  /** Present when there are more rows: pass it as `before` for the next page. */
  nextBefore: z.string().optional(),
});
export type ReceivesListResponse = z.infer<typeof ReceivesListResponse>;

// POST /api/agent/transcribe: body = raw audio bytes (Content-Type audio/wav, 16 kHz mono preferred), max 2 MB / 30 s.
// The text only fills the chat box; the user edits and sends it through POST /api/agent/chat.
export const TranscribeResponse = z.object({ text: z.string(), ms: z.number().int().nonnegative() });
export type TranscribeResponse = z.infer<typeof TranscribeResponse>;

// GET /api/wallet/lightning — mirrors WalletPort.lightningStatus(); `enabled: false` when Lightning is off.
export const LightningChannelDto = z.object({
  channelId: z.string(),
  peer: z.string(),
  assetId: z.string().optional(),
  /** Asset we can send over this channel, base units. */
  localAsset: BaseUnits,
  /** Asset we can receive over this channel, base units. */
  remoteAsset: BaseUnits,
  usable: z.boolean(),
});
export type LightningChannelDto = z.infer<typeof LightningChannelDto>;
export const LightningStatusResponse = z.object({
  enabled: z.boolean(),
  nodePubkey: z.string().optional(),
  channels: z.array(LightningChannelDto),
  /** Plain words when enabled but not working ("No channel yet: requested from the LSP"). */
  problem: z.string().optional(),
});
export type LightningStatusResponse = z.infer<typeof LightningStatusResponse>;

// GET /api/desk — the Money Desk home in one call. Built by code from local state only (store, payment requests,
// scheduled jobs, the wallet's last synced state, /api/health problems): no model call, no wallet sync awaited.
export const DeskNeedsKind = z.enum([
  'awaiting_confirmation',
  'review_verdict',
  'due_soon',
  'scheduled_today',
  'request_expiring',
  'low_fee_balance',
  'health_problem',
  /** No Bitcoin for fees at all (below the cost of one RGB send): listed first. */
  'no_fee_money',
]);
export type DeskNeedsKind = z.infer<typeof DeskNeedsKind>;
export const DeskLatelyKind = z.enum(['paid', 'received', 'blocked', 'scheduled', 'checked']);
export type DeskLatelyKind = z.infer<typeof DeskLatelyKind>;
/** The one next step for an item: a button label and the app page it opens ("#/invoice/<id>"). */
export const DeskAction = z.object({ label: z.string(), href: z.string() });
export type DeskAction = z.infer<typeof DeskAction>;
export const DeskNeedsItem = z.object({
  kind: DeskNeedsKind,
  /** Stable per item (invoice, receive or job id; "health-<n>", "fee-balance"). */
  id: z.string(),
  /** Plain text built by code; supplier names are cleaned and instruction-like names hidden. */
  title: z.string(),
  /** When it is due, expires or runs. */
  dueAt: IsoDateTime.optional(),
  action: DeskAction,
  /** Base units the item is about (invoice amount, request amount). */
  amount: BaseUnits.optional(),
  assetId: z.string().optional(),
  /** ok = nothing wrong, review = read the warnings, block = something stops you. */
  tone: z.enum(['ok', 'review', 'block']).optional(),
  /** Same as action.label (kept separate for the card button). */
  actionLabel: z.string().optional(),
});
export type DeskNeedsItem = z.infer<typeof DeskNeedsItem>;
export const DeskLatelyItem = z.object({
  kind: DeskLatelyKind,
  id: z.string(),
  title: z.string(),
  amount: BaseUnits.optional(),
  assetId: z.string().optional(),
  at: IsoDateTime,
  /** Money in, out, or none (a stopped or checked invoice moved nothing). */
  direction: z.enum(['in', 'out', 'none']).optional(),
  stamp: z.enum(['PAID', 'STOPPED', 'CHECKED', 'SCHEDULED', 'RECEIVED']).optional(),
});
export type DeskLatelyItem = z.infer<typeof DeskLatelyItem>;
export const DeskResponse = z.object({
  greetingCounts: z.object({
    /** All items that need the user (needsYou shows at most 5). */
    needsYou: z.number().int().nonnegative(),
    /** Unpaid invoices due in the next 7 days (or overdue). */
    dueThisWeek: z.number().int().nonnegative(),
    /** Scheduled payments still to run. */
    scheduled: z.number().int().nonnegative(),
    /** Open payment requests (waiting or incoming). */
    waitingToBePaid: z.number().int().nonnegative(),
  }),
  balances: z.array(
    z.object({ assetId: z.string(), ticker: z.string(), spendable: BaseUnits, precision: z.number().int().min(0) }),
  ),
  /** Spendable test sats for network fees; absent when the wallet does not expose them (mock, not ready). */
  feeSats: BaseUnits.optional(),
  /** Max 5, most urgent first. */
  needsYou: z.array(DeskNeedsItem).max(5),
  /** Max 5, newest first. */
  lately: z.array(DeskLatelyItem).max(5),
  /** The wallet state is the last background sync, not a live read: "Updated 12 s ago". */
  updated: z.object({
    at: IsoDateTime.optional(),
    secondsAgo: z.number().int().nonnegative().optional(),
    text: z.string(),
  }),
  /** busy = an analysis or payment is running now; attention = needsYou is not empty; quiet = nothing to do. */
  mood: z.enum(['busy', 'attention', 'quiet']).optional(),
  /** This calendar month (server local time). Invoices sent twice count once. */
  month: z
    .object({
      invoicesRead: z.number().int().nonnegative(),
      invoicesStopped: z.number().int().nonnegative(),
      /** Sum of the amounts of the stopped invoices, per asset (base units). */
      protectedAmount: z.array(z.object({ assetId: z.string(), amount: BaseUnits })),
      paymentsMade: z.number().int().nonnegative(),
      received: z.number().int().nonnegative(),
    })
    .optional(),
  /** Last successful wallet sync (same as updated.at); absent before the first sync. */
  syncedAt: IsoDateTime.optional(),
  /** True once the user went through "I saved my recovery words" in onboarding. */
  recoveryWordsSaved: z.boolean().optional(),
});
export type DeskResponse = z.infer<typeof DeskResponse>;

// GET /api/books?assetId=&limit=&before= — the asset's ledger with a running balance, newest first.
export const BooksQuery = z.object({
  /** Default: the one payment asset (first NIA asset held). */
  assetId: z.string().optional(),
  /** Default 20, max 100. */
  limit: z.coerce.number().int().min(1).max(100).optional(),
  /** `nextBefore` of the previous page. */
  before: z.string().optional(),
});
export type BooksQuery = z.infer<typeof BooksQuery>;
export const BookStamp = z.enum(['PAID', 'RECEIVED', 'ISSUED', 'PENDING', 'FAILED']);
export type BookStamp = z.infer<typeof BookStamp>;
export const BookRow = z.object({
  /** Settle time for settled rows, else the creation time. */
  at: IsoDateTime,
  kind: z.enum(['payment', 'receipt', 'issuance']),
  /** Plain text built by code ("Paid Acme Srl", "Received from Beta Spa · October hosting"). */
  title: z.string(),
  counterparty: z.string().optional(),
  in: BaseUnits.optional(),
  out: BaseUnits.optional(),
  /** Network fee in sats, when known. */
  fee: z.string().optional(),
  /** Settled balance after this row; null while pending or for a failed transfer. */
  balanceAfter: BaseUnits.nullable(),
  pending: z.boolean().optional(),
  transferId: z.string().optional(),
  invoiceId: z.string().optional(),
  receiveId: z.string().optional(),
  stamp: BookStamp,
  labels: z.array(z.string()),
});
export type BookRow = z.infer<typeof BookRow>;
export const BooksResponse = z.object({
  assetId: z.string().optional(),
  ticker: z.string().optional(),
  precision: z.number().int().min(0).optional(),
  /** wallet.assetBalance().settled; equals the newest settled row's balanceAfter. */
  settledBalance: BaseUnits,
  rows: z.array(BookRow),
  nextBefore: z.string().optional(),
});
export type BooksResponse = z.infer<typeof BooksResponse>;

// GET /api/receipts/:transferId — a settled payment (in or out) as a receipt; 404 for anything else.
export const ReceiptResponse = z.object({
  transferId: z.string(),
  direction: z.enum(['in', 'out']),
  payerName: z.string(),
  payeeName: z.string(),
  invoiceNumber: z.string().optional(),
  amount: BaseUnits,
  asset: z.object({ assetId: z.string(), ticker: z.string(), precision: z.number().int().min(0) }),
  rail: z.enum(['onchain', 'lightning']),
  txid: z.string().optional(),
  paymentHash: z.string().optional(),
  settledAt: IsoDateTime,
  planId: z.string().optional(),
  verdict: z.enum(['ok', 'review', 'block']).optional(),
  invoiceId: z.string().optional(),
  receiveId: z.string().optional(),
  labels: z.array(z.string()),
});
export type ReceiptResponse = z.infer<typeof ReceiptResponse>;

// GET /api/payees?q= — "Who pays you?" suggestions: payee book + earlier payers, max 8.
export const PayeesResponse = z.object({ names: z.array(z.string()).max(8) });
export type PayeesResponse = z.infer<typeof PayeesResponse>;

export const API_ROUTES = {
  desk: 'GET /api/desk',
  books: 'GET /api/books',
  receipt: 'GET /api/receipts/:transferId',
  payees: 'GET /api/payees',
  createInvoice: 'POST /api/invoices',
  listInvoices: 'GET /api/invoices',
  getInvoice: 'GET /api/invoices/:id',
  invoiceEvents: 'GET /api/invoices/:id/events',
  confirmInvoice: 'POST /api/invoices/:id/confirm',
  rejectInvoice: 'POST /api/invoices/:id/reject',
  setInvoiceAmount: 'POST /api/invoices/:id/amount',
  wallet: 'GET /api/wallet',
  walletReceive: 'POST /api/wallet/receive',
  walletReceives: 'GET /api/wallet/receives',
  walletReceiveGet: 'GET /api/wallet/receives/:receiveId',
  walletReceiveCancel: 'POST /api/wallet/receives/:receiveId/cancel',
  walletReceiveArchive: 'POST /api/wallet/receives/:receiveId/archive',
  walletLightning: 'GET /api/wallet/lightning',
  walletBtc: 'GET /api/wallet/btc',
  transfers: 'GET /api/transfers',
  transferDetail: 'GET /api/transfers/:id',
  agentChat: 'POST /api/agent/chat',
  /** Same body as agentChat; answers NDJSON ChatStreamLine lines (tokens as they come, then the reply). */
  agentChatStream: 'POST /api/agent/chat/stream',
  agentTranscribe: 'POST /api/agent/transcribe',
  scheduleList: 'GET /api/schedule',
  scheduleCancel: 'POST /api/schedule/:jobId/cancel',
  labelsPut: 'PUT /api/labels/:transferId',
  fiscal: 'GET /api/fiscal',
  health: 'GET /api/health',
  onboarding: 'GET /api/onboarding',
  onboardingCreate: 'POST /api/onboarding/create',
  onboardingSeedConfirmed: 'POST /api/onboarding/seed-confirmed',
  onboardingRestore: 'POST /api/onboarding/restore',
  onboardingUnlock: 'POST /api/onboarding/unlock',
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
 * RGB Lightning invoices are BOLT11 strings (lnbc mainnet, lntb testnet, lntbs signet, lnbcrt regtest; the mock
 * wallet uses lnrgb…), optionally behind "lightning:". On-chain RGB invoices start with "rgb:".
 */
export const LN_INVOICE_RE = /\b(?:lightning:)?(ln(?:bcrt|tbs|tb|bc|rgb)[^\s"'<>]{8,})/gi;
export function isLightningInvoice(invoice: string | undefined): boolean {
  return !!invoice && /^(?:lightning:)?ln(?:bcrt|tbs|tb|bc|rgb)[^\s"'<>]{8,}$/i.test(invoice.trim());
}

/**
 * The one sentence the user confirms, built by code from the plan (never by the LLM). Server and web both use this.
 * "Pay 25.00 TUSDT (asset rgb:…) to Acme Srl, now. Confirm?"; a Lightning invoice adds "via Lightning (instant)".
 */
export function buildConfirmationSentence(
  plan: Pick<PaymentPlan, 'amount' | 'assetId' | 'payee' | 'executeAt'> & { rgbInvoice?: string },
  asset: { ticker: string; precision: number } | undefined,
  /** IANA zone for the date (default: this machine's zone, so the user reads their own clock time). */
  timeZone?: string,
): string {
  const amount = asset
    ? `${formatAssetAmount(plan.amount, asset.precision)} ${asset.ticker}`
    : `${plan.amount} base units`;
  const when =
    plan.executeAt === 'now'
      ? 'now'
      : `on ${new Date(plan.executeAt).toLocaleString('en-GB', {
          weekday: 'short',
          day: 'numeric',
          month: 'short',
          year: 'numeric',
          hour: '2-digit',
          minute: '2-digit',
          timeZoneName: 'short',
          ...(timeZone ? { timeZone } : {}),
        })}`;
  const rail = isLightningInvoice(plan.rgbInvoice) ? ' via Lightning (instant)' : '';
  return `Pay ${amount} (asset ${plan.assetId}) to ${plan.payee.name}${rail}, ${when}. Confirm?`;
}
