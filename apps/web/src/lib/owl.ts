// The owl's moods are the existing owl image plus a small status chip (icon + word). No new drawings.
import {
  type AnalysisStep,
  type InvoiceState,
  isLightningInvoice,
  type OwlMood,
  type Stage,
} from '../api/contracts.js';

export const OWL_CHIPS: Record<OwlMood, { icon: string; word: string }> = {
  reading: { icon: '👀', word: 'Reading…' },
  thinking: { icon: '💭', word: 'Thinking…' },
  all_good: { icon: '✅', word: 'All good' },
  stopped: { icon: '✋', word: 'Stopped this one' },
  waiting_bitcoin: { icon: '⏳', word: 'Waiting for Bitcoin' },
  paid: { icon: '💸', word: 'Paid' },
};

/** The mood for an invoice's state, or null when there is nothing to say. */
export function moodForState(state: InvoiceState): OwlMood | null {
  switch (state) {
    case 'UPLOADED':
    case 'EXTRACTED':
      return 'reading';
    case 'ANALYZED':
    case 'CONFIRMED':
      return 'thinking';
    case 'EXECUTING':
      return 'waiting_bitcoin';
    case 'PAID':
      return 'paid';
    case 'BLOCKED':
    case 'FAILED':
    case 'REJECTED':
      return 'stopped';
    case 'AWAITING_CONFIRMATION':
    case 'SCHEDULED':
      return 'all_good';
  }
}

/** The owl's hint on how long a wait takes. */
export const WAIT_WORDS: Partial<Record<OwlMood, string>> = {
  reading: 'about 30 seconds on this computer',
  waiting_bitcoin: 'about a minute',
};

/** The owl's headline over a report, in its own voice. */
export function owlHeadline(verdict: 'ok' | 'review' | 'block', flagCount: number, state: InvoiceState): string {
  if (verdict === 'block' || state === 'BLOCKED') return 'I stopped this one. I will not pay it.';
  if (verdict === 'review')
    return `I read it. ${flagCount === 1 ? 'One thing looks' : flagCount === 2 ? 'Two things look' : `${flagCount} things look`} off.`;
  return 'I read it. It looks fine.';
}

/** How a payment travels, in words, from the printed invoice. */
export function railWords(rgbInvoice: string | undefined): string {
  return isLightningInvoice(rgbInvoice) ? 'via Lightning, instant' : 'on-chain, about a minute';
}

/** The Analyst's live stage in the owl's words (shown in the mood chip while an invoice is read). */
export const STAGE_CHIPS: Partial<Record<Stage, { icon: string; word: string }>> = {
  reading: { icon: '👀', word: 'Reading the text…' },
  extracting: { icon: '👀', word: 'Reading the amount…' },
  checking: { icon: '🔎', word: 'Checking 10 rules…' },
  summarizing: { icon: '✍️', word: 'Writing it up…' },
};

/** The finer step, when the server names it: payment requests say what is really checked. */
export const STEP_CHIPS: Record<AnalysisStep, { icon: string; word: string }> = {
  reading_text: { icon: '👀', word: 'Reading the text…' },
  reading_amount: { icon: '👀', word: 'Reading the amount…' },
  checking_request: { icon: '🔎', word: 'Checking the payment request…' },
  checking_rules: { icon: '🔎', word: 'Checking 10 rules…' },
  writing_summary: { icon: '✍️', word: 'Writing it up…' },
};

export const liveChip = (v: { stage?: Stage | undefined; step?: AnalysisStep | undefined }) =>
  (v.step ? STEP_CHIPS[v.step] : undefined) ?? (v.stage ? STAGE_CHIPS[v.stage] : undefined);
