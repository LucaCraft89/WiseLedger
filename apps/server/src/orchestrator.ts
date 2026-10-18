// Orchestrator: drives the invoice state machine (core INVOICE_TRANSITIONS) over the Analyst, the Treasurer
// and the wallet. Every transition is validated with assertTransition, then persisted together with its `state`
// event in one SQLite transaction (store.transition), which also pushes the event to SSE subscribers.
import { createHash, randomUUID } from 'node:crypto';
import { access, mkdir, writeFile } from 'node:fs/promises';
import { extname, join } from 'node:path';
import {
  type AnalysisReport,
  type AppEvent,
  assertTransition,
  buildConfirmationSentence,
  type Confirmation,
  type ConfirmRequest,
  type ConfirmResponse,
  canTransition,
  type EmitFn,
  type ExecutionResult,
  FLAG_CODES,
  formatAssetAmount,
  IllegalTransition,
  type InvoiceAnalyzer,
  type InvoiceSourceKind,
  type InvoiceState,
  type Job,
  makePlan,
  PAYMENT_REQUEST_PAYEE,
  type PaymentPlan,
  type RejectRequest,
  type RejectResponse,
  type SetAmountResponse,
  type TransferInfo,
  type TransferStatus,
  type TreasurerAgent,
  type WalletPort,
} from 'core';
import type { FastifyBaseLogger } from 'fastify';
import { RETRY_SAFE } from 'wallet';
import type { InvoiceStore, StoredInvoice } from './store.js';

/** Error with an HTTP status and a stable code; message is plain language for the user. */
export class ApiFailure extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'ApiFailure';
  }
}

/** Runs a confirmed plan now whatever its executeAt (B's Treasurer.executeNow behind the guard). */
export type ExecuteNowFn = (plan: PaymentPlan, confirmation: Confirmation, emit: EmitFn) => Promise<ExecutionResult>;

export interface OrchestratorDeps {
  store: InvoiceStore;
  analyzer: InvoiceAnalyzer;
  treasurer: TreasurerAgent & { executeNow?: ExecuteNowFn };
  wallet: WalletPort;
  uploadDir: string;
  /** Max amount per payment in base units (PAYMENT_CAP), for amounts the user types (open-amount requests). */
  paymentCap?: string;
  /** Stores the job of a scheduled payment (B's Scheduler.schedule). Without it, scheduled confirms are refused. */
  schedule?: (input: { planId: string; invoiceId: string; runAt: string }) => Promise<Job>;
  now?: () => Date;
}

/** What recover() did at startup. */
export interface RecoveryReport {
  /** Analysis was interrupted (UPLOADED/EXTRACTED): started again. */
  reanalyzed: string[];
  /** Report existed but planning was interrupted (ANALYZED): planning resumed. */
  resumed: string[];
  /** Upload missing on disk: marked FAILED. */
  failed: string[];
  /** CONFIRMED/EXECUTING: a payment may have been sent. Never re-executed; a wallet sync decides. */
  awaitingSync: string[];
}

/** What settleFromTransfers() did (invoice IDs). */
export interface SettleReport {
  paid: string[];
  failed: string[];
  /** Timed-out payments linked to the outgoing transfer found for their rgbInvoice. */
  linked: string[];
  /** Still waiting for the chain (or for the transfer to appear). */
  pending: string[];
}

type Log = Pick<FastifyBaseLogger, 'info' | 'warn'>;

export interface NewUpload {
  filename: string;
  mimeType?: string;
  data: Buffer;
  /** Kind already established by the upload checks; otherwise guessed from name and MIME type. */
  kind?: InvoiceSourceKind;
}

const IMAGE_EXT = new Set(['.png', '.jpg', '.jpeg', '.webp', '.gif', '.bmp', '.tif', '.tiff']);

