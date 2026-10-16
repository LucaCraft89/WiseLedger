// Prova RGB su Lightning (Mutinynet) con @utexo/wdk-rgb-lightning: due nodi nostri, A (paga) e B (riceve).
//   node ln.mjs info | utxos | rgb-invoice | refresh | channel | pay
// Stato in ~/prova/ln/state.json, mnemonic in ~/prova/ln/<nodo>/mnemonic (0600). Solo rete di test.
import WalletManagerRgbLightning from '@utexo/wdk-rgb-lightning'
import bip39 from 'bip39'
import fs from 'node:fs'
import path from 'node:path'

const ROOT = path.join(process.env.HOME, 'prova/ln')
const STATE = path.join(ROOT, 'state.json')
const state = fs.existsSync(STATE) ? JSON.parse(fs.readFileSync(STATE, 'utf8')) : {}
const save = () => fs.writeFileSync(STATE, JSON.stringify(state, null, 2))
const chans = (r) => (Array.isArray(r) ? r : r?.channels ?? [])
const j = (x) => JSON.stringify(x, (_, v) => (typeof v === 'bigint' ? v.toString() : v))
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a)

// Infrastruttura pubblica di Mutinynet: questo RLN accetta un indexer esplora AL POSTO di bitcoind RPC (non entrambi)
const UNLOCK = {
  indexer_url: 'https://esplora.signet.kaleidoswap.com',
  proxy_endpoint: 'rpcs://proxy.kaleidoswap.com/json-rpc',
  announce_addresses: []
}
const TUSDT = 'rgb:hIGgfm4S-KludZNU-CwHWEK3-tCrGuQ6-xfLoyNe-PLlzq9A'

async function openNode (name, port) {
  const dir = path.join(ROOT, name)
  fs.mkdirSync(path.join(dir, 'data'), { recursive: true, mode: 0o700 })
  const mfile = path.join(dir, 'mnemonic')
  if (!fs.existsSync(mfile)) fs.writeFileSync(mfile, bip39.generateMnemonic(), { mode: 0o600 })
  const manager = new WalletManagerRgbLightning(fs.readFileSync(mfile, 'utf8').trim(), {
    network: process.env.LN_NETWORK ?? 'signet',
    dataDir: path.join(dir, 'data'),
    ldkPeerListeningPort: port
  })
  const account = await manager.getAccount(0)
  const t = Date.now()
  await account.unlock({ ...UNLOCK, announce_alias: `prova-${name}` })
  const info = await account.getNodeInfo()
  log(`${name}: sbloccato in ${((Date.now() - t) / 1000).toFixed(1)} s · pubkey ${info.pubkey}`)
  return { name, port, manager, account, pubkey: info.pubkey }
}

async function show (n) {
  const a = n.account
  const bal = await a.getBalanceDetails?.().catch((e) => e.message)
  log(`${n.name}: indirizzo ${await a.getAddress()} · BTC ${j(bal)}`)
  try { log(`${n.name}: asset ${j((await a.listAssets())?.nia ?? (await a.listAssets()))}`) } catch (e) { log(`${n.name}: listAssets ${e.message}`) }
  try { log(`${n.name}: canali ${j(chans(await a.listChannels()).map((c) => ({ id: c.channel_id, status: c.status, ready: c.ready, usable: c.is_usable, funding: c.funding_txid, local_sat: c.local_balance_sat, asset_local: c.asset_local_amount, asset_remote: c.asset_remote_amount })))}`) } catch (e) { log(`${n.name}: listChannels ${e.message}`) }
}

const step = process.argv[2] ?? 'info'
const A = await openNode('A', 9735)
const B = await openNode('B', 9736)
state.pubA = A.pubkey; state.pubB = B.pubkey; save()

try {
  if (step === 'info') { await show(A); await show(B) }

  if (step === 'rgb-invoice') {
    // A riceve TUSDT on-chain dal wallet WDK "payer" (asset già esistente)
    const r = await A.account.createRgbInvoice({ asset_id: null, assignment: { type: 'Fungible', value: 100_000_000 }, min_confirmations: 1, witness: false, transport_endpoints: [UNLOCK.proxy_endpoint], expiration_timestamp: Math.floor(Date.now() / 1000) + 86400 })
    state.rgbInvoice = r.invoice ?? r; save()
    log('invoice RGB on-chain di A (100 TUSDT):', j(r))
  }

  if (step === 'refresh') {
    for (const n of [A, B]) { try { log(`${n.name} refresh:`, j(await n.account.refreshTransfers({ filter: [], skip_sync: false }))) } catch (e) { log(`${n.name} refresh: ${e.message}`) } }
    await show(A); await show(B)
  }

  if (step === 'utxos') {
    log('A createUtxos:', j(await A.account.createUtxos({ up_to: true, num: 4, size: 32000, fee_rate: 1, skip_sync: false })))
  }

  if (step === 'channel') {
    if (chans(await A.account.listChannels()).length) { log('canale già esistente'); await show(A); throw new Error('usa refresh/info') }
    await A.account.connectPeer(`${B.pubkey}@127.0.0.1:${B.port}`)
    log('A connesso a B')
    const r = await A.account.openChannel({
      peer_pubkey_and_opt_addr: `${B.pubkey}@127.0.0.1:${B.port}`,
      capacity_sat: Number(process.env.LN_CAP ?? 100_000), push_msat: 0, public: false, with_anchors: true,
      asset_id: TUSDT, asset_amount: 50_000_000, fee_base_msat: 1000, fee_proportional_millionths: 0
    })
    log('apertura canale:', j(r))
    for (let i = 0; i < 40; i++) {
      await sleep(15000)
      const ch = chans(await A.account.listChannels())
      const c = ch.find((x) => x.peer_pubkey === B.pubkey)
      log(`canale: ${c ? j({ status: c.status, ready: c.ready, usable: c.is_usable, asset: c.asset_local_amount }) : 'non ancora visibile'}`)
      if (c?.is_usable) { state.channelId = c.channel_id; save(); break }
    }
  }

  if (step === 'pay') {
    const inv = await B.account.createInvoice({ amt_msat: 3_000_000, expiry_sec: 3600, asset_id: TUSDT, asset_amount: 5_000_000 })
    log('invoice Lightning di B (5 TUSDT):', inv.invoice)
    const p = await A.account.sendPayment({ invoice: inv.invoice })
    log('pagamento:', j(p))
    for (let i = 0; i < 20; i++) {
      await sleep(3000)
      const s = await B.account.getInvoiceStatus(inv.invoice)
      log('stato invoice su B:', j(s))
      if (j(s).includes('Succeeded')) break
    }
    await show(A); await show(B)
  }
} catch (e) {
  log('ERRORE:', e.message, e.code ?? '')
} finally {
  for (const n of [A, B]) { try { await n.account.shutdown() } catch {} }
  process.exit(0)
}
