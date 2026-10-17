# WiseLedger · pitch skeleton (5 minutes, Sun 16:00)

Team **Coin³**: Luca (chain: RGB, WDK, payment guard, server), Antonino (AI agents and UI), Giuseppe (coordination, QA, demo machine).
Live flow runs on the tagged commit (`v1.0-submission`), same setup as `docs/demo/DESK.md`. Backup: screencast link in DESK.md.

## 0:00–0:30 · Problem
- Small firms, freelancers and accountants pay suppliers from invoices. A fake invoice or a changed bank detail is enough to lose the money.
- Invoices are private documents: sending them to a cloud AI is a privacy problem.
- Stablecoin payments on Bitcoin are fast, but nothing checks the invoice before the money moves.
- One line: "WiseLedger is a local AI payment firewall: invoice in, fraud checked, RGB payment out."

## 0:30–2:30 · Live flow (upload, Analyst, sentence, settle)
- Upload the good invoice. The **Analyst** (QVAC, Qwen 3.5 2B, on this laptop) reads it and fills a fixed form; it has no tools.
- **Rules in code** decide the verdict (valid RGB invoice, accepted asset, normal amount, not a duplicate, no hidden orders to the AI). The AI writes a plain summary from the checked fields only.
- The **confirmation sentence is built by code**: "Pay 25.00 TUSDT (asset rgb:…) to ACME SRL, now. Confirm?"
- The **Treasurer** (same model, second agent) gets only a plan ID and calls one tool; the **PaymentGuard** checks the plan and sends once. Real RGB transfer of our test asset TUSDT on Mutinynet, link to the explorer.

## 2:30–3:15 · Scam blocked
- Scam invoice: same supplier name, 480 TUSDT, pressure to pay. Blocked: far above the limit, no confirm button.
- Injection invoice: hidden text tells the AI to ignore its rules. Blocked by a rule in code, and the paying agent never sees invoice text.
- Wi-Fi off: the analysis still runs. Measured: no outbound connection during analysis (`ss` check in our evals).

## 3:15–3:45 · Stack and the WDK slide
- **QVAC**: one local model for both agents; extraction with JSON schema, forced tool call for the Treasurer. Evals: 6/6 verdicts, median ~29 s per invoice on a 14 GB laptop.
- **RGB on Bitcoin v0.11.1** via **WDK** (`@tetherto/wdk` + `@utexo/wdk-wallet-rgb`), Mutinynet. Our own NIA asset TUSDT, issued with WDK.
- Slide "What WDK does in WiseLedger" (content in DESK.md): keys and seed, asset issuance, receive invoices, payments with explicit fee rate, spend policies (max per payment, asset allowlist), first-run onboarding.
- Proof: 5 TUSDT settled in 57 s, txid `c079929a…a453b0b` on mutinynet.com.

## 3:45–5:00 · Market and next steps
- Who pays: small firms, freelancers and accountants who pay suppliers in stablecoins on Bitcoin. Invoice fraud is a real loss; privacy is a real need.
- Business model: per seat for small firms and accountants (an accountant manages many clients' payments).
- Italian angle: FatturaPA e-invoices as an input source (planned).
- Next: more rules and fixtures, scheduled payments and labels, fiscal report, supplier side "make your invoice payable in RGB", Lightning for small payments.
- Close: "Your invoices stay on your laptop. Your money moves only when code says it is safe and you say yes."

## Q&A answers
- **What if the model is wrong?** The model never decides alone. Rules in code decide the verdict; the confirmation sentence is written by code from the resolved plan; the PaymentGuard checks plan, hash, caps, asset allowlist and balance, and sends at most once. If the AI fails or times out, the invoice goes to review and nothing is paid.
- **Why local?** Invoices are private documents: they never leave the device. Wi-Fi off, it still works; our evals check that analysis opens no outbound connection.
- **Why RGB?** Privacy (client-side validation, amounts and parties are not public on-chain) and settlement on Bitcoin.
- **Why your own asset and not the faucet's USDT?** Different RGB networks: KaleidoSwap's faucet USDT lives on `signetcustom` (`sbc:`), WDK's wallet works on `signet` (`sb:`). So we issued our own test NIA, TUSDT, with WDK on Mutinynet. It is a test asset with no value.
- **What does WDK do?** Keys and seed, asset issuance, receive invoices, payments with explicit fee rate, spend policies, first-run onboarding.
- **Business model?** Per seat for small firms and accountants.
- **What is mocked?** Answer from the README "what is mocked, simulated or hard-coded" section (fill in at M5).
- **Prompt injection?** Two agents: the Analyst reads untrusted text but has no tools; the Treasurer has tools but only sees IDs. The summary call sees only checked fields.

## TODO before 16:00
- [ ] Slides: problem, architecture (Analyst → rules → sentence → Treasurer → guard → WDK/RGB), WDK slide, market.
- [ ] Rehearse to 5:00 with a timer; Luca at the keyboard, Antonino talking.
- [ ] Update numbers if `pnpm evals` changes (evals/RESULTS.md) and rule list after M3 (R5, R6, R8–R10).
