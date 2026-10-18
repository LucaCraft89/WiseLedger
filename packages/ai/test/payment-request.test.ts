import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { AppEvent, DecodedInvoice, InvoiceSource } from 'core';
import { MOCK_ASSET_ID, MockLlm, MockWallet } from 'core/mocks';
import { describe, expect, it } from 'vitest';
import { Analyst } from '../src/analyst/analyze.js';
import {
  PAYMENT_REQUEST_ONLY_REST,
  paymentRequestOnly,
  paymentRequestSummary,
} from '../src/analyst/payment-request.js';
import { confirmationGuard, Treasurer } from '../src/treasurer/treasurer.js';
import { CONFIG, historyOf } from './helpers.js';

const DIR = resolve(import.meta.dirname, '../../../fixtures/payment-request-only');
const EXPECTED = JSON.parse(readFileSync(resolve(DIR, 'expected.json'), 'utf8')) as {
  fixtures: {
    id: string;
    files: string[];
    rgbInvoice: string;
    decoded: Omit<DecodedInvoice, 'rgbInvoice'>;
    verdict: string;
    flags: string[];
  }[];
};
const NOW = new Date('2026-10-18T09:00:00Z');
// Mutinynet (rgb-lib reports Signet); the wallet's decode is replayed from expected.json (checked against rgb-lib in
// packages/wallet/test/decode.test.ts), so this test needs no native binary.
const SIGNET = { ...CONFIG, networks: ['mock', 'signet'] };

function walletFor(): MockWallet {
  const w = new MockWallet({ now: () => NOW.getTime() });
  const real = w.decodeInvoice.bind(w);
  w.decodeInvoice = async (s: string) => {
    const f = EXPECTED.fixtures.find((x) => x.rgbInvoice === s);
    return f ? { rgbInvoice: s, ...f.decoded } : real(s);
  };
  return w;
}

function source(file: string): InvoiceSource {
  const path = resolve(DIR, file);
  return {
    kind: file.endsWith('.pdf') ? 'pdf' : 'text',
    path,
    sha256: createHash('sha256').update(readFileSync(path)).digest('hex'),
    filename: file,
  };
}

describe('only a payment request: detection', () => {
  const req = EXPECTED.fixtures[0]?.rgbInvoice ?? '';
  it('a bare request, with whitespace, a lightning: prefix or a few words around it', () => {
    expect(paymentRequestOnly(req)).toBe(req);
    expect(paymentRequestOnly(`\n\n   ${req}  \n`)).toBe(req);
    expect(paymentRequestOnly(`Please pay: ${req}`)).toBe(req);
    expect(paymentRequestOnly('lightning:lnrgb1mockrequestxxxxxxxx')).toBe('lnrgb1mockrequestxxxxxxxx');
  });
  it(`${PAYMENT_REQUEST_ONLY_REST} or more other characters, two requests, or none → an invoice`, () => {
    expect(paymentRequestOnly(`${'x'.repeat(PAYMENT_REQUEST_ONLY_REST - 1)} ${req}`)).toBe(req);
    expect(paymentRequestOnly(`${'x'.repeat(PAYMENT_REQUEST_ONLY_REST)} ${req}`)).toBeUndefined();
    expect(paymentRequestOnly(`Invoice 2026-042 from ACME SRL, total 12.00 TUSDT. ${req}`)).toBeUndefined();
    expect(paymentRequestOnly(`${req}\n${EXPECTED.fixtures[1]?.rgbInvoice}`)).toBeUndefined();
    expect(paymentRequestOnly('nothing to pay here')).toBeUndefined();
  });
});