export function detectKind(filename: string, mimeType?: string): InvoiceSourceKind {
  const ext = extname(filename).toLowerCase();
  const mime = (mimeType ?? '').toLowerCase();
  if (ext === '.pdf' || mime === 'application/pdf') return 'pdf';
  if (IMAGE_EXT.has(ext) || mime.startsWith('image/')) return 'image';
  if (ext === '.xml' || mime.endsWith('/xml')) return 'xml';
  return 'text';
}

export class Orchestrator {
  private readonly store: InvoiceStore;
  private readonly now: () => Date;
  /** Background analysis/execution tasks, so tests and shutdown can await them. */
  private readonly tasks = new Set<Promise<void>>();
  /** Invoices found mid-payment at startup; cleared when they leave EXECUTING. */
  private readonly interrupted = new Set<string>();
  /** Invoices whose treasurer.execute() is still running: settleFromTransfers() leaves them alone. */
  private readonly executing = new Set<string>();
  /** Last status seen per transfer not linked to an invoice (null until the first settle pass). */
  private knownTransfers: Map<string, TransferStatus> | null = null;
  private settling: Promise<SettleReport> | null = null;

  constructor(private readonly deps: OrchestratorDeps) {
    this.store = deps.store;
    this.now = deps.now ?? (() => new Date());
  }

  private at(): string {
    return this.now().toISOString();
  }

  private emit = (event: AppEvent): void => {
    this.store.appendEvent(event);
  };

  /** Validates (core state machine), persists state + event atomically, pushes the event to SSE. */
  private transition(id: string, to: InvoiceState): StoredInvoice {
    const cur = this.mustGet(id);
    try {
      assertTransition(cur.state, to);
    } catch (err) {
      if (err instanceof IllegalTransition) throw invalidTransition(cur.state, to);
      throw err;
    }
    const next = this.store.transition(id, cur.state, to, {
      type: 'state',
      invoiceId: id,
      at: this.at(),
      from: cur.state,
      to,
    });
    // Someone else moved the invoice between our read and our write.
    if (!next) throw invalidTransition(this.mustGet(id).state, to);
    if (to !== 'EXECUTING') this.interrupted.delete(id);
    return next;
  }

  private mustGet(id: string): StoredInvoice {
    const inv = this.store.get(id);
    if (!inv) throw new ApiFailure(404, 'NOT_FOUND', 'We could not find this invoice.');
    return inv;
  }

  private background(task: () => Promise<void>): void {
    const p = task().finally(() => this.tasks.delete(p));
    this.tasks.add(p);
  }

  /** Waits until no analysis or payment is running (tests, graceful shutdown). */
  /**
   * Waits for background work. With `maxMs` it gives up after that long and returns false: a send that hangs inside
   * the wallet library must not block shutdown (nothing is resent; on restart recover() leaves it to the sync).
   */
  async idle(maxMs?: number): Promise<boolean> {
    const all = (async () => {
      while (this.tasks.size > 0) await Promise.allSettled([...this.tasks]);
    })();
    if (maxMs === undefined) {
      await all;
      return true;
    }
    let timer: ReturnType<typeof setTimeout> | undefined;
    const limit = new Promise<false>((r) => {
      timer = setTimeout(() => r(false), maxMs);
    });
    const done = await Promise.race([all.then(() => true as const), limit]);
    clearTimeout(timer);
    return done;
  }

  async createInvoice(upload: NewUpload): Promise<StoredInvoice> {
    const id = `inv_${randomUUID().replaceAll('-', '').slice(0, 16)}`;
    const kind = upload.kind ?? detectKind(upload.filename, upload.mimeType);
    const ext = safeExt(upload.filename) || (kind === 'text' ? '.txt' : '');
    const sha256 = createHash('sha256').update(upload.data).digest('hex');
    // Content-addressed: the same file uploaded twice is stored once; the record keeps the original filename.
    await mkdir(this.deps.uploadDir, { recursive: true });
    const path = join(this.deps.uploadDir, `${sha256}${ext}`);
    if (!(await exists(path))) await writeFile(path, upload.data);
    const createdAt = this.at();
    const record: StoredInvoice = {
      id,
      state: 'UPLOADED',
      filename: upload.filename,
      kind,
      sha256,
      path,
      createdAt,
      updatedAt: createdAt,
      ...(upload.mimeType ? { mimeType: upload.mimeType } : {}),
    };
    this.store.insert(record, { type: 'state', invoiceId: id, at: createdAt, to: 'UPLOADED' });
    this.background(() => this.analyze(id));
    return record;
  }

