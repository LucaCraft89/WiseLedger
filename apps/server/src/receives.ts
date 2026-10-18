// Incoming payments: every RGB invoice the app hands out (POST /api/wallet/receive, or the chat) is remembered here,
// matched to the incoming transfer that pays it (by recipient ID, the blinded UTXO) after each wallet sync, and
// reported in plain states: waiting → incoming → received (or expired / failed / cancelled). The global SSE stream
// already carries the transfer. A request can be cancelled while nobody pays it, and archived once it is closed.
import { randomUUID } from 'node:crypto';
import type { ReceiveFilter, ReceiveInvoice, ReceiveStatus, TransferInfo } from 'core';
import { ApiFailure } from './orchestrator.js';
import type { InvoiceStore } from './store.js';

export type { ReceiveStatus };

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
  /** Set by cancel(); with status `received` the money arrived after the cancel (never hidden). */
  cancelledAt?: string;
  archivedAt?: string;
  /** Lists under "Older requests": archived, closed for more than 24 h, or received more than 7 days ago. */
  older: boolean;
  payer?: string;
  purpose?: string;
  madeIn?: ReceiveMadeIn;
}

export type ReceiveMadeIn = 'form' | 'chat' | 'invoice_pdf';

/** What the user said about a request when making it. */
export interface ReceiveMeta {
  payer?: string;
  purpose?: string;
  /** Free text; filled as "payer · purpose" when absent, for readers that only know `note`. */
  note?: string;
  madeIn?: ReceiveMadeIn;
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
  cancelled_at: string | null;
  archived_at: string | null;
  payer: string | null;
  purpose: string | null;
  made_in: string | null;
}

const OPEN: readonly ReceiveStatus[] = ['waiting', 'incoming'];
const CLOSED: readonly ReceiveStatus[] = ['expired', 'cancelled', 'failed'];
const HOUR = 3_600_000;
/** Closed requests leave the main list after this long; received ones after RECEIVED_KEEP_MS. */
export const CLOSED_KEEP_MS = 24 * HOUR;
export const RECEIVED_KEEP_MS = 7 * 24 * HOUR;
export const PAGE_DEFAULT = 20;
export const PAGE_MAX = 100;

const GROUPS: Record<Exclude<ReceiveFilter, 'all'>, readonly ReceiveStatus[]> = {
  open: OPEN,
  paid: ['received'],
  closed: CLOSED,
};

export class SqliteReceiveStore {
  constructor(
    private readonly store: InvoiceStore,
    private readonly now: () => Date = () => new Date(),
  ) {}

  private toReceive(r: Row): ReceiveRequest {
    const status = r.status as ReceiveStatus;
    const age = this.now().getTime() - Date.parse(r.updated_at);
    const older =
      r.archived_at !== null ||
      (CLOSED.includes(status) && age > CLOSED_KEEP_MS) ||
      (status === 'received' && age > RECEIVED_KEEP_MS);
    return {
      receiveId: r.receive_id,
      rgbInvoice: r.rgb_invoice,
      recipientId: r.recipient_id,
      status,
      createdAt: r.created_at,
      expiresAt: r.expires_at,
      updatedAt: r.updated_at,
      older,
      ...(r.asset_id ? { assetId: r.asset_id } : {}),
      ...(r.amount ? { amount: r.amount } : {}),
      ...(r.note ? { note: r.note } : {}),
      ...(r.transfer_id ? { transferId: r.transfer_id } : {}),
      ...(r.txid ? { txid: r.txid } : {}),
      ...(r.received_amount ? { receivedAmount: r.received_amount } : {}),
      ...(r.cancelled_at ? { cancelledAt: r.cancelled_at } : {}),
      ...(r.archived_at ? { archivedAt: r.archived_at } : {}),
      ...(r.payer ? { payer: r.payer } : {}),
      ...(r.purpose ? { purpose: r.purpose } : {}),
      ...(r.made_in ? { madeIn: r.made_in as ReceiveMadeIn } : {}),
    };
  }

