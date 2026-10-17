import { describe, expect, it } from 'vitest';
import type { AppEvent, InvoiceState } from './api/contracts.js';
import { AppEvent as AppEventSchema, InvoiceDetailResponse } from './api/contracts.js';
import { createFakeClient } from './api/fake.js';
import { buildTimeline, formatAmount } from './lib/format.js';

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
