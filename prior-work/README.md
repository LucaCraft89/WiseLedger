# Prior work (14-15 October 2026, before kickoff)

Throwaway feasibility experiments by Antonino ([@Antoninova](https://github.com/Antoninova)), committed unchanged from the files as they were on 14-15 October. They are **not product code**; the product is written from scratch during the hackathon.
Seeds and mnemonics are generated at run time into git-ignored folders (`~/prova/...`); none are in this repository. No compiled binaries, no archives.

| Folder / file | What it does | Result |
|---|---|---|
| `qvac-hello/hello.mjs` | loads Qwen3.5-0.8B with `@qvac/sdk`, JSON-schema structured output | model loads in ~59 s, ~42 tok/s on CPU, valid JSON 3/3 |
| `wdk-hello/wallets.mjs`, `rgb-flow.mjs` | `@utexo/wdk-wallet-rgb` on Mutinynet: faucet, UTXOs, issue test NIA `TUSDT`, RGB invoice, transfer, watch | 5 TUSDT transfer reached `Settled` |
| `wdk-hello/test-rete.mjs`, `ln-hello/test-rete.mjs` | network smoke tests with throwaway wallets (15 Oct evening) | pass |
| `ln-hello/ln.mjs`, `ln-node.mjs`, `payments.mjs` | two RGB-Lightning nodes (A pays, B receives) with `@utexo/wdk-rgb-lightning`: open channel, pay, list payments | one 5 TUSDT RGB-over-Lightning payment `Succeeded` |
| `patches/wdk-rgb-lightning-signer.patch` | local patch to `@utexo/wdk-rgb-lightning` 0.1.0-beta.15: persistent signer state (`createWithStorage`) | needed for channel opening |
| `patches/rln-external-signer-cargo-lock.txt` | one-line `Cargo.lock` fix in `@utexo/rgb-lightning-node-nodejs` 0.1.0-beta.16 (a UTEXO package we built from source) | fixes a panic at the first payment |

`setup/wsl-bootstrap.sh` (Antonino) and `setup/fedora-bootstrap.sh` (derived from it): install system tools on a fresh Linux machine. No product code.

Third-party code used: `@qvac/sdk`, `@tetherto/wdk`, `@utexo/wdk-wallet-rgb`, `@utexo/rgb-sdk`, `@utexo/wdk-rgb-lightning`, `@utexo/rgb-lightning-node-nodejs` (patched build, binary not included), `bip39`. Test networks and test funds only; `TUSDT` has no value.