  private async analyze(id: string): Promise<void> {
    const inv = this.mustGet(id);
    try {
      const report = await this.deps.analyzer.analyze(
        {
          kind: inv.kind,
          path: inv.path,
          sha256: inv.sha256,
          filename: inv.filename,
          ...(inv.mimeType ? { mimeType: inv.mimeType } : {}),
        },
        { invoiceId: id },
        (event) => {
          this.emit(event);
          // Extraction finished: the Analyst's call 1 is done.
          if (event.type === 'stage' && event.stage === 'extracting' && event.status === 'end') {
            if (this.mustGet(id).state === 'UPLOADED') this.transition(id, 'EXTRACTED');
          }
        },
      );
      if (this.mustGet(id).state === 'UPLOADED') this.transition(id, 'EXTRACTED');
      this.store.update(id, { report });
      this.transition(id, 'ANALYZED');
      await this.finishAnalysis(id, report);
    } catch (err) {
      this.fail(id, 'ANALYSIS_FAILED', `We could not analyse this invoice: ${messageOf(err)}`);
    }
  }

  /**
   * ANALYZED → BLOCKED (verdict block), or plan + sentence → AWAITING_CONFIRMATION. A report that is not blocked
   * but has no payment we can make (e.g. AI_UNAVAILABLE) also waits for the user, without a plan: they can read
   * it and reject it; confirm is refused with a plain 409.
   */
  private async finishAnalysis(id: string, report: AnalysisReport): Promise<void> {
    if (report.verdict === 'block') {
      this.transition(id, 'BLOCKED');
      return;
    }
    if (!report.proposedPayment) {
      this.transition(id, 'AWAITING_CONFIRMATION');
      return;
    }
    const plan = await this.planFromReport(id, report);
    const confirmationSentence = await this.sentenceFor(plan);
    this.store.update(id, { plan, confirmationSentence });
    this.transition(id, 'AWAITING_CONFIRMATION');
  }

  /**
   * Startup recovery. Interrupted analysis is started again (or FAILED when the upload is gone); planning after a
   * stored report is resumed. CONFIRMED/EXECUTING invoices are never re-executed (a send may already be on its
   * way): they stay as they are, are logged, and are listed by awaitingSync() until a wallet sync decides.
   */
  async recover(log?: Log): Promise<RecoveryReport> {
    const out: RecoveryReport = { reanalyzed: [], resumed: [], failed: [], awaitingSync: [] };
    const stuck = this.store.list({ states: ['UPLOADED', 'EXTRACTED', 'ANALYZED', 'CONFIRMED', 'EXECUTING'] });
    for (const inv of stuck.reverse()) {
      const id = inv.id;
      if (inv.state === 'CONFIRMED' || inv.state === 'EXECUTING') {
        this.interrupted.add(id);
        out.awaitingSync.push(id);
        this.emit({
          type: 'stage',
          invoiceId: id,
          at: this.at(),
          stage: 'executing',
          status: 'error',
          message:
            'The app restarted while this payment was in progress. It will not be sent again; the next wallet sync will show whether it went through.',
        });
        log?.warn(
          { invoiceId: id, state: inv.state, transferId: inv.result?.transferId },
          'Payment interrupted by restart: not retried, waiting for a wallet sync',
        );
        continue;
      }
      if (inv.state === 'ANALYZED' && inv.report) {
        out.resumed.push(id);
        log?.info({ invoiceId: id }, 'Resuming planning interrupted by restart');
        this.background(async () => {
          try {
            await this.finishAnalysis(id, inv.report as AnalysisReport);
          } catch (err) {
            this.fail(id, 'ANALYSIS_FAILED', `We could not finish analysing this invoice: ${messageOf(err)}`);
          }
        });
        continue;
      }
      if (!(await exists(inv.path))) {
        out.failed.push(id);
        log?.warn({ invoiceId: id, path: inv.path }, 'Interrupted analysis cannot restart: upload missing');
        this.fail(
          id,
          'UPLOAD_MISSING',
          'The app restarted during the analysis and the uploaded file is no longer there. Please upload the invoice again.',
        );
        continue;
      }
      out.reanalyzed.push(id);
      log?.info({ invoiceId: id, state: inv.state }, 'Re-analysing invoice interrupted by restart');
      this.emit({
        type: 'stage',
        invoiceId: id,
        at: this.at(),
        stage: 'reading',
        status: 'start',
        message: 'The app restarted during the analysis. Starting the analysis again.',
      });
      this.background(() => this.analyze(id));
    }
    return out;
  }

