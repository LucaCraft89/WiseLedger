// In-browser fake backend: walks the same lifecycle as A's server using the core mocks.
// Verdict by file name (MockAnalyzer): *scam* / *inject* → block, *eur* → review, anything else → ok.

import type { ApiClient, InvoiceInput } from './client.js';
import { ApiCallError } from './client.js';
import {
  type AnalysisReport,
  type AppEvent,
  buildConfirmationSentence,
  type ExecutionResult,
  type InvoiceSourceKind,
  type InvoiceState,
  type InvoiceSummaryDto,
  MockAnalyzer,
  MockTreasurer,
  MockWallet,
  makePlan,
  type PaymentPlan,
  sha256Hex,
} from './contracts.js';

export interface FakeOptions {
  /** Gap between analysis stages (ms). */
  stageDelayMs?: number;
  /** Duration of each transfer status step (ms). */
  transferStepMs?: number;
  /** Treasurer poll interval (ms). */
  pollMs?: number;
}

interface Rec {
  summary: InvoiceSummaryDto;
  report?: AnalysisReport;
  plan?: PaymentPlan;
  confirmationSentence?: string;
  execution?: ExecutionResult;
  events: AppEvent[];
  listeners: Set<(e: AppEvent) => void>;
}

/** Pretend model output per stage, so the live AI box has something to show in demo mode. */
const FAKE_TOKENS: Partial<Record<string, string[]>> = {
  reading: ['Opening ', 'the file… ', 'text found.'],
  extracting: ['{"issuer": ', '{"name": "Acme Srl"}, ', '"total": "25.00", ', '"currency": "TUSDT", ', '"dueDate": …}'],
  checking: ['R1 supplier known… ', 'R4 amount usual… ', 'R7 payment details unchanged…'],
  summarizing: ['This invoice ', 'is from a supplier ', 'you paid before. ', 'The amount is usual.'],
};

function kindOf(name: string): InvoiceSourceKind {
  const n = name.toLowerCase();
  if (n.endsWith('.pdf')) return 'pdf';
  if (/\.(png|jpe?g|webp|gif)$/.test(n)) return 'image';
  if (n.endsWith('.xml')) return 'xml';
  return 'text';
}

