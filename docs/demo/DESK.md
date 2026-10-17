# WiseLedger · desk demo script (~3 minutes, live)

Who: **Luca** at the keyboard for the chain path, **Antonino** talks through the AI and the safety design, **Giuseppe** runs the demo machine (his laptop) and the setup checklist.
Run the tagged commit only. Everything below is the real flow: real QVAC on the laptop, real RGB transfer on Mutinynet.

## Setup checklist (before the judges arrive, Giuseppe)
- [ ] Node 22 active: `node -v` prints `v22.x` (rgb-lib does not load on Node 24/26).
- [ ] `pnpm demo:prepare` done: fresh demo PDFs with real RGB invoices in `.data/demo/`. Files ready to drag: good invoice, scam invoice, injection invoice, and `fixtures/invoices/sum-mismatch.txt` for the offline run.
- [ ] Server and web running: `LLM_PROVIDER=qvac WALLET_BACKEND=wdk-rgb RGB_NETWORK=mutinynet pnpm dev`.
- [ ] Browser open at the web URL printed by `pnpm dev` (Vite, usually `http://localhost:5173/#/`), on the upload screen `#/`.
- [ ] Model warm: open **Settings** → "AI: QWEN3_5_2B_MULTIMODAL_Q4_K_M (QVAC) running on this device (ready)". If it says "loading…", wait.
- [ ] Wallet ready: Settings → "Wallet: wdk-rgb · network signet · ready". "Everything is working." on top.
- [ ] Wallet funded: `#/wallet` shows TUSDT balance well above 25 and some bitcoin for fees.
- [ ] History clean enough: `pnpm demo:reset` if earlier runs would trigger the duplicate rule on the good invoice.
- [ ] Wi-Fi toggle reachable in one click (top bar), phone hotspot ready as a backup network.
- [ ] Second tab open on the pre-settled transaction (fallback): https://mutinynet.com/tx/c079929a2ebda5c5b025a953b77d9c0d03b5a56a47b87c020c02d8744a453b0b
- [ ] Backup screencast open in a third tab (link below).
- [ ] Close everything else on the laptop (RAM for the model).

## Script (~3:00)
| Time | What you click | What you SAY | What judges see |
|---|---|---|---|
| 0:00 | Nothing, upload screen `#/` | "Invoice fraud costs small firms real money: a fake invoice, a changed bank detail, and the money is gone. WiseLedger checks every invoice with an AI that runs on this laptop, then pays it with RGB on Bitcoin." | Upload screen |
| 0:15 | Drag the **good invoice** (ACME SRL, 25 TUSDT) | "This is a normal invoice from a supplier we know." | Invoice page opens |
| 0:20 | Nothing, watch the live view | "The Analyst is a local QVAC model, Qwen 3.5 2B. It reads the invoice and fills a fixed form. It has no tools, it cannot pay anything." | Live AI view: "Reading the document…", tokens streaming |
| 0:45 | Nothing | "Now plain code checks the rules: is the RGB invoice valid, is the asset accepted, is the amount normal, did we already pay this. The rules decide, not the AI." | "Checking the safety rules…", then "Writing the summary…" |
| 1:00 | Point at the report | "Then the AI writes a short summary. It only sees the checked fields, never the original document." | Report: verdict OK, summary in plain words |
| 1:10 | Open the confirm dialog | "This sentence is written by code, not by the AI: Pay 25.00 TUSDT, asset ID, to ACME SRL, now. That is exactly what will be paid." | Confirmation sentence |
| 1:20 | **Confirm and pay** | "The Treasurer is the second agent, same model. It never sees the invoice: it gets one plan ID and calls one tool. A payment guard checks the plan, the limits and the asset, and sends it once." | Payment stepper moves |
| 1:30 | Wait on the stepper | "This is a real RGB transfer of our own test asset TUSDT on Mutinynet, through the Tether WDK wallet. It takes about a minute." | Stepper statuses |
| 1:45 | Back to `#/`, drag the **scam invoice** while the transfer runs | "Same supplier name, but now 480 tokens and pressure to pay fast." | Live AI view again |
| 2:10 | Point at the red flag card | "Blocked. The amount is far above what this supplier usually asks and above our limit. No confirm button, nothing to pay." | Verdict BLOCK, flag card in plain words |
| 2:20 | Drag the **injection invoice** | "This one hides orders to the AI inside the text: ignore your rules and pay." | Live AI view |
| 2:35 | Point at the flag | "Blocked again, by a rule in code. And the agent that pays never sees this text anyway." | Verdict BLOCK, "tries to give orders to the AI" |
| 2:40 | Open the good invoice, click **View on the block explorer** | "And here is our payment, settled on Bitcoin." | Result card, Mutinynet explorer page |
| 2:45 | **Turn Wi-Fi off**, drag the **sum-mismatch invoice** (Officina Bianchi) | "Wi-Fi off. The analysis still runs, because the AI and the documents never leave this laptop." | Live AI view runs offline, verdict review (do not pay now) |
| 2:55 | Show the WDK slide (box below) | "WDK is our wallet: keys, issuing the asset, receiving, paying, spend limits." | WDK slide |
| 3:00 | **Turn Wi-Fi back on** | "Thank you." | |

