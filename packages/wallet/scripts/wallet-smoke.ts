// Smoke test on the real chain. Without flags: both wallets' BTC, assets and UTXOs.
// With --pay [amount]: payee creates a blind invoice, payer pays TUSDT (explicit feeRate), both refresh until
// Settled (or --timeout seconds, default 600). Prints transfer ID, txid and explorer link. No retry after a timeout.
import { SubmitTimeout } from 'core';
import { log, openWallet, readAssetId, sleep, tokens } from './common.js';

const args = process.argv.slice(2).filter((a) => a !== '--');
const payIdx = args.indexOf('--pay');
const amount = payIdx >= 0 && args[payIdx + 1] && /^\d+$/.test(args[payIdx + 1] ?? '') ? (args[payIdx + 1] as string) : '5000000';
const tIdx = args.indexOf('--timeout');
const timeoutSec = tIdx >= 0 ? Number(args[tIdx + 1]) : 600;

const payer = await openWallet('payer');
const payee = await openWallet('payee');
await Promise.all([payer.sync(), payee.sync()]);
for (const [role, w] of [['payer', payer], ['payee', payee]] as const) {
  const b = w.btcBalance();
  log(role, `BTC vanilla ${b.vanilla.settled} sats (spendable ${b.vanilla.spendable}) · colored ${b.colored.settled}`);
  if (payIdx < 0) log(role, `funding address ${await w.receiveAddress()}`);
  for (const a of await w.listAssets()) log(role, `${a.ticker} ${a.assetId} settled ${tokens(a.balance.settled, a.precision)} spendable ${tokens(a.balance.spendable, a.precision)}`);
}

if (payIdx >= 0) {
  const assetId = readAssetId();
  if (!assetId) throw new Error('No TUSDT asset ID: run `pnpm -F wallet issue-asset` first (or set TUSDT_ASSET_ID).');
  const explorer = process.env.RGB_EXPLORER_URL || 'https://mutinynet.com';
  await payee.createUtxosIfNeeded();
  const inv = await payee.createReceiveInvoice({ amount, expirySec: 3600 });
  log('payee', `invoice for ${tokens(amount)} TUSDT: ${inv.rgbInvoice.slice(0, 48)}…`);
  const quote = await payer.quotePay({ rgbInvoice: inv.rgbInvoice, assetId, amount });
  log('payer', `quote: fee ${quote.fee} sats at ${quote.feeRate} sat/vB`);
  let transferId: string | undefined;
  try {
    const sent = await payer.pay({ rgbInvoice: inv.rgbInvoice, assetId, amount });
    transferId = sent.transferId;
    log('payer', `sent: transfer ${sent.transferId} txid ${sent.txid ?? '?'}`);
  } catch (e) {
    if (!(e instanceof SubmitTimeout)) throw e;
    log('payer', 'submit timed out: NOT retrying, checking state instead');
  }
  const deadline = Date.now() + timeoutSec * 1000;
  let done = false;
  while (!done && Date.now() < deadline) {
    await Promise.all([payee.sync(), payer.sync()]);
    const out = (await payer.listTransfers(assetId)).filter((t) => t.direction === 'outgoing');
    const mine = transferId ? out.find((t) => t.transferId === transferId) : out.at(-1);
    const inc = (await payee.listTransfers()).filter((t) => t.direction === 'incoming').at(-1);
    log('both', `payer ${mine?.status ?? '?'} · payee ${inc?.status ?? '?'}`);
    if (mine?.status === 'Failed') throw new Error(`Transfer ${mine.transferId} failed.`);
    if (mine?.status === 'Settled' && inc?.status === 'Settled') {
      done = true;
      log('payer', `SETTLED transfer ${mine.transferId} txid ${mine.txid} → ${explorer}/tx/${mine.txid}`);
    } else await sleep(10_000);
  }
  if (!done) {
    console.error(`Not settled within ${timeoutSec}s. Run again without --pay to inspect; do not resend.`);
    process.exit(1);
  }
}
payer.close();
payee.close();
