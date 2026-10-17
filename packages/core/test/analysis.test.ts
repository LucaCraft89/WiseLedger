import { describe, expect, it } from 'vitest';
import { AnalysisReport, computeVerdict, InvoiceExtraction, type RiskFlag } from '../src/analysis.js';
import {
  ApiError,
  ChatRequest,
  ChatResponse,
  ConfirmRequest,
  ConfirmResponse,
  CreateInvoiceResponse,
  CreateInvoiceTextRequest,
  HealthResponse,
  InvoiceDetailResponse,
  InvoiceListResponse,
  RejectRequest,
  RejectResponse,
  TransfersResponse,
  WalletReceiveRequest,
  WalletReceiveResponse,
  WalletResponse,
} from '../src/api.js';
import { AppEvent } from '../src/events.js';
import { assertRequestShape, type CompletionRequest } from '../src/llm.js';
import { MockAnalyzer } from '../src/mocks/mock-analyzer.js';
import { MockLlm } from '../src/mocks/mock-llm.js';
import { MockTreasurer } from '../src/mocks/mock-treasurer.js';

const NOW = '2026-10-17T09:45:00.000Z';
const SHA = 'a'.repeat(64);

const extraction: InvoiceExtraction = {
  issuer: { name: 'Acme Srl', vatId: 'IT01234567890' },
  invoiceNumber: '2026-042',
  currency: 'TUSDT',
  total: '25.00',
  lineItems: [{ description: 'Hosting', quantity: 1, unitPrice: '25.00', amount: '25.00' }],
  payment: { method: 'rgb', rgbInvoice: 'rgb:mock/rgb:mock-tusdt/25000000/1800000000' },
  fieldConfidence: { total: 0.9 },
};

const validReport: AnalysisReport = {
  invoiceId: 'inv_1',
  extraction,
  flags: [{ code: 'R5_NEW_PAYEE', severity: 'warn', message: 'New supplier.' }],
  verdict: 'review',
  proposedPayment: {
    rgbInvoice: 'rgb:mock/rgb:mock-tusdt/25000000/1800000000',
    assetId: 'rgb:mock-tusdt',
    amount: '25000000',
    payee: 'Acme Srl',
  },
  summary: 'Acme asks 25 TUSDT.',
  questionsForUser: [],
  model: { name: 'mock', provider: 'mock' },
  createdAt: NOW,
};

describe('AnalysisReport', () => {
  it('parses a valid report', () => {
    expect(AnalysisReport.parse(validReport)).toEqual(validReport);
  });

  it('rejects an invalid report', () => {
    const bad = [
      { ...validReport, verdict: 'maybe' },
      { ...validReport, proposedPayment: { ...validReport.proposedPayment, amount: '25.00' } },
      { ...validReport, flags: [{ code: 'X', severity: 'fatal', message: 'm' }] },
      { ...validReport, createdAt: 'yesterday' },
      { ...validReport, extraction: { ...extraction, payment: { method: 'paypal' } } },
      { ...validReport, extraction: { ...extraction, fieldConfidence: { total: 3 } } },
    ];
    for (const b of bad) expect(AnalysisReport.safeParse(b).success).toBe(false);
  });

  it('computes the verdict from flags only', () => {
    const f = (severity: RiskFlag['severity']): RiskFlag => ({ code: 'X', severity, message: 'm' });
    expect(computeVerdict([])).toBe('ok');
    expect(computeVerdict([f('info')])).toBe('ok');
    expect(computeVerdict([f('info'), f('warn')])).toBe('review');
    expect(computeVerdict([f('warn'), f('block')])).toBe('block');
  });
});