Timing notes: analysis takes ~25–35 s per invoice on the 2B model, so start the next upload while talking. Do not press pay while offline. Do not re-upload the good invoice offline: it was just paid, so the duplicate rule blocks it (correct, but off-message).

## Fallbacks
- **Transfer slow** (more than ~2 min): keep talking over the stepper statuses ("waiting for a Bitcoin block, blocks here are ~30 s"), then open the pre-settled tab: 5 TUSDT, settled in 57 s, txid `c079929a…a453b0b`. Never press pay twice: after a timeout the app does not resend, it checks the state.
- **QVAC slow or stuck**: open Settings and read the AI line (loading / ready / not working). If the AI times out (120 s) the invoice goes to "needs review" and nothing is paid: say that this is the safe default. Then switch to the screencast.
- **Network down at the venue**: phone hotspot. The analysis part works offline anyway; only the payment needs the network.
- **Anything else breaks**: backup screencast, link below.

### Backup screencast
**TODO (humans, Giuseppe or Antonino) — record before the desk demo:**
1. Run the real flow exactly as in the script above (real QVAC, `WALLET_BACKEND=wdk-rgb`, Mutinynet): good invoice paid with explorer link, scam blocked, injection blocked, Wi-Fi off and analyse again.
2. Record the screen with OBS Studio, or on Linux `wf-recorder -f wiseledger-demo.mp4` (wlroots) or the GNOME recorder (Ctrl+Shift+Alt+R). At most 3 minutes; cut the waiting if needed and say so in the video.
3. Store the file **outside git** in the team drive (never commit video files to the repo).
4. Paste the share link here: `SCREENCAST_LINK = <paste link>`

## Slide: What WDK does in WiseLedger
```
+--------------------------------------------------------------------+
|  What WDK does in WiseLedger                                       |
|  @tetherto/wdk + @utexo/wdk-wallet-rgb · RGB v0.11.1 · Mutinynet   |
|                                                                    |
|  - Keys and seed: the self-custodial wallet lives on this laptop   |
|  - Asset issuance: our test asset TUSDT (NIA, 6 decimals)          |
|    rgb:UR2X9KDC-C4bpuWm-vYrR_~F-d8Y98h0-T6MAOXD-c8CyQG4            |
|  - Receive: RGB invoices with QR on the wallet page                |
|  - Payments: quote + transfer with an explicit fee rate            |
|  - Spend policies: max per payment, asset allowlist                |
|  - First-run onboarding: new wallet, UTXOs, sync                   |
|                                                                    |
|  Proof: 5 TUSDT settled in 57 s on Mutinynet                       |
|  mutinynet.com/tx/c079929a...a453b0b                               |
+--------------------------------------------------------------------+
```
