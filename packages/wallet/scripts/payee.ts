// Payee wallet (own mnemonic and data dir). Usage:
//   pnpm -F wallet payee status            BTC + assets
//   pnpm -F wallet payee address           funding address
//   pnpm -F wallet payee invoice [amount|any] [hours]
//                                          blind RGB invoice (base units, no assetId: the payer names the asset;
//                                          `any` = open amount, the payer types it), valid 1 h by default
//   pnpm -F wallet payee refresh           refresh transfers once
//   pnpm -F wallet payee watch             refresh every 10 s (the supplier side during a demo: accepts consignments)
//   pnpm -F wallet payee pay <rgbInvoice> [amount]
//                                          the supplier pays the app (incoming-payment demo); stop `watch` first:
//                                          one wallet = one process. Waits until Settled (or 10 min).
import { log, mine, openWallet, sleep, tokens } from './common.js';

const [cmd = 'status', arg, arg2] = process.argv.slice(2).filter((a) => a !== '--');
const w = await openWallet('payee');
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
    const seen = new Map<string, string>();
    log('payee', 'watching incoming transfers (Ctrl+C to stop)');
    for (;;) {
      try {
        await w.sync();
        for (const t of await w.listTransfers()) {
          if (t.direction !== 'incoming' || seen.get(t.transferId) === t.status) continue;
          if (seen.size > 0 || t.status !== 'Settled')
            log('payee', `transfer ${t.transferId}: ${tokens(t.amount)} ${t.status}`);
          seen.set(t.transferId, t.status);
        }
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
