// REST + SSE routes from core API_ROUTES. Requests are validated with the core zod DTOs.

import { MAX_AUDIO_BYTES, MAX_AUDIO_SECONDS, TranscribeError, type Transcriber } from 'ai';
import {
  API_ROUTES,
  type ApiError,
  type AppEvent,
  ChatRequest,
  type ChatResponse,
  type ChatStreamLine,
  ConfirmRequest,
  type CreateInvoiceResponse,
  CreateInvoiceTextRequest,
  type HealthResponse,
  IllegalTransition,
  type InvoiceDetailResponse,
  type InvoiceListResponse,
  InvoiceStateSchema,
  type InvoiceSummaryDto,
  isWalletError,
  type LightningStatusResponse,
  type LlmInfo,
  type ReceivesListResponse,
  RejectRequest,
  type ScheduleCancelResponse,
  type ScheduleListResponse,
  type TranscribeResponse,
  type TransferDto,
  type TransferInfo,
  type TransfersResponse,
  type TreasurerAgent,
  type WalletErrorCode,
  type WalletPort,
  WalletReceiveRequest,
  type WalletReceiveResponse,
  type WalletResponse,
} from 'core';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { ZodError } from 'zod';
import {
  FiscalQuery,
  type HealthOnboardingFields,
  type LabelsListResponse,
  LabelsPutRequest,
  M3_ROUTES,
  ScheduleListQuery,
} from './api-local.js';
import type { WalletFiscalService } from './fiscal.js';
import type { SqliteJobStore } from './jobs.js';
import { PAYEE_PREFIX, payeeTarget, type SqliteLabelStore } from './labels.js';
import { healthHints, type WalletHolder } from './onboarding.js';
import { ApiFailure, invalidTransition, type Orchestrator } from './orchestrator.js';
import type { SqliteReceiveStore } from './receives.js';
import { streamGlobalEvents, streamInvoiceEvents } from './sse.js';
import type { InvoiceStore, StoredInvoice } from './store.js';
import { checkUpload, tooLarge } from './uploads.js';

export interface RouteDeps {
  store: InvoiceStore;
  orchestrator: Orchestrator;
  wallet: WalletPort;
  treasurer: TreasurerAgent;
  labels: SqliteLabelStore;
  jobs: SqliteJobStore;
  receives: SqliteReceiveStore;
  fiscal: WalletFiscalService;
  llmInfo: () => LlmInfo & { warmUpMs?: number };
  /** Onboarding state (needs_setup / locked / ready) for /api/health. */
  holder: WalletHolder;
  walletBackend: WalletResponse['backend'];
  /** Spend limits from the config (PAYMENT_CAP, DAILY_CAP, ASSET_ALLOWLIST), shown on the Wallet page. */
  limits?: { paymentCap: string; dailyCap?: string; assetAllowlist: string[] };
  network: WalletResponse['network'];
  problems: () => string[];
  /** Largest accepted upload in MB. */
  uploadMaxMb: number;
  /** Background sync state (nulls on the mock wallet). */
  walletSync: () => WalletSyncState;
  /** B's on-device speech-to-text (Parakeet); the text only fills the chat box. */
  transcriber?: Transcriber;
}

/** Wallet errors caused by the request (400); the rest are the wallet's own failures (502). */
const WALLET_CLIENT_ERRORS: ReadonlySet<string> = new Set(['UnknownAsset', 'InvalidInvoice', 'InvoiceExpired']);

/** Wallet errors with their own HTTP status: a locked wallet needs the passphrase; the network may be down. */
const WALLET_STATUS: Partial<Record<WalletErrorCode, number>> = { WalletLocked: 401, NetworkUnavailable: 503 };

/** Plain words for wallet errors whose native message is technical (e.g. rgb-lib JSONConversion). */
const WALLET_MESSAGES: Partial<Record<WalletErrorCode, string>> = {
  TransferFailed: 'The wallet could not complete this operation. Please try again in a moment.',
  NoUtxo: 'The wallet has no free coins to use for RGB right now. Wait for the next block and try again.',
  SubmitTimeout: 'The wallet did not answer in time. Check the transfers list before trying again.',
};

/** Server-side route (not in core API_ROUTES yet). */
export const GLOBAL_EVENTS_ROUTE = 'GET /api/events';

export interface WalletSyncState {
  lastSyncAt: string | null;
  lastError: string | null;
}

