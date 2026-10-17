// Lightning spike (PLAN §5.3): two of OUR OWN RGB Lightning nodes on Mutinynet, a direct channel carrying TUSDT, one
// RGB payment over Lightning. Uses the patched @utexo/wdk-rgb-lightning 0.1.0-beta.15 (createWithStorage signer) and
// @utexo/rgb-lightning-node-nodejs 0.1.0-beta.16 built from source with the rln-external-signer fix, loaded from
// LN_MODULES (default ~/prove/lightning/node_modules): the compiled .node is never committed. Separate data dirs:
// .data/ln/a and .data/ln/b (seed in <dir>/mnemonic, 0600). One machine at a time.
//
//   tsx spikes/ln/ln.ts status       node info, BTC, TUSDT, channels (both nodes)
//   tsx spikes/ln/ln.ts fund-btc     payer WDK wallet → 60,000 sats to A, 12,000 to B (on-chain)
//   tsx spikes/ln/ln.ts b-to-a       B → 10,000 sats to A (uncolored coins for the channel)
//   tsx spikes/ln/ln.ts utxos        A: 2 free colorable UTXOs (an RGB channel needs one besides the asset's)
//   tsx spikes/ln/ln.ts fund-asset   A: UTXOs + RGB invoice; payer pays 40 TUSDT on-chain; refresh until settled
//   tsx spikes/ln/ln.ts channel      A ↔ B peer, open a 30,010-sat (LN_CAPACITY) channel with 20 TUSDT, wait until usable
//   tsx spikes/ln/ln.ts pay [tusdt]  B creates an RGB LN invoice (default 2 TUSDT), A pays it, wait for Succeeded
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { log, openWallet, readAssetId, repoRoot, sleep, tokens } from '../../scripts/common.js';

type Call = (req?: unknown) => Promise<unknown>;
type LnAccount = Record<string, Call>;
interface LnNode {
  name: 'A' | 'B';
  acct: LnAccount;
  pubkey: string;
  port: number;
}

const LN_MODULES = process.env.LN_MODULES || path.join(os.homedir(), 'prove/lightning/node_modules');
const INDEXER = process.env.RGB_INDEXER_URL || 'https://esplora.signet.kaleidoswap.com';
const PROXY = process.env.RGB_TRANSPORT_ENDPOINT || 'rpcs://proxy.kaleidoswap.com/json-rpc';
const assetId = readAssetId();
if (!assetId) throw new Error('No TUSDT asset ID (.data/tusdt.json): run pnpm -F wallet issue-asset first.');

const { default: Manager } = (await import(
  pathToFileURL(path.join(LN_MODULES, '@utexo/wdk-rgb-lightning/index.js')).href
)) as {
  default: (new (
    seed: string,
    cfg: object,
  ) => { getAccount(i: number): Promise<LnAccount> }) & {
    getRandomSeedPhrase(n: number): string;
  };
};

async function openNode(name: 'A' | 'B', port: number): Promise<LnNode> {
  const dir = path.join(repoRoot, '.data/ln', name.toLowerCase());
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const seedFile = path.join(dir, 'mnemonic');
  if (!fs.existsSync(seedFile)) fs.writeFileSync(seedFile, `${Manager.getRandomSeedPhrase(12)}\n`, { mode: 0o600 });
  const manager = new Manager(fs.readFileSync(seedFile, 'utf8').trim(), {
    network: 'signet',
    dataDir: path.join(dir, 'node'),
    ldkPeerListeningPort: port,
  });
  const acct = await manager.getAccount(0);
  const t0 = Date.now();
  await acct.unlock?.({
    indexer_url: INDEXER,
    proxy_endpoint: PROXY,
    announce_addresses: [],
    announce_alias: `wiseledger-${name}`,
  });
  const info = (await acct.getNodeInfo?.()) as { pubkey: string };
  log(
    `ln-${name}`,
    `unlocked in ${((Date.now() - t0) / 1000).toFixed(1)}s · ${info.pubkey.slice(0, 16)}… · port ${port}`,
  );
  return { name, acct, pubkey: info.pubkey, port };
}