  /** Remembers an invoice the wallet just created. */
  add(inv: ReceiveInvoice, meta: ReceiveMeta | string = {}): ReceiveRequest {
    const m: ReceiveMeta = typeof meta === 'string' ? { note: meta } : meta;
    const note = m.note ?? ([m.payer, m.purpose].filter(Boolean).join(' · ') || undefined);
    // Strictly increasing created_at: the paging cursor (`before` = createdAt of the last row) never skips a request
    // made in the same millisecond as another.
    const last = (this.store.db.prepare('SELECT MAX(created_at) AS at FROM receives').get() as { at: string | null })
      .at;
    const at = new Date(Math.max(this.now().getTime(), last ? Date.parse(last) + 1 : 0)).toISOString();
    const receiveId = `rcv_${randomUUID().replaceAll('-', '').slice(0, 16)}`;
    this.store.db
      .prepare(
        `INSERT INTO receives (receive_id, rgb_invoice, recipient_id, asset_id, amount, note, status, created_at, expires_at, updated_at, payer, purpose, made_in)
         VALUES (?, ?, ?, ?, ?, ?, 'waiting', ?, ?, ?, ?, ?, ?)`,
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
        m.payer ?? null,
        m.purpose ?? null,
        m.madeIn ?? null,
      );
    return this.get(receiveId) as ReceiveRequest;
  }

  get(receiveId: string): ReceiveRequest | undefined {
    const row = this.store.db.prepare('SELECT * FROM receives WHERE receive_id = ?').get(receiveId) as Row | undefined;
    return row ? this.toReceive(row) : undefined;
  }

  private mustGet(receiveId: string): ReceiveRequest {
    const r = this.get(receiveId);
    if (!r)
      throw new ApiFailure(
        404,
        'NOT_FOUND',
        'We could not find this payment request. Open Wallet › Get paid to see your requests.',
      );
    return r;
  }

  /** True while a request handed out in the last hour still waits for its payment (the wallet then syncs fast). */
  waitingRecently(withinMs = 60 * 60_000): boolean {
    const since = new Date(this.now().getTime() - withinMs).toISOString();
    return (
      this.store.db
        .prepare(`SELECT 1 FROM receives WHERE status IN ('waiting', 'incoming') AND created_at >= ? LIMIT 1`)
        .get(since) !== undefined
    );
  }

  /** Distinct earlier payers whose name contains `q` (case-insensitive), most recent first. */
  payers(q = '', max = 8): string[] {
    const rows = this.store.db
      .prepare(
        `SELECT payer, MAX(created_at) AS at FROM receives WHERE payer IS NOT NULL AND instr(lower(payer), lower(?)) > 0
         GROUP BY lower(payer) ORDER BY at DESC LIMIT ?`,
      )
      .all(q, max) as { payer: string }[];
    return rows.map((r) => r.payer);
  }

  /** Every request, newest first (tests, small lists). */
  list(): ReceiveRequest[] {
    const rows = this.store.db.prepare('SELECT * FROM receives ORDER BY created_at DESC').all() as unknown as Row[];
    return rows.map((r) => this.toReceive(r));
  }

  /**
   * One page, newest first: `older` false = the main list, true = "Older requests". `before` is the createdAt of the
   * last row of the previous page; `nextBefore` is set when more rows follow.
   */
  page(q: { status?: ReceiveFilter; older?: boolean; limit?: number; before?: string } = {}): {
    receives: ReceiveRequest[];
    nextBefore?: string;
  } {
    const limit = Math.min(Math.max(q.limit ?? PAGE_DEFAULT, 1), PAGE_MAX);
    const statuses = q.status && q.status !== 'all' ? GROUPS[q.status] : undefined;
    const where: string[] = [];
    const args: string[] = [];
    if (statuses) {
      where.push(`status IN (${statuses.map(() => '?').join(', ')})`);
      args.push(...statuses);
    }
    if (q.before) {
      where.push('created_at < ?');
      args.push(q.before);
    }
    // "older" depends on the clock, so it is decided per row; the scan stops once the page is full (+1 to know more).
    const stmt = this.store.db.prepare(
      `SELECT * FROM receives ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY created_at DESC`,
    );
    const out: ReceiveRequest[] = [];
    let more = false;
    for (const row of stmt.iterate(...args) as Iterable<Row>) {
      const r = this.toReceive(row);
      if (r.older !== (q.older ?? false)) continue;
      if (out.length === limit) {
        more = true;
        break;
      }
      out.push(r);
    }
    const last = out.at(-1);
    return { receives: out, ...(more && last ? { nextBefore: last.createdAt } : {}) };
  }