/** /api/health body: the core DTO plus the wallet sync state and onboarding fields (not in HealthResponse yet: core gap). */
export type HealthBody = HealthResponse & { walletSync: WalletSyncState } & HealthOnboardingFields;

/** BTC balance in sats when the backend exposes one (WdkRgbWallet.btcBalance(); not part of WalletPort). */
function btcBalanceSats(wallet: WalletPort): string | undefined {
  const w = wallet as { btcBalance?: () => { vanilla?: { spendable?: number } } };
  try {
    const sats = w.btcBalance?.().vanilla?.spendable;
    return typeof sats === 'number' && Number.isSafeInteger(sats) && sats >= 0 ? String(sats) : undefined;
  } catch {
    return undefined;
  }
}

function isTooLarge(err: unknown): boolean {
  const e = err as { statusCode?: number; code?: string };
  return e.statusCode === 413 || e.code === 'FST_REQ_FILE_TOO_LARGE' || e.code === 'FST_ERR_CTP_BODY_TOO_LARGE';
}

type Method = 'GET' | 'POST' | 'PUT';
type Handler = (req: FastifyRequest, reply: FastifyReply) => Promise<unknown> | unknown;

function route(app: FastifyInstance, spec: string, handler: Handler): void {
  const [method, url] = spec.split(' ') as [Method, string];
  app.route({ method, url, handler });
}

const url = (spec: string): string => spec.split(' ')[1] as string;

function apiError(code: string, message: string): ApiError {
  return { error: { code, message } };
}

function idParam(req: FastifyRequest): string {
  return (req.params as { id: string }).id;
}

export function toSummary(inv: StoredInvoice): InvoiceSummaryDto {
  const ex = inv.report?.extraction;
  return {
    id: inv.id,
    filename: inv.filename,
    kind: inv.kind,
    state: inv.state,
    createdAt: inv.createdAt,
    updatedAt: inv.updatedAt,
    ...(inv.report ? { verdict: inv.report.verdict } : {}),
    ...(ex?.issuer.name ? { issuerName: ex.issuer.name } : {}),
    ...(ex?.total ? { total: ex.total } : {}),
    ...(ex?.currency ? { currency: ex.currency } : {}),
  };
}

function toTransferDto(t: TransferInfo, invoiceId: string | undefined, labels: string[]): TransferDto {
  return {
    transferId: t.transferId,
    assetId: t.assetId ?? '',
    amount: t.amount,
    direction: t.direction === 'outgoing' ? 'out' : 'in',
    status: t.status,
    labels,
    createdAt: t.createdAt,
    updatedAt: t.updatedAt,
    ...(t.txid ? { txid: t.txid } : {}),
    ...(t.paymentHash ? { paymentHash: t.paymentHash } : {}),
    ...(invoiceId ? { invoiceId } : {}),
  };
}

