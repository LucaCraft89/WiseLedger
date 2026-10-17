# wallet

`WalletPort` on WDK core (`@tetherto/wdk`) + `@utexo/wdk-wallet-rgb` (rgb-lib, RGB v0.11.1). Node 22 only.

| Env | Default | Meaning |
|---|---|---|
| `WALLET_BACKEND` | `mock` | `mock` (in memory) or `wdk-rgb` (real chain) |
| `RGB_NETWORK` | `mutinynet` | `mutinynet` (signet) or `regtest` (`pnpm regtest start`) |
| `WALLET_DATA_DIR` / `PAYEE_DATA_DIR` | `.data/wallet` / `.data/payee` | one wallet per dir; seed in `<dir>/mnemonic` (0600) |
| `RGB_INDEXER_URL` | KaleidoSwap esplora / `tcp://127.0.0.1:50001` | always explicit |
| `RGB_TRANSPORT_ENDPOINT` | KaleidoSwap proxy / `rpc://127.0.0.1:3000/json-rpc` | RGB consignment proxy |
| `RGB_FEE_RATE` | `2` | sat/vB, always passed |
| `PAYMENT_CAP` | `100000000` | max base units per payment (WDK spend policy) |
| `ASSET_ALLOWLIST` | empty = any | comma-separated asset IDs allowed to pay (WDK spend policy) |

Scripts: `pnpm wallet:smoke [-- --pay <base units>] [--fund-regtest]` · `pnpm -F wallet issue-asset` · `pnpm -F wallet payee status|address|invoice <amount>|refresh` · `pnpm -F wallet test:live` (regtest).

Safety: spend limits live in the WDK policy engine (`src/policy.ts`); a send timeout is never retried (sync, then `SubmitTimeout` with the transfer ID); receive auto-creates UTXOs once on `NoUtxo`; background sync every 15 s with backoff (`src/sync.ts`).
