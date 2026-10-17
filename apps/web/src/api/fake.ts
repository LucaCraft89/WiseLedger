// In-browser fake backend: walks the same lifecycle as A's server using the core mocks.
// Verdict by file name (MockAnalyzer): *scam* / *inject* → block, *eur* → review, anything else → ok.
// Payment outcome by file name: *fail* → TransferFailed, *timeout* → SubmitTimeout (MockWallet amounts).

import type { ApiClient, InvoiceInput } from './client.js';
import { ApiCallError } from './client.js';
import {
  type AnalysisReport,
  type AppEvent,
  buildConfirmationSentence,
  type ChatResponse,
  type ExecutionResult,
  formatAssetAmount,
  type InvoiceSourceKind,
  type InvoiceState,
  type InvoiceSummaryDto,
  LabelsPutRequest,
  MOCK_ASSET_ID,
  MOCK_FAIL_AMOUNT,
  MOCK_TIMEOUT_AMOUNT,
  MemoryJobStore,
  MemoryLabelStore,
  MockAnalyzer,
  MockTreasurer,
  MockWallet,
  makePlan,
  mockInvoice,
  type PaymentPlan,
  sha256Hex,
  type TransferDto,
} from './contracts.js';

const MONTHS = [
  'january',
  'february',
  'march',
  'april',
  'may',
  'june',
  'july',
  'august',
  'september',
  'october',
  'november',
  'december',
];
const pad2 = (n: number) => String(n).padStart(2, '0');

/** Next Friday (never today) at 09:00 local time. */
export function nextFriday(now: Date = new Date()): Date {
  const d = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 9, 0, 0, 0);
  d.setDate(d.getDate() + ((5 - d.getDay() + 7) % 7 || 7));
  return d;
}

