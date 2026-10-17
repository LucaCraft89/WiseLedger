// R7 · text that tries to give orders to an AI. Any match blocks: an honest invoice never talks to the assistant.
import { FLAG_CODES } from 'core';
import type { Rule } from './types.js';

export const INJECTION_PATTERNS: RegExp[] = [
  /\b(ignore|disregard|forget|override)\b[^.\n]{0,40}\b(previous|prior|above|earlier|all|any|your)\b[^.\n]{0,20}\b(instructions?|rules?|prompts?|guidelines?)/i,
  /\bignora\b[^.\n]{0,30}\bistruzioni\b/i,
  /\b(system|developer)\s*(note|prompt|message|instruction)s?\b/i,
  /\b(note|message|instructions?)\s+(for|to)\s+the\s+(ai|assistant|model|llm|agent|bot)\b/i,
  /\byou\s+are\s+(now\s+)?((an?|the)\s+)?(ai|assistant|model|chatbot|treasurer|analyst)\b/i,
  /\b(pre-?approved|already\s+approved)\b/i,
  /\b(send|transfer|pay)\s+(everything|all\s+(the\s+)?funds|the\s+whole\s+balance)\b/i,
  /\bmanda\s+tutto\b/i,
  /\bdo\s+not\s+(show|display|raise)\s+(any\s+)?(warnings?|alerts?|flags?)\b/i,
  /<\|?(im_start|im_end|system|assistant)\|?>|\[\/?INST\]|<\/?tool_call>/i,
];

export function findInjection(text: string): string | undefined {
  for (const re of INJECTION_PATTERNS) {
    const m = re.exec(text);
    if (m) return m[0].slice(0, 80);
  }
  return undefined;
}

export const r7Injection: Rule = ({ sourceText, extraction, removed = [] }) => {
  const tokens = removed.filter((r) => r.startsWith('chat-template'));
  if (tokens.length) {
    return [
      {
        code: FLAG_CODES.R7_INJECTION,
        severity: 'block',
        message: 'The invoice contains hidden AI control codes. We removed them and stopped here.',
        evidence: (tokens[0] ?? '').slice(0, 80),
      },
    ];
  }
  const fields = [extraction.notes, extraction.issuer.name, ...extraction.lineItems.map((l) => l.description)]
    .filter(Boolean)
    .join('\n');
  const hit = findInjection(`${sourceText ?? ''}\n${fields}`);
  const invisible = removed.find((r) => r.includes('invisible'));
  if (!hit) {
    return invisible
      ? [
          {
            code: FLAG_CODES.R7_INJECTION,
            severity: 'warn',
            message: 'The invoice text contained invisible characters. We removed them; check the details carefully.',
            evidence: invisible,
          },
        ]
      : [];
  }
  return [
    {
      code: FLAG_CODES.R7_INJECTION,
      severity: 'block',
      message: 'The invoice contains text that tries to give orders to the AI. We stopped here.',
      evidence: hit,
    },
  ];
};
