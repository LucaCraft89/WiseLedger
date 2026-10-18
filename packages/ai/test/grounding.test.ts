import { describe, expect, it } from 'vitest';
import { toExtraction } from '../src/analyst/extract.js';
import {
  groundCode,
  groundCurrency,
  groundDate,
  groundExtraction,
  groundIssuer,
  groundNumber,
  groundText,
  numberReadings,
  printedDates,
} from '../src/analyst/grounding.js';

const INVOICE = `ACME S.R.L. - Via Roma 1, Torino
P.IVA IT 01234567890 · billing@acme.example
Invoice n. 2026/042   Date: 17/10/2026   Due: 16 Nov 2026
Hosting            1.234,56 €
Domain                20,00 €
TOTAL           1.254,56 EUR
IBAN IT60 X054 2811 1010 0000 0123 456
Pay to tb1qexampleaddress0000000000000000000000`;

describe('grounding matchers', () => {
  it('text: case-, space- and punctuation-insensitive substring', () => {
    expect(groundText('2026/042', INVOICE)).toBe(true);
    expect(groundText('2026-042', INVOICE)).toBe(true); // punctuation does not count
    expect(groundText('IT01234567890', INVOICE)).toBe(true);
    expect(groundText('BILLING@ACME.EXAMPLE', INVOICE)).toBe(true);
    expect(groundText('2026/043', INVOICE)).toBe(false);
    expect(groundText('', INVOICE)).toBe(false);
  });

  it('issuer: the model value inside one printed line, never the other way round', () => {
    expect(groundIssuer('ACME SRL', INVOICE)).toBe(true);
    expect(groundIssuer('Acme S.r.l.', INVOICE)).toBe(true);
    expect(groundIssuer('ACME S.R.L. - Via Roma 1, Torino, Italy', INVOICE)).toBe(false); // longer than the line
    expect(groundIssuer('Acme Holding SpA', INVOICE)).toBe(false);
    expect(groundIssuer('ACME Torino', INVOICE)).toBe(false); // not contiguous on the line
  });

  it('numbers: 1.234,56 / 1,234.56 / 1234.56 / 1234,56 all match; others do not', () => {
    for (const printed of ['1.234,56', '1,234.56', '1234.56', '1234,56']) {
      expect(groundNumber('1234.56', `Total ${printed}`)).toBe(true);
    }
    expect(groundNumber('1254.56', INVOICE)).toBe(true);
    expect(groundNumber('20', INVOICE)).toBe(true);
    expect(groundNumber('1254.65', INVOICE)).toBe(false);
    expect(groundNumber('99.00', INVOICE)).toBe(false);
    expect(numberReadings('1.234')).toEqual([1.234, 1234]);
    expect(numberReadings('25,00')).toEqual([25]);
  });

  it('dates: DD/MM/YYYY, DD-MM-YYYY, DD.MM.YYYY, YYYY-MM-DD, "23 Oct 2026", "23 ottobre 2026"', () => {
    expect(groundDate('2026-10-17', INVOICE)).toBe(true);
    expect(groundDate('2026-11-16', INVOICE)).toBe(true);
    expect(groundDate('17/10/2026', INVOICE)).toBe(true);
    for (const printed of [
      '23-10-2026',
      '23.10.2026',
      '2026-10-23',
      '23 Oct 2026',
      '23 ottobre 2026',
      'October 23, 2026',
    ]) {
      expect(groundDate('2026-10-23', `Data: ${printed}`)).toBe(true);
    }
    expect(groundDate('2026-10-18', INVOICE)).toBe(false);
    expect(groundDate('2026-12-31', 'no dates here')).toBe(false);
  });

  it('ambiguous 01/02/2026: either reading, only because that string is printed', () => {
    expect(printedDates('Date 01/02/2026')).toEqual(new Set(['2026-02-01', '2026-01-02']));
    expect(groundDate('2026-01-02', 'Date 01/02/2026')).toBe(true);
    expect(groundDate('2026-02-01', 'Date 01/02/2026')).toBe(true);
    expect(groundDate('2026-02-01', 'Date 03/02/2026')).toBe(false);
    expect(printedDates('Date 25/10/2026')).toEqual(new Set(['2026-10-25'])); // no month 25
  });

  it('IBAN and Bitcoin address: spaces removed, case-insensitive', () => {
    expect(groundCode('IT60X0542811101000000123456', INVOICE)).toBe(true);
    expect(groundCode('it60 x054 2811 1010 0000 0123 456', INVOICE)).toBe(true);
    expect(groundCode('IT60X0542811101000000999999', INVOICE)).toBe(false);
    expect(groundCode('tb1qexampleaddress0000000000000000000000', INVOICE)).toBe(true);
  });

  it('currency: the code or its symbol is printed', () => {
    expect(groundCurrency('EUR', INVOICE)).toBe(true);
    expect(groundCurrency('EUR', 'Total 25,00 €')).toBe(true);
    expect(groundCurrency('USD', 'Total $25.00')).toBe(true);
    expect(groundCurrency('TUSDT', 'Total 25.00 TUSDT')).toBe(true);
    expect(groundCurrency('USD', INVOICE)).toBe(false);
    expect(groundCurrency('TUSDT', 'Total 25.00 USDT')).toBe(false);
  });
});

