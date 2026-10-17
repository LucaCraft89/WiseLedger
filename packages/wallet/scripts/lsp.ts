// Self-made LSP for inbound liquidity (PLAN §7 extra): A acts as LSP for our asset on Mutinynet, since UTEXO's LSP is
// not on this network. Node A (.data/ln/a, BTC + TUSDT) stays online and opens, on request, one fixed channel per
// node pubkey with TUSDT on A's side, so a new node can receive TUSDT over Lightning at once.
//
//   pnpm -F wallet lsp              serve: GET /info · POST /channel-request {pubkey} · GET /channel-request/:pubkey
//   pnpm -F wallet lsp status       node, BTC, TUSDT, channels, requests
//   pnpm -F wallet lsp fund [sats]  payer WDK wallet → sats to node A (default 50,000), + 2 free colorable UTXOs
//
// The client first connects to A as a peer (`<pubkey>@<host>:<peerPort>` from /info), then requests the channel.
// Env: LSP_HTTP_PORT (8790), LSP_PEER_PORT (9735), LSP_HOST (127.0.0.1, what /info advertises), LSP_CHANNEL_SATS
// (30010, the RGB minimum), LSP_CHANNEL_ASSET (10000000 = 10 TUSDT), LSP_PUSH_MSAT (3100000), LSP_DATA_DIR (.data/ln/a).
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { LnNode } from '../src/ln/node.js';
import { loadDotEnv, log, openWallet, readAssetId, repoRoot, sleep, tokens } from './common.js';

loadDotEnv();
const env = process.env;
const HTTP_PORT = Number(env.LSP_HTTP_PORT ?? 8790);
const PEER_PORT = Number(env.LSP_PEER_PORT ?? 9735);
const HOST = env.LSP_HOST ?? '127.0.0.1';
const CAPACITY = Number(env.LSP_CHANNEL_SATS ?? 30_010);
const ASSET_AMOUNT = Number(env.LSP_CHANNEL_ASSET ?? 10_000_000);
const PUSH_MSAT = Number(env.LSP_PUSH_MSAT ?? 3_100_000);
const dataDir = path.resolve(repoRoot, env.LSP_DATA_DIR ?? '.data/ln/a');
const requestsFile = path.join(dataDir, 'lsp-requests.json');
const assetId = readAssetId();
if (!assetId) throw new Error('No TUSDT asset ID (.data/tusdt.json): run pnpm -F wallet issue-asset first.');

type RequestStatus = 'opening' | 'open' | 'failed';
interface ChannelRequest {
  pubkey: string;
  status: RequestStatus;
  requestedAt: string;
  temporaryChannelId?: string;
  channelId?: string;
  fundingTxid?: string;
  error?: string;
}

function loadRequests(): Record<string, ChannelRequest> {
  try {
    return JSON.parse(fs.readFileSync(requestsFile, 'utf8')) as Record<string, ChannelRequest>;
  } catch {
    return {};
  }
}
function saveRequests(r: Record<string, ChannelRequest>): void {
  fs.writeFileSync(requestsFile, `${JSON.stringify(r, null, 2)}\n`, { mode: 0o600 });
}

const PUBKEY = /^0[23][0-9a-f]{64}$/;

const [cmd = 'serve', arg] = process.argv.slice(2).filter((a) => a !== '--');
const node = await LnNode.open({ name: 'lsp', dataDir, peerPort: PEER_PORT, forwardToPrivateChannels: true });
log('lsp', `node ${node.pubkey} · peer port ${PEER_PORT}`);

async function status(): Promise<void> {
  const btc = await node.btc();
  const a = await node.assetBalance(assetId as string);
  log('lsp', `address ${await node.address()}`);
  log('lsp', `BTC vanilla ${btc.vanilla} · colored ${btc.colored}`);
  log(
    'lsp',
    `TUSDT on-chain ${tokens(String(a.spendable))} · in channels ${tokens(String(a.offchainOutbound))} out / ${tokens(String(a.offchainInbound))} in`,
  );
  for (const c of await node.channels())
    log(
      'lsp',
      `channel ${c.channel_id.slice(0, 12)}… peer ${c.peer_pubkey.slice(0, 16)}… usable=${c.is_usable} capacity=${c.capacity_sat} TUSDT ${tokens(String(c.asset_local_amount ?? 0))} / ${tokens(String(c.asset_remote_amount ?? 0))}`,
    );
  for (const r of Object.values(loadRequests())) log('lsp', `request ${r.pubkey.slice(0, 16)}… ${r.status}`);
  const u =
    (await node.call<{ utxo: { btc_amount: number; colorable: boolean }; rgb_allocations?: unknown[] }[]>(
      'listUnspents',
      false,
    )) ?? [];
  log(
    'lsp',
    `UTXOs (sats/colorable/allocations): ${u.map((x) => `${x.utxo.btc_amount}/${x.utxo.colorable ? 'c' : 'v'}/${x.rgb_allocations?.length ?? 0}`).join(' ')}`,
  );
}