  /**
   * Stops showing a request as open. Only while nobody pays it: rgb-lib cannot revoke a request already handed out,
   * so a payment that still arrives is recorded as received (reconcile keeps watching it until it expires).
   */
  cancel(receiveId: string): ReceiveRequest {
    const r = this.mustGet(receiveId);
    if (r.status === 'incoming') {
      throw new ApiFailure(409, 'PAYMENT_ON_ITS_WAY', 'Someone is already paying this request. Wait for it to arrive.');
    }
    if (r.status !== 'waiting') {
      throw new ApiFailure(
        409,
        'NOT_OPEN',
        `This request is already ${r.status}: there is nothing to cancel. You can archive it to tidy the list.`,
      );
    }
    const at = this.now().toISOString();
    this.store.db
      .prepare(
        "UPDATE receives SET status = 'cancelled', cancelled_at = ?, updated_at = ? WHERE receive_id = ? AND status = 'waiting'",
      )
      .run(at, at, receiveId);
    return this.mustGet(receiveId);
  }

  /** Moves a closed or paid request under "Older requests". Open ones must be cancelled (or expire) first. */
  archive(receiveId: string): ReceiveRequest {
    const r = this.mustGet(receiveId);
    if (OPEN.includes(r.status)) {
      throw new ApiFailure(
        409,
        'STILL_OPEN',
        'This request can still be paid. Cancel it first, or wait until it is paid or expires.',
      );
    }
    if (!r.archivedAt) {
      this.store.db
        .prepare('UPDATE receives SET archived_at = ? WHERE receive_id = ?')
        .run(this.now().toISOString(), receiveId);
    }
    return this.mustGet(receiveId);
  }

  /**
   * Matches open requests (and cancelled ones that could still be paid) to incoming transfers (recipient ID, else
   * the invoice string) and moves them on. Closed history is never scanned. Returns the requests whose status changed.
   */
  reconcile(transfers: readonly TransferInfo[]): ReceiveRequest[] {
    const incoming = transfers.filter((t) => t.direction === 'incoming');
    const changed: ReceiveRequest[] = [];
    const nowMs = this.now().getTime();
    const rows = this.store.db
      .prepare(
        `SELECT * FROM receives WHERE status IN ('waiting', 'incoming') OR (status = 'cancelled' AND expires_at > ?)`,
      )
      .all(new Date(nowMs - CLOSED_KEEP_MS).toISOString()) as unknown as Row[];
    for (const req of rows.map((r) => this.toReceive(r))) {
      const t = incoming.find(
        (x) => x.recipientId === req.recipientId || (x.rgbInvoice !== undefined && x.rgbInvoice === req.rgbInvoice),
      );
      let next: ReceiveStatus = req.status;
      // rgb-lib records a pending incoming transfer as soon as the request is made (WaitingCounterparty): nobody has
      // paid yet, so the request stays "waiting" (and can still expire) until the payer's transfer arrives.
      const paidYet = t && t.status !== 'WaitingCounterparty';
      if (req.status === 'cancelled') {
        // Money that arrives after a cancel is never hidden; a cancelled request never becomes waiting/expired again.
        if (paidYet && t.status !== 'Failed') next = t.status === 'Settled' ? 'received' : 'incoming';
      } else if (t && paidYet)
        next = t.status === 'Settled' ? 'received' : t.status === 'Failed' ? 'failed' : 'incoming';
      else if (Date.parse(req.expiresAt) < nowMs) next = 'expired';
      const transferId = next === 'cancelled' ? req.transferId : t?.transferId;
      if (next === req.status && transferId === req.transferId) continue;
      this.store.db
        .prepare(
          `UPDATE receives SET status = ?, transfer_id = ?, txid = ?, received_amount = ?, updated_at = ? WHERE receive_id = ?`,
        )
        .run(
          next,
          transferId ?? null,
          (next === 'cancelled' ? undefined : t?.txid) ?? null,
          t && next !== 'cancelled' && t.amount !== '0' ? t.amount : null,
          this.now().toISOString(),
          req.receiveId,
        );
      changed.push(this.get(req.receiveId) as ReceiveRequest);
    }
    return changed;
  }
}
