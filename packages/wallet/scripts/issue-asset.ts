// Issues the test asset TUSDT (NIA, precision 6, 1000 tokens) on the payer wallet. Idempotent: if a TUSDT
// issued by this wallet exists, it prints that asset ID. Writes .data/tusdt.json (git-ignored).
import fs from 'node:fs';
import { assetFile, log, mine, openWallet, tokens } from './common.js';

const TICKER = 'TUSDT';
const w = await openWallet('payer');
await w.sync();
const existing = (await w.listAssets()).find((a) => a.ticker === TICKER);
let asset = existing;
if (existing) {
  log('payer', `TUSDT already issued: ${existing.assetId}`);
} else {
  const btc = w.btcBalance();
  log('payer', `BTC vanilla spendable ${btc.vanilla.spendable} sats · colored ${btc.colored.spendable} sats`);
  const { created } = await w.createUtxosIfNeeded();
  if (created) log('payer', `created ${created} colorable UTXOs`);
  mine(1);
  await w.sync();
  asset = await w.issueAssetNia({
    ticker: TICKER,
    name: 'Test USDT (hackathon, no value)',
    precision: 6,
    amounts: ['1000000000'],
  });
  log('payer', `issued ${asset.assetId}`);
}
if (!asset) throw new Error('unreachable');
fs.writeFileSync(
  assetFile,
  `${JSON.stringify({ assetId: asset.assetId, ticker: TICKER, precision: 6, network: process.env.RGB_NETWORK ?? 'mutinynet' }, null, 2)}\n`,
);
log('payer', `balance ${tokens(asset.balance.settled)} TUSDT settled · spendable ${tokens(asset.balance.spendable)}`);
console.log(asset.assetId);
w.close();
