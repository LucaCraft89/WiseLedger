// Smoke test on the real chain. Without flags: both wallets' BTC, assets and UTXOs.
// With --pay [amount]: payee creates a blind invoice, payer pays TUSDT (explicit feeRate), both refresh until
// Settled (or --timeout seconds, default 600). Prints transfer ID, txid and explorer link. No retry after a timeout.
import { NoUtxo, SubmitTimeout } from 'core';
import { fundRegtest, log, mine, openWallet, readAssetId, sleep, tokens } from './common.js';

const args = process.argv.slice(2).filter((a) => a !== '--');
const payIdx = args.indexOf('--pay');
const amount =
  payIdx >= 0 && args[payIdx + 1] && /^\d+$/.test(args[payIdx + 1] ?? '') ? (args[payIdx + 1] as string) : '5000000';
const tIdx = args.indexOf('--timeout');
const timeoutSec = tIdx >= 0 ? Number(args[tIdx + 1]) : 600;

const payer = await openWallet('payer');
const payee = await openWallet('payee');
if (args.includes('--fund-regtest')) {
  fundRegtest(await payer.receiveAddress(), 1);
  fundRegtest(await payee.receiveAddress(), 0.1);
  log('both', 'funded from the local regtest miner');
}
await Promise.all([payer.sync(), payee.sync()]);
for (const [role, w] of [
  ['payer', payer],
  ['payee', payee],
] as const) {
  const b = w.btcBalance();
  log(role, `BTC vanilla ${b.vanilla.settled} sats (spendable ${b.vanilla.spendable}) · colored ${b.colored.settled}`);
  if (payIdx < 0) log(role, `funding address ${await w.receiveAddress()}`);
  for (const a of await w.listAssets())
    log(
      role,
      `${a.ticker} ${a.assetId} settled ${tokens(a.balance.settled, a.precision)} spendable ${tokens(a.balance.spendable, a.precision)}`,
    );
}

if (payIdx < 0) {
  // Receive side check: blind invoice without asset (the payer names it), then decode it back.
  try {
    const inv = await payer.createReceiveInvoice({ amount: '5000000', expirySec: 600 });
    const d = await payer.decodeInvoice(inv.rgbInvoice);
    log('payer', `receive invoice ${inv.rgbInvoice.slice(0, 40)}… expires ${inv.expiresAt}`);
    log(
      'payer',
      `decoded: network ${d.network} · amount ${d.amount ?? 'any'} · asset ${d.assetId ?? 'payer chooses'} · recipient ${d.recipientId.slice(0, 24)}…`,
    );
  } catch (e) {
    if (!(e instanceof NoUtxo)) throw e;
    log('payer', 'cannot create a receive invoice yet: no free UTXO. Fund the funding address above, then run again.');
  }
}

if (payIdx >= 0) {
  const assetId = readAssetId();
  if (!assetId) throw new Error('No TUSDT asset ID: run `pnpm -F wallet issue-asset` first (or set TUSDT_ASSET_ID).');
  const explorer =
    process.env.RGB_EXPLORER_URL || (process.env.RGB_NETWORK === 'regtest' ? 'regtest' : 'https://mutinynet.com');
  await payee.createUtxosIfNeeded();
  const inv = await payee.createReceiveInvoice({ amount, expirySec: 3600 });
  log('payee', `invoice for ${tokens(amount)} TUSDT: ${inv.rgbInvoice.slice(0, 48)}…`);
  const quote = await payer.quotePay({ rgbInvoice: inv.rgbInvoice, assetId, amount });
  log('payer', `quote: fee ${quote.fee} sats at ${quote.feeRate} sat/vB`);
  let transferId: string | undefined;
  const sentAt = Date.now();
  try {
    const sent = await payer.pay({ rgbInvoice: inv.rgbInvoice, assetId, amount });
    transferId = sent.transferId;
    log('payer', `sent: transfer ${sent.transferId} txid ${sent.txid ?? '?'}`);
  } catch (e) {
    if (!(e instanceof SubmitTimeout)) throw e;
    transferId = e.transferId;
    log('payer', `submit timed out: NOT retrying, checking state of transfer ${transferId ?? '(not found yet)'}`);
  }
  const deadline = Date.now() + timeoutSec * 1000;
  let done = false;
  while (!done && Date.now() < deadline) {
    await payee.sync();
    await payer.sync();
    mine(1);
    const out = (await payer.listTransfers(assetId)).filter((t) => t.direction === 'outgoing');
    const ours = transferId ? out.find((t) => t.transferId === transferId) : out.at(-1);
    const inc = (await payee.listTransfers()).filter((t) => t.direction === 'incoming').at(-1);
    log('both', `payer ${ours?.status ?? '?'} · payee ${inc?.status ?? '?'}`);
    if (ours?.status === 'Failed') throw new Error(`Transfer ${ours.transferId} failed.`);
    if (ours?.status === 'Settled' && inc?.status === 'Settled') {
      done = true;
      const secs = ((Date.now() - sentAt) / 1000).toFixed(1);
      log(
        'payer',
        `SETTLED in ${secs}s · transfer ${ours.transferId} · txid ${ours.txid} → ${explorer}/tx/${ours.txid}`,
      );
    } else await sleep(process.env.RGB_NETWORK === 'regtest' ? 2_000 : 10_000);
  }
  if (!done) {
    console.error(`Not settled within ${timeoutSec}s. Run again without --pay to inspect; do not resend.`);
    process.exit(1);
  }
}
payer.close();
payee.close();
