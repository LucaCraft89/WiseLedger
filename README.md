# WiseLedger — private coordination repo (team Coin³)

Local-first, self-custodial invoice-fraud checker that pays good invoices with RGB assets. Built for the *Agentic Dollars on Bitcoin* hackathon (BLOX Turin, 17–18 Oct 2026) by three people and two coding agents.

This is the **private** repo: plans, agent rules, prompts, setup guides, tests, spikes and the working code. The public repo [`LucaCraft89/WiseLedger`](https://github.com/LucaCraft89/WiseLedger) shows the judges the final code and the major steps as real-dated commits; how work gets there is in `docs/PUBLISH.md`.

## Read in this order
| File | For |
|---|---|
| `AGENTS.md` | every agent, every session: lanes, rules, sync protocol, human checkpoints |
| `docs/PLAN.md` | architecture, milestones, risks, open questions |
| `docs/PROMPTS.md` | the exact prompt for every step and lane (A = Luca, B = Antonino) |
| `docs/setup/README.md` | machine setup for WSL2/Ubuntu and Fedora (native or distrobox), every SDK and package |
| `docs/setup/CHECKLIST.md` | everything to do before Sat 09:30, with the Fri 23:00 registration |
| `docs/agent-plans/` | plans an agent follows to set up a machine and the dev environment, one human checkpoint per step |
| `docs/PUBLISH.md` | how the Merge Captain publishes to the public repo |
| `docs/STACK.md`, `MODIFICHE.md` | Antonino's technology deep dive and change list (Italian), integrated into the plan |
| `docs/decisions/` | short decision records (`h-` humans, `a-`/`b-` agents) |

## Rules in one breath
Never commit keys, `.env` or seeds. Test networks only. Two agents, one repo, folders owned by lane, contracts first in `packages/core`. Nobody pushes to `main` or `milestone/*` directly; the Merge Captain merges and publishes. Pre-kickoff work is machines, downloads and funding only: no product code before Sat 17 Oct 09:30.
