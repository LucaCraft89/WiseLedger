// REST + SSE routes from core API_ROUTES. Requests are validated with the core zod DTOs.
import {
  API_ROUTES,
  type ApiError,
  type AppEvent,
  ChatRequest,
  type ChatResponse,
  ConfirmRequest,
  type CreateInvoiceResponse,
  CreateInvoiceTextRequest,
  type HealthResponse,
  type InvoiceDetailResponse,
  type InvoiceListResponse,
  type InvoiceSummaryDto,
  type LlmInfo,
  ReceiveRequest,
  type ReceiveResponse,
  RejectRequest,
  type TransferDto,
  type TransferInfo,
  type TransfersResponse,
  type TreasurerAgent,
  type WalletPort,
  type WalletResponse,
} from 'core';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { ZodError } from 'zod';
import { ApiFailure, type Orchestrator } from './orchestrator.js';
import { streamInvoiceEvents } from './sse.js';
import type { InvoiceStore, StoredInvoice } from './store.js';

export interface RouteDeps {
  store: InvoiceStore;
  orchestrator: Orchestrator;
  wallet: WalletPort;
  treasurer: TreasurerAgent;
  llmInfo: () => LlmInfo;
  walletBackend: WalletResponse['backend'];
  network: WalletResponse['network'];
  problems: () => string[];
}

type Method = 'GET' | 'POST';
type Handler = (req: FastifyRequest, reply: FastifyReply) => Promise<unknown> | unknown;

function route(app: FastifyInstance, spec: string, handler: Handler): void {
  const [method, url] = spec.split(' ') as [Method, string];
  app.route({ method, url, handler });
}

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

function toTransferDto(t: TransferInfo, invoiceId: string | undefined): TransferDto {
  return {
    transferId: t.transferId,
    assetId: t.assetId ?? '',
    amount: t.amount,
    direction: t.direction === 'outgoing' ? 'out' : 'in',
    status: t.status,
    labels: [],
    createdAt: t.createdAt,
    updatedAt: t.updatedAt,
    ...(t.txid ? { txid: t.txid } : {}),
    ...(invoiceId ? { invoiceId } : {}),
  };
}

export function registerRoutes(app: FastifyInstance, deps: RouteDeps): void {
  const { store, orchestrator, wallet, treasurer } = deps;

  app.setErrorHandler((err, _req, reply) => {
    if (err instanceof ApiFailure) return reply.status(err.status).send(apiError(err.code, err.message));
    if (err instanceof ZodError) {
      const first = err.issues[0];
      const where = first?.path.length ? ` (${first.path.join('.')})` : '';
      return reply.status(400).send(apiError('VALIDATION', `The request is not valid${where}: ${first?.message}`));
    }
    const e = err as { statusCode?: number; code?: string; message?: string };
    if (e.statusCode && e.statusCode >= 400 && e.statusCode < 500) {
      return reply.status(e.statusCode).send(apiError(e.code ?? 'BAD_REQUEST', e.message ?? 'Bad request.'));
    }
    app.log.error(err);
    return reply.status(500).send(apiError('INTERNAL', 'Something went wrong on our side. Please try again.'));
  });

  app.setNotFoundHandler((_req, reply) => reply.status(404).send(apiError('NOT_FOUND', 'This page does not exist.')));

  route(app, API_ROUTES.health, async (): Promise<HealthResponse> => {
    const llm = deps.llmInfo();
    return {
      ok: llm.state !== 'error',
      time: new Date().toISOString(),
      llm: { provider: llm.provider, model: llm.model, state: llm.state, onDevice: llm.onDevice },
      wallet: { backend: deps.walletBackend, network: deps.network, ready: true },
      problems: deps.problems(),
    };
  });

  route(app, API_ROUTES.createInvoice, async (req, reply): Promise<CreateInvoiceResponse> => {
    let created: StoredInvoice;
    if (req.isMultipart()) {
      const file = await req.file();
      if (!file) throw new ApiFailure(400, 'NO_FILE', 'Please choose an invoice file to upload (field "file").');
      const data = await file.toBuffer();
      if (data.length === 0) throw new ApiFailure(400, 'EMPTY_FILE', 'The uploaded file is empty.');
      created = await orchestrator.createInvoice({
        filename: file.filename || 'invoice',
        mimeType: file.mimetype,
        data,
      });
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

  route(
    app,
    API_ROUTES.listInvoices,
    async (): Promise<InvoiceListResponse> => ({
      invoices: store.list().map(toSummary),
    }),
  );

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
    const [assets, address] = await Promise.all([wallet.listAssets(), wallet.receiveAddress()]);
    return {
      backend: deps.walletBackend,
      network: deps.network,
      ready: true,
      address,
      assets: assets.map((a) => ({
        assetId: a.assetId,
        ticker: a.ticker,
        name: a.name,
        precision: a.precision,
        balance: a.balance,
      })),
    };
  });

  route(app, API_ROUTES.walletReceive, async (req): Promise<ReceiveResponse> => {
    const body = ReceiveRequest.parse(req.body ?? {});
    const inv = await wallet.createReceiveInvoice({
      expirySec: (body.expiryMinutes ?? 60) * 60,
      ...(body.assetId ? { assetId: body.assetId } : {}),
      ...(body.amount ? { amount: body.amount } : {}),
    });
    return {
      rgbInvoice: inv.rgbInvoice,
      expiresAt: inv.expiresAt,
      ...(inv.assetId ? { assetId: inv.assetId } : {}),
      ...(inv.amount ? { amount: inv.amount } : {}),
    };
  });

  route(app, API_ROUTES.transfers, async (): Promise<TransfersResponse> => {
    const transfers = await wallet.listTransfers();
    return {
      transfers: transfers
        .map((t) => toTransferDto(t, store.invoiceForTransfer(t.transferId)))
        .sort((a, b) => b.createdAt.localeCompare(a.createdAt)),
    };
  });

  route(app, API_ROUTES.agentChat, async (req): Promise<ChatResponse> => {
    const body = ChatRequest.parse(req.body);
    const emit = (event: AppEvent) => store.appendEvent(event);
    return treasurer.chat(body.message, body.history ?? [], emit);
  });
}
