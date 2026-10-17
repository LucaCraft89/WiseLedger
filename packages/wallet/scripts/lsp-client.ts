// LSP client: a new node C (the app user's node, .data/ln/c) gets inbound TUSDT liquidity from our LSP (lsp.ts).
//
//   pnpm -F wallet lsp-client request [lspUrl]   connect to the LSP, request the channel, stay online until usable
//   pnpm -F wallet lsp-client pay-via-b [tusdt]  C creates an RGB LN invoice (default 1 TUSDT); node B pays it,
//                                                routed B → A (LSP) → C; waits for Succeeded on both sides
//   pnpm -F wallet lsp-client status             C's channels and payments
//
// LSP_URL (default http://127.0.0.1:8790), LN_C_PEER_PORT (9737), LN_B_PEER_PORT (9736). B is the a-003 spike node
// (.data/ln/b, channel with A). Each node folder is opened by one process only; the LSP runs in its own process.
import path from 'node:path';
import { LnNode, type LnNode as Node } from '../src/ln/node.js';
import { loadDotEnv, log, readAssetId, repoRoot, sleep, tokens } from './common.js';

loadDotEnv();
const args = process.argv.slice(2).filter((a) => a !== '--');
const [cmd = 'status', arg] = args;
const LSP_URL = (cmd === 'request' && arg) || process.env.LSP_URL || 'http://127.0.0.1:8790';
const assetId = readAssetId();
if (!assetId) throw new Error('No TUSDT asset ID (.data/tusdt.json): run pnpm -F wallet issue-asset first.');

interface LspInfo {
  pubkey: string;
  host: string;
  peerPort: number;
  channel: { capacitySat: number; assetAmount: string };
  available: boolean;
}

async function lsp<T>(p: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${LSP_URL}${p}`, { ...init, signal: AbortSignal.timeout(60_000) });
  const body = (await res.json()) as T & { error?: { message: string } };
  if (!res.ok) throw new Error(`LSP ${p}: ${body.error?.message ?? res.status}`);
  return body;
}

async function show(n: Node): Promise<void> {
  for (const c of await n.channels())
    log(
      `ln-${n.name}`,
      `channel ${c.channel_id.slice(0, 12)}… peer ${c.peer_pubkey.slice(0, 16)}… usable=${c.is_usable} TUSDT ${tokens(String(c.asset_local_amount ?? 0))} local / ${tokens(String(c.asset_remote_amount ?? 0))} remote${c.funding_txid ? ` · funding https://mutinynet.com/tx/${c.funding_txid}` : ''}`,
    );
  for (const p of await n.payments())
    log(
      `ln-${n.name}`,
      `payment ${p.payment_hash.slice(0, 16)}… ${p.status} ${p.inbound ? 'in' : 'out'} ${tokens(String(p.asset_amount ?? 0))} TUSDT`,
    );
}

const C = await LnNode.open({
  name: 'C',
  dataDir: path.join(repoRoot, '.data/ln/c'),
  peerPort: Number(process.env.LN_C_PEER_PORT ?? 9737),
});
log('ln-C', `node ${C.pubkey}`);
const opened: Node[] = [C];
try {
  switch (cmd) {
    case 'status':
      await show(C);
      break;
    case 'request': {
      const info = await lsp<LspInfo>('/info');
      log(
        'ln-C',
        `LSP ${info.pubkey.slice(0, 16)}… offers ${info.channel.capacitySat} sats + ${tokens(info.channel.assetAmount)} TUSDT inbound`,
      );
      await C.call('connectPeer', `${info.pubkey}@${info.host}:${info.peerPort}`);
      log('ln-C', 'connected to the LSP');
      const t0 = Date.now();
      const ask = () =>
        lsp<{ status: string; error?: string }>('/channel-request', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ pubkey: C.pubkey }),
        });
      let r: { status: string; error?: string } | undefined;
      for (let i = 0; i < 6 && !r; i++) {
        try {
          r = await ask();
        } catch (e) {
          // 503 = the LSP is preparing funds (one block): wait and ask again.
          if (!/preparing/i.test(String(e)) || i === 5) throw e;
          log('ln-C', `${e instanceof Error ? e.message : e} Waiting…`);
          await sleep(60_000);
          await C.call('connectPeer', `${info.pubkey}@${info.host}:${info.peerPort}`).catch(() => undefined);
        }
      }
      if (!r) throw new Error('No answer from the LSP.');
      let cur: { status: string; error?: string } = r;
      log('ln-C', `request → ${cur.status}${cur.error ? ` (${cur.error})` : ''}`);
      // Stay online while the funding transaction confirms; the LSP refreshes on its side.
      for (let i = 0; i < 90 && cur.status === 'opening'; i++) {
        await sleep(10_000);
        await C.call('refreshTransfers', { skip_sync: false }).catch(() => undefined);
        cur = await lsp(`/channel-request/${C.pubkey}`);
        const c = (await C.channels()).find((x) => x.peer_pubkey === info.pubkey);
        log('ln-C', `channel ${cur.status} · ready=${c?.ready ?? false} usable=${c?.is_usable ?? false}`);
      }
      log('ln-C', `channel ${cur.status} after ${Math.round((Date.now() - t0) / 1000)} s`);
      await show(C);
      break;
    }
    case 'pay-via-b': {
      const amount = Math.round(Number(arg ?? '1') * 1_000_000);
      const info = await lsp<LspInfo>('/info');
      const B = await LnNode.open({
        name: 'B',
        dataDir: path.join(repoRoot, '.data/ln/b'),
        peerPort: Number(process.env.LN_B_PEER_PORT ?? 9736),
      });
      opened.push(B);
      for (const n of [B, C])
        await n.call('connectPeer', `${info.pubkey}@${info.host}:${info.peerPort}`).catch(() => undefined);
      await sleep(5_000);
      const inv = await C.call<{ invoice: string }>('createInvoice', {
        amt_msat: 3_000_000,
        expiry_sec: 3600,
        asset_id: assetId,
        asset_amount: amount,
      });
      log('ln-C', `RGB Lightning invoice for ${tokens(String(amount))} TUSDT: ${inv.invoice.slice(0, 40)}…`);
      const t0 = Date.now();
      const sent = await B.call<{ payment_hash: string; status?: string }>('sendPayment', { invoice: inv.invoice });
      log('ln-B', `sendPayment → ${sent.status ?? 'sent'} · hash ${sent.payment_hash}`);
      let st = '';
      for (let i = 0; i < 45 && !/succeeded|failed/i.test(st); i++) {
        await sleep(2_000);
        st = (await B.payments()).find((p) => p.payment_hash === sent.payment_hash)?.status ?? st;
      }
      const got = (await C.payments()).find((p) => p.payment_hash === sent.payment_hash);
      log(
        'both',
        `B: ${st} · C: ${got?.status ?? 'not seen'} · ${((Date.now() - t0) / 1000).toFixed(1)} s · hash ${sent.payment_hash}`,
      );
      await show(C);
      break;
    }
    default:
      throw new Error(`unknown command ${cmd}`);
  }
} finally {
  for (const n of opened) await n.close();
}
process.exit(0);
