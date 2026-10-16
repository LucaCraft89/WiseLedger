// Test del nodo Lightning RGB senza fondi: crea un nodo TEMPORANEO (seed nuovo, cartella in /tmp),
// lo sblocca su Mutinynet, legge pubkey e indirizzo, poi lo spegne e cancella tutto.
// Non tocca i nodi A/B in ~/prova/ln, quindi è sicuro su qualsiasi PC.
import WalletManagerRgbLightning from '@utexo/wdk-rgb-lightning'
import bip39 from 'bip39'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'test-ln-'))
let account
try {
  const manager = new WalletManagerRgbLightning(bip39.generateMnemonic(), {
    network: 'signet', dataDir: dir, ldkPeerListeningPort: 9745
  })
  account = await manager.getAccount(0)
  const t = Date.now()
  await account.unlock({
    indexer_url: 'https://esplora.signet.kaleidoswap.com',
    proxy_endpoint: 'rpcs://proxy.kaleidoswap.com/json-rpc',
    announce_addresses: [], announce_alias: 'test-rete'
  })
  const info = await account.getNodeInfo()
  console.log(`nodo sbloccato in ${((Date.now() - t) / 1000).toFixed(1)} s · pubkey ${info.pubkey}`)
  console.log(`indirizzo on-chain del nodo: ${await account.getAddress()}`)
  console.log('LIGHTNING OK')
} catch (e) {
  console.log('LIGHTNING ERRORE:', e.message)
  process.exitCode = 1
} finally {
  try { await account?.shutdown() } catch {}
  fs.rmSync(dir, { recursive: true, force: true })
  process.exit()
}
