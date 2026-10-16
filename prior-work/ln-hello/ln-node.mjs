// Un nodo RGB Lightning (WDK) in un processo dedicato, con una piccola API HTTP solo su 127.0.0.1.
//   node ln-node.mjs <A|B> <porta-peer> <porta-http>
// GET /info · /channels · /invoice?asset_amount=&amt_msat= · /pay?invoice= · /status?invoice= · /payments · /connect?peer= · /stop
import WalletManagerRgbLightning from '@utexo/wdk-rgb-lightning'
import bip39 from 'bip39'
import fs from 'node:fs'
import http from 'node:http'
import path from 'node:path'

const [name, peerPort, httpPort] = [process.argv[2], Number(process.argv[3]), Number(process.argv[4])]
const TUSDT = 'rgb:hIGgfm4S-KludZNU-CwHWEK3-tCrGuQ6-xfLoyNe-PLlzq9A'
const j = (x) => JSON.stringify(x, (_, v) => (typeof v === 'bigint' ? v.toString() : v))
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), `[${name}]`, ...a)

const dir = path.join(process.env.HOME, 'prova/ln', name)
fs.mkdirSync(path.join(dir, 'data'), { recursive: true, mode: 0o700 })
const mfile = path.join(dir, 'mnemonic')
if (!fs.existsSync(mfile)) fs.writeFileSync(mfile, bip39.generateMnemonic(), { mode: 0o600 })
const manager = new WalletManagerRgbLightning(fs.readFileSync(mfile, 'utf8').trim(), {
  network: 'signet', dataDir: path.join(dir, 'data'), ldkPeerListeningPort: peerPort
})
const account = await manager.getAccount(0)
await account.unlock({
  indexer_url: 'https://esplora.signet.kaleidoswap.com',
  proxy_endpoint: 'rpcs://proxy.kaleidoswap.com/json-rpc',
  announce_addresses: [], announce_alias: `prova-${name}`
})
const info = await account.getNodeInfo()
log(`sbloccato · pubkey ${info.pubkey} · peer 127.0.0.1:${peerPort} · api http://127.0.0.1:${httpPort}`)

const routes = {
  info: async () => ({ pubkey: info.pubkey, peer: `${info.pubkey}@127.0.0.1:${peerPort}`, assets: await account.listAssets() }),
  channels: async () => account.listChannels(),
  connect: async (q) => account.connectPeer(q.get('peer')),
  invoice: async (q) => account.createInvoice({ amt_msat: Number(q.get('amt_msat') ?? 3_000_000), expiry_sec: 3600, asset_id: TUSDT, asset_amount: Number(q.get('asset_amount')) }),
  pay: async (q) => account.sendPayment({ invoice: q.get('invoice') }),
  status: async (q) => account.getInvoiceStatus(q.get('invoice')),
  payments: async () => account.listPayments(),
  stop: async () => { setTimeout(async () => { try { await account.shutdown() } catch {} process.exit(0) }, 100); return { ok: true } }
}

http.createServer(async (req, res) => {
  const u = new URL(req.url, 'http://x')
  const fn = routes[u.pathname.slice(1)]
  try {
    const out = fn ? await fn(u.searchParams) : { error: 'route sconosciuta' }
    res.writeHead(fn ? 200 : 404, { 'content-type': 'application/json' }).end(j(out))
  } catch (e) {
    log('errore', u.pathname, e.message)
    res.writeHead(500, { 'content-type': 'application/json' }).end(j({ error: e.message }))
  }
}).listen(httpPort, '127.0.0.1')