describe('only a payment request: the Analyst reads it with the wallet decoder, no model, nothing invented', () => {
  for (const f of EXPECTED.fixtures) {
    for (const file of f.files) {
      it(`${f.id} (${file}) → payment_request, ${f.verdict}, decoded facts only`, async () => {
        const llm = new MockLlm({ replies: [] }); // any model call would fail the test
        const events: AppEvent[] = [];
        const r = await new Analyst({
          llm,
          wallet: walletFor(),
          history: historyOf(),
          config: SIGNET,
          now: () => NOW,
          streamTokens: false,
        }).analyze(source(file), { invoiceId: 'inv_t' }, (e) => events.push(e));
        expect(llm.calls).toHaveLength(0);
        expect(r.kind).toBe('payment_request');
        expect(r.verdict).toBe(f.verdict);
        expect(r.flags.filter((x) => x.severity !== 'info').map((x) => x.code)).toEqual(f.flags);
        // Every invoice field empty: only the request itself.
        expect(r.extraction).toEqual({
          issuer: {},
          lineItems: [],
          payment: { method: 'rgb', rgbInvoice: f.rgbInvoice },
          fieldConfidence: { 'payment.rgbInvoice': 1 },
        });
        expect(r.paymentRequest).toEqual({
          rail: 'onchain',
          network: 'Signet',
          payAssetId: MOCK_ASSET_ID,
          ...(f.decoded.amount ? { amount: f.decoded.amount } : {}),
          expiresAt: f.decoded.expiresAt,
        });
        expect(r.summary).toMatch(/^A payment request for /);
        expect(r.summary).toContain('only pay it if you know who sent it');
        if (f.decoded.amount) {
          expect(r.proposedPayment).toEqual({
            rgbInvoice: f.rgbInvoice,
            assetId: MOCK_ASSET_ID,
            amount: f.decoded.amount,
            payee: 'whoever sent this payment request',
          });
          expect(r.summary).toContain('12.00 TUSDT');
        } else {
          // Open amount: no plan until the user types the amount (POST /api/invoices/:id/amount).
          expect(r.proposedPayment).toBeUndefined();
          expect(r.flags.find((x) => x.code === 'R3_AMOUNT')?.message).toBe(
            'This request leaves the amount to you: you will type it before paying.',
          );
          expect(r.rgbCheck?.find((l) => l.check === 'amount_matches')).toMatchObject({ result: 'review' });
        }
      });
    }
  }

  it('summary when the wallet cannot read it, or it is blocked', () => {
    expect(paymentRequestSummary(undefined, [], 'block', CONFIG, NOW)).toMatch(/could not read it\. Do not pay it/);
    const s = paymentRequestSummary(
      {
        rail: 'onchain',
        network: 'Signet',
        amount: '12000000',
        payAssetId: MOCK_ASSET_ID,
        expiresAt: '2026-10-18T08:00:00Z',
      },
      [{ code: 'R1_RGB_INVOICE', severity: 'block', message: 'The RGB payment request has expired.' }],
      'block',
      CONFIG,
      NOW,
    );
    expect(s).toContain('already expired');
    expect(s).toContain('Do not pay it: The RGB payment request has expired.');
  });
});

describe('Treasurer chat and payment requests', () => {
  const NOWC = new Date('2026-10-17T10:00:00Z');
  it('"pay this: rgb:…" opens the same check (no model call, never paid from chat)', async () => {
    const llm = new MockLlm({ replies: [] });
    const opened: string[] = [];
    const t = new Treasurer({
      llm,
      wallet: new MockWallet({ stepMs: 0, now: () => NOWC.getTime() }),
      guard: confirmationGuard(),
      checkPaymentRequest: async (text) => {
        opened.push(text);
        return { invoiceId: 'inv_pr' };
      },
    });
    const req = EXPECTED.fixtures[0]?.rgbInvoice ?? '';
    const r = await t.chat(`pay this: ${req}`, [], () => {});
    expect(llm.calls).toHaveLength(0);
    expect(opened).toEqual([req]);
    expect(r.needsConfirmation).toBeUndefined();
    expect(r.toolCalls).toEqual([
      { name: 'check_payment_request', args: {}, ok: true, result: { invoiceId: 'inv_pr' } },
    ]);
    expect(r.text).toMatch(/nothing is paid from the chat/);
  });

  it('a payment request made in chat returns the stored receiveId (the card reads the live request by it)', async () => {
    const call = (name: string, args: Record<string, unknown>) => ({ toolCall: { name, arguments: args } });
    const t = new Treasurer({
      llm: new MockLlm({ replies: [call('create_receive_invoice', { amount: '10', expiryMinutes: 60 })] }),
      wallet: new MockWallet({ stepMs: 0, now: () => NOWC.getTime() }),
      guard: confirmationGuard(),
      now: () => NOWC,
      onReceiveCreated: () => ({ receiveId: 'rcv_123' }),
    });
    const r = await t.chat('make a payment request for 10 TUSDT valid 1 hour', [], () => {});
    expect(r.toolCalls[0]?.result).toMatchObject({ receiveId: 'rcv_123', amount: '10000000' });
    expect(r.text).toMatch(/^Done: a payment request for 10.00 TUSDT/);
  });
});
