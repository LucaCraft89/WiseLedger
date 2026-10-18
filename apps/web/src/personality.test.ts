import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { bookRows } from './lib/books.js';
import { DESK_MOODS, dateLine, deskMood, monthLine, orderNeeds } from './lib/desk.js';
import { liveAiView } from './lib/live.js';
import { liveChip } from './lib/owl.js';
import { pdfSafe, receiptPdf, receiptView } from './lib/receipt.js';
import {
  composeNote,
  expiryMinutes,
  nextBusinessDay2359,
  requestButtonLabel,
  requestStamp,
  shortName,
  splitNote,
  validUntil,
  validUntilWords,
} from './lib/request-form.js';
import { Stamp } from './Stamp.js';

const counts = (needsYou: number) => ({ needsYou, dueThisWeek: 0, scheduled: 0, waitingToBePaid: 0 });

describe('Desk mood', () => {
  it("uses A's mood and never a constant", () => {
    expect(DESK_MOODS.busy.word).toBe('Thinking…');
    expect(DESK_MOODS.attention.word).toBe('Something needs you');
    expect(DESK_MOODS.quiet.word).toBe('All quiet');
    expect(deskMood({ mood: 'busy', greetingCounts: counts(2) })).toBe('busy');
    expect(deskMood({ mood: 'quiet', greetingCounts: counts(2) })).toBe('quiet');
    expect(deskMood({ greetingCounts: counts(1) })).toBe('attention');
    expect(deskMood({ greetingCounts: counts(0) })).toBe('quiet');
  });
  it('puts the missing fee money first', () => {
    const items = [{ kind: 'review_verdict' }, { kind: 'low_fee_balance' }, { kind: 'due_soon' }];
    expect(orderNeeds(items).map((i) => i.kind)).toEqual(['low_fee_balance', 'review_verdict', 'due_soon']);
  });
  it('hides the month line at zero and says it in the owl voice otherwise', () => {
    const bal = [{ assetId: 'a', ticker: 'TUSDT', precision: 6, spendable: '0' }];
    const month = (invoicesRead: number, invoicesStopped: number, amount = '0') => ({
      invoicesRead,
      invoicesStopped,
      protectedAmount: [{ assetId: 'a', amount }],
      paymentsMade: 0,
      received: 0,
    });
    expect(monthLine(undefined, bal)).toBeNull();
    expect(monthLine(month(0, 0), bal)).toBeNull();
    expect(monthLine(month(14, 3, '1240000000'), bal)).toBe(
      'This month I read 14 invoices, stopped 3 and protected 1,240.00 TUSDT.',
    );
    expect(monthLine(month(1, 0), bal)).toBe('This month I read 1 invoice and stopped 0.');
  });
  it('says how fresh the books are, and warns after 5 minutes', () => {
    const now = new Date('2026-10-18T12:00:00');
    const fresh = dateLine(now, { text: '', secondsAgo: 20 });
    expect(fresh.stale).toBe(false);
    expect(fresh.text).toBe('Sunday 18 October · your books are up to date (checked 20 s ago)');
    const old = dateLine(now, { text: '', at: '2026-10-18T11:53:00' });
    expect(old).toEqual({ text: 'Sunday 18 October · last checked 7 min ago', stale: true });
  });
});

describe('Stamp', () => {
  it('carries its word as text and as the accessible name', () => {
    const html = renderToStaticMarkup(Stamp({ kind: 'PAID' }));
    expect(html).toContain('>PAID<');
    expect(html).toContain('aria-label="PAID"');
    expect(html).toContain('data-tone="ok"');
  });
  it('can say more than its kind (STOPPED BY WISE) and animates only when asked', () => {
    const html = renderToStaticMarkup(Stamp({ kind: 'STOPPED', label: 'STOPPED BY WISE', grow: true }));
    expect(html).toContain('aria-label="STOPPED BY WISE"');
    expect(html).toContain('wl-stamp-grow');
    expect(html).toContain('data-tone="block"');
    expect(renderToStaticMarkup(Stamp({ kind: 'OPEN' }))).not.toContain('wl-stamp-grow');
  });
  it('follows the status of a payment request', () => {
    expect(['waiting', 'incoming', 'received', 'expired', 'cancelled'].map((s) => requestStamp(s as never))).toEqual([
      'OPEN',
      'ARRIVING',
      'PAID',
      'EXPIRED',
      'CANCELLED',
    ]);
  });
});

