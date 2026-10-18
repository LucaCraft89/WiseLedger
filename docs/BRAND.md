# WiseLedger brand identity

Source: the team's brand sheet (generated 17 Oct, checked and corrected here). **This file is the source of truth**; the sheet had garbled text and wrong contrast numbers. Code: `apps/web/src/brand.css` (tokens and base styles) and `apps/web/src/lib/format.ts` (verdict colours). Logos: `docs/brand/` (originals, untouched) and `apps/web/public/brand/` (web sizes).

## 1. Logos (never redraw or restyle)
| Logo | File | Use |
|---|---|---|
| WiseLedger owl (blue owl, gold coin eye, rust face mask) | `docs/brand/logo-wiseledger-owl.png`, web: `apps/web/public/brand/owl.png`, `owl-192.png`, `favicon.png`, `apple-touch-icon.png` | product icon, app header, avatar, slides |
| Coin³ team coin (gold ₿ coin with superscript 3) | `docs/brand/logo-coin3-team.png`, web: `apps/web/public/brand/coin3.png` | team mark: README, slide footer, credits |

Lockups: **horizontal** = owl left, wordmark "WiseLedger" right (header); **stacked** = owl above wordmark (title slide); **icon** = owl only (favicon, avatar, app icon). The wordmark is set in Nunito Bold (rounded) in deep blue; it exists only as part of the logo art, the UI text fonts are in section 3. One-colour versions: all deep blue `#0B4F8F` on light, all white on `#0B4F8F`/`#063F73`.
Clear space: at least half the owl's width on every side. Minimum size: 24 px on screen, 1 cm in print.
Do not: stretch or squash the owl; redraw or restyle it; put it on colours outside the palette or on busy backgrounds; add effects (shadows, gradients, outlines).

## 2. Colour
| Token | HEX | RGB | Use |
|---|---|---|---|
| `--wl-blue` | `#0B4F8F` | 11 79 143 | primary: buttons, links, headings accents |
| `--wl-navy` | `#063F73` | 6 63 115 | dark backgrounds, hover, headings |
| `--wl-rust` | `#A9420F` | 169 66 15 | accent: one key action per screen, highlights |
| `--wl-gold` | `#FFC20E` | 255 194 14 | coin colour, focus ring, highlights on dark. Never as text on white (1.6:1) |
| `--wl-white` | `#FFFFFF` | 255 255 255 | cards, text on dark |
| `--wl-ink` | `#1B2733` | 27 39 51 | body text |
| `--wl-muted` | `#52606D` | 82 96 109 | secondary text |
| `--wl-page` | `#F7F4EC` | 247 244 236 | page background (warm paper) |

Functional colours (each state = background + solid + text colour, always with an icon and a word):
| State | Background | Solid (border, badge) | Text on background | Icon |
|---|---|---|---|---|
| OK / looks fine | `#E3F3E8` | `#1E7B45` | `#0F4D2A` | ✓ |
| Review / check | `#FFF1C7` | `#8A5A00` | `#5B3A00` | ! |
| Blocked / do not pay | `#FBE3E1` | `#B3261E` | `#7A1511` | ✕ |
| Info / neutral | `#EEF1F4` | `#52606D` | `#1B2733` | i |

**Contrast, computed with the WCAG formula** (the sheet's numbers were wrong; AA needs 4.5 for text, 3 for large text and UI borders):
| Pair | Ratio |
|---|---|
| ink on page / on white | 13.8 / 15.2 |
| muted on white / on page | 6.5 / 5.9 |
| white on blue (buttons) / white on navy | 8.3 / 10.7 |
| blue on white (links) / blue on page | 8.3 / 7.6 |
| white on rust / rust on white | 6.1 / 6.1 |
| navy on gold (gold badge) | 6.6 |
| gold on navy (icon on dark) | 6.6 |
| OK: text on bg / white on solid | 8.6 / 5.3 |
| Review: text on bg / white on solid | 9.1 / 5.9 |
| Block: text on bg / white on solid | 8.8 / 6.5 |
Not allowed: gold text on white or on page (1.6:1), rust text on gold (3.7:1), white text on gold. Rule: never colour alone, every status has an icon and a word.

## 3. Type
| Role | Font | Size |
|---|---|---|
| Headings | DM Serif Display (400) | H1 32 px, H2 28 px, H3 22 px |
| Body, captions, buttons | Inter | body 16 px / 1.5, caption 14 px, button 14 px bold |
Both fonts are bundled with `@fontsource/*` (no network): the app is local-first and must work offline.

## 4. Voice and tone
Calm, clear, a little clever: a careful friend who reads the fine print. Plain words, no jargon ("payment", not "transaction"; "your wallet", not "UTXO"). Short sentences. Say what happened, why, and what to do next.
| Principle | Do | Don't |
|---|---|---|
| Clear over clever | "Your payment was sent." | "Bazinga! Invoice paid!" |
| Be the careful friend | "This invoice asks you to pay a different account than last time. I stopped it so you can check." | "ALERT: anomaly detected." |
| Say what to do next | "Ask the supplier by phone, then upload the invoice again." | "Verification failed." |
| Calm under risk | "I did not pay. Nothing left your money." | "FRAUD!!! DO NOT PAY!!!" |
| No jargon | "Waiting for Bitcoin to confirm (about a minute)." | "Awaiting 1 confirmation on signet." |
Microcopy (use as is):
| Moment | Text |
|---|---|
| Invoice uploaded | "Got it. Reading your invoice…" |
| Safe verdict | "Looks fine. I found nothing suspicious." |
| Review verdict | "Check before paying. Some details look unusual. Read the warnings below." |
| Blocked verdict | "Do not pay. This invoice looks dangerous. I will not pay it." |
| Payment confirmed | "Payment sent. You can follow it under My invoices." |
| Payment scheduled | "Scheduled. I will pay on {date} and tell you when it is done." |
| No network | "No internet right now. Your invoice and your wallet stay on this device. Try again when you are back online." |

## 5. UI rules (ease of use over aesthetics)
- Radius 8 px; tap targets at least 44 px; body 16 px; generous spacing; one primary action per screen.
- Buttons: primary = blue filled, secondary = white with blue border (`class="wl-secondary"`), accent = rust (`class="wl-accent"`, for the one decisive action, e.g. the final "Pay"). Disabled = grey with muted text.
- Cards: white, 1 px line `#C9D1D9`, 8 px radius (`class="wl-card"`).
- Verdict badges: `class="wl-badge" data-tone="ok|review|block"`, icon + word, solid border in the state colour. The Report banner uses the same colours (`VERDICT_COLORS`, `VERDICT_ACCENT`, `VERDICT_ICON` in `lib/format.ts`).
- Form fields: 44 px high, 1 px muted border, visible label above, plain error text under the field.
- Focus: gold outline with a navy ring (visible on every background).
- Empty states: one friendly line plus the next action ("No invoices yet. Check your first invoice.").
- Confirmation screen: the one-sentence summary generated by code ("Pay 25.00 TUSDT to Acme Srl, now"), large, then Cancel (secondary) and Pay (accent).

## 6. Where it applies
| Place | What |
|---|---|
| Web app | `brand.css` (tokens, fonts, buttons, fields, focus), header with the owl, favicon, verdict colours |
| README (public) | owl at the top, Coin³ mark in the Team section |
| Slides | dark navy for title, demo and closing slides, white for the rest, Coin³ mark in the footer (prompt in the team notes) |
| Pitch/desk | one sentence: "A careful friend that reads the fine print before you pay." |
