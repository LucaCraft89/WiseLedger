import { describe, expect, it } from 'vitest';
import type { AppEvent, InvoiceState, Stage } from './api/contracts.js';
import {
  AppEvent as AppEventSchema,
  InvoiceDetailResponse,
  InvoiceListResponse,
  WalletReceiveResponse,
  WalletResponse,
} from './api/contracts.js';
import { createFakeClient } from './api/fake.js';
import {
  ASSET_ID_HINT,
  assetIdHint,
  confirmGate,
  dialogSentence,
  gateHint,
  paidSentence,
  paymentProgress,
} from './lib/confirm.js';
import {
  buildFullTimeline,
  buildTimeline,
  describeHealth,
  formatAmount,
  STATE_LABELS,
  stateHistory,
  stateTone,
  VERDICT_LABELS,
} from './lib/format.js';
import { LIVE_TEXT_CAP, liveAiView, mergeEvents, toBaseUnits, toolCallLine, toolCallParts } from './lib/live.js';
import {
  canRetry,
  ERROR_WORDS,
  errorWords,
  explorerTxUrl,
  FLAG_TITLES,
  filterInvoices,
  flagTitle,
  SEVERITY_ICON_WORD,
  shortEvidence,
} from './lib/payment.js';

const fast = () => createFakeClient({ stageDelayMs: 0, transferStepMs: 0, pollMs: 1 });

