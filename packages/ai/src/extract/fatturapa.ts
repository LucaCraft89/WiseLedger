// FatturaPA (Italian e-invoice XML) → InvoiceExtraction, deterministically: no model reads these fields.
// Only the summary (call 2) uses the LLM. Values are still untrusted text: rules check them like any other invoice.
import { InvoiceExtraction, isLightningInvoice, type LineItem } from 'core';
import { XMLParser } from 'fast-xml-parser';
import { normalizeDecimal, paymentRequestsIn } from '../analyst/extract.js';

type Node = Record<string, unknown>;

const parser = new XMLParser({
  ignoreAttributes: true,
  removeNSPrefix: true,
  parseTagValue: false, // keep "25.00", "00123" as printed
  trimValues: true,
  processEntities: false, // no entity expansion from an untrusted document
});

/** True when the XML is a FatturaPA document (root FatturaElettronica, any namespace prefix). */
export function isFatturaPA(xml: string): boolean {
  return /<([\w-]+:)?FatturaElettronica[\s>]/.test(xml);
}

const arr = <T>(v: T | T[] | undefined): T[] => (v === undefined ? [] : Array.isArray(v) ? v : [v]);
const obj = (v: unknown): Node => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Node) : {});
const str = (v: unknown): string | undefined =>
  typeof v === 'string' && v.trim() ? v.trim().slice(0, 200) : undefined;
const path = (n: unknown, ...keys: string[]): unknown => keys.reduce<unknown>((cur, k) => obj(cur)[k], n);

/** Parses the first invoice body. Undefined when the document is not a readable FatturaPA. */
export function parseFatturaPA(xml: string): InvoiceExtraction | undefined {
  let doc: Node;
  try {
    doc = obj(parser.parse(xml));
  } catch {
    return undefined;
  }
  const root = obj(doc.FatturaElettronica);
  const header = obj(root.FatturaElettronicaHeader);
  const body = obj(arr(root.FatturaElettronicaBody as Node | Node[])[0]);
  if (!Object.keys(header).length || !Object.keys(body).length) return undefined;

  const seller = obj(header.CedentePrestatore);
  const anag = obj(path(seller, 'DatiAnagrafici', 'Anagrafica'));
  const name = str(anag.Denominazione) ?? ([str(anag.Nome), str(anag.Cognome)].filter(Boolean).join(' ') || undefined);
  const idIva = obj(path(seller, 'DatiAnagrafici', 'IdFiscaleIVA'));
  const vatId = str(idIva.IdCodice) ? `${str(idIva.IdPaese) ?? ''}${str(idIva.IdCodice)}` : undefined;
  const email = str(path(seller, 'Contatti', 'Email'));

  const gen = obj(path(body, 'DatiGenerali', 'DatiGeneraliDocumento'));
  const causale = arr(gen.Causale as string | string[])
    .map(str)
    .filter(Boolean)
    .join(' ');

  const lines: LineItem[] = arr(path(body, 'DatiBeniServizi', 'DettaglioLinee') as Node | Node[])
    .slice(0, 10)
    .map((l) => {
      const amount = normalizeDecimal(str(l.PrezzoTotale));
      const unitPrice = normalizeDecimal(str(l.PrezzoUnitario));
      const qty = Number(str(l.Quantita) ?? '1');
      return {
        description: str(l.Descrizione) ?? '',
        ...(Number.isFinite(qty) ? { quantity: qty } : {}),
        ...(unitPrice ? { unitPrice } : {}),
        ...(amount ? { amount } : {}),
      };
    });
  // Line amounts are before VAT: add the VAT as a line so total = Σ lines holds (R3).
  const vatCents = arr(path(body, 'DatiBeniServizi', 'DatiRiepilogo') as Node | Node[]).reduce(
    (s, r) => s + Math.round(Number(normalizeDecimal(str(r.Imposta)) ?? '0') * 100),
    0,
  );
  if (vatCents > 0) lines.push({ description: 'IVA', amount: (vatCents / 100).toFixed(2) });

  const pay = arr(path(body, 'DatiPagamento', 'DettaglioPagamento') as Node | Node[]).map(obj)[0] ?? {};
  const total =
    normalizeDecimal(str(gen.ImportoTotaleDocumento)) ??
    normalizeDecimal(str(pay.ImportoPagamento)) ??
    (lines.every((l) => l.amount)
      ? (lines.reduce((s, l) => s + Math.round(Number(l.amount) * 100), 0) / 100).toFixed(2)
      : undefined);

  const rgbCandidates = paymentRequestsIn(xml);
  const rgbInvoice = rgbCandidates.length === 1 ? rgbCandidates[0] : undefined;
  const iban = str(pay.IBAN);

  const fields: Record<string, string | undefined> = {
    issuer: name,
    'issuer.vatId': vatId,
    invoiceNumber: str(gen.Numero),
    issueDate: str(gen.Data),
    dueDate: str(pay.DataScadenzaPagamento),
    currency: str(gen.Divisa),
    total,
    'payment.rgbInvoice': rgbInvoice,
  };
  // Read from tagged fields, not guessed: full confidence where present, 0 where missing (R9 reports gaps).
  const fieldConfidence = Object.fromEntries(Object.entries(fields).map(([k, v]) => [k, v ? 1 : 0]));

  const out = InvoiceExtraction.safeParse({
    issuer: { ...(name ? { name } : {}), ...(vatId ? { vatId } : {}), ...(email ? { email } : {}) },
    ...(fields.invoiceNumber ? { invoiceNumber: fields.invoiceNumber } : {}),
    ...(fields.issueDate ? { issueDate: fields.issueDate } : {}),
    ...(fields.dueDate ? { dueDate: fields.dueDate } : {}),
    ...(fields.currency ? { currency: fields.currency.toUpperCase() } : {}),
    ...(total ? { total } : {}),
    lineItems: lines,
    payment: {
      method: rgbInvoice ? (isLightningInvoice(rgbInvoice) ? 'ln' : 'rgb') : iban ? 'iban' : 'unknown',
      ...(rgbInvoice ? { rgbInvoice } : {}),
      ...(iban ? { iban } : {}),
    },
    ...(causale ? { notes: causale.slice(0, 300) } : {}),
    pressure: { detected: false },
    fieldConfidence,
  });
  return out.success ? out.data : undefined;
}
