// Payee wallet (own mnemonic and data dir). Usage:
//   pnpm -F wallet payee status            BTC + assets
//   pnpm -F wallet payee address           funding address
//   pnpm -F wallet payee invoice [amount|any] [hours]
//                                          blind RGB invoice (base units, no assetId: the payer names the asset;
//                                          `any` = open amount, the payer types it), valid 1 h by default
//   pnpm -F wallet payee refresh           refresh transfers once
//   pnpm -F wallet payee watch             refresh every 10 s (the supplier side during a demo: accepts consignments);
//                                          prints the wallet (address, BTC, tokens), the last 5 transfers and every
//                                          change with txid, seal, transport, expiry and explorer link
//   pnpm -F wallet payee pay <rgbInvoice> [amount]
//                                          the supplier pays the app (incoming-payment demo); stop `watch` first:
//                                          one wallet = one process. Waits until Settled (or 10 min).
import type { TransferInfo } from 'core';
import { log, mine, openWallet, sleep, tokens } from './common.js';

const [cmd = 'status', arg, arg2] = process.argv.slice(2).filter((a) => a !== '--');
const w = await openWallet('payee');
// Used by printWallet / printTransfer (declared before the commands run them).
let fundingAddress: string | undefined;
const tickers = new Map<string, { ticker: string; precision: number }>();
switch (cmd) {
  case 'address':
    console.log(await w.receiveAddress());
    break;
  case 'invoice': {
    await w.createUtxosIfNeeded();
    const hours = arg2 ? Number(arg2) : 1;
    if (!(hours > 0 && hours <= 24 * 30)) throw new Error('hours must be a number between 0 and 720');
    const amount = arg && arg !== 'any' ? arg : undefined;
    const inv = await w.createReceiveInvoice({ ...(amount ? { amount } : {}), expirySec: Math.round(hours * 3600) });
    log('payee', `invoice expires ${inv.expiresAt}`);
    console.log(inv.rgbInvoice);
    break;
  }
  case 'watch': {
    // The supplier side during a demo: accepts consignments, and prints the wallet and every transfer change.
    const seen = new Map<string, string>();
    await w.sync().catch((e) => log('payee', `first sync failed (${e instanceof Error ? e.message : e}); retrying`));
    await printWallet();
    const recent = (await w.listTransfers()).filter((t) => t.direction !== 'issuance').slice(-5);
    if (recent.length) log('payee', `last ${recent.length} transfers:`);
    for (const t of recent) {
      await printTransfer(t);
      seen.set(t.transferId, t.status);
    }
    for (const t of await w.listTransfers()) seen.set(t.transferId, t.status);
    log('payee', 'watching transfers every 10 s (Ctrl+C to stop)');
    for (;;) {
      try {
        await w.sync();
        let settled = false;
        for (const t of await w.listTransfers()) {
          if (t.direction === 'issuance' || seen.get(t.transferId) === t.status) continue;
          seen.set(t.transferId, t.status);
          await printTransfer(t);
          if (t.status === 'Settled') settled = true;
        }
        if (settled) await printWallet();
      } catch (e) {
        log('payee', `sync failed (${e instanceof Error ? e.message : e}); retrying`);
      }
      await sleep(10_000);
    }
  }
  case 'pay': {
    if (!arg) throw new Error('Usage: pnpm -F wallet payee pay <rgbInvoice> [amount in base units]');
    await w.sync();
    const decoded = await w.decodeInvoice(arg);
    const amount = arg2 ?? decoded.amount;
    if (!amount) throw new Error('This invoice has no amount: add it in base units (5000000 = 5 tokens).');
    // The invoice may leave the asset open: pay with the one NIA asset this wallet holds (or the invoice's).
    const nia = (await w.listAssets()).filter((a) => a.schema === 'NIA');
    const asset = nia.find((a) => a.assetId === decoded.assetId) ?? (nia.length === 1 ? nia[0] : undefined);
    if (!asset)
      throw new Error('Cannot tell which asset to pay with: the invoice names none and this wallet holds several.');
    log('payee', `paying ${tokens(amount, asset.precision)} ${asset.ticker} to the app`);
    const { transferId, txid } = await w.pay({ rgbInvoice: arg, assetId: asset.assetId, amount });
    log('payee', `sent: transfer ${transferId}${txid ? ` · txid ${txid}` : ''}`);
    const deadline = Date.now() + 10 * 60_000;
    let last = '';
    while (Date.now() < deadline) {
      mine(1);
      await w.sync().catch(() => undefined);
      const t = await w.getTransfer(transferId);
      if (t && t.status !== last) {
        last = t.status;
        log('payee', `transfer ${transferId}: ${last}`);
      }
      if (t?.status === 'Settled' || t?.status === 'Failed') break;
      await sleep(10_000);
    }
    if (txid) log('payee', `explorer ${w.config.explorerUrl}/tx/${txid}`);
    break;
  }
  case 'refresh':
    await w.sync();
    for (const t of await w.listTransfers()) log('payee', `${t.transferId} ${t.direction} ${t.amount} ${t.status}`);
    break;
  default: {
    await w.sync();
    const b = w.btcBalance();
    log('payee', `BTC vanilla ${b.vanilla.settled} (spendable ${b.vanilla.spendable}) · colored ${b.colored.settled}`);
    for (const a of await w.listAssets())
      log('payee', `${a.ticker} ${a.assetId} ${tokens(a.balance.settled, a.precision)}`);
  }
}
w.close();

