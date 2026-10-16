// Test WDK + RGB senza fondi: crea un wallet TEMPORANEO (seed nuovo, cartella in /tmp) su Mutinynet,
// lo registra presso l'indexer, mostra indirizzo e saldi, poi cancella tutto.
// Non tocca i wallet in ~/prova/wallets-mutinynet.
import WalletManagerRgb from '@utexo/wdk-wallet-rgb'
import bip39 from 'bip39'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'test-wdk-'))
try {
  const manager = new WalletManagerRgb(bip39.generateMnemonic(), {
    network: 'signet',
    indexerUrl: 'https://esplora.signet.kaleidoswap.com',
    transportEndpoint: 'rpcs://proxy.kaleidoswap.com/json-rpc',
    dataDir: dir
  })
  const account = await manager.getAccount()
  const reg = await account.registerWallet()
  const j = (x) => JSON.stringify(x, (_, v) => (typeof v === 'bigint' ? v.toString() : v))
  console.log(`indirizzo: ${reg.address}`)
  console.log(`saldo BTC: ${j(reg.btcBalance)}`)
  console.log(`asset: ${j(account.listAssets())}`)
  console.log('WDK/RGB OK')
} catch (e) {
  console.log('WDK/RGB ERRORE:', e.message)
  process.exitCode = 1
} finally {
  // dispose() di wdk-wallet-rgb 2.0.3 lancia "Invalid checksum": non lo chiamiamo
  fs.rmSync(dir, { recursive: true, force: true })
  process.exit()
}