export function createFakeClient(opts: FakeOptions = {}): ApiClient {
  const wallet = new MockWallet({ stepMs: opts.transferStepMs ?? 1500 });
  const analyzer = new MockAnalyzer({ stageDelayMs: opts.stageDelayMs ?? 600 });
  const treasurer = new MockTreasurer(wallet, { pollMs: opts.pollMs ?? 250 });
  const recs = new Map<string, Rec>();
  let seq = 0;
  let address: string | undefined;

  const get = (id: string): Rec => {
    const r = recs.get(id);
    if (!r) throw new ApiCallError('NOT_FOUND', 'This invoice does not exist.');
    return r;
  };
  const emit = (r: Rec, e: AppEvent) => {
    r.events.push(e);
    for (const l of r.listeners) l(e);
  };
  const setState = (r: Rec, to: InvoiceState) => {
    const from = r.summary.state;
    r.summary = { ...r.summary, state: to, updatedAt: new Date().toISOString() };
    emit(r, { type: 'state', invoiceId: r.summary.id, at: r.summary.updatedAt, from, to });
  };
  const fail = (r: Rec, err: unknown) => {
    const message = err instanceof Error ? err.message : String(err);
    emit(r, { type: 'error', invoiceId: r.summary.id, at: new Date().toISOString(), code: 'FAKE_ERROR', message });
    setState(r, 'FAILED');
  };

  async function analyze(r: Rec, filename: string, content: string) {
    const id = r.summary.id;
    const report = await analyzer.analyze(
      { kind: r.summary.kind, path: `fake://${filename}`, sha256: await sha256Hex(content), filename },
      { invoiceId: id },
      (e) => {
        emit(r, e);
        if (e.type === 'stage' && e.status === 'start') {
          for (const text of FAKE_TOKENS[e.stage] ?? []) {
            emit(r, { type: 'token', invoiceId: id, at: new Date().toISOString(), agent: 'analyst', text });
          }
        }
        if (e.type === 'stage' && e.stage === 'extracting' && e.status === 'end') setState(r, 'EXTRACTED');
      },
    );
    r.report = report;
    r.summary = {
      ...r.summary,
      verdict: report.verdict,
      issuerName: report.extraction.issuer.name,
      total: report.extraction.total,
      currency: report.extraction.currency,
    };
    setState(r, 'ANALYZED');
    const p = report.proposedPayment;
    if (report.verdict === 'block' || !p) {
      setState(r, 'BLOCKED');
      return;
    }
    r.plan = await makePlan({
      invoiceId: id,
      rgbInvoice: p.rgbInvoice,
      assetId: p.assetId,
      amount: p.amount,
      payee: { name: p.payee },
      executeAt: p.executeAt ?? 'now',
      labels: [],
    });
    const asset = (await wallet.listAssets()).find((a) => a.assetId === r.plan?.assetId);
    r.confirmationSentence = buildConfirmationSentence(r.plan, asset);
    setState(r, 'AWAITING_CONFIRMATION');
  }

  async function execute(r: Rec, plan: PaymentPlan) {
    const at = () => new Date().toISOString();
    const id = r.summary.id;
    setState(r, 'EXECUTING');
    emit(r, { type: 'stage', invoiceId: id, at: at(), stage: 'executing', status: 'start' });
    const result = await treasurer.execute(plan, { planId: plan.planId, confirmedAt: at() }, (e) => emit(r, e));
    r.execution = result;
    const ok = result.status !== 'failed';
    emit(r, { type: 'stage', invoiceId: id, at: at(), stage: 'executing', status: ok ? 'end' : 'error' });
    if (result.status === 'settled' || result.status === 'submitted') setState(r, 'PAID');
    else if (result.status === 'scheduled') setState(r, 'SCHEDULED');
    else {
      if (result.error) emit(r, { type: 'error', invoiceId: id, at: at(), ...result.error });
      setState(r, 'FAILED');
    }
    emit(r, { type: 'stage', invoiceId: id, at: at(), stage: 'done', status: 'end' });
  }

  return {
    mode: 'fake',
    async health() {
      return {
        ok: true,
        time: new Date().toISOString(),
        llm: { provider: 'mock', model: 'mock-analyzer', state: 'ready', onDevice: true },
        wallet: { backend: 'mock', network: 'mock', ready: true },
        problems: [],
      };
    },
    async createInvoice(input: InvoiceInput) {
      const filename = 'file' in input ? input.file.name : (input.filename ?? 'pasted-invoice.txt');
      const content = 'file' in input ? `${input.file.name}:${input.file.size}:${input.file.lastModified}` : input.text;
      const id = `inv_fake_${++seq}`;
      const now = new Date().toISOString();
      const r: Rec = {
        summary: { id, filename, kind: kindOf(filename), state: 'UPLOADED', createdAt: now, updatedAt: now },
        events: [],
        listeners: new Set(),
      };
      recs.set(id, r);
      // Start after the caller had a chance to subscribe, like a real server would.
      setTimeout(() => void analyze(r, filename, content).catch((err) => fail(r, err)), 50);
      return { invoiceId: id, state: r.summary.state };
    },
    async listInvoices() {
      const invoices = [...recs.values()].map((r) => r.summary).reverse();
      return { invoices };
    },
    async getInvoice(id) {
      const r = get(id);
      return {
        invoice: r.summary,
        report: r.report,
        plan: r.plan,
        confirmationSentence: r.confirmationSentence,
        execution: r.execution,
        events: [...r.events],
      };
    },
    subscribe(id, onEvent) {
      const r = get(id);
      r.listeners.add(onEvent);
      return () => r.listeners.delete(onEvent);
    },
    async confirm(id, req) {
      const r = get(id);
      if (r.summary.state !== 'AWAITING_CONFIRMATION' || !r.plan) {
        throw new ApiCallError('INVALID_TRANSITION', 'This invoice is not waiting for your confirmation.');
      }
      if (req.planId !== r.plan.planId) {
        throw new ApiCallError('PLAN_CHANGED', 'The payment details changed. Please read them again.');
      }
      if (r.report?.verdict === 'review' && req.override !== true) {
        throw new ApiCallError('NEEDS_OVERRIDE', 'Please tick the box to say you checked the warnings.');
      }
      const plan = r.plan;
      setState(r, 'CONFIRMED');
      setTimeout(() => void execute(r, plan).catch((err) => fail(r, err)), 50);
      return { invoiceId: id, state: r.summary.state, planId: plan.planId };
    },
    async reject(id) {
      const r = get(id);
      if (!['AWAITING_CONFIRMATION', 'BLOCKED', 'FAILED', 'SCHEDULED', 'CONFIRMED'].includes(r.summary.state)) {
        throw new ApiCallError('INVALID_TRANSITION', 'This invoice can no longer be rejected.');
      }
      setState(r, 'REJECTED');
      return { invoiceId: id, state: r.summary.state };
    },
    async wallet() {
      address ??= await wallet.receiveAddress();
      const assets = await wallet.listAssets();
      return {
        backend: 'mock',
        network: 'mock',
        ready: true,
        address,
        btcBalanceSats: '150000',
        assets: assets.map((a) => ({
          assetId: a.assetId,
          ticker: a.ticker,
          name: a.name,
          precision: a.precision,
          balance: a.balance,
        })),
      };
    },
    async receive(req) {
      if (req.assetId && !(await wallet.listAssets()).some((a) => a.assetId === req.assetId)) {
        throw new ApiCallError('UNKNOWN_ASSET', 'This wallet does not hold that asset.');
      }
      const inv = await wallet.createReceiveInvoice({
        ...(req.assetId ? { assetId: req.assetId } : {}),
        ...(req.amount ? { amount: req.amount } : {}),
        expirySec: (req.expiryMinutes ?? 60) * 60,
      });
      return {
        rgbInvoice: inv.rgbInvoice,
        expiresAt: inv.expiresAt,
        ...(inv.assetId ? { assetId: inv.assetId } : {}),
        ...(inv.amount ? { amount: inv.amount } : {}),
      };
    },
  };
}
