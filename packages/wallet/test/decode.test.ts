import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { decodeRgbInvoiceOffline } from '../src/decode.js';

const DIR = resolve(import.meta.dirname, '../../../fixtures/payment-request-only');
const EXPECTED = JSON.parse(readFileSync(resolve(DIR, 'expected.json'), 'utf8')) as {
  fixtures: { id: string; rgbInvoice: string; decoded: Record<string, unknown> }[];
};

// rgb-lib ships native builds for these only (its loader exits the process elsewhere, e.g. Intel macOS, Windows).
const NATIVE = ['linux-x64', 'linux-arm64', 'darwin-arm64'].includes(`${process.platform}-${process.arch}`);

describe.skipIf(!NATIVE)('decodeRgbInvoiceOffline (rgb-lib Invoice, no wallet, no network)', () => {
  for (const f of EXPECTED.fixtures) {
    it(`${f.id}: the real Mutinynet request decodes to expected.json`, () => {
      expect(decodeRgbInvoiceOffline(f.rgbInvoice)).toEqual({ rgbInvoice: f.rgbInvoice, ...f.decoded });
    });
  }
  it('garbage → InvalidInvoice', () => {
    expect(() => decodeRgbInvoiceOffline('rgb:not-a-request')).toThrow(/not a valid RGB invoice/);
  });
});
