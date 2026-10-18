// The owl's moods are the existing owl image plus a small status chip (icon + word). No new drawings.
import { type InvoiceState, isLightningInvoice, type OwlMood } from '../api/contracts.js';

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