export function registerRoutes(app: FastifyInstance, deps: RouteDeps): void {
  const { store, orchestrator, wallet, treasurer } = deps;

  app.setErrorHandler((err, req, reply) => {
    if (err instanceof ApiFailure) return reply.status(err.status).send(apiError(err.code, err.message));
    if (err instanceof TranscribeError) return reply.status(err.status).send(apiError(err.code, err.message));
    if (isTooLarge(err) && req.url.startsWith(url(API_ROUTES.agentTranscribe))) {
      return reply
        .status(413)
        .send(apiError('AUDIO_TOO_LONG', `The recording is too long. Keep it under ${MAX_AUDIO_SECONDS} seconds.`));
    }
    if (err instanceof IllegalTransition) {
      const f = invalidTransition(err.from, err.to);
      return reply.status(f.status).send(apiError(f.code, f.message));
    }
    if (err instanceof ZodError) {
      const first = err.issues[0];
      const where = first?.path.length ? ` (${first.path.join('.')})` : '';
      return reply.status(400).send(apiError('VALIDATION', `The request is not valid${where}: ${first?.message}`));
    }
    if (isWalletError(err)) {
      app.log.warn({ err }, 'Wallet operation failed');
      const status = WALLET_STATUS[err.code] ?? (WALLET_CLIENT_ERRORS.has(err.code) ? 400 : 502);
      return reply.status(status).send(apiError(err.code, WALLET_MESSAGES[err.code] ?? err.message));
    }
    if (isTooLarge(err)) {
      const f = tooLarge(deps.uploadMaxMb);
      return reply.status(f.status).send(apiError(f.code, f.message));
    }
    const e = err as { statusCode?: number; code?: string; message?: string };
    if (e.statusCode && e.statusCode >= 400 && e.statusCode < 500) {
      return reply.status(e.statusCode).send(apiError(e.code ?? 'BAD_REQUEST', e.message ?? 'Bad request.'));
    }
    app.log.error(err);
    return reply.status(500).send(apiError('INTERNAL', 'Something went wrong on our side. Please try again.'));
  });

  app.setNotFoundHandler((_req, reply) => reply.status(404).send(apiError('NOT_FOUND', 'This page does not exist.')));

  route(app, API_ROUTES.health, async (): Promise<HealthBody> => {
    const llm = deps.llmInfo();
    return {
      ok: llm.state !== 'error',
      time: new Date().toISOString(),
      llm: {
        provider: llm.provider,
        model: llm.model,
        state: llm.state,
        onDevice: llm.onDevice,
        ...(llm.warmUpMs !== undefined ? { warmUpMs: llm.warmUpMs } : {}),
      },
      // blockHeight: WalletPort exposes no chain tip yet (core gap), so it is omitted.
      wallet: { backend: deps.walletBackend, network: deps.network, ready: deps.holder.state === 'ready' },
      walletSync: deps.walletSync(),
      problems: deps.problems(),
      onboarding: deps.holder.state,
      network: deps.holder.opts.network,
      hints: await healthHints(deps.holder, () => btcBalanceSats(wallet)),
    };
  });

  route(app, API_ROUTES.createInvoice, async (req, reply): Promise<CreateInvoiceResponse> => {
    let created: StoredInvoice;
    if (req.isMultipart()) {
      const file = await req.file();
      if (!file) throw new ApiFailure(400, 'NO_FILE', 'Please choose an invoice file to upload (field "file").');
      let data: Buffer;
      try {
        data = await file.toBuffer();
      } catch (err) {
        if (isTooLarge(err)) throw tooLarge(deps.uploadMaxMb);
        throw err;
      }
      if (data.length === 0) throw new ApiFailure(400, 'EMPTY_FILE', 'The uploaded file is empty.');
      const filename = file.filename || 'invoice';
      const kind = checkUpload(filename, data);
      created = await orchestrator.createInvoice({ filename, mimeType: file.mimetype, data, kind });
    } else {
      const body = CreateInvoiceTextRequest.parse(req.body);
      created = await orchestrator.createInvoice({
        filename: body.filename ?? 'pasted-invoice.txt',
        mimeType: 'text/plain',
        data: Buffer.from(body.text, 'utf8'),
      });
    }
    reply.status(201);
    return { invoiceId: created.id, state: created.state };
  });

  // Optional ?state=EXECUTING (comma-separated) filter, e.g. to find payments waiting for a wallet sync.
  route(app, API_ROUTES.listInvoices, async (req): Promise<InvoiceListResponse> => {
    const raw = (req.query as { state?: string } | undefined)?.state;
    const states = raw ? raw.split(',').map((s) => InvoiceStateSchema.parse(s.trim().toUpperCase())) : [];
    return { invoices: store.list({ states }).map(toSummary) };
  });

  route(app, API_ROUTES.getInvoice, async (req): Promise<InvoiceDetailResponse> => {
    const inv = store.get(idParam(req));
    if (!inv) throw new ApiFailure(404, 'NOT_FOUND', 'We could not find this invoice.');
    return {
      invoice: toSummary(inv),
      events: store.eventsOf(inv.id),
      ...(inv.report ? { report: inv.report } : {}),
      ...(inv.plan ? { plan: inv.plan } : {}),
      ...(inv.confirmationSentence ? { confirmationSentence: inv.confirmationSentence } : {}),
      ...(inv.result ? { execution: inv.result } : {}),
    };
  });

  route(app, API_ROUTES.invoiceEvents, async (req, reply) => {
    const id = idParam(req);
    if (!store.get(id)) throw new ApiFailure(404, 'NOT_FOUND', 'We could not find this invoice.');
    streamInvoiceEvents(store, id, req, reply);
  });

  route(app, API_ROUTES.confirmInvoice, async (req) =>
    orchestrator.confirm(idParam(req), ConfirmRequest.parse(req.body ?? {})),
  );

  route(app, API_ROUTES.rejectInvoice, async (req) =>
    orchestrator.reject(idParam(req), RejectRequest.parse(req.body ?? {})),
  );

  route(app, API_ROUTES.wallet, async (): Promise<WalletResponse> => {
    const [assets, address, transfers] = await Promise.all([
      wallet.listAssets(),
      wallet.receiveAddress(),
      deps.limits ? wallet.listTransfers().catch(() => []) : Promise.resolve([]),
    ]);
    const sats = btcBalanceSats(wallet);
    // Same rolling-24 h sum the PaymentGuard checks (outgoing, not failed), per asset; local reads only.
    const since = Date.now() - 86_400_000;
    const spent = new Map<string, bigint>();
    for (const t of transfers) {
      if (t.direction !== 'outgoing' || t.status === 'Failed' || !t.assetId || Date.parse(t.createdAt) < since)
        continue;
      spent.set(t.assetId, (spent.get(t.assetId) ?? 0n) + BigInt(t.amount));
    }
    return {
      backend: deps.walletBackend,
      network: deps.network,
      ready: true,
      address,
      ...(sats ? { btcBalanceSats: sats } : {}),
      assets: assets.map((a) => ({
        assetId: a.assetId,
        ticker: a.ticker,
        name: a.name,
        precision: a.precision,
        balance: a.balance,
      })),
      ...(deps.limits
        ? {
            spending: {
              paymentCap: deps.limits.paymentCap,
              ...(deps.limits.dailyCap ? { dailyCap: deps.limits.dailyCap } : {}),
              assetAllowlist: deps.limits.assetAllowlist,
              spentLast24h: [...spent].map(([assetId, amount]) => ({ assetId, amount: amount.toString() })),
              enforcedBy: deps.walletBackend === 'wdk-rgb' ? ('wdk-policy' as const) : ('guard' as const),
            },
          }
        : {}),
    };
  });

  route(app, API_ROUTES.walletReceive, async (req): Promise<WalletReceiveResponse> => {
    const body = WalletReceiveRequest.parse(req.body ?? {});
    const inv = await wallet.createReceiveInvoice({
      // Default 24 h; no assetId by default, so the payer chooses the asset (amount optional too).
      expirySec: (body.expiryMinutes ?? 24 * 60) * 60,
      ...(body.assetId ? { assetId: body.assetId } : {}),
      ...(body.amount ? { amount: body.amount } : {}),
    });
    // Remembered so the app can tell when it is paid (matched after each wallet sync).
    deps.receives.add(inv, body.note);
    return {
      rgbInvoice: inv.rgbInvoice,
      expiresAt: inv.expiresAt,
      ...(inv.assetId ? { assetId: inv.assetId } : {}),
      ...(inv.amount ? { amount: inv.amount } : {}),
    };
  });

  // Invoices handed out to get paid, newest first: waiting → incoming → received (or expired / failed).
  // Voice: raw audio (audio/wav from the browser) → text for the chat box. Never executes anything by itself.
  app.addContentTypeParser(/^audio\//, { parseAs: 'buffer', bodyLimit: MAX_AUDIO_BYTES }, (_req, body, done) =>
    done(null, body),
  );
  route(app, API_ROUTES.agentTranscribe, async (req): Promise<TranscribeResponse> => {
    if (!deps.transcriber)
      throw new ApiFailure(503, 'STT_UNAVAILABLE', 'Voice input is not available on this computer.');
    if (!Buffer.isBuffer(req.body) || req.body.length === 0) {
      throw new ApiFailure(
        400,
        'AUDIO_EMPTY',
        'No recording arrived. Hold the button while you speak, then try again.',
      );
    }
    return deps.transcriber.transcribe(req.body, req.headers['content-type']);
  });

  route(app, API_ROUTES.walletReceives, async (): Promise<ReceivesListResponse> => {
    deps.receives.reconcile(await wallet.listTransfers());
    return { receives: deps.receives.list() };
  });

  // Lightning node and channels (Wallet page panel); off when the backend has no Lightning rail.
  route(
    app,
    API_ROUTES.walletLightning,
    async (): Promise<LightningStatusResponse> =>
      wallet.lightningStatus ? wallet.lightningStatus() : { enabled: false, channels: [] },
  );

  route(app, API_ROUTES.transfers, async (): Promise<TransfersResponse> => {
    const transfers = await wallet.listTransfers();
    const labels = await deps.labels.effectiveLabelsMap(transfers.map((t) => t.transferId));
    return {
      transfers: transfers
        .map((t) => toTransferDto(t, store.invoiceForTransfer(t.transferId), labels.get(t.transferId) ?? []))
        .sort((a, b) => b.createdAt.localeCompare(a.createdAt)),
    };
  });

  // Global SSE stream: `transfer` status changes for transfers not linked to an invoice (invoice-linked ones go on
  // /api/invoices/:id/events). Not in core API_ROUTES yet (core gap).
  route(app, GLOBAL_EVENTS_ROUTE, async (req, reply) => {
    streamGlobalEvents(store, req, reply);
  });

  route(app, API_ROUTES.agentChat, async (req): Promise<ChatResponse> => {
    const body = ChatRequest.parse(req.body);
    const emit = (event: AppEvent) => store.appendEvent(event);
    return treasurer.chat(body.message, body.history ?? [], emit);
  });

  // The same chat, streamed: one JSON line per event (reply text as the model writes it, then the full reply).
  // Tokens go only to this response, never into the event store.
  route(app, API_ROUTES.agentChatStream, async (req, reply) => {
    const body = ChatRequest.parse(req.body);
    reply.hijack();
    const res = reply.raw;
    res.writeHead(200, {
      'content-type': 'application/x-ndjson; charset=utf-8',
      'cache-control': 'no-cache',
      'x-accel-buffering': 'no',
    });
    const line = (l: ChatStreamLine) => {
      if (!res.writableEnded) res.write(`${JSON.stringify(l)}\n`);
    };
    try {
      const out = await treasurer.chat(body.message, body.history ?? [], (e) => store.appendEvent(e), {
        onToken: (text) => line({ t: 'token', text }),
        onReset: () => line({ t: 'reset' }),
      });
      line({ t: 'reply', reply: out });
    } catch (err) {
      line({
        t: 'error',
        code: 'CHAT_FAILED',
        message: err instanceof Error ? err.message : 'The Treasurer did not answer. Try again in a minute.',
      });
    } finally {
      res.end();
    }
  });

  route(app, M3_ROUTES.scheduleList, async (req): Promise<ScheduleListResponse> => {
    const q = ScheduleListQuery.parse(req.query ?? {});
    return { jobs: await deps.jobs.list(q.status ? { status: q.status } : {}) };
  });

  // Cancels a pending job; its SCHEDULED invoice is rejected so it does not stay "scheduled" forever.
  route(app, M3_ROUTES.scheduleCancel, async (req): Promise<ScheduleCancelResponse> => {
    const { jobId } = req.params as { jobId: string };
    const job = await deps.jobs.get(jobId);
    if (!job) throw new ApiFailure(404, 'NOT_FOUND', 'We could not find this scheduled payment.');
    if (!(await deps.jobs.cancel(jobId))) {
      throw new ApiFailure(
        409,
        'JOB_NOT_PENDING',
        `This scheduled payment cannot be cancelled any more (it is ${job.status}).`,
      );
    }
    if (store.get(job.invoiceId)?.state === 'SCHEDULED') orchestrator.reject(job.invoiceId, {});
    return { ok: true };
  });

  route(app, M3_ROUTES.labelsList, async (): Promise<LabelsListResponse> => ({ labels: await deps.labels.list() }));

  route(app, M3_ROUTES.labelsPutPayee, async (req) => {
    const name = ((req.params as { name: string }).name ?? '').trim();
    if (!name || name.length > 200) throw new ApiFailure(400, 'VALIDATION', 'Please give the payee name.');
    const body = LabelsPutRequest.parse(req.body ?? {});
    return deps.labels.set(payeeTarget(name), body.labels, body.note);
  });

  // Target = a transferId, an invoiceId (unpaid invoices) or `payee:<name>`.
  route(app, M3_ROUTES.labelsPut, async (req) => {
    const target = ((req.params as { transferId: string }).transferId ?? '').trim();
    if (!target || target.length > 200 || target === PAYEE_PREFIX) {
      throw new ApiFailure(400, 'VALIDATION', 'Please say which payment the labels are for.');
    }
    const body = LabelsPutRequest.parse(req.body ?? {});
    return deps.labels.set(target, body.labels, body.note);
  });

  const fiscalDownload: Handler = async (req, reply) => {
    const q = FiscalQuery.parse(req.query ?? {});
    const report = await deps.fiscal.report(q.from, q.to, q.format, { includeFailed: q.includeFailed === 'true' });
    reply
      .header('content-type', q.format === 'csv' ? 'text/csv; charset=utf-8' : 'application/json; charset=utf-8')
      .header('content-disposition', `attachment; filename="${report.filename}"`);
    return report.content;
  };
  route(app, M3_ROUTES.fiscal, fiscalDownload);
  route(app, M3_ROUTES.fiscalAlias, fiscalDownload);
}
