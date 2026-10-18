// The Lightning rail on WalletPort (contract #50): wraps the on-chain wallet and the app's own RGB Lightning node.
// decodeInvoice() reads RGB Lightning invoices (BOLT11 with RGB fields) as rail 'lightning'; pay() sends those over
// the node's channel (from our LSP, scripts/lsp.ts) and everything else on-chain; transfers list both rails;
// lightningStatus() shows the node and its channels. Same `rgbInvoice` string everywhere, so plan and guard are
// unchanged. A Lightning payment is never retried by us either: on a timeout its status is read back by hash.
import {
  type CreateReceiveRequest,
  type DecodedInvoice,
  InsufficientFunds,
  InvalidInvoice,
  InvoiceExpired,
  type LightningStatus,
  type PaymentRequest,
  type PayResult,
  type ReceiveInvoice,
  TransferFailed,
  type TransferInfo,
  type TransferStatus,
  type WalletPort,
} from 'core';
import { isInbound, type LnNode, type LnPayment } from './node.js';

export const LN_TRANSFER_PREFIX = 'ln:';
/** Bitcoin carried by an RGB Lightning payment (rln needs an HTLC above dust; same as the M4 runs). */
export const LN_RECEIVE_MSAT = 3_000_000;

/** BOLT11 on our networks (signet = Mutinynet `lntbs`, regtest `lnbcrt`), optionally with a `lightning:` scheme. */
export function looksLightning(invoice: string): boolean {
  return /^(?:lightning:)?ln(?:tbs|bcrt|tb)[0-9a-z]{20,}$/i.test(invoice.trim());
}

const strip = (inv: string) => inv.trim().replace(/^lightning:/i, '');

interface LnDecoded {
  amt_msat?: number;
  expiry_sec?: number;
  timestamp?: number;
  asset_id?: string;
  asset_amount?: number;
  payment_hash: string;
  payee_pubkey?: string;
  network?: string;
}

function lnStatus(s: string | undefined): TransferStatus {
  if (/succeeded/i.test(s ?? '')) return 'Settled';
  if (/failed/i.test(s ?? '')) return 'Failed';
  return 'WaitingCounterparty';
}

export interface LightningRailOptions {
  /** How long pay() follows a Lightning payment before returning it as pending (default 30 s). */
  followMs?: number;
}

/**
 * WalletPort with a Lightning rail. Every non-Lightning call goes to the on-chain wallet unchanged; its own extra
 * properties (btcBalance, rgb, close, …, duck-typed by the server) are kept by the spread.
 */