/** Can A open one more channel? Plain reasons when not. */
async function canOpen(): Promise<string | undefined> {
  const btc = await node.btc();
  const colored = await freeColoredSats();
  if (colored < CAPACITY && btc.vanilla < CAPACITY + 6_000)
    return `The LSP has ${btc.vanilla + colored} free sats; a channel needs about ${CAPACITY + 6_000}. Run \`pnpm -F wallet lsp fund\`.`;
  const a = await node.assetBalance(assetId as string);
  if (a.spendable < ASSET_AMOUNT)
    return `The LSP has ${tokens(String(a.spendable))} TUSDT on-chain; a channel puts ${tokens(String(ASSET_AMOUNT))} in it.`;
  return undefined;
}

/** Free colored sats (UTXOs without RGB allocations): what rgb-lib can put into a channel. */
async function freeColoredSats(): Promise<number> {
  const u =
    (await node.call<{ utxo: { btc_amount: number; colorable: boolean }; rgb_allocations?: unknown[] }[]>(
      'listUnspents',
      false,
    )) ?? [];
  return u
    .filter((x) => x.utxo.colorable && !(x.rgb_allocations?.length ?? 0))
    .reduce((s, x) => s + x.utxo.btc_amount, 0);
}

let preparing = 0;
/** One colored UTXO big enough for the next channel (usable after 1 block). At most once per 2 minutes. */
async function prepareFunding(): Promise<void> {
  if (Date.now() - preparing < 120_000) return;
  preparing = Date.now();
  const size = CAPACITY + 3_000;
  await node
    .call('createUtxos', { up_to: false, num: 1, size, fee_rate: 2, skip_sync: false })
    .then(() => log('lsp', `moved ${size} sats into a colored UTXO for the next channel (usable after 1 block)`))
    .catch((err: unknown) => log('lsp', `createUtxos: ${err instanceof Error ? err.message : err}`));
}

async function refresh(r: ChannelRequest): Promise<ChannelRequest> {
  if (r.status !== 'opening') return r;
  const c = (await node.channels()).find((x) => x.peer_pubkey === r.pubkey);
  if (!c) return r;
  return {
    ...r,
    channelId: c.channel_id,
    ...(c.funding_txid ? { fundingTxid: c.funding_txid } : {}),
    status: c.is_usable ? 'open' : 'opening',
  };
}

async function openFor(pubkey: string): Promise<ChannelRequest> {
  const reqs = loadRequests();
  const prev = reqs[pubkey];
  if (prev && prev.status !== 'failed') return refresh(prev);
  if (!(await node.peers()).includes(pubkey)) {
    throw Object.assign(new Error(`Connect to ${node.pubkey}@${HOST}:${PEER_PORT} first, then ask again.`), {
      status: 409,
      code: 'NOT_CONNECTED',
    });
  }
  // The node's wallet only sees new coins after a sync (refreshTransfers does not sync the vanilla side).
  await node.call('sync').catch(() => undefined);
  const reason = await canOpen();
  if (reason) throw Object.assign(new Error(reason), { status: 503, code: 'LSP_NO_LIQUIDITY' });
  const r: ChannelRequest = { pubkey, status: 'opening', requestedAt: new Date().toISOString() };
  try {
    const opened = await node.call<{ temporary_channel_id?: string }>('openChannel', {
      peer_pubkey_and_opt_addr: pubkey,
      capacity_sat: CAPACITY,
      push_msat: PUSH_MSAT,
      asset_id: assetId,
      asset_amount: ASSET_AMOUNT,
      public: false,
      with_anchors: true,
    });
    if (opened?.temporary_channel_id) r.temporaryChannelId = opened.temporary_channel_id;
    log('lsp', `channel for ${pubkey.slice(0, 16)}… opening: ${CAPACITY} sats + ${tokens(String(ASSET_AMOUNT))} TUSDT`);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (/NoAvailableUtxos|uncolored UTXO/i.test(msg)) {
      // rgb-lib funds an RGB channel from FREE COLORED UTXOs (not the vanilla coins) and reports a shortfall as
      // InsufficientAllocationSlots → rln "No uncolored UTXOs". Move capacity + fees into one colored UTXO.
      await prepareFunding();
      throw Object.assign(new Error('The LSP is preparing funds for a new channel. Ask again in about a minute.'), {
        status: 503,
        code: 'LSP_PREPARING',
      });
    }
    r.status = 'failed';
    r.error = msg;
    log('lsp', `channel for ${pubkey.slice(0, 16)}… failed: ${r.error}`);
  }
  reqs[pubkey] = r;
  saveRequests(reqs);
  return r;
}

