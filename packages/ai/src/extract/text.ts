// Turns an uploaded invoice into model input: plain text (txt, xml, PDF text layer) or an image path for vision.
import { readFile } from 'node:fs/promises';
import type { InvoiceSource } from 'core';

export type InvoiceInput =
  | { mode: 'text'; text: string; source: InvoiceSource }
  | { mode: 'image'; imagePath: string; source: InvoiceSource };

/** Characters kept from a document (keeps call 1 inside ctx 4096 with the prompt and the answer). */
export const MAX_TEXT_CHARS = 6000;

export async function loadInvoice(source: InvoiceSource): Promise<InvoiceInput> {
  switch (source.kind) {
    case 'text':
    case 'xml':
      return { mode: 'text', text: clip(await readFile(source.path, 'utf8')), source };
    case 'pdf': {
      const text = await pdfText(source.path);
      // Scanned PDF without a text layer: nothing to read here; vision on a rendered page is M2 work.
      if (text.trim().length < 20) throw new Error('This PDF has no readable text. Upload a photo or an image of it.');
      return { mode: 'text', text: clip(text), source };
    }
    case 'image':
      return { mode: 'image', imagePath: source.path, source };
  }
}

export async function pdfText(path: string): Promise<string> {
  const { extractText, getDocumentProxy } = await import('unpdf');
  const pdf = await getDocumentProxy(new Uint8Array(await readFile(path)));
  const { text } = await extractText(pdf, { mergePages: true });
  return text;
}

/** Normalises whitespace and control characters and truncates to the safe window. */
export function clip(text: string, max = MAX_TEXT_CHARS): string {
  // biome-ignore lint/suspicious/noControlCharactersInRegex: stripping control characters is the point
  const clean = text.replace(/\r\n?/g, '\n').replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '');
  return clean.length > max ? `${clean.slice(0, max)}\n[…truncated]` : clean;
}