export function withLightning(onchain: WalletPort, node: LnNode, opts: LightningRailOptions = {}): WalletPort {
  const createdAt = new Map<string, string>();

  const decodeLn = async (rgbInvoice: string): Promise<DecodedInvoice> => {
    let d: LnDecoded;
    try {
      d = await node.call<LnDecoded>('decodeInvoice', strip(rgbInvoice));
    } catch {
      throw new InvalidInvoice('This Lightning payment request could not be read.');
    }
    const expiresAt =
      d.timestamp && d.expiry_sec ? new Date((d.timestamp + d.expiry_sec) * 1000).toISOString() : undefined;
    return {
      rgbInvoice,
      recipientId: d.payment_hash,
      ...(d.asset_id ? { assetId: d.asset_id } : {}),
      ...(d.asset_amount !== undefined ? { amount: String(d.asset_amount) } : {}),
      // rln reports the BOLT11 network (Signet on Mutinynet), like the on-chain decoder.
      network: d.network ?? 'Signet',
      ...(expiresAt ? { expiresAt } : {}),
      transportEndpoints: [],
      rail: 'lightning',
      paymentHash: d.payment_hash,
    };
  };

  const iso = (s?: number) => (s ? new Date(s * 1000).toISOString() : undefined);
  const toTransfer = (p: LnPayment): TransferInfo => {
    const at = iso(p.created_at) ?? createdAt.get(p.payment_hash) ?? new Date().toISOString();
    return {
      transferId: `${LN_TRANSFER_PREFIX}${p.payment_hash}`,
      ...(p.asset_id ? { assetId: p.asset_id } : {}),
      amount: String(p.asset_amount ?? 0),
      direction: isInbound(p) ? 'incoming' : 'outgoing',
      // Our Lightning requests use the payment hash as recipient ID, so received ones match their request.
      ...(isInbound(p) ? { recipientId: p.payment_hash } : {}),
      status: lnStatus(p.status),
      rail: 'lightning',
      paymentHash: p.payment_hash,
      createdAt: at,
      updatedAt: iso(p.updated_at) ?? at,
    };
  };

  // An inbound entry is an invoice we issued: it is a transfer only once paid.
  const lnTransfers = async (assetId?: string): Promise<TransferInfo[]> =>
    (await node.payments())
      .filter((p) => !isInbound(p) || /succeeded/i.test(p.status))
      .map(toTransfer)
      .filter((t) => !assetId || t.assetId === assetId);

  const payLn = async (req: PaymentRequest): Promise<PayResult> => {
    const d = await decodeLn(req.rgbInvoice);
    if (d.expiresAt && Date.parse(d.expiresAt) <= Date.now()) throw new InvoiceExpired();
    if (d.assetId && d.assetId !== req.assetId)
      throw new InvalidInvoice('This Lightning request is for another asset.');
    if (d.amount && d.amount !== req.amount) throw new InvalidInvoice('The amount differs from the Lightning request.');
    const local = (await node.channels())
      .filter((c) => c.is_usable && c.asset_id === req.assetId)
      .reduce((s, c) => s + BigInt(c.asset_local_amount ?? 0), 0n);
    if (local < BigInt(req.amount)) {
      throw new InsufficientFunds(
        'Not enough in the Lightning channel for this payment. Pay on-chain instead, or ask the LSP for a channel.',
      );
    }
    let sent: { payment_hash: string; status?: string };
    try {
      sent = await node.call<{ payment_hash: string; status?: string }>('sendPayment', {
        invoice: strip(req.rgbInvoice),
      });
    } catch (e) {
      throw new TransferFailed(`The Lightning payment failed: ${e instanceof Error ? e.message : e}`);
    }
    createdAt.set(sent.payment_hash, new Date().toISOString());
    const end = Date.now() + (opts.followMs ?? 30_000);
    let status = lnStatus(sent.status);
    while (status === 'WaitingCounterparty' && Date.now() < end) {
      await new Promise((r) => setTimeout(r, 1_000));
      status = lnStatus((await node.payments()).find((p) => p.payment_hash === sent.payment_hash)?.status);
    }
    if (status === 'Failed') throw new TransferFailed('The Lightning payment failed: no route or the peer refused it.');
    return { transferId: `${LN_TRANSFER_PREFIX}${sent.payment_hash}`, paymentHash: sent.payment_hash };
  };

  // An RGB Lightning invoice from this node: the payer's node routes it through the LSP into our channel.
  const receiveLn = async (r: CreateReceiveRequest): Promise<ReceiveInvoice> => {
    if (!r.assetId || !r.amount) throw new InvalidInvoice('A Lightning request needs a token and an amount.');
    const room = (await node.channels())
      .filter((c) => c.is_usable && c.asset_id === r.assetId)
      .reduce((s, c) => s + BigInt(c.asset_remote_amount ?? 0), 0n);
    if (room < BigInt(r.amount)) {
      throw new InsufficientFunds(
        room > 0n
          ? `Lightning can receive at most ${room} base units right now. Ask for less, or make an on-chain request.`
          : 'Lightning has no room to receive right now. Make an on-chain request instead.',
      );
    }
    let made: { invoice: string };
    try {
      made = await node.call<{ invoice: string }>('createInvoice', {
        amt_msat: LN_RECEIVE_MSAT,
        expiry_sec: r.expirySec,
        asset_id: r.assetId,
        asset_amount: Number(r.amount),
      });
    } catch (e) {
      throw new TransferFailed(`The Lightning node could not make the request: ${e instanceof Error ? e.message : e}`);
    }
    const d = await decodeLn(made.invoice);
    return {
      rgbInvoice: made.invoice,
      recipientId: d.recipientId,
      assetId: r.assetId,
      amount: r.amount,
      expiresAt: d.expiresAt ?? new Date(Date.now() + r.expirySec * 1000).toISOString(),
      rail: 'lightning',
      ...(d.paymentHash ? { paymentHash: d.paymentHash } : {}),
    };
  };

  return {
    ...onchain,
    init: () => onchain.init(),
    onboarding: (o) => onchain.onboarding(o),
    receiveAddress: () => onchain.receiveAddress(),
    listAssets: () => onchain.listAssets(),
    assetBalance: (id) => onchain.assetBalance(id),
    createUtxosIfNeeded: () => onchain.createUtxosIfNeeded(),
    issueAssetNia: (r) => onchain.issueAssetNia(r),
    createReceiveInvoice: (r) => (r.rail === 'lightning' ? receiveLn(r) : onchain.createReceiveInvoice(r)),
    quotePay: (r) => (looksLightning(r.rgbInvoice) ? Promise.resolve({ fee: '0', feeRate: 0 }) : onchain.quotePay(r)),
    decodeInvoice: (inv) => (looksLightning(inv) ? decodeLn(inv) : onchain.decodeInvoice(inv)),
    pay: (r) => (looksLightning(r.rgbInvoice) ? payLn(r) : onchain.pay(r)),
    getTransfer: async (id) =>
      id.startsWith(LN_TRANSFER_PREFIX)
        ? ((await lnTransfers()).find((t) => t.transferId === id) ?? null)
        : onchain.getTransfer(id),
    listTransfers: async (assetId) => [
      ...(await onchain.listTransfers(assetId)),
      ...(await lnTransfers(assetId).catch(() => [])),
    ],
    sync: async () => {
      await onchain.sync();
      // A Lightning refresh failure must not fail the on-chain sync loop.
      await node.call('refreshTransfers', { skip_sync: false }).catch(() => undefined);
    },
    lightningStatus: async (): Promise<LightningStatus> => {
      const channels = (await node.channels()).map((c) => ({
        channelId: c.channel_id,
        peer: c.peer_pubkey,
        ...(c.asset_id ? { assetId: c.asset_id } : {}),
        localAsset: String(c.asset_local_amount ?? 0),
        remoteAsset: String(c.asset_remote_amount ?? 0),
        usable: c.is_usable,
      }));
      const problem = channels.some((c) => c.usable)
        ? undefined
        : channels.length
          ? 'The Lightning channel is not usable yet (waiting for the LSP or a confirmation).'
          : 'No Lightning channel yet: the app asks our LSP for one at start.';
      return { enabled: true, nodePubkey: node.pubkey, channels, ...(problem ? { problem } : {}) };
    },
  };
}