const call = (n: LnNode, method: string, req?: unknown) => {
  const fn = n.acct[method];
  if (!fn) throw new Error(`LN account has no ${method}()`);
  return fn.call(n.acct, req);
};

async function status(n: LnNode): Promise<void> {
  const btc = await call(n, 'getBalanceDetails').catch(() => call(n, 'getBalance'));
  const bal = await call(n, 'getAssetBalance', assetId).catch((e: unknown) => ({ error: String(e) }));
  const chans = ((await call(n, 'listChannels')) as Record<string, unknown>[]) ?? [];
  log(`ln-${n.name}`, `address ${await call(n, 'getAddress')}`);
  log(`ln-${n.name}`, `btc ${JSON.stringify(btc, (_k, v) => (typeof v === 'bigint' ? v.toString() : v))}`);
  log(`ln-${n.name}`, `TUSDT ${JSON.stringify(bal)}`);
  const pays = ((await call(n, 'listPayments').catch(() => [])) as Record<string, unknown>[]) ?? [];
  for (const p of pays)
    log(
      `ln-${n.name}`,
      `payment ${String(p.payment_hash ?? '').slice(0, 16)}… ${p.status} inbound=${p.inbound} asset_amount=${p.asset_amount}`,
    );
  for (const c of chans)
    log(
      `ln-${n.name}`,
      `channel ${String(c.channel_id ?? '').slice(0, 12)}… funding ${c.funding_txid} ready=${c.ready} usable=${c.is_usable} capacity=${c.capacity_sat} asset_local=${c.asset_local_amount} asset_remote=${c.asset_remote_amount}`,
    );
}

