# Runbook · chain (Mutinynet, regtest fallback)

Node 22.x only (`nvm use`): the rgb-lib binding does not build on Node 24+. Test networks only; TUSDT is our test asset, no value.

## From zero to a settled payment (~15 min)
1. `pnpm install` (approves the rgb-lib build) · `cp .env.example .env`
2. In `.env`: `WALLET_BACKEND=wdk-rgb`, `RGB_NETWORK=mutinynet`, `LLM_PROVIDER=qvac` (or `mock`). Leave the endpoints as they are.
3. `pnpm wallet:smoke` → creates the payer (`.data/wallet`) and payee (`.data/payee`) wallets and prints a funding address for each.
4. Fund on https://faucet.mutinynet.com (GitHub login): payer ≥ 100,000 sats, payee ≥ 30,000. Wait ~30 s (1 block), rerun `pnpm wallet:smoke` until sats show.
5. `pnpm -F wallet issue-asset` → issues TUSDT (1000, precision 6), prints the asset ID, writes `.data/tusdt.json`. Put it in `.env` as `ASSET_ALLOWLIST=<asset id>`.
6. Chain check: `pnpm wallet:smoke -- --pay 5000000` → `SETTLED in …s · txid … → https://mutinynet.com/tx/…` (1–2 min).
7. `pnpm demo:prepare` → fresh 24 h RGB invoices and `.data/demo/1-good … 4-injection` (.pdf + .txt); fails with exactly what to fund if not ready.
8. Two terminals: `pnpm -F wallet payee watch` (the supplier side: accepts consignments) and `pnpm dev` → http://localhost:5173.
9. Upload `1-good-acme.pdf` → confirm the sentence → PAID with the explorer link. Then 2, 3, 4: all blocked.

## Moving the funded wallets to the demo machine
Copy `.data/wallet/`, `.data/payee/` and `.data/tusdt.json` (USB, never git, never chat; keep mode 600). Run each wallet on **one machine only**: stop it on the old one first.

## When something is off
- Payment stuck in `WaitingCounterparty`: the payee is not refreshing → start `pnpm -F wallet payee watch`.
- Stuck in `WaitingConfirmations` for > 3 min: Mutinynet block delay; check https://mutinynet.com. Never resend: the guard refuses a second execution and a send timeout is never retried.
- `NoUtxo` / "needs more bitcoin": fund the payer address from `pnpm wallet:smoke`; UTXOs are created automatically.
- `PolicyDenied`: amount above `PAYMENT_CAP` (base units) or asset not in `ASSET_ALLOWLIST`, enforced by the WDK policy engine.
- Spendable 0 right after a payment: change is locked until the transfer settles; wait, or `pnpm wallet:smoke` to refresh.
- KaleidoSwap indexer down: `RGB_INDEXER_URL=https://mutinynet.com/api`.

## Offline fallback (regtest, no faucet)
`pnpm regtest start` · `RGB_NETWORK=regtest pnpm wallet:smoke -- --fund-regtest` · `RGB_NETWORK=regtest pnpm -F wallet issue-asset` · `RGB_NETWORK=regtest pnpm wallet:smoke -- --pay 5000000`. Wallets live in `.data/regtest/`; blocks are mined by the scripts.

## Reset
Stop the server; `rm -rf .data/app.db* .data/uploads .data/demo` keeps the wallets. Deleting `.data/wallet` loses its test funds (seed is in `.data/wallet/mnemonic`).