  /** Invoices interrupted mid-payment by a restart, still waiting for a wallet sync to settle their outcome. */
  awaitingSync(): StoredInvoice[] {
    return [...this.interrupted]
      .map((id) => this.store.get(id))
      .filter((inv): inv is StoredInvoice => inv?.state === 'EXECUTING' || inv?.state === 'CONFIRMED');
  }

  private async planFromReport(id: string, report: AnalysisReport, executeAt?: string): Promise<PaymentPlan> {
    const p = report.proposedPayment;
    if (!p) throw new ApiFailure(409, 'NO_PAYMENT', 'This invoice has no payment we can make.');
    return makePlan({
      invoiceId: id,
      rgbInvoice: p.rgbInvoice,
      assetId: p.assetId,
      amount: p.amount,
      payee: { name: p.payee },
      executeAt: executeAt ?? (p.executeAt ? new Date(p.executeAt).toISOString() : 'now'),
      labels: [],
    });
  }

  /** The shared sentence builder (core), so server and web always show the same words. */
  private async sentenceFor(plan: PaymentPlan): Promise<string> {
    const asset = (await this.deps.wallet.listAssets()).find((a) => a.assetId === plan.assetId);
    return buildConfirmationSentence(plan, asset);
  }

  /**
   * Open-amount payment request: the amount the user typed (base units) is checked here (> 0, ≤ payment cap,
   * ≤ spendable) and becomes the proposed payment, so confirm() rebuilds and checks exactly this plan.
   */
  async setAmount(id: string, amount: string): Promise<SetAmountResponse> {
    const inv = this.mustGet(id);
    const report = inv.report;
    const pr = report?.paymentRequest;
    if (!report || report.kind !== 'payment_request' || !pr || pr.amount) {
      throw new ApiFailure(409, 'AMOUNT_FIXED', 'This payment already has its amount; it cannot be changed.');
    }
    if (inv.state !== 'AWAITING_CONFIRMATION' || report.verdict === 'block') {
      throw new ApiFailure(409, 'INVALID_TRANSITION', `The amount cannot be set now (state ${inv.state}).`);
    }
    const assetId = pr.assetId ?? pr.payAssetId;
    const rgbInvoice = report.extraction.payment.rgbInvoice;
    if (!assetId || !rgbInvoice) {
      throw new ApiFailure(409, 'NO_PAYMENT', 'No token you accept is set up to pay this request.');
    }
    const asset = (await this.deps.wallet.listAssets()).find((a) => a.assetId === assetId);
    const words = (v: string) =>
      asset ? `${formatAssetAmount(v, asset.precision)} ${asset.ticker}` : `${v} base units`;
    const value = BigInt(amount);
    if (value <= 0n) throw new ApiFailure(400, 'AMOUNT_ZERO', 'Type an amount greater than zero.');
    if (this.deps.paymentCap && value > BigInt(this.deps.paymentCap)) {
      throw new ApiFailure(400, 'OVER_CAP', `This is above your payment limit of ${words(this.deps.paymentCap)}.`);
    }
    const spendable = (await this.deps.wallet.assetBalance(assetId)).spendable;
    if (value > BigInt(spendable)) {
      throw new ApiFailure(400, 'INSUFFICIENT_FUNDS', `You can spend at most ${words(spendable)} right now.`);
    }
    const withAmount: AnalysisReport = {
      ...report,
      proposedPayment: { rgbInvoice, assetId, amount, payee: PAYMENT_REQUEST_PAYEE },
    };
    const plan = await this.planFromReport(id, withAmount);
    const confirmationSentence = await this.sentenceFor(plan);
    this.store.update(id, { report: withAmount, plan, confirmationSentence });
    return { invoiceId: id, plan, confirmationSentence };
  }

