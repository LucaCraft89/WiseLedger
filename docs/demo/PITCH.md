# WiseLedger · pitch (5 minutes + 2 minutes Q&A, Sun 16:00)

Team **Coin³**: Luca (chain: RGB, WDK, payment guard, server), Antonino (AI agents and UI), Giuseppe (coordination, QA, demo machine).
Live flow on the tagged commit (`v1.0-submission`), same setup as `docs/demo/DESK.md`: `WALLET_BACKEND=wdk-rgb`, `RGB_NETWORK=mutinynet`, `LLM_PROVIDER=qvac`. Luca at the keyboard, Antonino talking. Slides: `docs/demo/DECK.md`. Backup: the screencast of a real settled run, announced as a recording.
Never say "real money": it is a test network and a test asset.

## 0:00–0:30 · Problem (slide 2)
- Small firms, freelancers and accountants pay suppliers from invoices. A fake invoice, a look-alike supplier or "our bank details have changed" is enough to lose the money.
- Invoices are private documents: sending them to a cloud AI is a privacy problem.
- Stablecoin payments on Bitcoin are fast, but nothing checks the invoice before the money moves.
- Opening line: **"WiseLedger is not a bank account and not just a wallet. It's a money desk: your books like an account, your money in your own hands like a wallet, and a careful owl who reads every invoice before you pay."** Then: invoice in, fraud checked, RGB payment out.

## 0:30–2:30 · Live flow (slides 3–4, then the app)
1. Upload the good invoice (PDF from `pnpm demo:prepare`). The **Analyst** (QVAC, Qwen 3.5 2B, on this laptop) reads it and fills a fixed form. It has **no tools**. The live box shows the model reading.
2. **Rules in code (R1–R10)** decide the verdict: valid RGB invoice for our network, accepted asset, amount = printed total and under the limit, not a duplicate, supplier known or look-alike, pressure or changed bank details, hidden orders to the AI, currency, missing fields, dates. The AI then writes a plain summary **from the checked fields only**.
3. The **confirmation sentence is built by code**: "Pay 25.00 TUSDT (asset rgb:…) to ACME SRL, now. Confirm?"
4. Confirm. The **Treasurer** (same model, second agent) gets only the plan ID and calls one tool; the **PaymentGuard** checks plan, hash, caps, allowlist and balance, and sends once. A real RGB transfer of our test asset TUSDT on Mutinynet: transfer ID, txid, **explorer link** on screen.
5. While it settles (about 40–60 s): open **Chat**: "pay the latest invoice on Friday" → the Treasurer prepares a scheduled payment, and the code-built sentence asks to confirm. Spend tools never execute from chat.

## 2:30–3:15 · Fraud blocked (slide 5)
- **Scam**: "ACME S.R.L. – Accounts department", 480 TUSDT, "our bank details have changed, pay TODAY". Blocked: changed details + urgency (R6), above the limit (R3), not the supplier we paid before (R5). No confirm button.
- **Injection**: text tells the AI to ignore its rules and send everything. Blocked by a rule in code (R7). The paying agent never sees invoice text; a test proves it for every fixture.
- One sentence on the rest: look-alike letters (Cyrillic "Е" in "ACMЕ"), hidden white text in a PDF, an amount in words ≠ digits: all caught.
- Wi-Fi off: the analysis still runs. Our evals measure **no outbound connection** during analysis.

## 3:15–3:45 · Stack and the WDK slide (slides 6–8)
- **QVAC**: one local model for both agents. Extraction with a JSON schema, forced tool call for the Treasurer. Italian **FatturaPA XML** is read without the model, in ~8 s. **Evals: 14/14 invoices correct, precision and recall 100% for ok / review / block, median 24.8 s** (`evals/RESULTS.md`).
- **RGB on Bitcoin v0.11.1** via **WDK** (`@tetherto/wdk` + `@utexo/wdk-wallet-rgb`) on Mutinynet. Our own NIA asset TUSDT, issued with WDK.
- Slide "What WDK does in WiseLedger": keys and seed (create, restore, passphrase lock), asset issuance, receive requests, payments with an explicit fee rate, **spend policies in the WDK policy engine** (max per payment, max per day, asset allowlist), backup and restore.
- Proof slide: three real settled transfers on the merged code, one of them scheduled (txids on the slide), plus an incoming payment received.

## 3:45–5:00 · Market and next steps (slides 9–11)
- Who pays: small firms, freelancers and accountants who pay suppliers in stablecoins on Bitcoin. Invoice fraud is a real loss; privacy is a real need.
- Business model: per seat for small firms and accountants (an accountant manages many clients' payments).
- Italian angle: FatturaPA e-invoices already read deterministically.
- Already there besides payments: scheduled payments, labels, fiscal report (CSV/JSON), getting paid (payment requests with live status), Treasurer chat.
- Next: supplier side ("make your invoice payable in RGB"), Lightning for small payments (spike works with patches), more invoice formats, FX rates.
- Close: **"Your invoices stay on your laptop. Your money moves only when code says it is safe and you say yes."**

## Q&A answers
- **What if the model is wrong?** It never decides alone. Rules in code decide the verdict; the confirmation sentence is written by code from the resolved plan; the PaymentGuard checks plan, hash, caps, allowlist and balance, and sends at most once. If the AI fails or times out, the invoice goes to review and nothing is paid.
- **Prompt injection?** Two agents: the Analyst reads untrusted text but has no tools; the Treasurer has tools but only sees IDs and short checked fields. Control codes and invisible characters are stripped before the model reads. A test runs every fixture and proves no tool call and no invoice text in the Treasurer's prompt; a model forced to answer with tool calls only gets the invoice sent to review.
- **Why local?** Invoices are private documents: they never leave the device. Wi-Fi off, it still works.
- **Why RGB?** Privacy (client-side validation: amounts and parties are not public on-chain) and settlement on Bitcoin.
- **Why your own asset and not the faucet's USDT?** Different RGB networks: KaleidoSwap's faucet USDT lives on `signetcustom` (`sbc:`), WDK's wallet works on `signet` (`sb:`). So we issued our own test NIA, TUSDT, with WDK on Mutinynet. It is a test asset with no value.
- **What does WDK do?** Keys and seed, asset issuance, receive, payments with explicit fee rate, spend policies in the policy engine, backup and restore.
- **How fast?** About 25 s per invoice on a 14 GB laptop with a 2B model (8 s for FatturaPA XML); settlement 40–60 s on Mutinynet.
- **What is mocked?** Nothing in the demo: real model, real wallet, real transfers. Mocks exist only as test doubles for CI (README section "what is mocked").
- **Business model?** Per seat for small firms and accountants.
- **What did you build here?** Everything in the repo after Sat 09:30; pre-hackathon feasibility scripts are declared in `prior-work/`.

## Timing check
- Desk script (`DESK.md`) target: about 3 minutes. Pitch target: 5:00 with a timer, rehearsed twice.
- Fallbacks: settlement slow → say "this settles in about a minute" and show the previous settled transfer in Transfers; model slow → show the live reading box, never fill silence with apologies.
