// Analyst call 1: invoice → validated InvoiceExtraction. json_schema + low temperature, at most 2 repair retries.
import { type ChatMessage, InvoiceExtraction, type LlmProvider } from 'core';
import { z } from 'zod';
import type { InvoiceInput } from '../extract/text.js';
import {
  EXTRACT_IMAGE_PROMPT,
  EXTRACT_SYSTEM,
  EXTRACTION_LLM_SCHEMA,
  extractUserPrompt,
  repairPrompt,
} from './prompts.js';

const nul = z.string().nullable();
/** What the model returns (mirror of EXTRACTION_LLM_SCHEMA). */
export const LlmExtraction = z.object({
  issuerName: nul,
  issuerVatId: nul,
  issuerEmail: nul.optional(),
  invoiceNumber: nul,
  issueDate: nul,
  dueDate: nul,
  currency: nul,
  total: nul,
  lineItems: z
    .array(z.object({ description: z.string(), quantity: z.number().nullable().optional(), amount: nul }))
    .default([]),
  paymentMethod: z.enum(['rgb', 'iban', 'btc', 'ln', 'unknown']),
  rgbInvoice: nul,
  iban: nul.optional(),
  btcAddress: nul.optional(),
  pressureLanguage: z.boolean(),
  pressureQuote: nul,
  confidence: z.number(),
});
export type LlmExtraction = z.infer<typeof LlmExtraction>;

export interface ExtractOptions {
  maxRetries?: number;
  temperature?: number;
  signal?: AbortSignal;
  onToken?: (text: string) => void;
}

export interface ExtractResult {
  extraction: InvoiceExtraction;
  raw: LlmExtraction;
  attempts: number;
  ms: number;
}

export async function extractInvoice(
  input: InvoiceInput,
  llm: LlmProvider,
  opts: ExtractOptions = {},
): Promise<ExtractResult> {
  const started = Date.now();
  const messages: ChatMessage[] = [
    { role: 'system', content: EXTRACT_SYSTEM },
    input.mode === 'text'
      ? { role: 'user', content: extractUserPrompt(input.text) }
      : { role: 'user', content: EXTRACT_IMAGE_PROMPT, attachments: [{ path: input.imagePath }] },
  ];
  const maxRetries = opts.maxRetries ?? 2;
  let lastError = '';
  for (let attempt = 1; attempt <= maxRetries + 1; attempt++) {
    const req = {
      messages: attempt === 1 ? messages : [...messages, { role: 'user' as const, content: repairPrompt(lastError) }],
      temperature: opts.temperature ?? 0.1,
      maxTokens: 700,
      responseFormat: {
        type: 'json_schema' as const,
        json_schema: { name: 'InvoiceFields', schema: EXTRACTION_LLM_SCHEMA },
      },
      ...(opts.signal ? { signal: opts.signal } : {}),
    };
    let json: unknown;
    if (opts.onToken) {
      let text = '';
      for await (const e of llm.stream(req)) {
        if (e.type === 'token') opts.onToken(e.text);
        if (e.type === 'done') {
          text = e.result.text;
          json = e.result.json;
        }
      }
      json ??= safeJson(text);
    } else {
      json = (await llm.complete(req)).json;
    }
    const parsed = LlmExtraction.safeParse(json);
    if (parsed.success) {
      const sourceText = input.mode === 'text' ? input.text : undefined;
      return {
        extraction: toExtraction(parsed.data, sourceText),
        raw: parsed.data,
        attempts: attempt,
        ms: Date.now() - started,
      };
    }
    lastError =
      json === undefined ? 'not JSON' : parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ');
  }
  throw new Error(`The AI could not read this invoice (${lastError}).`);
}