describe('groundExtraction', () => {
  it('drops what is not printed, sets its confidence to 0, keeps the rest', () => {
    const { extraction, dropped } = groundExtraction(
      {
        issuer: { name: 'ACME SRL', vatId: 'IT01234567890', email: 'invented@acme.example' },
        invoiceNumber: '2026/042',
        issueDate: '2026-10-17',
        dueDate: '2026-12-01',
        currency: 'EUR',
        total: '1254.56',
        lineItems: [
          { description: 'Hosting', amount: '1234.56' },
          { description: 'Setup', amount: '99.00' },
        ],
        payment: { method: 'iban', iban: 'IT00X0000000000000000000000' },
        fieldConfidence: { issuer: 0.9, dueDate: 0.9, 'payment.iban': 0.9 },
      },
      INVOICE,
    );
    expect(dropped.sort()).toEqual(['dueDate', 'issuer.email', 'lineItems.1.amount', 'payment.iban']);
    expect(extraction.issuer).toEqual({ name: 'ACME SRL', vatId: 'IT01234567890' });
    expect(extraction).not.toHaveProperty('dueDate');
    expect(extraction.payment).toEqual({ method: 'iban' });
    expect(extraction.lineItems).toEqual([{ description: 'Hosting', amount: '1234.56' }, { description: 'Setup' }]);
    expect(extraction.fieldConfidence).toMatchObject({ issuer: 0.9, dueDate: 0, 'payment.iban': 0 });
  });

  it('a bare payment request: the model guesses supplier, number, dates, total and IBAN; all of them are dropped', () => {
    const request =
      'rgb:~/~/aaCVD/sb:utxob:OiCN9BJP-csFGkap-UrN1YGG-r4tsf22-wu2BlM0-j_aOyfu-ETU0w?assignment_name=assetOwner&expiry=1792566489&endpoints=rpcs://proxy.kaleidoswap.com/json-rpc';
    const ext = toExtraction(
      {
        issuerName: 'Kaleidoswap Ltd',
        issuerVatId: 'GB123456789',
        issuerEmail: 'billing@kaleidoswap.com',
        invoiceNumber: 'INV-0001',
        issueDate: '2026-10-18',
        dueDate: '2026-10-21',
        currency: 'USDT',
        total: '12.00',
        lineItems: [{ description: 'Services', amount: '12.00' }],
        paymentMethod: 'rgb',
        rgbInvoice: request,
        iban: 'GB29NWBK60161331926819',
        btcAddress: null,
        pressureLanguage: false,
        pressureQuote: null,
        confidence: 0.9,
      },
      request,
    );
    expect(ext.issuer).toEqual({});
    for (const k of ['invoiceNumber', 'issueDate', 'dueDate', 'currency', 'total'] as const) {
      expect(ext).not.toHaveProperty(k);
    }
    expect(ext.payment).toEqual({ method: 'rgb', rgbInvoice: request });
    expect(ext.lineItems).toEqual([{ description: 'Services' }]);
  });
});