/** Funding address (asked once: the wallet gives a new one per call), BTC and token balances of the payee wallet. */
async function printWallet(): Promise<void> {
  const b = w.btcBalance();
  fundingAddress ??= await w.receiveAddress();
  log('payee', `── wallet (${w.config.network}) ─────────────────────────────`);
  log('payee', `funding address ${fundingAddress}`);
  log(
    'payee',
    `BTC ${b.vanilla.settled} sats (spendable ${b.vanilla.spendable}) · in RGB UTXOs ${b.colored.settled} sats`,
  );
  for (const a of await w.listAssets()) {
    const bal = a.balance;
    log(
      'payee',
      `${a.ticker} ${tokens(bal.settled, a.precision)} settled · ${tokens(bal.spendable, a.precision)} spendable · ${tokens(bal.future, a.precision)} incl. pending · ${a.assetId}`,
    );
  }
}

/** One transfer with its RGB details: amount, status, txid, seal, transport, expiry, explorer link. */
async function printTransfer(t: TransferInfo): Promise<void> {
  if (t.assetId && !tickers.has(t.assetId)) {
    for (const a of await w.listAssets()) tickers.set(a.assetId, { ticker: a.ticker, precision: a.precision });
  }
  const a = t.assetId ? tickers.get(t.assetId) : undefined;
  const amount = a ? `${tokens(t.amount, a.precision)} ${a.ticker}` : `${t.amount} base units`;
  const dir = t.direction === 'incoming' ? 'received' : 'sent';
  log('payee', `transfer ${t.transferId} · ${dir} ${amount} · ${t.status} · updated ${t.updatedAt.slice(11, 19)}`);
  const details = [
    t.txid ? `txid ${t.txid}` : 'no txid yet',
    t.sealType ? `seal ${t.sealType}` : undefined,
    t.recipientId ? `recipient ${t.recipientId.slice(0, 24)}…` : undefined,
    t.transportEndpoints?.[0] ? `via ${t.transportEndpoints[0]}` : undefined,
    t.status !== 'Settled' && t.expiresAt ? `expires ${t.expiresAt.slice(0, 16).replace('T', ' ')} UTC` : undefined,
  ].filter(Boolean);
  log('payee', `   ${details.join(' · ')}`);
  if (t.txid) log('payee', `   ${w.config.explorerUrl}/tx/${t.txid}`);
}
