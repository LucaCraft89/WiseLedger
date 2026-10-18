Documents that are only an RGB payment request (no invoice around it): the Analyst must not invent a supplier, number, dates, total or IBAN.

- `1.txt` / `1.pdf`: 12 TUSDT request, `2.txt` / `2.pdf`: open-amount request (the payer types the amount). Both from the payee test wallet on Mutinynet, valid until 21 Oct 2026 07:08 UTC: `pnpm -F wallet payee invoice 12000000 72`, `pnpm -F wallet payee invoice any 72`.
- PDFs: headless Chromium `page.pdf()` of the string in a one-line `<pre>` (6 px monospace, `white-space: nowrap`) so the text layer keeps it on one line (a wrapped request would be split).
- `expected.json`: what the wallet's decoder reads from each string and the expected verdict and flags.
