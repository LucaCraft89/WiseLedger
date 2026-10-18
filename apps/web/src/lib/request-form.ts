// Get paid form helpers: valid-until presets, the button label, the note that carries payer and purpose.
import type { ReceiveStatus } from '../api/contracts.js';
import type { StampKind } from '../Stamp.js';

export const NOTE_MAX = 120;
export const MAX_VALID_MINUTES = 60 * 24 * 7;

export type ValidChoice = '1h' | '1d' | '1w' | 'date';
export const VALID_CHOICES: readonly { id: ValidChoice; label: string }[] = [
  { id: '1h', label: '1 hour' },
  { id: '1d', label: '1 day' },
  { id: '1w', label: '1 week' },
  { id: 'date', label: 'Until a date…' },
];
const PRESET_MINUTES = { '1h': 60, '1d': 1440, '1w': MAX_VALID_MINUTES } as const;

/** 23:59 local time of the next Monday–Friday after `now`. */
export function nextBusinessDay2359(now: Date): Date {
  const d = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1, 23, 59, 0, 0);
  while (d.getDay() === 0 || d.getDay() === 6) d.setDate(d.getDate() + 1);
  return d;
}

/** "2026-10-19" for the date picker's value, local calendar day. */
export function dateInputValue(d: Date): string {
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

/** The moment a request stops being valid. "date" = 23:59 local on the picked day. */
export function validUntil(choice: ValidChoice, now: Date, dateStr?: string): Date {
  if (choice !== 'date') return new Date(now.getTime() + PRESET_MINUTES[choice] * 60_000);
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(dateStr ?? '');
  if (!m) return nextBusinessDay2359(now);
  return new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]), 23, 59, 0, 0);
}

/** "Valid until Mon 19 Oct, 23:59 (CET)" in the viewer's zone (or `timeZone`, for tests). */
export function validUntilWords(d: Date, timeZone?: string): string {
  const tz = timeZone ? { timeZone } : {};
  const day = d.toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short', ...tz });
  const time = d.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', hour12: false, ...tz });
  const zone =
    new Intl.DateTimeFormat('en-GB', { timeZoneName: 'short', ...tz })
      .formatToParts(d)
      .find((p) => p.type === 'timeZoneName')?.value ?? '';
  return `Valid until ${day}, ${time}${zone ? ` (${zone})` : ''}`;
}

export type MinutesResult = { ok: true; minutes: number } | { ok: false; error: string };
/** Whole minutes from now to `until`, as the server wants them (at least 1, at most a week). */
export function expiryMinutes(until: Date, now: Date): MinutesResult {
  const minutes = Math.ceil((until.getTime() - now.getTime()) / 60_000);
  if (minutes < 1) return { ok: false, error: 'Pick a time in the future.' };
  if (minutes > MAX_VALID_MINUTES) return { ok: false, error: 'A payment request can be valid for one week at most.' };
  return { ok: true, minutes };
}

const LEGAL = /\s+(srl|s\.r\.l\.?|spa|s\.p\.a\.?|snc|sas|ltd\.?|llc|inc\.?|gmbh|ag|sa|bv|b\.v\.?|co\.?|plc)$/i;
/** "Acme Srl" → "Acme": the name the owl uses in sentences. */
export function shortName(name: string): string {
  const t = name.trim().replace(/\s+/g, ' ');
  const cut = t.replace(LEGAL, '').trim();
  return cut || t;
}

/** The primary button's words, built from the form. */
export function requestButtonLabel(f: {
  payer: string;
  anyAmount: boolean;
  amountText: string;
  ticker: string;
}): string {
  const who = shortName(f.payer);
  if (!who) return 'Create the payment request';
  if (f.anyAmount || !f.amountText.trim()) return `Ask ${who} to pay`;
  return `Ask ${who} for ${f.amountText.trim()}${f.ticker ? ` ${f.ticker}` : ''}`;
}

/** Payer and purpose travel in the request's note: "Acme Srl · October hosting" (payer only: "Acme Srl ·"). */
export function composeNote(payer: string, purpose: string): string {
  const p = payer.trim();
  const q = purpose.trim();
  const note = p && q ? `${p} · ${q}` : p ? `${p} ·` : q;
  return note.slice(0, NOTE_MAX).trim();
}

export function splitNote(note: string | undefined): { payer?: string; purpose?: string } {
  const n = (note ?? '').trim();
  if (!n) return {};
  const i = n.indexOf(' · ');
  if (i > 0)
    return { payer: n.slice(0, i).trim(), ...(n.slice(i + 3).trim() ? { purpose: n.slice(i + 3).trim() } : {}) };
  if (n.endsWith(' ·')) return { payer: n.slice(0, -2).trim() };
  return { purpose: n };
}

/** Payer and purpose of a request: A's own fields, else read from the note of an older request. */
export function namesOf(r: { payer?: string | undefined; purpose?: string | undefined; note?: string | undefined }): {
  payer?: string;
  purpose?: string;
} {
  if (r.payer || r.purpose) {
    return { ...(r.payer ? { payer: r.payer } : {}), ...(r.purpose ? { purpose: r.purpose } : {}) };
  }
  return splitNote(r.note);
}

/** Which stamp a payment request wears. */
export function requestStamp(status: ReceiveStatus): StampKind {
  switch (status) {
    case 'waiting':
      return 'OPEN';
    case 'incoming':
      return 'ARRIVING';
    case 'received':
      return 'PAID';
    case 'expired':
      return 'EXPIRED';
    case 'cancelled':
      return 'CANCELLED';
    case 'failed':
      return 'STOPPED';
  }
}

/** The owl's line for a request (the page's fixed lines). `who` is the short payer name. */
export function requestOwlLine(status: ReceiveStatus, who: string, amountText: string): string {
  const name = who || 'They';
  switch (status) {
    case 'waiting':
      return `Done. Send this to ${who || 'them'}. I'll tell you when the money arrives.`;
    case 'incoming':
      return `${name === 'They' ? 'The' : `${name}'s`} payment is on its way. Waiting for Bitcoin to confirm (about a minute).`;
    case 'received':
      return `${name} paid${amountText ? ` ${amountText}` : ''}. It's in your books.`;
    case 'expired':
      return 'This one expired before anyone paid. Ask again?';
    case 'cancelled':
      return 'You cancelled this one. Ask again?';
    case 'failed':
      return 'That payment did not go through. Ask again?';
  }
}

export const LIGHTNING_OFF_LINE = "Lightning can't receive right now, so this one goes on-chain.";
