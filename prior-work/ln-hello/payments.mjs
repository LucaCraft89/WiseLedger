// Elenca i pagamenti di A e B (solo lettura). Lanciare da ~/prova/ln-hello
import WalletManagerRgbLightning from '@utexo/wdk-rgb-lightning'
import fs from 'node:fs'
import path from 'node:path'
const ROOT = path.join(process.env.HOME, 'prova/ln')
const UNLOCK = { indexer_url: 'https://esplora.signet.kaleidoswap.com', proxy_endpoint: 'rpcs://proxy.kaleidoswap.com/json-rpc', announce_addresses: [] }
const open = []
for (const [name, port] of [['A', 9735], ['B', 9736]]) {
  const m = new WalletManagerRgbLightning(fs.readFileSync(path.join(ROOT, name, 'mnemonic'), 'utf8').trim(), { network: 'signet', dataDir: path.join(ROOT, name, 'data'), ldkPeerListeningPort: port })
  const a = await m.getAccount(0)
  await a.unlock({ ...UNLOCK, announce_alias: `prova-${name}` })
  open.push(a)
  for (const p of await a.listPayments()) {
    console.log(name, p.payment_type, p.status, p.payment_hash.slice(0, 12), 'asset', p.asset_amount, 'msat', p.amt_msat, 'preimage', p.preimage ? p.preimage.slice(0, 12) + '…' : null, new Date(p.updated_at * 1000).toISOString().slice(0, 19))
  }
}
for (const a of open) { try { await a.shutdown() } catch {} }
process.exit(0)
