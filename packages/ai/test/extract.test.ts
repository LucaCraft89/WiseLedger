import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { MockLlm } from 'core/mocks';
import { describe, expect, it } from 'vitest';
import { extractInvoice, normalizeDecimal, printedTotal, rowAmount, toExtraction } from '../src/analyst/extract.js';
import { EXTRACT_SYSTEM } from '../src/analyst/prompts.js';
import { loadInvoice } from '../src/extract/text.js';
import { QvacProvider } from '../src/llm/qvac.js';
import { EXPECTED, type ExpectedFixture, FIXTURES_DIR, perfectAnswer, sourceOf } from './fixtures.js';

describe('extract: input loading', () => {
  it('reads text and the PDF text layer, and passes images by path', async () => {
    for (const f of EXPECTED) {
      const input = await loadInvoice(sourceOf(f));
      if (f.kind === 'image') expect(input.mode).toBe('image');
      else {
        expect(input.mode).toBe('text');
        if (input.mode === 'text') expect(input.text).toContain(f.invoiceNumber);
      }
    }
  });
});

describe('extract: call 1 with MockLlm', () => {
  for (const f of EXPECTED) {
    it(`${f.id} → valid InvoiceExtraction`, async () => {
      const llm = new MockLlm({ replies: [{ json: perfectAnswer(f) }] });
      const { extraction, attempts } = await extractInvoice(await loadInvoice(sourceOf(f)), llm);
      expect(attempts).toBe(1);
      expect(extraction.issuer.name).toBe(f.issuer);
      expect(extraction.total).toBe(f.total);
      expect(extraction.payment.method).toBe('rgb');
      expect(extraction.payment.rgbInvoice).toBe(f.rgbInvoice);
      const req = llm.calls[0];
      expect(req?.responseFormat?.type).toBe('json_schema');
      expect(req && 'tools' in req && req.tools).toBeFalsy();
      expect(req?.messages[0]?.content).toBe(EXTRACT_SYSTEM);
    });
  }

  it('repairs an invalid answer, then gives up after 2 retries', async () => {
    const f = EXPECTED[0] as ExpectedFixture;
    const ok = new MockLlm({ replies: [{ json: { nope: true } }, { json: perfectAnswer(f) }] });
    const r = await extractInvoice(await loadInvoice(sourceOf(f)), ok);
    expect(r.attempts).toBe(2);
    expect(ok.calls[1]?.messages.at(-1)?.content).toMatch(/not valid/);
    const bad = new MockLlm({ fallback: { json: { nope: true } } });
    await expect(extractInvoice(await loadInvoice(sourceOf(f)), bad)).rejects.toThrow(/could not read/);
    expect(bad.calls).toHaveLength(3);
  });
});

describe('extract: deterministic clean-up', () => {
  const base = perfectAnswer(EXPECTED[0] as ExpectedFixture);
  it('normalizes decimals', () => {
    expect(normalizeDecimal('1.250,00 €')).toBe('1250.00');
    expect(normalizeDecimal('1,250.00')).toBe('1250.00');
    expect(normalizeDecimal('EUR 25')).toBe('25');
    expect(normalizeDecimal('n/a')).toBeUndefined();
    expect(normalizeDecimal('So.30.00')).toBe('30.00');
    expect(normalizeDecimal('25.-')).toBe('25');
  });
  it('drops an RGB invoice not printed in the document and falls back to the single printed one', () => {
    const text = 'Pay to rgb:mock/rgb:mock-tusdt/25000000/1900000000 thanks';
    const e = toExtraction({ ...base, rgbInvoice: 'rgb:mock/rgb:mock-tusdt/99/1900000000' }, text);
    expect(e.payment.rgbInvoice).toBe('rgb:mock/rgb:mock-tusdt/25000000/1900000000');
  });
  it('with two printed RGB invoices keeps only a verbatim model choice', () => {
    const text = 'rgb:a/1 and rgb:b/2';
    expect(toExtraction({ ...base, rgbInvoice: 'rgb:b/2' }, text).payment.rgbInvoice).toBe('rgb:b/2');
    expect(toExtraction({ ...base, rgbInvoice: 'rgb:c/3' }, text).payment.rgbInvoice).toBeUndefined();
  });
  it('falls back to a single printed TOTAL line when the model drops the total', () => {
    const e = toExtraction({ ...base, total: null }, 'Item 10.00\nTOTAL DUE: 55.00 TUSDT\n');
    expect(e.total).toBe('55.00');
    expect(e.fieldConfidence.total).toBeLessThanOrEqual(0.6);
    expect(printedTotal('TOTAL: 12.00\nTotale: 13.00')).toBeUndefined();
    expect(printedTotal('TOTALE: EUR 120.00')).toBe('120.00');
  });
  it('fills a dropped row amount from the matching text line', () => {
    const text = 'Bike repair, labour                2        15.00    30.00\nSpare parts   1   10.00   10.00\n';
    expect(rowAmount(text, 'Bike repair, labour')).toBe('30.00');
    const e = toExtraction({ ...base, lineItems: [{ description: 'Spare parts', quantity: 1, amount: null }] }, text);
    expect(e.lineItems[0]?.amount).toBe('10.00');
    expect(rowAmount(text + 'Spare parts again 5.00', 'Spare parts')).toBeUndefined();
  });
  it('marks missing fields with confidence 0', () => {
    const e = toExtraction({ ...base, invoiceNumber: null, total: 'abc' });
    expect(e.fieldConfidence.invoiceNumber).toBe(0);
    expect(e.fieldConfidence.total).toBe(0);
    expect(e.total).toBeUndefined();
  });
});

describe.skipIf(process.env.LIVE_QVAC !== '1')('extract: live QVAC on the six fixtures', () => {
  it('gets issuer, total and payment method right on at least 4 of 6', { timeout: 900_000 }, async () => {
    const llm = new QvacProvider({ vision: true });
    const rows: string[] = [];
    let good = 0;
    for (const f of EXPECTED) {
      const t = Date.now();
      try {
        const { extraction: e } = await extractInvoice(await loadInvoice(sourceOf(f)), llm);
        const issuer = (e.issuer.name ?? '').toUpperCase().includes(f.issuer.toUpperCase().slice(0, 8));
        const total = e.total !== undefined && Number(e.total) === Number(f.total);
        const method = e.payment.method === f.paymentMethod;
        const rgb = e.payment.rgbInvoice === f.rgbInvoice;
        if (issuer && total && method) good++;
        rows.push(
          `| ${f.id} | ${issuer ? '✅' : '❌'} ${e.issuer.name ?? '-'} | ${total ? '✅' : '❌'} ${e.total ?? '-'} ${e.currency ?? ''} | ${method ? '✅' : '❌'} ${e.payment.method} | ${rgb ? '✅' : '❌'} | ${e.pressure?.detected ? 'yes' : 'no'} | ${((Date.now() - t) / 1000).toFixed(0)} s |`,
        );
      } catch (err) {
        rows.push(`| ${f.id} | error: ${(err as Error).message} |`);
      }
    }
    const table = `| fixture | issuer | total | method | rgbInvoice exact | pressure | time |\n|---|---|---|---|---|---|---|\n${rows.join('\n')}\n\n${good}/6 with issuer, total and method right (${llm.model})\n`;
    // vitest hides console output of passing tests: keep the table in the git-ignored .data/.
    mkdirSync(resolve(FIXTURES_DIR, '../../.data'), { recursive: true });
    writeFileSync(resolve(FIXTURES_DIR, '../../.data/extract-live.md'), table);
    console.log(table);
    await llm.unload();
    expect(good).toBeGreaterThanOrEqual(4);
  });
});