const RGB_INVOICE_RE = /rgb:[^\s"'<>]+/g;

/** Maps the model output to the contract and applies deterministic clean-up. */
export function toExtraction(raw: LlmExtraction, sourceText?: string): InvoiceExtraction {
  const conf = clamp01(raw.confidence);
  const fieldConfidence: Record<string, number> = {};
  const keep = <T>(field: string, v: T | null | undefined): T | undefined => {
    if (v === null || v === undefined || (typeof v === 'string' && v.trim() === '')) {
      fieldConfidence[field] = 0;
      return undefined;
    }
    fieldConfidence[field] = conf;
    return typeof v === 'string' ? (v.trim() as T) : v;
  };

  // Small models sometimes drop the total: read it from a single printed TOTAL line instead (lower confidence).
  let total = normalizeDecimal(raw.total);
  let totalFromText = false;
  if (!total && sourceText !== undefined) {
    total = printedTotal(sourceText);
    totalFromText = total !== undefined;
  }

  // The RGB invoice must be printed in the document (text mode). If the model altered it, fall back to the
  // single rgb: string in the text; with several candidates keep the model's verbatim choice or nothing.
  let rgbInvoice = raw.rgbInvoice?.trim() || undefined;
  if (sourceText !== undefined) {
    const candidates = [...new Set(sourceText.match(RGB_INVOICE_RE) ?? [])];
    if (rgbInvoice && !sourceText.includes(rgbInvoice)) rgbInvoice = undefined;
    if (!rgbInvoice && candidates.length === 1) rgbInvoice = candidates[0];
  }

  const keptTotal = total ? keep('total', total) : (keep('total', undefined) as undefined);
  if (totalFromText) fieldConfidence.total = Math.min(conf, 0.6);

  const ext: InvoiceExtraction = {
    issuer: {
      ...opt('name', keep('issuer', raw.issuerName)),
      ...opt('vatId', keep('issuer.vatId', raw.issuerVatId)),
      ...opt('email', keep('issuer.email', raw.issuerEmail)),
    },
    ...opt('invoiceNumber', keep('invoiceNumber', raw.invoiceNumber)),
    ...opt('issueDate', keep('issueDate', raw.issueDate)),
    ...opt('dueDate', keep('dueDate', raw.dueDate)),
    ...opt('currency', keep('currency', raw.currency?.toUpperCase())),
    ...opt('total', keptTotal),
    lineItems: raw.lineItems.slice(0, 10).map((l) => ({
      description: l.description.slice(0, 200),
      ...opt('quantity', l.quantity ?? undefined),
      ...opt('amount', normalizeDecimal(l.amount) ?? (sourceText ? rowAmount(sourceText, l.description) : undefined)),
    })),
    payment: {
      method: rgbInvoice ? 'rgb' : raw.paymentMethod,
      ...opt('rgbInvoice', keep('payment.rgbInvoice', rgbInvoice)),
      ...opt('iban', raw.iban?.trim() || undefined),
      ...opt('address', raw.btcAddress?.trim() || undefined),
    },
    pressure: { detected: raw.pressureLanguage, ...opt('evidence', raw.pressureQuote?.slice(0, 160) || undefined) },
    fieldConfidence,
  };
  return InvoiceExtraction.parse(ext);
}

/** The amount on the one line that starts with TOTAL/TOTALE/AMOUNT DUE; undefined if absent or ambiguous. */
export function printedTotal(text: string): string | undefined {
  const found = new Set<string>();
  for (const m of text.matchAll(
    /^\s*(?:grand\s+)?(?:total(?:e)?(?:\s+due)?|amount\s+due|importo\s+totale)\b[^\d\n]*([\d][\d.,]*)/gim,
  )) {
    const v = normalizeDecimal(m[1]);
    if (v) found.add(v);
  }
  return found.size === 1 ? [...found][0] : undefined;
}

/** Small models sometimes drop row amounts: take the last decimal on the one text line that holds the description. */
export function rowAmount(text: string, description: string): string | undefined {
  const needle = description.trim().toLowerCase();
  if (needle.length < 3) return undefined;
  const rows = text.split('\n').filter((r) => r.toLowerCase().includes(needle));
  if (rows.length !== 1) return undefined;
  const nums = (rows[0] ?? '').match(/\d[\d.,]*[.,]\d{2}\b/g);
  return nums ? normalizeDecimal(nums[nums.length - 1]) : undefined;
}

/** "1.250,00" | "1,250.00" | "€ 25" | "25.00 TUSDT" → "1250.00" | "25". Undefined when not a number. */
export function normalizeDecimal(v: string | null | undefined): string | undefined {
  if (!v) return undefined;
  // Keep digits and separators, then drop separators stuck to the ends ("So.30.00" → "30.00", "25.-" → "25").
  let s = v
    .replace(/[^\d.,-]/g, '')
    .replace(/^[^\d-]+|[^\d]+$/g, '')
    .replace(/^-[^\d]+/, '-');
  if (!/\d/.test(s)) return undefined;
  const lastComma = s.lastIndexOf(',');
  const lastDot = s.lastIndexOf('.');
  if (lastComma > lastDot) s = s.replace(/\./g, '').replace(',', '.');
  else s = s.replace(/,/g, '');
  return /^-?\d+(\.\d+)?$/.test(s) ? s : undefined;
}

function opt<K extends string, V>(key: K, v: V | undefined): { [P in K]?: V } {
  return (v === undefined ? {} : { [key]: v }) as { [P in K]?: V };
}

const clamp01 = (n: number) => (Number.isFinite(n) ? Math.min(1, Math.max(0, n)) : 0);

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}