describe('API DTOs', () => {
  const summary = {
    id: 'inv_1',
    filename: 'ok-basic.txt',
    kind: 'text',
    state: 'ANALYZED',
    verdict: 'ok',
    createdAt: NOW,
    updatedAt: NOW,
  };
  const transfer = {
    transferId: 't1',
    assetId: 'rgb:mock-tusdt',
    amount: '25000000',
    direction: 'out',
    status: 'Settled',
    labels: ['hosting'],
    createdAt: NOW,
  };
  const cases: [string, { safeParse(v: unknown): { success: boolean } }, unknown, unknown][] = [
    ['ApiError', ApiError, { error: { code: 'NOT_FOUND', message: 'Invoice not found.' } }, { error: 'x' }],
    ['CreateInvoiceTextRequest', CreateInvoiceTextRequest, { text: 'Invoice…' }, { text: '' }],
    ['CreateInvoiceResponse', CreateInvoiceResponse, { invoiceId: 'inv_1', state: 'UPLOADED' }, { invoiceId: 'inv_1' }],
    ['InvoiceListResponse', InvoiceListResponse, { invoices: [summary] }, { invoices: [{ ...summary, kind: 'doc' }] }],
    [
      'InvoiceDetailResponse',
      InvoiceDetailResponse,
      {
        invoice: summary,
        report: validReport,
        events: [{ type: 'stage', invoiceId: 'inv_1', at: NOW, stage: 'reading', status: 'start' }],
      },
      { invoice: summary, events: [{ type: 'nope', at: NOW }] },
    ],
    ['ConfirmRequest', ConfirmRequest, { planId: 'p1', override: true }, { override: true }],
    [
      'ConfirmResponse',
      ConfirmResponse,
      { invoiceId: 'inv_1', state: 'EXECUTING', planId: 'p1', execution: { planId: 'p1', status: 'submitted' } },
      { invoiceId: 'inv_1', state: 'EXECUTING' },
    ],
    ['RejectRequest', RejectRequest, {}, { reason: 'x'.repeat(501) }],
    ['RejectResponse', RejectResponse, { invoiceId: 'inv_1', state: 'REJECTED' }, { invoiceId: 'inv_1', state: '' }],
    [
      'WalletResponse',
      WalletResponse,
      {
        backend: 'mock',
        network: 'regtest',
        ready: true,
        assets: [
          {
            assetId: 'rgb:mock-tusdt',
            ticker: 'TUSDT',
            name: 'Test USDT',
            precision: 6,
            balance: { settled: '1000000000', future: '1000000000', spendable: '1000000000' },
          },
        ],
      },
      { backend: 'mock', network: 'mainnet', ready: true, assets: [] },
    ],
    ['WalletReceiveRequest', WalletReceiveRequest, { amount: '5000000', expiryMinutes: 60 }, { amount: '5.0' }],
    ['WalletReceiveResponse', WalletReceiveResponse, { rgbInvoice: 'rgb:…', expiresAt: NOW }, { rgbInvoice: 'rgb:…' }],
    ['TransfersResponse', TransfersResponse, { transfers: [transfer] }, { transfers: [{ ...transfer, status: 'Done' }] }],
    ['ChatRequest', ChatRequest, { message: 'what is my balance' }, { message: '' }],
    [
      'ChatResponse',
      ChatResponse,
      { text: 'You have 1000 TUSDT.', toolCalls: [{ name: 'get_balance', args: {}, ok: true }] },
      { text: 'x', toolCalls: [{ name: 'get_balance' }] },
    ],
    [
      'HealthResponse',
      HealthResponse,
      {
        ok: true,
        time: NOW,
        llm: { provider: 'mock', model: 'mock', state: 'ready', onDevice: true },
        wallet: { backend: 'mock', network: 'regtest', ready: true },
        problems: [],
      },
      { ok: true, time: NOW, llm: { provider: 'gpt', model: 'x', state: 'ready', onDevice: false } },
    ],
  ];

  for (const [name, schema, good, bad] of cases) {
    it(`${name} accepts valid and rejects invalid`, () => {
      expect(schema.safeParse(good).success).toBe(true);
      expect(schema.safeParse(bad).success).toBe(false);
    });
  }
});

