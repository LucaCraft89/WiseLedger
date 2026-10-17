// Incoming payments: every RGB invoice the app hands out (POST /api/wallet/receive) is remembered here, matched to the
// incoming transfer that pays it (by recipient ID, the blinded UTXO) after each wallet sync, and reported in plain
// states: waiting → incoming → received (or expired / failed). The global SSE stream already carries the transfer.
import { randomUUID } from 'node:crypto';
import type { ReceiveInvoice, TransferInfo } from 'core';
import { z } from 'zod';
import type { InvoiceStore } from './store.js';

export const ReceiveStatus = z.enum(['waiting', 'incoming', 'received', 'expired', 'failed']);
export type ReceiveStatus = z.infer<typeof ReceiveStatus>;

export interface ReceiveRequest {
  receiveId: string;
  rgbInvoice: string;
  recipientId: string;
  assetId?: string;
  amount?: string;
  /** Who should pay or what for ("Acme, refund October"), shown in the list. */
  note?: string;
  status: ReceiveStatus;
  transferId?: string;
  txid?: string;
  /** Base units actually received (from the transfer), once known. */
  receivedAmount?: string;
  createdAt: string;
  expiresAt: string;
  updatedAt: string;
}

interface Row {
  receive_id: string;
  rgb_invoice: string;
  recipient_id: string;
  asset_id: string | null;
  amount: string | null;
  note: string | null;
  status: string;
  transfer_id: string | null;
  txid: string | null;
  received_amount: string | null;
  created_at: string;
  expires_at: string;
  updated_at: string;
}

function toReceive(r: Row): ReceiveRequest {
  return {
    receiveId: r.receive_id,
    rgbInvoice: r.rgb_invoice,
    recipientId: r.recipient_id,
    status: r.status as ReceiveStatus,
    createdAt: r.created_at,
    expiresAt: r.expires_at,
    updatedAt: r.updated_at,
    ...(r.asset_id ? { assetId: r.asset_id } : {}),
    ...(r.amount ? { amount: r.amount } : {}),
    ...(r.note ? { note: r.note } : {}),
    ...(r.transfer_id ? { transferId: r.transfer_id } : {}),
    ...(r.txid ? { txid: r.txid } : {}),
    ...(r.received_amount ? { receivedAmount: r.received_amount } : {}),
  };
}

const OPEN: readonly ReceiveStatus[] = ['waiting', 'incoming'];

export class SqliteReceiveStore {
  constructor(
    private readonly store: InvoiceStore,
    private readonly now: () => Date = () => new Date(),
  ) {}

  /** Remembers an invoice the wallet just created. */
  add(inv: ReceiveInvoice, note?: string): ReceiveRequest {
    const at = this.now().toISOString();
    const receiveId = `rcv_${randomUUID().replaceAll('-', '').slice(0, 16)}`;
    this.store.db
      .prepare(
        `INSERT INTO receives (receive_id, rgb_invoice, recipient_id, asset_id, amount, note, status, created_at, expires_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, 'waiting', ?, ?, ?)`,
      )
      .run(
        receiveId,
        inv.rgbInvoice,
        inv.recipientId,
        inv.assetId ?? null,
        inv.amount ?? null,
        note ?? null,
        at,
        inv.expiresAt,
        at,
      );
    return this.get(receiveId) as ReceiveRequest;
  }

  get(receiveId: string): ReceiveRequest | undefined {
    const row = this.store.db.prepare('SELECT * FROM receives WHERE receive_id = ?').get(receiveId) as Row | undefined;
    return row ? toReceive(row) : undefined;
  }

  /** True while a request handed out in the last hour still waits for its payment (the wallet then syncs fast). */
  waitingRecently(withinMs = 60 * 60_000): boolean {
    const since = this.now().getTime() - withinMs;
    return this.list().some((r) => OPEN.includes(r.status) && Date.parse(r.createdAt) >= since);
  }

  /** Newest first. */
  list(): ReceiveRequest[] {
    const rows = this.store.db.prepare('SELECT * FROM receives ORDER BY created_at DESC').all() as unknown as Row[];
    return rows.map(toReceive);
  }

  /**
   * Matches open requests to incoming transfers (recipient ID, else the invoice string) and moves them on.
   * Returns the requests whose status changed.
   */
  reconcile(transfers: readonly TransferInfo[]): ReceiveRequest[] {
    const incoming = transfers.filter((t) => t.direction === 'incoming');
    const changed: ReceiveRequest[] = [];
    const nowMs = this.now().getTime();
    for (const req of this.list().filter((r) => OPEN.includes(r.status))) {
      const t = incoming.find(
        (x) => x.recipientId === req.recipientId || (x.rgbInvoice !== undefined && x.rgbInvoice === req.rgbInvoice),
      );
      let next: ReceiveStatus = req.status;
      // rgb-lib records a pending incoming transfer as soon as the request is made (WaitingCounterparty): nobody has
      // paid yet, so the request stays "waiting" (and can still expire) until the payer's transfer arrives.
      const paidYet = t && t.status !== 'WaitingCounterparty';
      if (t && paidYet) next = t.status === 'Settled' ? 'received' : t.status === 'Failed' ? 'failed' : 'incoming';
      else if (Date.parse(req.expiresAt) < nowMs) next = 'expired';
      const transferId = t?.transferId;
      if (next === req.status && transferId === req.transferId) continue;
      this.store.db
        .prepare(
          `UPDATE receives SET status = ?, transfer_id = ?, txid = ?, received_amount = ?, updated_at = ? WHERE receive_id = ?`,
        )
        .run(
          next,
          transferId ?? null,
          t?.txid ?? null,
          t && t.amount !== '0' ? t.amount : null,
          this.now().toISOString(),
          req.receiveId,
        );
      changed.push(this.get(req.receiveId) as ReceiveRequest);
    }
    return changed;
  }
}
