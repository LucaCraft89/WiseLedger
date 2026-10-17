import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { InvoiceSource, PayeeBookEntry } from 'core';
import type { LlmExtraction } from '../src/analyst/extract.js';

export const FIXTURES_DIR = resolve(import.meta.dirname, '../../../fixtures/invoices');

export interface ExpectedFixture {
  id: string;
  file: string;
  kind: InvoiceSource['kind'];
  issuer: string;
  vatId: string;
  invoiceNumber: string;
  total: string;
  currency: string;
  paymentMethod: string;
  rgbInvoice: string;
  verdict: string | string[];
  flags: string[];
  seenBefore?: string[];
  lineAmounts: string[];
  issueDate?: string;
  dueDate?: string;
  note?: string;
}

const EXPECTED_FILE = JSON.parse(readFileSync(resolve(FIXTURES_DIR, 'expected.json'), 'utf8'));
export const EXPECTED: ExpectedFixture[] = EXPECTED_FILE.fixtures;
/** Suppliers the user paid before (R5), shared by tests and evals. */
export const PAYEE_BOOK: PayeeBookEntry[] = EXPECTED_FILE.payeeBook;

export function sourceOf(f: ExpectedFixture): InvoiceSource {
  const path = resolve(FIXTURES_DIR, f.file);
  return {
    kind: f.kind,
    path,
    sha256: createHash('sha256').update(readFileSync(path)).digest('hex'),
    filename: f.file,
  };
}

/** A perfect model answer for a fixture (what MockLlm replays). */
export function perfectAnswer(f: ExpectedFixture): LlmExtraction {
  return {
    issuerName: f.issuer,
    issuerVatId: f.vatId,
    issuerEmail: null,
    invoiceNumber: f.invoiceNumber,
    issueDate: f.issueDate ?? null,
    dueDate: f.dueDate ?? null,
    currency: f.currency,
    total: f.total,
    lineItems: f.lineAmounts.map((amount, i) => ({ description: `line ${i + 1}`, quantity: 1, amount })),
    paymentMethod: f.paymentMethod as LlmExtraction['paymentMethod'],
    rgbInvoice: f.rgbInvoice,
    iban: null,
    btcAddress: null,
    pressureLanguage: f.id.startsWith('scam'),
    pressureQuote: f.id.startsWith('scam') ? 'our bank details have changed' : null,
    confidence: 0.9,
  };
}
