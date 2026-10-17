// Payee wallet (own mnemonic and data dir). Usage:
//   pnpm -F wallet payee status            BTC + assets
//   pnpm -F wallet payee address           funding address
//   pnpm -F wallet payee invoice <amount>  blind RGB invoice (base units, no assetId: the payer names the asset)
//   pnpm -F wallet payee refresh           refresh transfers once
//   pnpm -F wallet payee watch             refresh every 10 s (the supplier side during a demo: accepts consignments)
import { log, openWallet, sleep, tokens } from './common.js';

const [cmd = 'status', arg] = process.argv.slice(2).filter((a) => a !== '--');
const w = await openWallet('payee');
switch (cmd) {
  case 'address':
    console.log(await w.receiveAddress());
    break;
  case 'invoice': {
    await w.createUtxosIfNeeded();
    const inv = await w.createReceiveInvoice({ ...(arg ? { amount: arg } : {}), expirySec: 3600 });
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