async function waitForState(api: ReturnType<typeof fast>, id: string, state: InvoiceState) {
  for (let i = 0; i < 200; i++) {
    const d = await api.getInvoice(id);
    if (d.invoice.state === state) return d;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error(`timed out waiting for ${state}`);
}

describe('formatAmount', () => {
  it('formats base units at precision 6', () => {
    expect(formatAmount('25000000', 6)).toBe('25.00');
    expect(formatAmount('1', 6)).toBe('0.000001');
    expect(formatAmount('1234560000', 6)).toBe('1234.56');
    expect(formatAmount('0', 6)).toBe('0.00');
  });
});

describe('fake client', () => {
  it('walks an ok invoice to PAID with valid events', async () => {
    const api = fast();
    const { invoiceId } = await api.createInvoice({ text: 'Invoice 2026-042', filename: 'acme.txt' });
    const live: AppEvent[] = [];
    api.subscribe(invoiceId, (e) => live.push(e));

    const ready = await waitForState(api, invoiceId, 'AWAITING_CONFIRMATION');
    expect(ready.report?.verdict).toBe('ok');
    expect(ready.confirmationSentence).toContain('25.00 TUSDT');
    expect(InvoiceDetailResponse.safeParse(ready).success).toBe(true);

    const plan = ready.plan;
    if (!plan) throw new Error('no plan');
    await api.confirm(invoiceId, { planId: plan.planId });
    const paid = await waitForState(api, invoiceId, 'PAID');

    expect(paid.execution?.transferId).toBeTruthy();
    for (const e of live) expect(AppEventSchema.safeParse(e).success).toBe(true);
    expect(buildTimeline(paid.events).map((s) => s.stage)).toEqual([
      'reading',
      'extracting',
      'checking',
      'summarizing',
      'executing',
    ]);
  });

  it('blocks a scam invoice and requires the tick box on review', async () => {
    const api = fast();
    const scam = await api.createInvoice({ text: 'x', filename: 'scam.txt' });
    expect((await waitForState(api, scam.invoiceId, 'BLOCKED')).report?.verdict).toBe('block');

    const eur = await api.createInvoice({ text: 'x', filename: 'eur.txt' });
    const d = await waitForState(api, eur.invoiceId, 'AWAITING_CONFIRMATION');
    const planId = d.plan?.planId ?? '';
    await expect(api.confirm(eur.invoiceId, { planId })).rejects.toThrow(/tick the box/);
    await api.confirm(eur.invoiceId, { planId, override: true });
    await waitForState(api, eur.invoiceId, 'PAID');
  });
});

describe('plain-language labels', () => {
  it('names states and verdicts in plain words', () => {
    expect(STATE_LABELS.AWAITING_CONFIRMATION).toBe('Waiting for your OK');
    expect(STATE_LABELS.BLOCKED).toBe('Stopped: looks unsafe');
    expect(STATE_LABELS.PAID).toBe('Paid');
    expect(VERDICT_LABELS).toEqual({ ok: 'Looks fine', review: 'Check before paying', block: 'Do not pay' });
    expect(stateTone('PAID')).toBe('good');
    expect(stateTone('AWAITING_CONFIRMATION')).toBe('attention');
    expect(stateTone('BLOCKED')).toBe('bad');
    expect(stateTone('EXECUTING')).toBe('neutral');
  });

  it('describes health in plain words', () => {
    const d = describeHealth({
      ok: false,
      time: '2026-10-17T10:00:00.000Z',
      llm: { provider: 'qvac', model: 'Qwen3.5-2B', state: 'ready', onDevice: true },
      wallet: { backend: 'wdk-rgb', network: 'mutinynet', ready: false, blockHeight: 123 },
      problems: ['No TUSDT yet'],
    });
    expect(d.ai).toBe('AI: Qwen3.5-2B (QVAC) running on this device (ready)');
    expect(d.wallet).toBe('Wallet: wdk-rgb · network mutinynet · not ready · block 123');
    expect(d.overall).toMatch(/needs attention/);
  });

  it('always shows the four analysis steps, pending until started', () => {
    const at = '2026-10-17T10:00:00.000Z';
    const events: AppEvent[] = [
      { type: 'stage', at, stage: 'reading', status: 'start' },
      { type: 'stage', at, stage: 'reading', status: 'end' },
      { type: 'stage', at, stage: 'extracting', status: 'start' },
      { type: 'state', at, from: 'UPLOADED', to: 'EXTRACTED' },
    ];
    expect(buildFullTimeline(events).map((s) => [s.stage, s.status])).toEqual([
      ['reading', 'done'],
      ['extracting', 'running'],
      ['checking', 'pending'],
      ['summarizing', 'pending'],
    ]);
    const failed = [...events, { type: 'stage', at, stage: 'extracting', status: 'error' } as AppEvent];
    expect(buildFullTimeline(failed)[1]?.status).toBe('error');
    expect(stateHistory(events)).toEqual([{ at, label: STATE_LABELS.EXTRACTED }]);
  });
});

describe('fake listInvoices', () => {
  it('starts empty and lists invoices newest first with their summary', async () => {
    const api = fast();
    expect((await api.listInvoices()).invoices).toEqual([]);
    const a = await api.createInvoice({ text: 'x', filename: 'acme.txt' });
    const b = await api.createInvoice({ text: 'x', filename: 'scam.txt' });
    await waitForState(api, a.invoiceId, 'AWAITING_CONFIRMATION');
    await waitForState(api, b.invoiceId, 'BLOCKED');
    const list = await api.listInvoices();
    expect(InvoiceListResponse.safeParse(list).success).toBe(true);
    expect(list.invoices.map((i) => i.id)).toEqual([b.invoiceId, a.invoiceId]);
    expect(list.invoices[0]?.verdict).toBe('block');
    expect(list.invoices[1]?.state).toBe('AWAITING_CONFIRMATION');
  });
});

describe('confirmation dialog', () => {
  const tusdt = { assetId: 'rgb:mock-tusdt', ticker: 'TUSDT', precision: 6 };
  const plan = {
    amount: '25000000',
    assetId: 'rgb:mock-tusdt',
    payee: { name: 'Acme Srl' },
    executeAt: 'now' as const,
  };

  it('builds the exact sentence for the ok-basic plan', () => {
    expect(dialogSentence(plan, [tusdt])).toBe('Pay 25.00 TUSDT (asset rgb:mock-tusdt) to Acme Srl, now. Confirm?');
  });

  it('matches the asset by ID, never by ticker', () => {
    const other = { ...tusdt, assetId: 'rgb:other' };
    expect(dialogSentence(plan, [other])).toBe(
      'Pay 25000000 base units (asset rgb:mock-tusdt) to Acme Srl, now. Confirm?',
    );
  });

  it('explains the asset ID only when the sentence shows one', () => {
    expect(assetIdHint(dialogSentence(plan, [tusdt]))).toBe(ASSET_ID_HINT);
    expect(assetIdHint('Pay 25.00 TUSDT to Acme Srl, now. Confirm?')).toBeNull();
    expect(assetIdHint(undefined)).toBeNull();
  });

  it('the paid sentence never says "base units"', () => {
    expect(paidSentence(plan, [tusdt])).toBe('25.00 TUSDT (asset rgb:mock-tusdt) to Acme Srl');
    expect(paidSentence(plan, [])).toBe(
      '25000000 smallest units of an unknown token (asset rgb:mock-tusdt) to Acme Srl',
    );
  });

  it('gates confirm by verdict', () => {
    expect(confirmGate('ok', false)).toEqual({ canConfirm: true });
    expect(confirmGate('review', false)).toEqual({ canConfirm: false });
    expect(confirmGate('review', true)).toEqual({ canConfirm: true, override: true });
    expect(confirmGate('block', true)).toEqual({ canConfirm: false });
  });

  it('folds transfer events into the 4-step progress', () => {
    const at = '2026-10-17T10:00:00.000Z';
    const statuses = (p: ReturnType<typeof paymentProgress>) => p.steps.map((s) => s.status);
    const executing: AppEvent[] = [{ type: 'state', at, from: 'CONFIRMED', to: 'EXECUTING' }];
    expect(statuses(paymentProgress('EXECUTING', executing))).toEqual(['running', 'pending', 'pending', 'pending']);
    const waiting = [
      ...executing,
      { type: 'transfer', at, transferId: 't1', status: 'WaitingCounterparty' } as AppEvent,
    ];
    expect(statuses(paymentProgress('EXECUTING', waiting))).toEqual(['done', 'running', 'pending', 'pending']);
    const confirming = [
      ...waiting,
      { type: 'transfer', at, transferId: 't1', status: 'WaitingConfirmations', txid: 'tx1' } as AppEvent,
    ];
    const p = paymentProgress('EXECUTING', confirming);
    expect(statuses(p)).toEqual(['done', 'done', 'running', 'pending']);
    expect(p.txid).toBe('tx1');
    expect(statuses(paymentProgress('PAID', confirming))).toEqual(['done', 'done', 'done', 'done']);
    const failed = [
      ...waiting,
      { type: 'error', at, code: 'X', message: 'The supplier wallet did not answer.' } as AppEvent,
      { type: 'transfer', at, transferId: 't1', status: 'Failed' } as AppEvent,
    ];
    const f = paymentProgress('FAILED', failed);
    expect(f.failed).toBe(true);
    expect(f.errorMessage).toBe('The supplier wallet did not answer.');
    expect(statuses(f)).toEqual(['done', 'pending', 'pending', 'pending']);
  });
});

describe('fake confirm flows', () => {
  it('ok: wallet assets give the code-built sentence, confirm reaches Paid with transfer ID', async () => {
    const api = fast();
    const assets = (await api.wallet()).assets;
    expect(assets.map((a) => a.ticker)).toContain('TUSDT');
    const { invoiceId } = await api.createInvoice({ text: 'x', filename: 'acme.txt' });
    const d = await waitForState(api, invoiceId, 'AWAITING_CONFIRMATION');
    if (!d.plan) throw new Error('no plan');
    expect(dialogSentence(d.plan, assets)).toBe(d.confirmationSentence);
    await api.confirm(invoiceId, { planId: d.plan.planId, override: confirmGate('ok', false).override });
    const paid = await waitForState(api, invoiceId, 'PAID');
    const p = paymentProgress(paid.invoice.state, paid.events, paid.execution);
    expect(p.steps.every((s) => s.status === 'done')).toBe(true);
    expect(p.transferId).toBeTruthy();
  });

  it('block: no plan, confirm refused; reject archives it', async () => {
    const api = fast();
    const { invoiceId } = await api.createInvoice({ text: 'x', filename: 'scam.txt' });
    const d = await waitForState(api, invoiceId, 'BLOCKED');
    expect(d.plan).toBeUndefined();
    expect(confirmGate('block', true).canConfirm).toBe(false);
    await expect(api.confirm(invoiceId, { planId: 'x' })).rejects.toThrow(/not waiting/);
    expect((await api.reject(invoiceId)).state).toBe('REJECTED');
  });

  it('reject: an ok invoice can be refused, then cannot be confirmed', async () => {
    const api = fast();
    const { invoiceId } = await api.createInvoice({ text: 'x', filename: 'acme.txt' });
    const d = await waitForState(api, invoiceId, 'AWAITING_CONFIRMATION');
    expect((await api.reject(invoiceId, 'I do not know this supplier')).state).toBe('REJECTED');
    await expect(api.confirm(invoiceId, { planId: d.plan?.planId ?? '' })).rejects.toThrow(/not waiting/);
    await expect(api.reject(invoiceId)).rejects.toThrow(/no longer/);
  });
});

describe('live AI view', () => {
  const at = '2026-10-17T10:00:00.000Z';
  const stage = (s: Stage, status: 'start' | 'end') =>
    ({ type: 'stage', invoiceId: 'i', at, stage: s, status }) as AppEvent;
  const tok = (text: string, agent: 'analyst' | 'treasurer' = 'analyst') =>
    ({ type: 'token', invoiceId: 'i', at, agent, text }) as AppEvent;

  it('accumulates analyst tokens per stage and resets at each stage start', () => {
    let v = liveAiView([stage('extracting', 'start'), tok('{"a"'), tok(': 1}'), tok('ignored', 'treasurer')]);
    expect(v.stage).toBe('extracting');
    expect(v.text).toBe('{"a": 1}');
    v = liveAiView([
      stage('extracting', 'start'),
      tok('old'),
      stage('extracting', 'end'),
      stage('summarizing', 'start'),
      tok('new'),
    ]);
    expect(v.stage).toBe('summarizing');
    expect(v.text).toBe('new');
    v = liveAiView([stage('summarizing', 'start'), tok('x'), stage('analyzed', 'end')]);
    expect(v.stage).toBeUndefined();
    expect(v.finished).toBe(true);
  });

  it('keeps only the last characters', () => {
    const v = liveAiView([stage('summarizing', 'start'), tok('a'.repeat(500)), tok('b'.repeat(500))]);
    expect(v.text).toHaveLength(LIVE_TEXT_CAP);
    expect(v.text.endsWith('b')).toBe(true);
  });

  it('merges replayed events without dropping repeated live tokens', () => {
    const t = tok(' the');
    let list = mergeEvents([], [t], true);
    list = mergeEvents(list, [t], true);
    expect(list).toHaveLength(2);
    // A replay from GET with the same two tokens adds nothing; a third one is added.
    expect(mergeEvents(list, [t, t])).toHaveLength(2);
    expect(mergeEvents(list, [t, t, t])).toHaveLength(3);
    const s = stage('reading', 'start');
    expect(mergeEvents([s], [s], true)).toHaveLength(1);
  });

  it('describes a tool call in one line', () => {
    expect(
      toolCallLine({
        type: 'toolCall',
        at,
        agent: 'treasurer',
        name: 'execute_plan',
        args: { planId: 'p1' },
        status: 'ok',
      }),
    ).toBe('Treasurer: Sending the payment you confirmed: done (execute_plan(planId=p1))');
  });

  it('tool call lines shorten long IDs and name unknown tools plainly', () => {
    const p = toolCallParts({
      type: 'toolCall',
      at,
      agent: 'treasurer',
      name: 'mystery_tool',
      args: { planId: 'a'.repeat(64), n: 2 },
      status: 'rejected',
      message: 'over the limit',
    });
    expect(p.text).toBe('Treasurer: Using the tool mystery_tool: refused, over the limit');
    expect(p.tech).toBe('mystery_tool(planId=aaaaaa…aaaaaa, n=2)');
  });

  it('fake analysis emits analyst tokens for each stage', async () => {
    const api = fast();
    const { invoiceId } = await api.createInvoice({ text: 'x', filename: 'acme.txt' });
    const d = await waitForState(api, invoiceId, 'AWAITING_CONFIRMATION');
    const tokenStages = new Set<string>();
    let current = '';
    for (const e of d.events) {
      if (e.type === 'stage' && e.status === 'start') current = e.stage;
      if (e.type === 'token') tokenStages.add(current);
    }
    expect([...tokenStages]).toEqual(['reading', 'extracting', 'checking', 'summarizing']);
  });
});

describe('receive form', () => {
  it('converts tokens to base units with the asset precision', () => {
    expect(toBaseUnits('12.5', 6)).toEqual({ ok: true, value: '12500000' });
    expect(toBaseUnits('0,000001', 6)).toEqual({ ok: true, value: '1' });
    expect(toBaseUnits('25', 6)).toEqual({ ok: true, value: '25000000' });
    expect(toBaseUnits('7', 0)).toEqual({ ok: true, value: '7' });
    expect(toBaseUnits('', 6)).toEqual({ ok: true });
    expect(toBaseUnits('1.1234567', 6).ok).toBe(false);
    expect(toBaseUnits('abc', 6).ok).toBe(false);
    expect(toBaseUnits('0', 6).ok).toBe(false);
    expect(toBaseUnits('-1', 6).ok).toBe(false);
  });

  it('fake wallet returns an address and creates a receive invoice', async () => {
    const api = fast();
    const w = await api.wallet();
    expect(WalletResponse.safeParse(w).success).toBe(true);
    expect(w.address).toBeTruthy();
    const asset = w.assets[0];
    if (!asset) throw new Error('no asset');
    const before = Date.now();
    const res = await api.receive({ assetId: asset.assetId, amount: '5000000', expiryMinutes: 30 });
    expect(WalletReceiveResponse.safeParse(res).success).toBe(true);
    expect(res.amount).toBe('5000000');
    expect(res.rgbInvoice).toBeTruthy();
    const expires = new Date(res.expiresAt).getTime();
    expect(expires).toBeGreaterThan(before + 29 * 60_000);
    expect(expires).toBeLessThan(before + 31 * 60_000);
    await expect(api.receive({ assetId: 'rgb:nope' })).rejects.toThrow('does not hold');
  });
});

describe('flag cards', () => {
  it('has a plain title for every rule code', () => {
    const codes = [
      'R1_RGB_INVOICE',
      'R2_ASSET',
      'R3_AMOUNT',
      'R4_DUPLICATE',
      'R5_NEW_PAYEE',
      'R6_PRESSURE',
      'R7_INJECTION',
      'R8_CURRENCY',
      'R9_MISSING_FIELDS',
      'R10_DATES',
      'AI_UNAVAILABLE',
    ];
    for (const c of codes) expect(FLAG_TITLES[c], c).toBeTruthy();
    expect(flagTitle('R4_DUPLICATE')).toBe('Already received');
    expect(flagTitle('R7_INJECTION')).toBe('Hidden orders to the AI');
    expect(flagTitle('R3_AMOUNT')).toBe('Amount problem');
    expect(flagTitle('R1_RGB_INVOICE')).toBe('Payment request problem');
    expect(flagTitle('AI_UNAVAILABLE')).toBe('The AI could not read this invoice');
    expect(flagTitle('R99_NEW')).toBe('Something to check');
    expect(SEVERITY_ICON_WORD).toEqual({ block: 'Stop', warn: 'Check', info: 'Note' });
  });

  it('cuts evidence to one line of about 80 characters', () => {
    expect(shortEvidence('our bank\n details  changed')).toBe('our bank details changed');
    const long = shortEvidence('x'.repeat(200));
    expect(long.length).toBe(80);
    expect(long.endsWith('…')).toBe(true);
  });

  it('states the override rule next to the button', () => {
    expect(gateHint('block', true)).toMatch(/cannot pay/);
    expect(gateHint('review', false)).toMatch(/Tick the box/);
    expect(gateHint('review', true)).toMatch(/can pay now/);
  });
});

describe('failure card', () => {
  it('allows retry only when nothing can have been sent', () => {
    expect(canRetry('NoUtxo')).toBe(true);
    expect(canRetry('TREASURER_PARSE')).toBe(true);
    expect(canRetry('TransferFailed')).toBe(false);
    expect(canRetry('InsufficientFunds')).toBe(true);
    expect(canRetry('InsufficientFunds', 'tr_1')).toBe(false);
    expect(canRetry('NoUtxo', 'tr_1')).toBe(false);
    expect(canRetry('SubmitTimeout')).toBe(false);
    expect(canRetry('already_executed')).toBe(false);
    expect(canRetry('InvoiceExpired')).toBe(true);
    expect(canRetry('PolicyDenied')).toBe(true);
    for (const code of [
      'unknown_plan',
      'not_confirmed',
      'hash_mismatch',
      'over_cap',
      'asset_not_allowed',
      'insufficient_funds',
      'invoice_expired',
      'policy_denied',
      'FAKE_ERROR',
    ])
      expect(canRetry(code), code).toBe(false);
    expect(canRetry(undefined)).toBe(false);
  });

  it('maps every typed error to plain words', () => {
    expect(errorWords('SubmitTimeout')).toMatch(/do NOT pay again/);
    expect(errorWords('InsufficientFunds')).toBe('Not enough funds in the wallet.');
    expect(errorWords('TREASURER_PARSE')).toBe('The AI could not start the payment. Nothing was sent.');
    expect(errorWords('weird', 'Server text')).toBe('Server text');
    expect(errorWords(undefined)).toBe(
      'The payment failed. Nothing is retried automatically: check My invoices before paying again.',
    );
    for (const [code, words] of Object.entries(ERROR_WORDS)) expect(words, code).not.toMatch(/_/);
  });

  it('fake: a *fail* invoice ends in TransferFailed, which is not retried (it may have been signed)', async () => {
    const api = fast();
    const { invoiceId } = await api.createInvoice({ text: 'x', filename: 'fail.txt' });
    const d = await waitForState(api, invoiceId, 'AWAITING_CONFIRMATION');
    if (!d.plan) throw new Error('no plan');
    await api.confirm(invoiceId, { planId: d.plan.planId });
    const f = await waitForState(api, invoiceId, 'FAILED');
    const p = paymentProgress(f.invoice.state, f.events, f.execution);
    expect(p.failed).toBe(true);
    expect(p.errorCode).toBe('TransferFailed');
    expect(canRetry(p.errorCode, p.transferId)).toBe(false);
  });

  it('fake: a *timeout* invoice fails with SubmitTimeout and no retry', async () => {
    const api = fast();
    const { invoiceId } = await api.createInvoice({ text: 'x', filename: 'timeout.txt' });
    const d = await waitForState(api, invoiceId, 'AWAITING_CONFIRMATION');
    if (!d.plan) throw new Error('no plan');
    await api.confirm(invoiceId, { planId: d.plan.planId });
    const f = await waitForState(api, invoiceId, 'FAILED');
    const p = paymentProgress(f.invoice.state, f.events, f.execution);
    expect(p.errorCode).toBe('SubmitTimeout');
    expect(canRetry(p.errorCode, p.transferId)).toBe(false);
  });
});

describe('explorer link', () => {
  it('builds the Mutinynet tx URL by default and trims a trailing slash', () => {
    expect(explorerTxUrl('abc123')).toBe('https://mutinynet.com/tx/abc123');
    expect(explorerTxUrl('abc123', 'https://mempool.space/signet/')).toBe('https://mempool.space/signet/tx/abc123');
  });
});

describe('history filter', () => {
  const list = (
    ['AWAITING_CONFIRMATION', 'PAID', 'SCHEDULED', 'BLOCKED', 'REJECTED', 'FAILED', 'EXECUTING'] as const
  ).map((state) => ({ state }));
  it('groups invoices by what the user cares about', () => {
    expect(filterInvoices(list, 'all')).toHaveLength(7);
    expect(filterInvoices(list, 'waiting').map((i) => i.state)).toEqual(['AWAITING_CONFIRMATION']);
    expect(filterInvoices(list, 'paid').map((i) => i.state)).toEqual(['PAID']);
    expect(filterInvoices(list, 'stopped').map((i) => i.state)).toEqual(['BLOCKED', 'REJECTED']);
    expect(filterInvoices(list, 'failed').map((i) => i.state)).toEqual(['FAILED']);
  });
});

describe('payment stepper', () => {
  it('marks Submitted done once execute_plan succeeded', () => {
    const at = new Date().toISOString();
    const events: AppEvent[] = [
      {
        type: 'toolCall',
        invoiceId: 'i',
        at,
        agent: 'treasurer',
        name: 'execute_plan',
        args: {},
        status: 'ok',
      },
    ];
    expect(paymentProgress('EXECUTING', events).steps.map((s) => s.status)).toEqual([
      'done',
      'running',
      'pending',
      'pending',
    ]);
  });
});