function send(res: http.ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
}

async function readJson(req: http.IncomingMessage): Promise<Record<string, unknown>> {
  let raw = '';
  for await (const chunk of req) {
    raw += chunk;
    if (raw.length > 4096) throw Object.assign(new Error('Request too large.'), { status: 413, code: 'TOO_LARGE' });
  }
  try {
    return JSON.parse(raw || '{}') as Record<string, unknown>;
  } catch {
    throw Object.assign(new Error('The body must be JSON.'), { status: 400, code: 'BAD_JSON' });
  }
}

async function serve(): Promise<void> {
  const server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? '/', 'http://lsp');
      if (req.method === 'GET' && url.pathname === '/info') {
        return send(res, 200, {
          pubkey: node.pubkey,
          host: HOST,
          peerPort: PEER_PORT,
          network: 'signet',
          assetId,
          channel: { capacitySat: CAPACITY, assetAmount: String(ASSET_AMOUNT), pushMsat: PUSH_MSAT },
          available: (await canOpen()) === undefined,
        });
      }
      if (req.method === 'POST' && url.pathname === '/channel-request') {
        const pubkey = String((await readJson(req)).pubkey ?? '').toLowerCase();
        if (!PUBKEY.test(pubkey))
          return send(res, 400, {
            error: { code: 'BAD_PUBKEY', message: 'Send the node public key (66 hex characters).' },
          });
        const r = await openFor(pubkey);
        return send(res, r.status === 'failed' ? 502 : 202, r);
      }
      const m = /^\/channel-request\/(0[23][0-9a-f]{64})$/.exec(url.pathname);
      if (req.method === 'GET' && m?.[1]) {
        const reqs = loadRequests();
        const r = reqs[m[1]];
        if (!r)
          return send(res, 404, { error: { code: 'NOT_FOUND', message: 'No channel was requested for this node.' } });
        const now = await refresh(r);
        if (now.status !== r.status || now.channelId !== r.channelId) {
          reqs[m[1]] = now;
          saveRequests(reqs);
        }
        return send(res, 200, now);
      }
      send(res, 404, { error: { code: 'NOT_FOUND', message: 'Unknown LSP route.' } });
    } catch (e) {
      const err = e as { status?: number; code?: string; message?: string };
      send(res, err.status ?? 500, { error: { code: err.code ?? 'LSP_ERROR', message: err.message ?? 'LSP error.' } });
    }
  });
  server.listen(HTTP_PORT, HOST);
  log('lsp', `serving http://${HOST}:${HTTP_PORT} (A acts as LSP for TUSDT on Mutinynet)`);
  const reason = await canOpen();
  if (reason) log('lsp', reason);
  // Keep RGB channel transfers moving (consignments, funding confirmations).
  for (;;) {
    await node.call('sync').catch(() => undefined);
    await node.call('refreshTransfers', { skip_sync: false }).catch(() => undefined);
    await sleep(15_000);
  }
}

const stop = async () => {
  await node.close();
  process.exit(0);
};
process.on('SIGINT', stop);
process.on('SIGTERM', stop);

switch (cmd) {
  case 'serve':
    await serve();
    break;
  case 'status':
    await status();
    break;
  case 'fund': {
    const sats = Number(arg ?? 50_000);
    const payer = await openWallet('payer');
    const txid = await payer.rgb.sendBtc({
      address: await node.address(),
      amount: sats,
      feeRate: payer.config.feeRate,
    });
    log('payer', `sent ${sats} sats to the LSP · ${payer.config.explorerUrl}/tx/${txid}`);
    payer.close();
    await sleep(45_000); // one Mutinynet block
    await node
      .call('createUtxos', { up_to: true, num: 2, size: 1_000, fee_rate: 2, skip_sync: false })
      .catch((e) => log('lsp', `createUtxos: ${e instanceof Error ? e.message : e}`));
    await status();
    break;
  }
  default:
    throw new Error(`unknown command ${cmd}`);
}
await node.close();
process.exit(0);