/** Month named in the message (the most recent past one), else the previous month: first and last day. */
export function monthRange(message: string, now: Date = new Date()): { from: string; to: string; label: string } {
  const lower = message.toLowerCase();
  const named = MONTHS.findIndex((m) => lower.includes(m));
  let year = now.getFullYear();
  let month = named;
  if (named < 0) {
    month = now.getMonth() - 1;
    if (month < 0) {
      month = 11;
      year -= 1;
    }
  } else if (named >= now.getMonth()) year -= 1;
  const last = new Date(year, month + 1, 0).getDate();
  const label = `${MONTHS[month]?.replace(/^./, (c) => c.toUpperCase())} ${year}`;
  return { from: `${year}-${pad2(month + 1)}-01`, to: `${year}-${pad2(month + 1)}-${pad2(last)}`, label };
}

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
  const stageDelayMs = opts.stageDelayMs ?? 600;
  const analyzer = new MockAnalyzer({ stageDelayMs });
  const failAnalyzer = new MockAnalyzer({ stageDelayMs, amount: MOCK_FAIL_AMOUNT });
  const timeoutAnalyzer = new MockAnalyzer({ stageDelayMs, amount: MOCK_TIMEOUT_AMOUNT });
  const analyzerFor = (name: string) => {
    const n = name.toLowerCase();
    return n.includes('timeout') ? timeoutAnalyzer : n.includes('fail') ? failAnalyzer : analyzer;
  };
  const treasurer = new MockTreasurer(wallet, { pollMs: opts.pollMs ?? 250 });
  const recs = new Map<string, Rec>();
  let seq = 0;
  let address: string | undefined;
  const jobs = new MemoryJobStore();
  const labels = new MemoryLabelStore();
  const transferInvoice = new Map<string, string>();
  let jobSeq = 0;

  // Two past payments, so the transfers table, labels and "my last payment" have something to work with.
  let seeded: Promise<void> | undefined;
  const seed = () => {
    seeded ??= (async () => {
      const far = Math.floor(Date.now() / 1000) + 365 * 86_400;
      for (const amount of ['120000000', '25000000']) {
        await wallet.pay({ assetId: MOCK_ASSET_ID, amount, rgbInvoice: mockInvoice(MOCK_ASSET_ID, amount, far) });
      }
    })();
    return seeded;
  };

  async function transferList(): Promise<TransferDto[]> {
    await seed();
    const list = (await wallet.listTransfers()).reverse();
    return Promise.all(
      list.map(async (t) => ({
        transferId: t.transferId,
        ...(t.assetId ? { assetId: t.assetId } : {}),
        amount: t.amount,
        direction: t.direction === 'outgoing' ? ('out' as const) : ('in' as const),
        status: t.status,
        ...(t.txid ? { txid: t.txid } : {}),
        ...(transferInvoice.has(t.transferId) ? { invoiceId: transferInvoice.get(t.transferId) } : {}),
        labels: (await labels.get(t.transferId))?.labels ?? [],
        createdAt: t.createdAt,
        updatedAt: t.updatedAt,
      })),
    );
  }

  async function assetMeta(assetId: string) {
    return (await wallet.listAssets()).find((a) => a.assetId === assetId);
  }

  /** Pattern-matches the four example requests; the real Treasurer runs the local model with tools. */
  async function fakeChat(message: string): Promise<ChatResponse> {
    const m = message.toLowerCase();
    if (/balance|how much/.test(m)) {
      const assets = await wallet.listAssets();
      const result = assets.map((a) => ({
        assetId: a.assetId,
        ticker: a.ticker,
        precision: a.precision,
        spendable: a.balance.spendable,
        settled: a.balance.settled,
      }));
      const t = assets.find((a) => a.ticker === 'TUSDT') ?? assets[0];
      const text = t
        ? `You can spend ${formatAssetAmount(t.balance.spendable, t.precision)} ${t.ticker} (${formatAssetAmount(t.balance.settled, t.precision)} confirmed).`
        : 'This wallet holds no assets yet.';
      return { text, toolCalls: [{ name: 'get_balance', args: { assetId: 'TUSDT' }, ok: true, result }] };
    }
    const labelMatch = /label .*last payment as\s+["']?([^"'.]+)/i.exec(message);
    if (labelMatch?.[1]) {
      const label = labelMatch[1].trim().toLowerCase().slice(0, 40);
      const outgoing = (await transferList()).filter((t) => t.direction === 'out');
      const listCall = {
        name: 'list_transfers',
        args: {},
        ok: true,
        result: outgoing.slice(0, 10).map((t) => ({ transferId: t.transferId, amount: t.amount, labels: t.labels })),
      };
      const last = outgoing[0];
      if (!last) return { text: 'There are no payments to label yet.', toolCalls: [listCall] };
      const current = (await labels.get(last.transferId))?.labels ?? [];
      const entry = await labels.set(last.transferId, [...new Set([...current, label])]);
      const asset = last.assetId ? await assetMeta(last.assetId) : undefined;
      const amount = asset ? `${formatAssetAmount(last.amount, asset.precision)} ${asset.ticker}` : last.amount;
      return {
        text: `Done: your last payment (${amount}) is now labelled "${label}".`,
        toolCalls: [
          listCall,
          { name: 'label_transfer', args: { transferId: last.transferId, label }, ok: true, result: entry },
        ],
      };
    }
    if (/report|fiscal|tax/.test(m)) {
      const r = monthRange(message);
      const rows = (await transferList()).filter(
        (t) => t.createdAt.slice(0, 10) >= r.from && t.createdAt.slice(0, 10) <= r.to,
      ).length;
      const filename = `wiseledger-report-${r.from}_${r.to}.csv`;
      return {
        text: `Your report for ${r.label} is ready (${rows} transfers). Use the Download link.`,
        toolCalls: [
          {
            name: 'fiscal_report',
            args: { from: r.from, to: r.to, format: 'csv' },
            ok: true,
            result: { filename, format: 'csv', rows, from: r.from, to: r.to },
          },
        ],
      };
    }
    if (/\bpay\b/.test(m)) {
      const target = [...recs.values()]
        .reverse()
        .find(
          (r) =>
            r.summary.state === 'AWAITING_CONFIRMATION' &&
            r.plan &&
            (!/acme/.test(m) || (r.summary.issuerName ?? '').toLowerCase().includes('acme')),
        );
      if (!target?.plan) {
        return {
          text: 'I could not find an invoice waiting for payment. Check the invoice first (any file name works in demo mode), then ask me again.',
          toolCalls: [{ name: 'schedule_payment', args: {}, ok: false, error: 'No invoice waiting for payment' }],
        };
      }
      const executeAt = (/friday/.test(m) ? nextFriday() : new Date(Date.now() + 86_400_000)).toISOString();
      const invoiceId = target.summary.id;
      const sentence = buildConfirmationSentence(
        { ...target.plan, executeAt },
        await assetMeta(target.plan.assetId),
      );
      const needsConfirmation = {
        needsConfirmation: true as const,
        kind: 'schedule' as const,
        planId: target.plan.planId,
        invoiceId,
        sentence,
      };
      return {
        text: `Please confirm: ${sentence}`,
        toolCalls: [
          { name: 'schedule_payment', args: { invoiceId, executeAt }, ok: true, result: needsConfirmation },
        ],
        needsConfirmation,
      };
    }
    return {
      text: 'In demo mode I understand: your balance, labelling your last payment, a report for a month, and paying the Acme invoice on Friday.',
      toolCalls: [],
    };
  }

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
    const report = await analyzerFor(filename).analyze(
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
    if (result.transferId) transferInvoice.set(result.transferId, id);
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
      if (req.executeAt) {
        if (Number.isNaN(Date.parse(req.executeAt)) || Date.parse(req.executeAt) <= Date.now()) {
          throw new ApiCallError('BAD_DATE', 'The payment date must be in the future.');
        }
        const scheduled: PaymentPlan = { ...r.plan, executeAt: req.executeAt };
        r.plan = scheduled;
        r.confirmationSentence = buildConfirmationSentence(scheduled, await assetMeta(scheduled.assetId));
        setState(r, 'CONFIRMED');
        const now = new Date().toISOString();
        await jobs.put({
          jobId: `job_fake_${++jobSeq}`,
          planId: scheduled.planId,
          invoiceId: id,
          runAt: req.executeAt,
          status: 'pending',
          createdAt: now,
          updatedAt: now,
        });
        setState(r, 'SCHEDULED');
        return { invoiceId: id, state: r.summary.state, planId: scheduled.planId };
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
    async transfers() {
      return { transfers: await transferList() };
    },
    async setLabels(transferId, req) {
      const parsed = LabelsPutRequest.safeParse(req);
      if (!parsed.success) {
        throw new ApiCallError('BAD_LABELS', 'Labels must be 1 to 40 characters, at most 10 per transfer.');
      }
      if (!(await wallet.getTransfer(transferId))) throw new ApiCallError('NOT_FOUND', 'This transfer does not exist.');
      const clean = [...new Set(parsed.data.labels.map((l) => l.trim().toLowerCase()))];
      return labels.set(transferId, clean);
    },
    chat: (req) => fakeChat(req.message),
    async schedule() {
      return { jobs: await jobs.list() };
    },
    async cancelJob(jobId) {
      const job = (await jobs.list()).find((j) => j.jobId === jobId);
      const ok = await jobs.cancel(jobId);
      const r = job ? recs.get(job.invoiceId) : undefined;
      if (ok && r?.plan && r.summary.state === 'SCHEDULED') {
        r.plan = { ...r.plan, executeAt: 'now' };
        r.confirmationSentence = buildConfirmationSentence(r.plan, await assetMeta(r.plan.assetId));
        setState(r, 'AWAITING_CONFIRMATION');
      }
      return { ok };
    },
    fiscalUrl: () => null,
  };
}