  async confirm(id: string, req: ConfirmRequest): Promise<ConfirmResponse> {
    const inv = this.mustGet(id);
    const report = inv.report;
    if (inv.state === 'BLOCKED' || report?.verdict === 'block') {
      throw new ApiFailure(409, 'VERDICT_BLOCK', 'This invoice was blocked as dangerous and cannot be paid.');
    }
    if (
      inv.state === 'AWAITING_CONFIRMATION' &&
      report?.kind === 'payment_request' &&
      !report.proposedPayment &&
      report.paymentRequest &&
      !report.paymentRequest.amount
    ) {
      throw new ApiFailure(409, 'AMOUNT_NEEDED', 'This request leaves the amount to you: type it first, then confirm.');
    }
    if (inv.state === 'AWAITING_CONFIRMATION' && report && !report.proposedPayment) {
      if (report.flags.some((f) => f.code === FLAG_CODES.AI_UNAVAILABLE)) {
        throw new ApiFailure(
          409,
          'AI_UNAVAILABLE',
          'The local AI could not read this invoice, so there is no payment to confirm. Check it yourself or upload it again.',
        );
      }
      throw new ApiFailure(
        409,
        'NO_PAYMENT',
        'This invoice has no RGB payment we can make. Check it yourself, then reject it or ask the supplier for an RGB invoice.',
      );
    }
    // Retry after a failure: only when nothing can have been sent (wallet RETRY_SAFE codes).
    const retry = inv.state === 'FAILED';
    if (retry && !RETRY_SAFE.has(inv.result?.error?.code ?? '')) {
      throw new ApiFailure(
        409,
        'RETRY_NOT_SAFE',
        'This payment may already have left the wallet, so it cannot be retried. Check the transfer list first.',
      );
    }
    if ((!retry && inv.state !== 'AWAITING_CONFIRMATION') || !report || !inv.plan) {
      throw new ApiFailure(409, 'INVALID_TRANSITION', `This invoice cannot be confirmed now (state ${inv.state}).`);
    }
    if (report.verdict === 'review' && req.override !== true) {
      throw new ApiFailure(
        409,
        'OVERRIDE_REQUIRED',
        'This invoice needs your review. Read the warnings, then confirm again with override.',
      );
    }
    const executeAt = req.executeAt ? new Date(req.executeAt).toISOString() : undefined;
    if (executeAt) {
      if (!this.deps.schedule) {
        throw new ApiFailure(409, 'SCHEDULING_UNAVAILABLE', 'Scheduled payments are not available. Pay now instead.');
      }
      if (Date.parse(executeAt) <= this.now().getTime()) {
        throw new ApiFailure(400, 'IN_THE_PAST', 'The payment date must be in the future.');
      }
    }
    // Rebuild the plan from the report: the planId the user saw must match what we would pay now.
    const plan = await this.planFromReport(id, report);
    if (plan.planId !== inv.plan.planId || req.planId !== plan.planId) {
      throw new ApiFailure(
        409,
        'PLAN_MISMATCH',
        'The payment changed after you saw it. Reload the invoice and check it again.',
      );
    }
    // Scheduled: the same payment with the chosen date (its own planId); the job runs it through the guard when due.
    const toPay = executeAt ? await this.planFromReport(id, report, executeAt) : plan;
    const confirmation = { planId: toPay.planId, confirmedAt: this.at() };
    this.store.update(id, { plan: toPay, confirmation });
    this.transition(id, 'CONFIRMED');
    this.transition(id, 'EXECUTING');
    this.background(async () => {
      await this.execute(id, toPay, confirmation);
    });
    return { invoiceId: id, state: 'EXECUTING', planId: toPay.planId };
  }

