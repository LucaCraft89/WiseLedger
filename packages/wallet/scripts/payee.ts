// Payee wallet (own mnemonic and data dir). Usage:
//   pnpm -F wallet payee status            BTC + assets
//   pnpm -F wallet payee address           funding address
//   pnpm -F wallet payee invoice <amount>  blind RGB invoice (base units, no assetId: the payer names the asset)
//   pnpm -F wallet payee refresh           refresh transfers once
import { log, openWallet, tokens } from './common.js';

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
  case 'refresh':
    await w.sync();
    for (const t of await w.listTransfers()) log('payee', `${t.transferId} ${t.direction} ${t.amount} ${t.status}`);
    break;
  default: {
    await w.sync();
    const b = w.btcBalance();
    log('payee', `BTC vanilla ${b.vanilla.settled} (spendable ${b.vanilla.spendable}) · colored ${b.colored.settled}`);
    for (const a of await w.listAssets()) log('payee', `${a.ticker} ${a.assetId} ${tokens(a.balance.settled, a.precision)}`);
  }
}
w.close();