const cmd = process.argv.slice(2).filter((a) => a !== '--')[0] ?? 'status';
const arg = process.argv.slice(2).filter((a) => a !== '--')[1];
const A = await openNode('A', 9735);
const B = await openNode('B', 9736);
try {
  switch (cmd) {
    case 'status':
      await status(A);
      await status(B);
      break;
    case 'fund-btc': {
      const payer = await openWallet('payer');
      const rgb = payer.rgb as unknown as {
        sendBtc(p: { address: string; amount: number; feeRate: number }): Promise<string>;
      };
      for (const [n, amount] of [
        [A, 60_000],
        [B, 12_000],
      ] as const) {
        const address = (await call(n, 'getAddress')) as string;
        const txid = await rgb.sendBtc({ address, amount, feeRate: 2 });
        log('payer', `sent ${amount} sats to ln-${n.name}: https://mutinynet.com/tx/${txid}`);
      }
      payer.close();
      break;
    }
    case 'utxos': {
      await call(A, 'createUtxos', { up_to: false, num: 2, size: 1_000, fee_rate: 2, skip_sync: false });
      log('ln-A', 'created 2 colorable UTXOs of 1,000 sats (wait 1 block)');
      break;
    }
    case 'b-to-a': {
      const address = (await call(A, 'getAddress')) as string;
      const r = await call(B, 'sendBtc', { address, amount: 10_000, fee_rate: 2, skip_sync: false });
      log('ln-B', `sent 10,000 sats to ln-A: ${JSON.stringify(r)}`);
      break;
    }
    case 'fund-asset': {
      await call(A, 'createUtxos', { up_to: true, num: 3, size: 1_000, fee_rate: 2, skip_sync: false }).catch((e) =>
        log('ln-A', `createUtxos: ${e instanceof Error ? e.message : e}`),
      );
      const inv = (await call(A, 'createRgbInvoice', {
        min_confirmations: 1,
        witness: false,
        assignment_kind: 'Fungible',
        assignment_amount: 40_000_000,
        duration_seconds: 3600,
      })) as { invoice: string };
      log('ln-A', `RGB on-chain invoice ${inv.invoice.slice(0, 40)}…`);
      const payer = await openWallet('payer');
      const sent = await payer.pay({ rgbInvoice: inv.invoice, assetId, amount: '40000000' });
      log('payer', `paid 40 TUSDT to ln-A: transfer ${sent.transferId} https://mutinynet.com/tx/${sent.txid}`);
      for (let i = 0; i < 40; i++) {
        await call(A, 'refreshTransfers', { skip_sync: false });
        await payer.sync();
        const t = await payer.getTransfer(sent.transferId);
        log('both', `payer ${t?.status}`);
        if (t?.status === 'Settled') break;
        await sleep(10_000);
      }
      await call(A, 'refreshTransfers', { skip_sync: false });
      payer.close();
      await status(A);
      break;
    }
    case 'channel': {
      await call(A, 'sync').catch(() => undefined);
      log('ln-A', `btc ${JSON.stringify(await call(A, 'getBalanceDetails'))}`);
      const unspents =
        ((await call(A, 'listUnspents', false)) as { utxo: { btc_amount: number; colorable: boolean } }[]) ?? [];
      log('ln-A', `unspents ${JSON.stringify(unspents.map((u) => [u.utxo.btc_amount, u.utxo.colorable]))}`);
      await call(A, 'connectPeer', `${B.pubkey}@127.0.0.1:${B.port}`);
      log('ln-A', 'peer B connected');
      const opened = await call(A, 'openChannel', {
        peer_pubkey_and_opt_addr: `${B.pubkey}@127.0.0.1:${B.port}`,
        capacity_sat: Number(process.env.LN_CAPACITY ?? 30_010),
        push_msat: 3_100_000,
        asset_id: assetId,
        asset_amount: 20_000_000,
        public: false,
        with_anchors: process.env.LN_ANCHORS !== '0',
      });
      log('ln-A', `openChannel → ${JSON.stringify(opened)}`);
      for (let i = 0; i < 90; i++) {
        await sleep(10_000);
        const chans = ((await call(A, 'listChannels')) as Record<string, unknown>[]) ?? [];
        const c = chans.find((x) => x.peer_pubkey === B.pubkey);
        log(
          'ln-A',
          `channel ready=${c?.ready} usable=${c?.is_usable} funding=${String(c?.funding_txid ?? '').slice(0, 16)}`,
        );
        if (c?.is_usable) break;
      }
      await status(A);
      break;
    }
    case 'pay': {
      const amount = Math.round(Number(arg ?? '2') * 1_000_000);
      await call(A, 'connectPeer', `${B.pubkey}@127.0.0.1:${B.port}`).catch(() => undefined);
      await sleep(5_000);
      const inv = (await call(B, 'createInvoice', {
        amt_msat: 3_000_000,
        expiry_sec: 3600,
        asset_id: assetId,
        asset_amount: amount,
      })) as { invoice: string };
      log('ln-B', `LN invoice for ${tokens(String(amount))} TUSDT: ${inv.invoice.slice(0, 40)}…`);
      const t0 = Date.now();
      const sent = (await call(A, 'sendPayment', { invoice: inv.invoice })) as Record<string, unknown>;
      log('ln-A', `sendPayment → ${JSON.stringify(sent)}`);
      for (let i = 0; i < 30; i++) {
        await sleep(2_000);
        const pays = ((await call(A, 'listPayments').catch(() => [])) as Record<string, unknown>[]) ?? [];
        const st = String(pays.find((x) => x.payment_hash === sent.payment_hash)?.status ?? sent.status ?? '');
        log('ln-A', `payment ${st}`);
        if (/succeeded|failed/i.test(st)) {
          log('ln-A', `${st} in ${((Date.now() - t0) / 1000).toFixed(1)}s · hash ${String(sent.payment_hash)}`);
          break;
        }
      }
      await status(A);
      await status(B);
      break;
    }
    default:
      throw new Error(`unknown command ${cmd}`);
  }
} finally {
  for (const n of [A, B]) await call(n, 'shutdown').catch(() => undefined);
}
process.exit(0);
