import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { decodeRgbInvoiceOffline } from '../src/decode.js';

const DIR = resolve(import.meta.dirname, '../../../fixtures/payment-request-only');
const EXPECTED = JSON.parse(readFileSync(resolve(DIR, 'expected.json'), 'utf8')) as {
  fixtures: { id: string; rgbInvoice: string; decoded: Record<string, unknown> }[];
};

describe('decodeRgbInvoiceOffline (rgb-lib Invoice, no wallet, no network)', () => {
  for (const f of EXPECTED.fixtures) {
    it(`${f.id}: the real Mutinynet request decodes to expected.json`, () => {
      expect(decodeRgbInvoiceOffline(f.rgbInvoice)).toEqual({ rgbInvoice: f.rgbInvoice, ...f.decoded });
    });
  }
  it('garbage → InvalidInvoice', () => {
    expect(() => decodeRgbInvoiceOffline('rgb:not-a-request')).toThrow(/not a valid RGB invoice/);
  });
});
