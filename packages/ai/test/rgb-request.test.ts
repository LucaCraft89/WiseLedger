import type { InvoiceExtraction } from 'core';
import { describe, expect, it } from 'vitest';
import { summaryFacts } from '../src/analyst/summarize.js';
import {
  normalizeEndpoint,
  type RuleInput,
  rgbRequestCheck,
  runRules,
  transportAllowlistFromEnv,
} from '../src/index.js';
import { CONFIG } from './helpers.js';

const INV = 'rgb:mock/rgb:mock-tusdt/25000000/1900000000';
const PROXY = 'rpcs://proxy.kaleidoswap.com/json-rpc';
const extraction: InvoiceExtraction = {
  issuer: { name: 'Acme Srl' },
  invoiceNumber: '1',
  currency: 'TUSDT',
  total: '25.00',
  lineItems: [],
  payment: { method: 'rgb', rgbInvoice: INV },
  fieldConfidence: {},
};
const now = new Date('2026-10-17T10:00:00Z');
const base: RuleInput = {
  extraction,
  decoded: {
    rgbInvoice: INV,
    recipientId: 'r',
    assetId: 'rgb:mock-tusdt',
    amount: '25000000',
    network: 'mock',
    expiresAt: '2026-10-18T10:00:00Z',
    transportEndpoints: [PROXY],
  },
  balance: { settled: '1000000000', future: '1000000000', spendable: '1000000000' },
  history: [],
  payees: [{ name: 'Acme Srl', rgbInvoices: [], timesPaid: 2 }],
  config: { ...CONFIG, transportAllowlist: [PROXY] },
  now,
};
const withDecoded = (patch: object): RuleInput => ({
  ...base,
  decoded: { ...(base.decoded as object), ...patch } as RuleInput['decoded'],
});
const r11 = (i: RuleInput) => runRules(i).flags.filter((f) => f.code === 'R11_RGB_REQUEST');
const lineOf = (i: RuleInput, check: string) => rgbRequestCheck(i)?.find((l) => l.check === check);

describe('R11 · payment request transport and expiry', () => {
  it('known proxy (rpcs ≡ https), valid for a day → no flag, all 8 checks pass', () => {
    expect(r11(base)).toEqual([]);
    expect(r11(withDecoded({ transportEndpoints: ['https://Proxy.kaleidoswap.com/json-rpc/'] }))).toEqual([]);
    const lines = rgbRequestCheck(base) ?? [];
    expect(lines.map((l) => l.check)).toEqual([
      'decodes',
      'rail',
      'network',
      'not_expired',
      'asset_approved',
      'asset_matches',
      'amount_matches',
      'transport_known',
    ]);
    expect(lines.every((l) => l.result === 'ok' && !l.flagCode)).toBe(true);
  });

  it('unknown proxy → review with the plain sentence, check line links to the flag', () => {
    const i = withDecoded({ transportEndpoints: ['rpcs://evil.example/json-rpc'] });
    expect(r11(i).map((f) => [f.severity, f.message])).toEqual([
      ['warn', 'This payment request routes through a server we do not know.'],
    ]);
    expect(runRules(i).verdict).toBe('review');
    expect(lineOf(i, 'transport_known')).toMatchObject({ result: 'review', flagCode: 'R11_RGB_REQUEST' });
  });

  it('expires in under 15 minutes → review; expired → R1 block; far after the due date → nothing', () => {
    const soon = withDecoded({ expiresAt: '2026-10-17T10:10:00Z' });
    expect(r11(soon)[0]?.message).toMatch(/expires very soon/);
    expect(lineOf(soon, 'not_expired')).toMatchObject({ result: 'review', flagCode: 'R11_RGB_REQUEST' });
    const gone = withDecoded({ expiresAt: '2026-10-17T09:00:00Z' });
    expect(r11(gone)).toEqual([]);
    expect(lineOf(gone, 'not_expired')).toMatchObject({ result: 'block', flagCode: 'R1_RGB_INVOICE' });
    expect(r11(withDecoded({ expiresAt: '2027-10-17T10:00:00Z' }))).toEqual([]);
  });

  it('open-amount request → info line on the check, not a flag', () => {
    const i = withDecoded({ amount: undefined });
    expect(r11(i)).toEqual([]);
    expect(lineOf(i, 'amount_matches')).toEqual({
      check: 'amount_matches',
      result: 'ok',
      text: 'The payment request leaves the amount to you; we will pay the printed total.',
    });
  });

  it('amount differs from the printed total → block line linked to R3', () => {
    const i = withDecoded({ amount: '26000000' });
    expect(lineOf(i, 'amount_matches')).toMatchObject({ result: 'block', flagCode: 'R3_AMOUNT' });
    expect(runRules(i).flags.some((f) => f.code === 'R3_AMOUNT' && f.severity === 'block')).toBe(true);
  });

  it('wrong network / unapproved asset / undecodable → block lines', () => {
    expect(lineOf(withDecoded({ network: 'bitcoin' }), 'network')?.result).toBe('block');
    expect(lineOf(withDecoded({ assetId: 'rgb:other' }), 'asset_approved')?.result).toBe('block');
    expect(rgbRequestCheck({ ...base, decoded: { error: 'bad' } })).toEqual([
      {
        check: 'decodes',
        result: 'block',
        text: 'Your wallet could not read the payment request.',
        flagCode: 'R1_RGB_INVOICE',
      },
    ]);
    expect(rgbRequestCheck({ ...base, extraction: { ...extraction, payment: { method: 'iban' } } })).toBeUndefined();
  });

  it('no allowlist configured → transport not checked', () => {
    const i = { ...base, config: CONFIG };
    expect(r11(withDecoded({ transportEndpoints: ['rpcs://x/y'] }))).toHaveLength(1);
    expect(lineOf(i, 'transport_known')).toBeUndefined();
  });

  it('summary call 2 gets only the pass/fail list, never the request string', () => {
    const facts = summaryFacts(extraction, [], 'ok', rgbRequestCheck(base));
    expect(facts).toContain('RGB payment request check:');
    expect(facts).toContain('- transport known: ok');
    expect(facts).not.toContain(INV);
    expect(facts).not.toContain('proxy.kaleidoswap');
  });

  it('allowlist from env', () => {
    expect(transportAllowlistFromEnv({ WALLET_BACKEND: 'wdk-rgb', RGB_TRANSPORT_ALLOWLIST: 'a, b' })).toEqual([
      'a',
      'b',
    ]);
    expect(transportAllowlistFromEnv({ WALLET_BACKEND: 'wdk-rgb', RGB_TRANSPORT_ENDPOINT: PROXY })).toEqual([PROXY]);
    expect(transportAllowlistFromEnv({ WALLET_BACKEND: 'mock' })).toContain('mock://transport');
    expect(normalizeEndpoint('rpcs://A.b/json-rpc/')).toBe('https://a.b/json-rpc');
  });
});
