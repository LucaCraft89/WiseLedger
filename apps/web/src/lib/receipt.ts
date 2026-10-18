// Receipts: a paper slip for a settled payment, and the same lines as a PDF made in the browser (pdf-lib).
import type { ReceiptResponse } from '../api/contracts.js';
import { groupDigits } from './desk.js';
import { formatAmount, formatDate } from './format.js';

export interface ReceiptView {
  stamp: 'PAID' | 'RECEIVED';
  title: string;
  rows: { label: string; value: string }[];
  amount: string;
  how: string;
  signed: string;
  fileName: string;
}

/** The paper slip for GET /api/receipts/:transferId (the server only answers for settled payments). */
export function receiptView(r: ReceiptResponse): ReceiptView {
  const out = r.direction === 'out';
  const ln = r.rail === 'lightning';
  const amount = `${groupDigits(formatAmount(r.amount, r.asset.precision))} ${r.asset.ticker}`;
  const you = (name: string) => (name.startsWith('You') ? 'You' : name);
  return {
    stamp: out ? 'PAID' : 'RECEIVED',
    title: 'RECEIPT',
    rows: [
      { label: 'From', value: you(r.payerName) },
      { label: 'To', value: you(r.payeeName) },
      ...(r.invoiceNumber ? [{ label: 'Invoice number', value: r.invoiceNumber }] : []),
      { label: out ? 'Paid on' : 'Received on', value: formatDate(r.settledAt) },
      { label: 'How it travelled', value: ln ? 'Lightning, instant' : 'On-chain, about a minute' },
    ],
    amount,
    how: ln
      ? 'Sent over Lightning and settled at once, with no Bitcoin transaction needed.'
      : `${out ? 'Sent' : 'Received'} as an RGB token transfer on Bitcoin. The other wallet checked it and Bitcoin confirmed it.`,
    signed: '— Wise',
    fileName: `receipt-${r.transferId.slice(0, 12).replace(/[^A-Za-z0-9_-]/g, '')}.pdf`,
  };
}

/** Helvetica only has Latin-1 letters: anything else becomes "?" instead of making the PDF fail. */
export const pdfSafe = (s: string): string => s.replace(/[^\x20-\x7e -ÿ–—•]/g, '?');

export async function receiptPdf(v: ReceiptView): Promise<Uint8Array> {
  const { PDFDocument, StandardFonts, rgb } = await import('pdf-lib');
  const doc = await PDFDocument.create();
  const page = doc.addPage([420, 560]);
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const bold = await doc.embedFont(StandardFonts.HelveticaBold);
  const ink = rgb(0.106, 0.153, 0.2);
  const muted = rgb(0.32, 0.38, 0.43);
  const green = rgb(0.118, 0.482, 0.271);
  const text = (s: string, x: number, y: number, size: number, f = font, color = ink) =>
    page.drawText(pdfSafe(s), { x, y, size, font: f, color });

  text('WiseLedger', 36, 516, 11, bold, muted);
  text(v.title, 36, 484, 24, bold);
  let y = 440;
  for (const r of v.rows) {
    text(r.label.toUpperCase(), 36, y, 8, bold, muted);
    text(r.value, 36, y - 14, 12);
    y -= 42;
  }
  text(v.amount, 36, y - 6, 26, bold);
  y -= 50;
  for (const line of wrap(v.how, 62)) {
    text(line, 36, y, 10, font, muted);
    y -= 14;
  }
  text(v.signed, 36, y - 16, 13, bold);
  // The stamp: double border in the state colour (kept straight in the PDF so it prints crisp).
  page.drawRectangle({
    x: 250,
    y: 470,
    width: 120,
    height: 34,
    borderColor: green,
    borderWidth: 2,
  });
  page.drawRectangle({
    x: 254,
    y: 473,
    width: 112,
    height: 28,
    borderColor: green,
    borderWidth: 1,
  });
  text(v.stamp, 276, 480, 16, bold, green);
  return doc.save();
}

function wrap(s: string, width: number): string[] {
  const lines: string[] = [];
  let cur = '';
  for (const w of s.split(' ')) {
    if ((cur + w).length > width) {
      lines.push(cur.trim());
      cur = '';
    }
    cur += `${w} `;
  }
  if (cur.trim()) lines.push(cur.trim());
  return lines;
}