  private async execute(
    id: string,
    plan: PaymentPlan,
    confirmation: Confirmation,
    run: ExecuteNowFn = (p, c, e) => this.deps.treasurer.execute(p, c, e),
  ): Promise<ExecutionResult> {
    this.executing.add(id);
    try {
      return await this.runExecution(id, plan, confirmation, run);
    } finally {
      this.executing.delete(id);
    }
  }

  /**
   * The Scheduler's executor: a due job pays its SCHEDULED invoice now (SCHEDULED → EXECUTING → Treasurer.executeNow
   * through the guard). Anything else (cancelled, rejected, already started before a crash) is refused, never re-sent.
   */
  async runScheduled(job: Job): Promise<ExecutionResult> {
    const inv = this.store.get(job.invoiceId);
    const refuse = (code: string, message: string): ExecutionResult => ({
      planId: job.planId,
      status: 'failed',
      error: { code, message },
    });
    if (!inv || inv.plan?.planId !== job.planId || inv.confirmation?.planId !== job.planId) {
      return refuse('NOT_SCHEDULED', 'This scheduled payment no longer matches its invoice. Nothing was sent.');
    }
    if (inv.state === 'EXECUTING' || inv.state === 'PAID') {
      return refuse(
        'already_executed',
        'This payment was already started. It was not sent again; the wallet sync shows whether it went through.',
      );
    }
    if (inv.state !== 'SCHEDULED') {
      return refuse('NOT_SCHEDULED', `This payment is no longer scheduled (it is ${inv.state}). Nothing was sent.`);
    }
    const treasurer = this.deps.treasurer;
    if (!treasurer.executeNow) {
      return refuse('SCHEDULING_UNAVAILABLE', 'Scheduled payments are not available. Nothing was sent.');
    }
    this.transition(inv.id, 'EXECUTING');
    return this.execute(inv.id, inv.plan, inv.confirmation, (p, c, e) =>
      (treasurer.executeNow as ExecuteNowFn).call(treasurer, p, c, e),
    );
  }

  private async runExecution(
    id: string,
    plan: PaymentPlan,
    confirmation: Confirmation,
    run: ExecuteNowFn,
  ): Promise<ExecutionResult> {
    this.emit({ type: 'stage', invoiceId: id, at: this.at(), stage: 'executing', status: 'start' });
    let result: ExecutionResult;
    try {
      result = await run(plan, confirmation, this.emit);
    } catch (err) {
      result = { planId: plan.planId, status: 'failed', error: { code: 'EXECUTION_ERROR', message: messageOf(err) } };
    }
    // A send timeout may be on chain: treat it as submitted (stay EXECUTING, never FAILED, never retried).
    if (result.status === 'failed' && result.error?.code === 'SubmitTimeout') {
      result = {
        planId: result.planId,
        status: 'submitted',
        ...(result.transferId ? { transferId: result.transferId } : {}),
        ...(result.txid ? { txid: result.txid } : {}),
        error: result.error,
      };
    }
    if (result.status === 'scheduled') {
      try {
        if (!this.deps.schedule || plan.executeAt === 'now') throw new Error('Scheduled payments are not available.');
        await this.deps.schedule({ planId: plan.planId, invoiceId: id, runAt: plan.executeAt });
      } catch (err) {
        result = { planId: plan.planId, status: 'failed', error: { code: 'SCHEDULE_FAILED', message: messageOf(err) } };
      }
    }
    // A Lightning payment is identified by its hash: fill it from the wallet when the executor did not pass it.
    if (result.transferId && !result.txid && !result.paymentHash) {
      const t = await this.deps.wallet.getTransfer(result.transferId).catch(() => null);
      if (t?.paymentHash) result = { ...result, paymentHash: t.paymentHash };
    }
    this.store.update(id, { result });
    if (result.transferId) this.store.linkTransfer(result.transferId, id);
    // Something else (e.g. a wallet sync) already settled it while we waited.
    if (this.mustGet(id).state !== 'EXECUTING') return result;
    switch (result.status) {
      case 'settled':
        this.emit({ type: 'stage', invoiceId: id, at: this.at(), stage: 'executing', status: 'end' });
        this.transition(id, 'PAID');
        this.emit({ type: 'stage', invoiceId: id, at: this.at(), stage: 'done', status: 'end' });
        return result;
      case 'scheduled':
        this.emit({ type: 'stage', invoiceId: id, at: this.at(), stage: 'executing', status: 'end' });
        this.transition(id, 'SCHEDULED');
        return result;
      case 'failed':
        this.fail(id, result.error?.code ?? 'PAYMENT_FAILED', result.error?.message ?? 'The payment failed.');
        return result;
      case 'submitted':
        // Sent (or maybe sent, after a timeout) but not settled yet: stay EXECUTING; the wallet sync settles it.
        this.emit({
          type: 'stage',
          invoiceId: id,
          at: this.at(),
          stage: 'executing',
          status: 'end',
          message: result.error
            ? 'The payment was submitted but the wallet did not answer in time. It will not be sent again; the next wallet sync will show whether it went through.'
            : 'The payment was sent and is waiting for confirmation on chain.',
        });
        return result;
    }
  }

