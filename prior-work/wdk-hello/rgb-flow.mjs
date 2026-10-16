// Prova del flusso RGB completo con WDK, a passi idempotenti:
//   NET=mutinynet|utexo node rgb-flow.mjs status | address | fund-payee | utxos | issue | invoice | pay | send <invoice> <token> | watch
// Default: Mutinynet (signet + endpoint KaleidoSwap). Stato in ~/prova/wallets-<NET>/state.json. Solo reti di test.
import WalletManagerRgb from '@utexo/wdk-wallet-rgb'
import fs from 'node:fs'
import path from 'node:path'
import bip39 from 'bip39'

const NET = process.env.NET ?? 'mutinynet'
const PROFILES = {
  mutinynet: { network: 'signet', indexerUrl: 'https://esplora.signet.kaleidoswap.com', transportEndpoint: 'rpcs://proxy.kaleidoswap.com/json-rpc' },
  utexo: { network: 'signet', indexerUrl: 'https://esplora-api.utexo.com', transportEndpoint: 'rpcs://rgb-proxy-utexo.utexo.com/json-rpc' }
}
const CFG = PROFILES[NET]
const ROOT = path.join(process.env.HOME, NET === 'utexo' ? 'prova/wallets' : `prova/wallets-${NET}`)
const STATE = path.join(ROOT, 'state.json')
const state = fs.existsSync(STATE) ? JSON.parse(fs.readFileSync(STATE, 'utf8')) : {}
const save = () => fs.writeFileSync(STATE, JSON.stringify(state, null, 2))
const j = (x) => JSON.stringify(x, (_, v) => (typeof v === 'bigint' ? v.toString() : v))

async function open (name) {
  const dir = path.join(ROOT, name)
  fs.mkdirSync(path.join(dir, 'data'), { recursive: true, mode: 0o700 })
  const mfile = path.join(dir, 'mnemonic')
  if (!fs.existsSync(mfile)) fs.writeFileSync(mfile, bip39.generateMnemonic(), { mode: 0o600 })
  const m = new WalletManagerRgb(fs.readFileSync(path.join(dir, 'mnemonic'), 'utf8').trim(), { ...CFG, dataDir: path.join(dir, 'data') })
  const a = await m.getAccount()
  await a.registerWallet() // porta il wallet online
  return a
}
const payer = await open('payer')
const payee = await open('payee')

const EXPLORER = NET === 'mutinynet' ? 'https://mutinynet.com' : null
const sats = (n) => `${Number(n).toLocaleString('it-IT')} sats`
const tok = (n, p = 6) => `${(Number(n) / 10 ** p).toLocaleString('it-IT', { maximumFractionDigits: p })}`

async function status () {
  console.log(`Rete: ${NET} · indexer ${CFG.indexerUrl}
`)
  for (const [n, a] of [['PAGATORE (payer)', payer], ['BENEFICIARIO (payee)', payee]]) {
    try { a.refreshWallet() } catch (e) { console.log(`  refresh: ${e.message}`) }
    const reg = await a.registerWallet()
    const b = reg.btcBalance
    console.log(`== ${n}`)
    console.log(`  BTC disponibili:      ${sats(b.vanilla.spendable)}   (in arrivo: ${sats(b.vanilla.future)})`)
    console.log(`  BTC nelle UTXO RGB:   ${sats(b.colored.spendable)}`)
    try { console.log(`  UTXO totali:          ${a._wallet.listUnspents().length}`) } catch {}
    console.log(`  Indirizzo di ricezione nuovo: ${reg.address}`)
    const nia = a.listAssets().nia ?? []
    if (!nia.length) console.log('  Asset RGB: nessuno')
    for (const x of nia) {
      const bal = a._wallet.getAssetBalance(x.assetId)
      console.log(`  Asset ${x.ticker} (${x.name})
    id ${x.assetId}
    saldo ${tok(bal.settled, x.precision)} · spendibile ${tok(bal.spendable, x.precision)} · in arrivo ${tok(bal.future, x.precision)}`)
      for (const t of a.listTransfers(x.assetId)) {
        const amt = t.requestedAssignment?.Fungible ?? ''
        const link = t.txid && EXPLORER ? `  ${EXPLORER}/tx/${t.txid}` : ''
        console.log(`    · #${t.idx} ${t.kind} ${t.status}${amt !== '' ? ' ' + tok(amt, x.precision) + ' ' + x.ticker : ''}${link}`)
      }
    }
    console.log()
  }
}

