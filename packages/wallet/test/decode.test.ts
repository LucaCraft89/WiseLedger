import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { decodeRgbInvoiceOffline, requestAlreadyPaid } from '../src/decode.js';

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

describe('requestAlreadyPaid (asks the RGB proxy for a payment on this recipient ID)', () => {
  const proxy = (body: unknown, seen: string[] = []) =>
    (async (url: string | URL | Request) => {
      seen.push(String(url));
      return new Response(JSON.stringify(body));
    }) as typeof fetch;
  it('paid / not paid / no answer', async () => {
    const seen: string[] = [];
    const paid = proxy({ jsonrpc: '2.0', id: '1', result: { consignment: 'UkdC…', txid: 'd421' } }, seen);
    expect(await requestAlreadyPaid('sb:utxob:x', ['rpcs://proxy.example/json-rpc'], { fetch: paid })).toBe(true);
    expect(seen).toEqual(['https://proxy.example/json-rpc']);
    const none = proxy({ jsonrpc: '2.0', id: '1', error: { code: -101, message: 'Consignment not found' } });
    expect(await requestAlreadyPaid('sb:utxob:x', ['rpcs://proxy.example/json-rpc'], { fetch: none })).toBe(false);
    const down = (async () => {
      throw new Error('ECONNREFUSED');
    }) as typeof fetch;
    expect(await requestAlreadyPaid('sb:utxob:x', ['rpcs://proxy.example/json-rpc'], { fetch: down })).toBeUndefined();
    expect(await requestAlreadyPaid('sb:utxob:x', [], { fetch: paid })).toBeUndefined();
  });
});
