// Payment requests ("Get paid"): plain words, tones and list helpers (tested in receive.test.ts).
import type { ReceiveFilter, ReceiveRequestDto, ReceiveStatus } from '../api/contracts.js';

/** Status = icon + word + tone (wl-badge data-tone), never colour alone. */
export const RECEIVE_STATUS: Record<
  ReceiveStatus,
  { icon: string; word: string; tone: 'ok' | 'review' | 'block' | 'info' }
> = {
  waiting: { icon: '…', word: 'Waiting for payment', tone: 'info' },
  incoming: { icon: '…', word: 'Payment on its way', tone: 'review' },
  received: { icon: '✓', word: 'Received', tone: 'ok' },
  expired: { icon: '○', word: 'Expired', tone: 'info' },
  cancelled: { icon: '○', word: 'Cancelled', tone: 'info' },
  failed: { icon: '✕', word: 'Payment failed', tone: 'block' },
};

/** Copy and QR only while the request can still be paid. */
export const canUse = (r: Pick<ReceiveRequestDto, 'status'>): boolean => r.status === 'waiting';
export const isOpen = (r: Pick<ReceiveRequestDto, 'status'>): boolean =>
  r.status === 'waiting' || r.status === 'incoming';

/** Why a request cannot be used any more, in plain words (undefined while it can). */
export function whyNotUsable(r: Pick<ReceiveRequestDto, 'status' | 'cancelledAt'>): string | undefined {
  switch (r.status) {
    case 'waiting':
      return undefined;
    case 'incoming':
      return 'Someone is paying it right now: wait for the payment to arrive.';
    case 'received':
      return r.cancelledAt
        ? 'It was paid: the money arrived after you cancelled it, and it is in your wallet.'
        : 'It was paid: a payment request is used once.';
    case 'expired':
      return 'It expired before anyone paid it. Make a new one to get paid.';
    case 'cancelled':
      return 'You cancelled it. Make a new one to get paid.';
    case 'failed':
      return 'The payment to it failed. Make a new request and ask them to pay again.';
  }
}

/** "18 Oct 2026, 09:08 CEST" — local time with the zone, so "valid until" is never ambiguous. */
export function localTimeWithZone(iso: string, timeZone?: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleString('en-GB', {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    timeZoneName: 'short',
    ...(timeZone ? { timeZone } : {}),
  });
}

export const RECEIVE_FILTERS: readonly { id: ReceiveFilter; label: string }[] = [
  { id: 'open', label: 'Open' },
  { id: 'paid', label: 'Paid' },
  { id: 'closed', label: 'Expired/cancelled' },
  { id: 'all', label: 'All' },
];

/** Open requests first (waiting, incoming), then the rest; newest first inside each group. */
export function openFirst<T extends Pick<ReceiveRequestDto, 'status' | 'createdAt'>>(list: readonly T[]): T[] {
  return [...list].sort((a, b) => Number(isOpen(b)) - Number(isOpen(a)) || b.createdAt.localeCompare(a.createdAt));
}

/** Rows of a later page appended, without duplicates (a row can move while paging). */
export function mergePage<T extends { receiveId: string }>(list: readonly T[], page: readonly T[]): T[] {
  const seen = new Set(list.map((r) => r.receiveId));
  return [...list, ...page.filter((r) => !seen.has(r.receiveId))];
}

/** Hash of the Get paid detail view. */
export const receiveHref = (receiveId: string): string => `#/wallet/get-paid/${encodeURIComponent(receiveId)}`;
/** Hash of the Get paid form pre-filled like an old request. */
export const likeHref = (receiveId: string): string => `#/wallet/get-paid?like=${encodeURIComponent(receiveId)}`;

/** "#/wallet/get-paid/rcv_1" → rcv_1; "#/wallet/get-paid?like=rcv_1" → { like: rcv_1 }. */
export function parseGetPaid(hash: string): { receiveId?: string; like?: string } {
  const detail = /^#\/wallet\/get-paid\/([^?/]+)$/.exec(hash)?.[1];
  if (detail) return { receiveId: decodeURIComponent(detail) };
  const like = /^#\/wallet\/get-paid\?like=([^&]+)$/.exec(hash)?.[1];
  return like ? { like: decodeURIComponent(like) } : {};
}

/** The tool result of create_receive_invoice → the stored request ID (the chat card loads it from the server). */
export function receiveIdOf(result: unknown): string | undefined {
  const id = (result as { receiveId?: unknown } | undefined)?.receiveId;
  return typeof id === 'string' ? id : undefined;
}
