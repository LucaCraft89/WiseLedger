import { describe, expect, it } from 'vitest';
import type { AppEvent, InvoiceState } from './api/contracts.js';
import { AppEvent as AppEventSchema, InvoiceDetailResponse, InvoiceListResponse } from './api/contracts.js';
import { createFakeClient } from './api/fake.js';
import { confirmGate, dialogSentence, paymentProgress } from './lib/confirm.js';
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