  /**
   * Called after each wallet sync. EXECUTING invoices (not being executed right now) are settled from the wallet:
   * the stored transferId (or, after a timeout without one, the outgoing transfer paying the plan's rgbInvoice) is
   * read; Settled → PAID, Failed → FAILED. Emits `transfer` events on status changes (invoice-linked ones on the
   * invoice stream, the others on the global stream) and `state` events through transition().
   */
  settleFromTransfers(): Promise<SettleReport> {
    this.settling ??= this.settleOnce().finally(() => {
      this.settling = null;
    });
    return this.settling;
  }

  private async settleOnce(): Promise<SettleReport> {
    const out: SettleReport = { paid: [], failed: [], linked: [], pending: [] };
    const transfers = await this.deps.wallet.listTransfers();
    const byId = new Map(transfers.map((t) => [t.transferId, t]));

    for (const inv of this.store.list({ states: ['EXECUTING'] })) {
      const id = inv.id;
      if (this.executing.has(id) || !inv.plan) continue;
      let transferId = inv.result?.transferId;
      if (!transferId) {
        // rgb-lib reports sends without the invoice string: match on it when present, else on the recipient ID.
        const recipientId = await this.deps.wallet
          .decodeInvoice(inv.plan.rgbInvoice)
          .then((d) => d.recipientId)
          .catch(() => undefined);
        const match = transfers.find(
          (t) =>
            t.direction === 'outgoing' &&
            (t.rgbInvoice === inv.plan?.rgbInvoice || (recipientId !== undefined && t.recipientId === recipientId)) &&
            t.status !== 'Failed' &&
            [undefined, null, id].includes(this.store.invoiceForTransfer(t.transferId)),
        );
        if (!match) {
          out.pending.push(id);
          continue;
        }
        transferId = match.transferId;
        this.store.linkTransfer(transferId, id);
        this.store.update(id, {
          result: {
            ...(inv.result ?? { planId: inv.plan.planId, status: 'submitted' }),
            transferId,
            ...(match.txid ? { txid: match.txid } : {}),
          },
        });
        out.linked.push(id);
      }
      const t = byId.get(transferId) ?? (await this.deps.wallet.getTransfer(transferId));
      if (!t) {
        out.pending.push(id);
        continue;
      }
      this.emitTransferChange(id, t);
      if (t.status === 'Settled') {
        this.store.update(id, {
          result: {
            planId: inv.plan.planId,
            status: 'settled',
            transferId,
            ...(t.txid ? { txid: t.txid } : {}),
            ...(t.paymentHash ? { paymentHash: t.paymentHash } : {}),
          },
        });
        this.emit({ type: 'stage', invoiceId: id, at: this.at(), stage: 'executing', status: 'end' });
        this.transition(id, 'PAID');
        this.emit({ type: 'stage', invoiceId: id, at: this.at(), stage: 'done', status: 'end' });
        out.paid.push(id);
      } else if (t.status === 'Failed') {
        this.store.update(id, {
          result: {
            planId: inv.plan.planId,
            status: 'failed',
            transferId,
            ...(t.txid ? { txid: t.txid } : {}),
            error: { code: 'TransferFailed', message: 'The transfer failed on chain.' },
          },
        });
        this.fail(id, 'TransferFailed', 'The transfer failed. Nothing more will be sent for this invoice.');
        out.failed.push(id);
      } else {
        out.pending.push(id);
      }
    }

    this.emitUnlinkedTransferChanges(transfers);
    return out;
  }