describe('Get paid form', () => {
  it('builds the button from the form', () => {
    const f = { payer: 'Acme Srl', anyAmount: false, amountText: '22.00', ticker: 'TUSDT' };
    expect(requestButtonLabel(f)).toBe('Ask Acme for 22.00 TUSDT');
    expect(requestButtonLabel({ ...f, payer: '' })).toBe('Create the payment request');
    expect(requestButtonLabel({ ...f, anyAmount: true })).toBe('Ask Acme to pay');
    expect(shortName('Rossi & Figli S.r.l.')).toBe('Rossi & Figli');
  });
  it('keeps payer and purpose in the note and reads them back', () => {
    expect(composeNote('Acme Srl', 'October hosting')).toBe('Acme Srl · October hosting');
    expect(splitNote('Acme Srl · October hosting')).toEqual({ payer: 'Acme Srl', purpose: 'October hosting' });
    expect(splitNote(composeNote('Acme Srl', ''))).toEqual({ payer: 'Acme Srl' });
    expect(splitNote('refund October')).toEqual({ purpose: 'refund October' });
  });
  it('turns the presets into a valid-until moment, in local time and with the zone', () => {
    const now = new Date('2026-10-17T10:00:00Z'); // a Saturday
    expect(validUntil('1h', now).toISOString()).toBe('2026-10-17T11:00:00.000Z');
    expect(validUntil('1d', now).toISOString()).toBe('2026-10-18T10:00:00.000Z');
    expect(validUntil('1w', now).toISOString()).toBe('2026-10-24T10:00:00.000Z');
    const local = new Date(2026, 9, 17, 12, 0); // Saturday, local
    const monday = nextBusinessDay2359(local);
    expect([monday.getDay(), monday.getHours(), monday.getMinutes(), monday.getDate()]).toEqual([1, 23, 59, 19]);
    expect(validUntilWords(new Date('2026-10-19T21:59:00Z'), 'Europe/Rome')).toBe(
      'Valid until Mon 19 Oct, 23:59 (CEST)',
    );
    expect(validUntilWords(new Date('2026-12-01T22:59:00Z'), 'Europe/Rome')).toBe('Valid until Tue 1 Dec, 23:59 (CET)');
    expect(validUntil('date', now, '2026-10-19').getHours()).toBe(23);
  });
  it('checks the time limit the server accepts', () => {
    const now = new Date('2026-10-17T10:00:00Z');
    expect(expiryMinutes(new Date(now.getTime() + 90_000), now)).toEqual({ ok: true, minutes: 2 });
    expect(expiryMinutes(now, now).ok).toBe(false);
    expect(expiryMinutes(new Date(now.getTime() + 8 * 86_400_000), now).ok).toBe(false);
  });
});

const row = (o: Record<string, unknown>) => ({
  at: '2026-10-02T10:00:00Z',
  kind: 'payment',
  title: 'Paid Acme',
  balanceAfter: null,
  stamp: 'PAID',
  labels: [],
  ...o,
});

describe('Books ledger', () => {
  const rows = bookRows({
    ticker: 'TUSDT',
    precision: 6,
    rows: [
      row({ transferId: 't3', out: '1000000', pending: true, stamp: 'PENDING' }),
      row({ transferId: 't2', out: '25000000', balanceAfter: '974000000', invoiceId: 'inv1' }),
      row({
        transferId: 't1',
        kind: 'receipt',
        title: 'Payment received',
        in: '1000000000',
        balanceAfter: '999000000',
        stamp: 'RECEIVED',
      }),
      row({ transferId: 't0', kind: 'issuance', in: '5', balanceAfter: '5', stamp: 'ISSUED' }),
      row({ transferId: 'tf', out: '1', stamp: 'FAILED' }),
    ] as never,
  });
  it('shows in/out columns and the balance after each settled row', () => {
    expect(rows[1]).toMatchObject({ what: 'Paid Acme', out: '25.00 TUSDT', balance: '974.00 TUSDT', pending: false });
    expect(rows[2]).toMatchObject({ in: '1,000.00 TUSDT', balance: '999.00 TUSDT' });
  });
  it('keeps pending rows without a balance, and offers receipts only for settled payments', () => {
    expect(rows[0]).toMatchObject({ pending: true, out: '1.00 TUSDT' });
    expect(rows[0]?.balance).toBeUndefined();
    expect(rows.map((r) => r.canReceipt)).toEqual([false, true, true, false, false]);
    expect(rows[4]).toMatchObject({ failed: true });
  });
});

describe('Receipt', () => {
  const r = {
    transferId: 'abcdef123456',
    direction: 'out',
    payerName: 'You (this wallet)',
    payeeName: 'Acme Srl',
    invoiceNumber: 'INV-7',
    amount: '1000000',
    asset: { assetId: 'a', ticker: 'TUSDT', precision: 6 },
    rail: 'onchain',
    settledAt: '2026-10-02T10:00:48Z',
    labels: [],
  } as never;
  it('is a PAID slip with from, to, invoice number, amount and the signature', () => {
    const v = receiptView(r);
    expect(v.stamp).toBe('PAID');
    expect(v.rows).toEqual(
      expect.arrayContaining([
        { label: 'From', value: 'You' },
        { label: 'To', value: 'Acme Srl' },
        { label: 'Invoice number', value: 'INV-7' },
        { label: 'How it travelled', value: 'On-chain, about a minute' },
      ]),
    );
    expect(v.amount).toBe('1.00 TUSDT');
    expect(v.signed).toBe('— Wise');
    expect(receiptView({ ...(r as object), direction: 'in' } as never).stamp).toBe('RECEIVED');
  });
  it('makes a real PDF in the browser', async () => {
    const bytes = await receiptPdf(receiptView(r));
    expect(new TextDecoder().decode(bytes.slice(0, 5))).toBe('%PDF-');
    expect(pdfSafe('Café → ok')).toBe('Café ? ok');
  });
});

describe('Live analysis chip', () => {
  it('names the step A sends, and falls back to the stage', () => {
    expect(liveChip({ step: 'checking_request' })?.word).toBe('Checking the payment request…');
    expect(liveChip({ step: 'reading_amount' })?.word).toBe('Reading the amount…');
    expect(liveChip({ stage: 'summarizing' })?.word).toBe('Writing it up…');
    expect(liveChip({})).toBeUndefined();
  });
  it('folds the step out of the stage events', () => {
    const at = '2026-10-18T10:00:00Z';
    const v = liveAiView([
      { type: 'stage', stage: 'checking', status: 'start', step: 'checking_request', at },
    ] as never);
    expect(v.step).toBe('checking_request');
  });
});