describe('LLM request shape', () => {
  it('refuses responseFormat together with tools', () => {
    const req = {
      messages: [],
      responseFormat: { type: 'json_schema', json_schema: { name: 'x', schema: {} } },
      tools: [{ name: 't', description: 'd', parameters: {} }],
    } as unknown as CompletionRequest;
    expect(() => assertRequestShape(req)).toThrow();
  });
});

describe('mocks', () => {
  it('MockLlm replays canned text, JSON and tool calls in order', async () => {
    const llm = new MockLlm({
      replies: [{ json: { a: 1 } }, { toolCall: { name: 'execute_plan', arguments: { planId: 'p1' } } }],
    });
    const r1 = await llm.complete({
      messages: [{ role: 'user', content: 'x' }],
      responseFormat: { type: 'json_schema', json_schema: { name: 'x', schema: {} } },
    });
    expect(r1.json).toEqual({ a: 1 });
    const r2 = await llm.complete({ messages: [], tools: [], toolChoice: { name: 'execute_plan' } });
    expect(r2.toolCalls[0]).toMatchObject({ name: 'execute_plan', arguments: { planId: 'p1' } });
    const events = [];
    for await (const e of llm.stream({ messages: [] })) events.push(e);
    expect(events.at(-1)).toMatchObject({ type: 'done', result: { text: 'ok' } });
    expect(llm.calls).toHaveLength(3);
  });

  it('MockAnalyzer routes verdict by file name and emits valid events', async () => {
    const analyzer = new MockAnalyzer({ stageDelayMs: 0 });
    const verdicts: Record<string, string> = {};
    for (const file of ['ok-basic.txt', 'scam-bank-change.pdf', 'injection.txt', 'ok-eur.png']) {
      const events: unknown[] = [];
      const report = await analyzer.analyze(
        { kind: 'text', path: `/tmp/uploads/${file}`, sha256: SHA },
        { invoiceId: file },
        (e) => events.push(e),
      );
      expect(AnalysisReport.safeParse(report).success).toBe(true);
      for (const e of events) expect(AppEvent.safeParse(e).success).toBe(true);
      verdicts[file] = report.verdict;
    }
    expect(verdicts).toEqual({
      'ok-basic.txt': 'ok',
      'scam-bank-change.pdf': 'block',
      'injection.txt': 'block',
      'ok-eur.png': 'review',
    });
  });

  it('MockTreasurer pays a confirmed plan and follows it to Settled', async () => {
    const statuses = ['WaitingConfirmations', 'Settled'] as const;
    let polls = 0;
    const paid: unknown[] = [];
    const wallet = {
      pay: async (req: unknown) => {
        paid.push(req);
        return { transferId: 't1' };
      },
      getTransfer: async () => ({ status: statuses[Math.min(polls++, 1)], txid: 'abc' }),
    };
    // Only pay/getTransfer are used; the rest of WalletPort is irrelevant here.
    const treasurer = new MockTreasurer(wallet as never, { pollMs: 0 });
    const plan = {
      planId: 'p1',
      invoiceId: 'inv_1',
      rgbInvoice: 'rgb:mock/rgb:mock-tusdt/25000000/1800000000',
      assetId: 'rgb:mock-tusdt',
      amount: '25000000',
      payee: 'Acme Srl',
      executeAt: 'now',
      labels: [],
    };
    const events: unknown[] = [];
    const ok = await treasurer.execute(plan as never, { planId: 'p1', confirmedAt: NOW } as never, (e) => events.push(e));
    expect(ok).toMatchObject({ planId: 'p1', status: 'settled', transferId: 't1', txid: 'abc' });
    for (const e of events) expect(AppEvent.safeParse(e).success).toBe(true);

    const bad = await treasurer.execute(plan as never, { planId: 'other', confirmedAt: NOW } as never, () => {});
    expect(bad.status).toBe('failed');
    expect(paid).toHaveLength(1);
  });
});
