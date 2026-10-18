// Analyst call 2: a plain-language summary from the VALIDATED fields and the rule flags only.
// It never receives the original document text, so instructions hidden in the invoice cannot reach it.
import type { InvoiceExtraction, LlmProvider, RgbCheckLine, RiskFlag, Verdict } from 'core';
import { z } from 'zod';

export const SUMMARY_SYSTEM = [
  'You explain an invoice check to a non-technical person in plain words.',
  'You receive structured fields and the results of safety rules. The rules already decided the verdict; never contradict it.',
  'Write at most 80 words. Mention who asks for how much and for what, then the problems found, if any.',
  'questionsForUser: up to 3 short questions the person should answer before paying (empty if the verdict is ok).',
].join('\n');

const SUMMARY_ONLY_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: { summary: { type: 'string' } },
  required: ['summary'],
};

const SUMMARY_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    summary: { type: 'string' },
    questionsForUser: { type: 'array', maxItems: 3, items: { type: 'string' } },
  },
  required: ['summary', 'questionsForUser'],
};

const SummaryOut = z.object({ summary: z.string().min(1), questionsForUser: z.array(z.string()).max(3).default([]) });

const VERDICT_WORDS: Record<Verdict, string> = {
  ok: 'ok — no problems found',
  review: 'review — the person must check the warnings before paying',
  block: 'block — do not pay',
};

/** The only invoice data call 2 sees: short validated fields, code-written flag messages, no evidence quotes. */
export function summaryFacts(
  extraction: InvoiceExtraction,
  flags: RiskFlag[],
  verdict: Verdict,
  rgbCheck?: readonly RgbCheckLine[],
): string {
  const cut = (s: string | undefined, n = 60) => (s ? s.replace(/\s+/g, ' ').slice(0, n) : 'unknown');
  const lines = extraction.lineItems
    .slice(0, 5)
    .map((l) => `- ${cut(l.description, 50)}${l.amount ? `: ${l.amount}` : ''}`);
  return [
    `Supplier: ${cut(extraction.issuer.name)}`,
    `Invoice number: ${cut(extraction.invoiceNumber, 30)}`,
    `Issue date: ${cut(extraction.issueDate, 20)} · Due date: ${cut(extraction.dueDate, 20)}`,
    `Total: ${extraction.total ?? 'unknown'} ${extraction.currency ?? ''}`.trim(),
    `Payment method: ${extraction.payment.method}`,
    'Lines:',
    ...(lines.length ? lines : ['- none read']),
    `Verdict (decided by rules): ${VERDICT_WORDS[verdict]}`,
    'Rule results:',
    ...(flags.length ? flags.map((f) => `- [${f.severity}] ${f.message}`) : ['- no problems found']),
    // Pass/fail list only (check name + result), never the payment request string itself.
    ...(rgbCheck?.length
      ? ['RGB payment request check:', ...rgbCheck.map((c) => `- ${c.check.replace(/_/g, ' ')}: ${c.result}`)]
      : []),
  ].join('\n');
}

export interface SummaryResult {
  summary: string;
  questionsForUser: string[];
  ms: number;
  /** True when the LLM failed and the code template was used. */
  fallback: boolean;
}

export async function summarize(
  extraction: InvoiceExtraction,
  flags: RiskFlag[],
  verdict: Verdict,
  llm: LlmProvider,
  opts: { signal?: AbortSignal; onToken?: (t: string) => void; rgbCheck?: readonly RgbCheckLine[] } = {},
): Promise<SummaryResult> {
  const started = Date.now();
  const req = {
    messages: [
      { role: 'system' as const, content: SUMMARY_SYSTEM },
      { role: 'user' as const, content: summaryFacts(extraction, flags, verdict, opts.rgbCheck) },
    ],
    temperature: 0.2,
    maxTokens: 220,
    // Verdict ok never has questions: do not make the model write an empty list.
    responseFormat: {
      type: 'json_schema' as const,
      json_schema: { name: 'Summary', schema: verdict === 'ok' ? SUMMARY_ONLY_SCHEMA : SUMMARY_SCHEMA },
    },
    ...(opts.signal ? { signal: opts.signal } : {}),
  };
  try {
    let json: unknown;
    if (opts.onToken) {
      for await (const e of llm.stream(req)) {
        if (e.type === 'token') opts.onToken(e.text);
        if (e.type === 'done') json = e.result.json;
      }
    } else {
      json = (await llm.complete(req)).json;
    }
    const out = SummaryOut.parse(json);
    return {
      summary: limitWords(withLead(out.summary, extraction), 120),
      questionsForUser: verdict === 'ok' ? [] : out.questionsForUser.map((q) => q.slice(0, 200)),
      ms: Date.now() - started,
      fallback: false,
    };
  } catch {
    return { ...templateSummary(extraction, flags, verdict), ms: Date.now() - started, fallback: true };
  }
}

/** Makes sure the summary says who asks for what: prepends a code-built sentence when the model left the supplier out. */
export function withLead(summary: string, extraction: InvoiceExtraction): string {
  const name = extraction.issuer.name?.trim();
  if (!name) return summary.trim();
  const first = name.split(/\s+/)[0]?.toLowerCase() ?? '';
  if (first && summary.toLowerCase().includes(first)) return summary.trim();
  const what = extraction.total ? ` ${extraction.total} ${extraction.currency ?? ''}`.trimEnd() : '';
  return `${name} asks for${what || ' a payment'}. ${summary.trim()}`;
}

export function limitWords(text: string, max: number): string {
  const words = text.trim().split(/\s+/);
  return words.length <= max ? text.trim() : `${words.slice(0, max).join(' ')}…`;
}

/** Deterministic summary when the model is unavailable. */
export function templateSummary(extraction: InvoiceExtraction, flags: RiskFlag[], verdict: Verdict) {
  const who = extraction.issuer.name ?? 'An unknown supplier';
  const what = extraction.total
    ? `${extraction.total} ${extraction.currency ?? ''}`.trim()
    : 'an amount we could not read';
  const head = `${who} asks for ${what}.`;
  const tail =
    verdict === 'ok'
      ? 'Everything we checked looks normal.'
      : `${verdict === 'block' ? 'Do not pay this invoice.' : 'Check these points before paying.'} ${flags.map((f) => f.message).join(' ')}`;
  return { summary: limitWords(`${head} ${tail}`, 120), questionsForUser: [] as string[] };
}
