// Turns an uploaded invoice into model input: plain text (txt, xml, PDF text layer) or an image path for vision.
import { readFile } from 'node:fs/promises';
import type { InvoiceExtraction, InvoiceSource } from 'core';
import { isFatturaPA, parseFatturaPA } from './fatturapa.js';

export type InvoiceInput =
  /** `removed`: control-like text stripped by `sanitize` (R7 evidence); the model never sees it. */
  /** `structured`: fields read deterministically (FatturaPA XML); the Analyst then skips extraction call 1. */
  | { mode: 'text'; text: string; source: InvoiceSource; removed: string[]; structured?: InvoiceExtraction }
  | { mode: 'image'; imagePath: string; source: InvoiceSource };

/** Characters kept from a document (keeps call 1 inside ctx 4096 with the prompt and the answer). */
export const MAX_TEXT_CHARS = 6000;

export interface LoadOptions {
  /** Image invoices: 'vision' (projector, default, b-001) or 'ocr' (OCR_LATIN → text). Env IMAGE_MODE. */
  imageMode?: 'vision' | 'ocr';
}

export async function loadInvoice(source: InvoiceSource, opts: LoadOptions = {}): Promise<InvoiceInput> {
  switch (source.kind) {
    case 'text':
      return { mode: 'text', ...untrusted(await readFile(source.path, 'utf8')), source };
    case 'xml': {
      const raw = await readFile(source.path, 'utf8');
      const structured = isFatturaPA(raw) ? parseFatturaPA(sanitize(raw).text) : undefined;
      return { mode: 'text', ...untrusted(raw), source, ...(structured ? { structured } : {}) };
    }
    case 'pdf': {
      const text = await pdfText(source.path);
      // Scanned PDF without a text layer: nothing to read here; vision on a rendered page is M2 work.
      if (text.trim().length < 20) throw new Error('This PDF has no readable text. Upload a photo or an image of it.');
      return { mode: 'text', ...untrusted(text), source };
    }
    case 'image': {
      const mode = opts.imageMode ?? (process.env.IMAGE_MODE === 'ocr' ? 'ocr' : 'vision');
      if (mode === 'ocr') {
        const { ocrImage } = await import('../ocr.js');
        return { mode: 'text', ...untrusted((await ocrImage(source.path)).text), source };
      }
      return { mode: 'image', imagePath: source.path, source };
    }
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

// Chat-template and tool-call markers: an invoice has no reason to contain them; they only steer a model.
const TEMPLATE_TOKENS =
  /<\|[a-z_]{2,20}\|>|<\/?(?:s|system|assistant|user|tool_call|tool_response|think)>|\[\/?(?:INST|SYS)\]/gi;
// Zero-width, bidi-override and soft-hyphen characters: invisible on paper, used to hide or split words.
const INVISIBLE = /[\u00ad\u200b-\u200f\u202a-\u202e\u2060-\u2064\u2066-\u2069\ufeff]/g;

/** Strips control-like text from an untrusted document and says what was removed (R7 flags it). */
export function sanitize(text: string): { text: string; removed: string[] } {
  const removed: string[] = [];
  const tokens = text.match(TEMPLATE_TOKENS);
  if (tokens) removed.push(...[...new Set(tokens)].slice(0, 5).map((t) => `chat-template token ${t}`));
  const invisible = text.match(INVISIBLE)?.length ?? 0;
  if (invisible) removed.push(`${invisible} invisible character${invisible === 1 ? '' : 's'}`);
  return { text: text.replace(TEMPLATE_TOKENS, '[removed]').replace(INVISIBLE, ''), removed };
}

/** Untrusted document text → sanitized, clipped model input. */
export function untrusted(raw: string): { text: string; removed: string[] } {
  const { text, removed } = sanitize(raw);
  return { text: clip(text), removed };
}