const step = process.argv[2] ?? 'status'
if (step === 'status') await status()

if (step === 'address') {
  console.log(`[${NET}] indirizzo del pagatore da finanziare: ${(await payer.registerWallet()).address}`)
}

if (step === 'fund-payee') {
  // BTC del pagatore al beneficiario (servono UTXO anche a lui per la ricezione blind)
  const to = (await payee.registerWallet()).address
  // sendTransaction() stima la fee con estimateFeeRate(1) arrotondato: su Mutinynet diventa 0 e rgb-lib lo rifiuta.
  // Flusso a passi con fee esplicita (in 2.0.3 sendBtcBegin/End sono solo su _wallet).
  const psbt = payer._wallet.sendBtcBegin({ address: to, amount: 30_000, feeRate: 1 })
  const txid = payer._wallet.sendBtcEnd({ signedPsbt: await payer.signPsbt(psbt) })
  console.log('inviati 30000 sats al beneficiario, txid:', j(txid))
}

if (step === 'utxos') {
  console.log('payer UTXO create:', await payer.createUtxos({ upTo: true, num: 3, size: 1000, feeRate: 1 }))
  console.log('payee UTXO create:', await payee.createUtxos({ upTo: true, num: 2, size: 1000, feeRate: 1 }))
}

if (step === 'issue') {
  if (!state.assetId) {
    const a = payer.issueAssetNia({ ticker: 'TUSDT', name: 'Test USDT (hackathon, no value)', precision: 6, amounts: [1_000_000_000] })
    state.assetId = a.assetId; save()
    console.log('emesso:', j(a))
  }
  console.log('assetId:', state.assetId, '· saldo payer:', j(payer._wallet.getAssetBalance(state.assetId)))
}

if (step === 'invoice') {
  // senza assetId: il beneficiario non conosce ancora l'asset (rgb-lib darebbe AssetNotFound)
  const r = payee.receiveAsset({ witness: false, amount: 5_000_000 })
  state.invoice = r.invoice; save()
  console.log('invoice del beneficiario (5 TUSDT):', r.invoice)
  try { console.log('decodificata:', j(payer._wallet.decodeRGBInvoice({ invoice: r.invoice }))) } catch (e) { console.log('decode:', e.message) }
}

if (step === 'pay') {
  if (state.txid) { console.log('già pagato, txid', state.txid, '(niente nuovi tentativi: usa watch)'); process.exit(0) }
  const opts = { token: state.assetId, recipient: state.invoice, amount: 5_000_000, feeRate: 1 }
  console.log('quote:', j(await payer.quoteTransfer(opts)))
  const r = await payer.transfer(opts)
  state.txid = r.hash; save()
  console.log('inviato:', j(r))
}

if (step === 'send') {
  // wallet send <invoice RGB> <token>: il pagatore manda TUSDT a un'invoice qualsiasi (es. il nodo Lightning)
  const [invoice, amount] = [process.argv[3], Math.round(Number(process.argv[4]) * 1e6)]
  const opts = { token: state.assetId, recipient: invoice, amount, feeRate: 1 }
  console.log('quote:', j(await payer.quoteTransfer(opts)))
  const r = await payer.transfer(opts)
  ;(state.sends ??= []).push({ invoice, amount, txid: r.hash }); save()
  console.log('inviato:', j(r), EXPLORER ? `${EXPLORER}/tx/${r.hash}` : '')
}

if (step === 'watch') {
  for (const [n, a] of [['payer', payer], ['payee', payee]]) {
    try { a.refreshWallet() } catch (e) { console.log(`${n} refresh: ${e.message}`) }
    const t = a.listTransfers(state.assetId)
    console.log(`${n}:`, j(t.map(x => ({ idx: x.idx, status: x.status, kind: x.kind, txid: x.txid, req: x.requestedAssignment ?? x.amount }))))
    console.log(`   saldo: ${j(a._wallet.getAssetBalance(state.assetId))}`)
  }
}
process.exit(0)
