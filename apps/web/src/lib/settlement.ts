// "How this was settled": plain lines for one RGB transfer, built from GET /api/transfers/:id (tested in web.test.ts).
import type { TransferDetailResponse, TransferStatus } from '../api/contracts.js';

export type StepState = 'done' | 'current' | 'pending' | 'failed';
export interface LadderStep {
  status: TransferStatus;
  label: string;
  state: StepState;
  at?: string;
}
export interface TechLine {
  label: string;
  value: string;
  /** One plain line next to the term. */
  explain: string;
  /** Long ID: shortened with a copy button. */
  id?: boolean;
}
export interface SettlementView {
  headline: string;
  ladder: LadderStep[];
  /** Plain next step when the transfer failed. */
  failedNext?: string;
  /** Client-side validation line, only once the receiver accepted the consignment. */
  validated?: string;
  /** On-chain only. */
  privacy?: string;
  txid?: string;
  tech: TechLine[];
}

const ORDER: TransferStatus[] = ['WaitingCounterparty', 'WaitingConfirmations', 'Settled'];

export function settlementView(d: TransferDetailResponse): SettlementView {
  const t = d.transfer;
  const ticker = d.asset?.ticker ?? 'the token';
  const out = t.kind === 'outgoing';
  const ln = t.rail === 'lightning';
  const headline =
    t.kind === 'issuance'
      ? `Created ${ticker} in this wallet — identified by its contract, not its name`
      : `${out ? 'Paid with' : 'Received'} ${ticker}${ln ? ' over Lightning' : ''} — identified by its contract, not its name`;

  const labels: Record<TransferStatus, string> = ln
    ? {
        WaitingCounterparty: 'Going through the Lightning channel',
        WaitingConfirmations: 'Going through the Lightning channel',
        Settled: 'Settled (instant, no Bitcoin transaction needed)',
        Failed: 'Failed',
      }
    : {
        WaitingCounterparty: out ? "Waiting for the supplier's wallet" : "Waiting for the payer's wallet",
        WaitingConfirmations: 'Waiting for Bitcoin to confirm (about a minute)',
        Settled: 'Settled',
        Failed: 'Failed',
      };
  const steps = ln ? (['WaitingCounterparty', 'Settled'] as TransferStatus[]) : ORDER;
  const failed = t.status === 'Failed';
  const reached = failed
    ? -1
    : steps.indexOf(t.status === 'WaitingConfirmations' && ln ? 'WaitingCounterparty' : t.status);
  const ladder: LadderStep[] = steps.map((status, i) => ({
    status,
    label: labels[status],
    state: failed
      ? d.statusTimes[status]
        ? 'done'
        : 'pending'
      : i < reached || (i === reached && status === 'Settled')
        ? 'done'
        : i === reached
          ? 'current'
          : 'pending',
    ...(d.statusTimes[status] ? { at: d.statusTimes[status] } : {}),
  }));
  if (failed)
    ladder.push({
      status: 'Failed',
      label: labels.Failed,
      state: 'failed',
      ...(d.statusTimes.Failed ? { at: d.statusTimes.Failed } : {}),
    });

  const accepted = t.status === 'WaitingConfirmations' || t.status === 'Settled';
  const view: SettlementView = {
    headline,
    ladder,
    ...(failed
      ? {
          failedNext: out
            ? 'Nothing was sent: the tokens stayed with you. Ask the supplier for a new payment request and pay again.'
            : 'The payment did not arrive. Ask the payer to send it again to a new payment request.',
        }
      : {}),
    ...(accepted && !ln && t.kind !== 'issuance'
      ? {
          validated: out
            ? "The supplier's wallet checked the full history of these tokens before accepting them."
            : 'You checked the full history of these tokens before accepting them.',
        }
      : {}),
    ...(!ln && t.txid
      ? {
          privacy: 'On Bitcoin this looks like an ordinary transaction: no token, amount or recipient is visible.',
          txid: t.txid,
        }
      : {}),
    tech: [],
  };

  const tech = view.tech;
  if (d.asset) {
    tech.push({
      label: 'Asset ID',
      value: d.asset.assetId,
      id: true,
      explain: 'The token’s contract ID: a fake token with the same name would be refused.',
    });
    tech.push({
      label: 'Schema',
      value: d.asset.schema,
      explain: 'Non-Inflatable Asset: a token contract with a fixed supply.',
    });
  }
  tech.push({ label: 'Transfer ID', value: t.transferId, id: true, explain: 'The number I gave this payment.' });
  if (ln && d.lightning) {
    tech.push({
      label: 'Rail',
      value: 'Lightning',
      explain: 'Paid over a payment channel instead of a Bitcoin transaction.',
    });
    tech.push({
      label: 'Payment hash',
      value: d.lightning.paymentHash,
      id: true,
      explain: 'Identifies this Lightning payment.',
    });
    if (d.lightning.channelId)
      tech.push({
        label: 'Channel',
        value: d.lightning.channelId,
        id: true,
        explain: 'The channel the payment went through.',
      });
  } else {
    if (t.txid)
      tech.push({
        label: 'Bitcoin txid',
        value: t.txid,
        id: true,
        explain: 'The Bitcoin transaction that anchors the payment.',
      });
    if (t.sealType)
      tech.push({
        label: 'Seal type',
        value: t.sealType,
        explain:
          t.sealType === 'blinded'
            ? out
              ? 'blinded: the supplier’s receiving spot is hidden even from you.'
              : 'blinded: your receiving spot was hidden even from the payer.'
            : 'witness: the tokens moved to a new output of the payment transaction.',
      });
    for (const e of t.transportEndpoints ?? [])
      tech.push({
        label: 'Transport endpoint',
        value: e,
        explain: 'The relay that carried the payment proof (consignment) between the two wallets.',
      });
  }
  tech.push({ label: 'Created', value: t.createdAt, explain: 'When I started this transfer.' });
  if (t.expiresAt && t.status !== 'Settled')
    tech.push({
      label: 'Expires',
      value: t.expiresAt,
      explain: 'If still waiting for the other wallet after this, it fails and nothing moves.',
    });
  if (t.settledAt)
    tech.push({ label: 'Settled', value: t.settledAt, explain: 'When Bitcoin confirmed it and both wallets agreed.' });
  return view;
}
