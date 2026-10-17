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
  type ConfirmRequest,
  type ConfirmResponse,
  canTransition,
  type ExecutionResult,
  IllegalTransition,
  type InvoiceAnalyzer,
  type InvoiceSourceKind,
  type InvoiceState,
  makePlan,
  type PaymentPlan,
  type RejectRequest,
  type RejectResponse,
  type TreasurerAgent,
  type WalletPort,
} from 'core';
import type { FastifyBaseLogger } from 'fastify';
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

export interface OrchestratorDeps {
  store: InvoiceStore;
  analyzer: InvoiceAnalyzer;
  treasurer: TreasurerAgent;
  wallet: WalletPort;
  uploadDir: string;
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

type Log = Pick<FastifyBaseLogger, 'info' | 'warn'>;

export interface NewUpload {
  filename: string;
  mimeType?: string;
  data: Buffer;
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

/** Base units → human decimal with `precision` digits ("25000000", 6 → "25.000000"). */
export function formatUnits(amount: string, precision: number): string {
  if (precision === 0) return amount;
  const padded = amount.padStart(precision + 1, '0');
  return `${padded.slice(0, -precision)}.${padded.slice(-precision)}`;
}

export class Orchestrator {
  private readonly store: InvoiceStore;
  private readonly now: () => Date;
  /** Background analysis/execution tasks, so tests and shutdown can await them. */
  private readonly tasks = new Set<Promise<void>>();
  /** Invoices found mid-payment at startup; cleared when they leave EXECUTING. */
  private readonly interrupted = new Set<string>();

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
  async idle(): Promise<void> {
    while (this.tasks.size > 0) await Promise.allSettled([...this.tasks]);
  }

  async createInvoice(upload: NewUpload): Promise<StoredInvoice> {
    const id = `inv_${randomUUID().replaceAll('-', '').slice(0, 16)}`;
    const kind = detectKind(upload.filename, upload.mimeType);
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

  /** ANALYZED → BLOCKED, or plan + sentence → AWAITING_CONFIRMATION. */
  private async finishAnalysis(id: string, report: AnalysisReport): Promise<void> {
    if (report.verdict === 'block' || !report.proposedPayment) {
      this.transition(id, 'BLOCKED');
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

  private async planFromReport(id: string, report: AnalysisReport): Promise<PaymentPlan> {
    const p = report.proposedPayment;
    if (!p) throw new ApiFailure(409, 'NO_PAYMENT', 'This invoice has no payment we can make.');
    return makePlan({
      invoiceId: id,
      rgbInvoice: p.rgbInvoice,
      assetId: p.assetId,
      amount: p.amount,
      payee: { name: p.payee },
      executeAt: p.executeAt ? new Date(p.executeAt).toISOString() : 'now',
      labels: [],
    });
  }

  private async sentenceFor(plan: PaymentPlan): Promise<string> {
    const assets = await this.deps.wallet.listAssets();
    const asset = assets.find((a) => a.assetId === plan.assetId);
    const amount = asset ? `${formatUnits(plan.amount, asset.precision)} ${asset.ticker}` : `${plan.amount} base units`;
    const when = plan.executeAt === 'now' ? 'now' : `on ${plan.executeAt}`;
    return `Pay ${amount} (asset ${plan.assetId}) to ${plan.payee.name}, ${when}. Confirm?`;
  }

  async confirm(id: string, req: ConfirmRequest): Promise<ConfirmResponse> {
    const inv = this.mustGet(id);
    const report = inv.report;
    if (inv.state === 'BLOCKED' || report?.verdict === 'block') {
      throw new ApiFailure(409, 'VERDICT_BLOCK', 'This invoice was blocked as dangerous and cannot be paid.');
    }
    if (inv.state !== 'AWAITING_CONFIRMATION' || !report || !inv.plan) {
      throw new ApiFailure(409, 'INVALID_TRANSITION', `This invoice cannot be confirmed now (state ${inv.state}).`);
    }
    if (report.verdict === 'review' && req.override !== true) {
      throw new ApiFailure(
        409,
        'OVERRIDE_REQUIRED',
        'This invoice needs your review. Read the warnings, then confirm again with override.',
      );
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
    const confirmation = { planId: plan.planId, confirmedAt: this.at() };
    this.store.update(id, { plan, confirmation });
    this.transition(id, 'CONFIRMED');
    this.transition(id, 'EXECUTING');
    this.background(() => this.execute(id, plan, confirmation));
    return { invoiceId: id, state: 'EXECUTING', planId: plan.planId };
  }

  private async execute(id: string, plan: PaymentPlan, confirmation: { planId: string; confirmedAt: string }) {
    this.emit({ type: 'stage', invoiceId: id, at: this.at(), stage: 'executing', status: 'start' });
    let result: ExecutionResult;
    try {
      result = await this.deps.treasurer.execute(plan, confirmation, this.emit);
    } catch (err) {
      result = { planId: plan.planId, status: 'failed', error: { code: 'EXECUTION_ERROR', message: messageOf(err) } };
    }
    this.store.update(id, { result });
    if (result.transferId) this.store.linkTransfer(result.transferId, id);
    switch (result.status) {
      case 'settled':
        this.emit({ type: 'stage', invoiceId: id, at: this.at(), stage: 'executing', status: 'end' });
        this.transition(id, 'PAID');
        this.emit({ type: 'stage', invoiceId: id, at: this.at(), stage: 'done', status: 'end' });
        return;
      case 'scheduled':
        this.emit({ type: 'stage', invoiceId: id, at: this.at(), stage: 'executing', status: 'end' });
        this.transition(id, 'SCHEDULED');
        return;
      case 'failed':
        this.fail(id, result.error?.code ?? 'PAYMENT_FAILED', result.error?.message ?? 'The payment failed.');
        return;
      case 'submitted':
        // Sent but not settled yet: stay EXECUTING (never retry automatically).
        this.emit({
          type: 'stage',
          invoiceId: id,
          at: this.at(),
          stage: 'executing',
          status: 'end',
          message: 'The payment was sent and is waiting for confirmation on chain.',
        });
        return;
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
