import { describe, expect, it } from 'vitest';
import {
  assertTransition,
  canonicalJson,
  canTransition,
  computePlanId,
  IllegalTransition,
  INVOICE_TRANSITIONS,
  InvoiceStateSchema,
  makePlan,
  type PaymentPlanInput,
  verifyPlanId,
} from '../src/index.js';

const input: PaymentPlanInput = {
  invoiceId: 'inv-1',
  rgbInvoice: 'rgb:mock/rgb:mock-tusdt/25000000/4102444800',
  assetId: 'rgb:mock-tusdt',
  amount: '25000000',
  payee: { name: 'Acme Srl' },
  executeAt: 'now',
  labels: ['supplier'],
};

describe('canTransition', () => {
  it('allows the happy path', () => {
    const path = [
      'UPLOADED',
      'EXTRACTED',
      'ANALYZED',
      'AWAITING_CONFIRMATION',
      'CONFIRMED',
      'EXECUTING',
      'PAID',
    ] as const;
    for (const [i, to] of path.slice(1).entries()) {
      expect(canTransition(path[i] ?? 'UPLOADED', to)).toBe(true);
    }
  });

  it('allows scheduling and blocking', () => {
    expect(canTransition('EXECUTING', 'SCHEDULED')).toBe(true);
    expect(canTransition('SCHEDULED', 'EXECUTING')).toBe(true);
    expect(canTransition('ANALYZED', 'BLOCKED')).toBe(true);
    expect(canTransition('CONFIRMED', 'BLOCKED')).toBe(true);
  });

  it('refuses skipping confirmation and leaving terminal states', () => {
    expect(canTransition('ANALYZED', 'EXECUTING')).toBe(false);
    expect(canTransition('AWAITING_CONFIRMATION', 'EXECUTING')).toBe(false);
    expect(canTransition('BLOCKED', 'CONFIRMED')).toBe(false);
    expect(canTransition('PAID', 'EXECUTING')).toBe(false);
    expect(INVOICE_TRANSITIONS.PAID).toEqual([]);
    expect(INVOICE_TRANSITIONS.REJECTED).toEqual([]);
    expect(() => assertTransition('PAID', 'FAILED')).toThrow(IllegalTransition);
  });

  it('has an entry for every state', () => {
    for (const s of InvoiceStateSchema.options) expect(INVOICE_TRANSITIONS[s]).toBeDefined();
  });
});

describe('planId', () => {
  it('is independent of key order', async () => {
    const shuffled = JSON.parse(canonicalJson(input)) as PaymentPlanInput;
    const reordered: PaymentPlanInput = {
      labels: shuffled.labels,
      payee: { name: 'Acme Srl' },
      executeAt: 'now',
      amount: '25000000',
      assetId: shuffled.assetId,
      rgbInvoice: shuffled.rgbInvoice,
      invoiceId: 'inv-1',
    };
    expect(await computePlanId(reordered)).toBe(await computePlanId(input));
  });

  it('is a stable known value', async () => {
    const id = await computePlanId(input);
    expect(id).toMatch(/^[0-9a-f]{64}$/);
    expect(id).toBe(await computePlanId(structuredClone(input)));
    expect(canonicalJson(input)).toBe(
      '{"amount":"25000000","assetId":"rgb:mock-tusdt","executeAt":"now","invoiceId":"inv-1","labels":["supplier"],"payee":{"name":"Acme Srl"},"rgbInvoice":"rgb:mock/rgb:mock-tusdt/25000000/4102444800"}',
    );
  });

  it('changes with any field and detects tampering', async () => {
    const plan = await makePlan(input);
    expect(await verifyPlanId(plan)).toBe(true);
    expect(await computePlanId({ ...input, amount: '25000001' })).not.toBe(plan.planId);
    expect(await verifyPlanId({ ...plan, payee: { name: 'Evil Ltd' } })).toBe(false);
  });

  it('ignores an existing planId field', async () => {
    const plan = await makePlan(input);
    expect(await computePlanId(plan)).toBe(plan.planId);
  });

  it('rejects invalid input', async () => {
    await expect(makePlan({ ...input, amount: '1.5' })).rejects.toThrow();
    await expect(makePlan({ ...input, executeAt: 'tomorrow' })).rejects.toThrow();
  });
});
