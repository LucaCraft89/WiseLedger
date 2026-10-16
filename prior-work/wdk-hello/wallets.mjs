// Prova WDK + RGB: crea (o riapre) due wallet di test su signet UTEXO (endpoint espliciti) e mostra indirizzi e saldi.
import WalletManagerRgb from '@utexo/wdk-wallet-rgb'
import bip39 from 'bip39'
import fs from 'node:fs'
import path from 'node:path'

const ROOT = path.join(process.env.HOME, 'prova/wallets')
const NETWORK = process.env.RGB_NETWORK ?? 'signet'
const ENDPOINTS = {
  indexerUrl: process.env.RGB_INDEXER_URL ?? 'https://esplora-api.utexo.com',
  transportEndpoint: process.env.RGB_TRANSPORT_ENDPOINT ?? 'rpcs://rgb-proxy-utexo.utexo.com/json-rpc'
}

async function open(name) {
  const dir = path.join(ROOT, name)
  fs.mkdirSync(path.join(dir, 'data'), { recursive: true, mode: 0o700 })
  const mfile = path.join(dir, 'mnemonic')
  if (!fs.existsSync(mfile)) fs.writeFileSync(mfile, bip39.generateMnemonic(), { mode: 0o600 })
  const manager = new WalletManagerRgb(fs.readFileSync(mfile, 'utf8').trim(), { network: NETWORK, ...ENDPOINTS, dataDir: path.join(dir, 'data') })
  const account = await manager.getAccount()
  return { name, manager, account }
}

for (const name of ['payer', 'payee']) {
  const w = await open(name)
  const reg = await w.account.registerWallet()
  console.log(`${name}: ${reg.address} · BTC ${JSON.stringify(reg.btcBalance)} · asset ${JSON.stringify(await w.account.listAssets())}`)
  // dispose() di wdk-wallet-rgb 2.0.3 lancia "Invalid checksum": evitato, il processo termina comunque
}
process.exit(0)