  /** Emits a `transfer` event on the invoice stream when the status differs from the last one emitted there. */
  private emitTransferChange(invoiceId: string, t: TransferInfo): void {
    const last = this.store
      .eventsOf(invoiceId)
      .filter((e) => e.type === 'transfer' && e.transferId === t.transferId)
      .at(-1);
    if (last?.type === 'transfer' && last.status === t.status) return;
    this.emit({
      type: 'transfer',
      invoiceId,
      at: this.at(),
      transferId: t.transferId,
      status: t.status,
      ...(t.txid ? { txid: t.txid } : {}),
      ...(t.paymentHash ? { paymentHash: t.paymentHash } : {}),
    });
  }

  /** Global `transfer` events for transfers not linked to an invoice. The first pass only records the baseline. */
  private emitUnlinkedTransferChanges(transfers: TransferInfo[]): void {
    const first = this.knownTransfers === null;
    const known = this.knownTransfers ?? new Map<string, TransferStatus>();
    this.knownTransfers = known;
    for (const t of transfers) {
      if (this.store.invoiceForTransfer(t.transferId)) continue;
      const prev = known.get(t.transferId);
      known.set(t.transferId, t.status);
      if (first || prev === t.status) continue;
      this.emit({
        type: 'transfer',
        at: this.at(),
        transferId: t.transferId,
        status: t.status,
        ...(t.txid ? { txid: t.txid } : {}),
        ...(t.paymentHash ? { paymentHash: t.paymentHash } : {}),
      });
    }
  }

  private fail(id: string, code: string, message: string): void {
    this.emit({ type: 'error', invoiceId: id, at: this.at(), code, message });
    const cur = this.store.get(id);
    if (!cur || !canTransition(cur.state, 'FAILED')) return;
    try {
      this.transition(id, 'FAILED');
    } catch (err) {
      if (!(err instanceof ApiFailure)) throw err;
    }
  }

  reject(id: string, _req: RejectRequest): RejectResponse {
    const inv = this.mustGet(id);
    if (!canTransition(inv.state, 'REJECTED')) throw invalidTransition(inv.state, 'REJECTED');
    this.transition(id, 'REJECTED');
    return { invoiceId: id, state: 'REJECTED' };
  }
}

const ACTION: Partial<Record<InvoiceState, string>> = {
  REJECTED: 'rejected',
  CONFIRMED: 'confirmed',
  EXECUTING: 'paid',
};

export function invalidTransition(from: InvoiceState, to: InvoiceState): ApiFailure {
  const action = ACTION[to] ?? `moved to ${to}`;
  return new ApiFailure(
    409,
    'INVALID_TRANSITION',
    `This invoice cannot be ${action} now: it is ${from}. Reload the invoice to see its current state.`,
  );
}

/** Lower-case extension, only if short and plain (never trust a client filename in a path). */
function safeExt(filename: string): string {
  const ext = extname(filename).toLowerCase();
  return /^\.[a-z0-9]{1,8}$/.test(ext) ? ext : '';
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
