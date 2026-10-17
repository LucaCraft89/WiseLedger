#!/usr/bin/env bash
# Desk demo, N times in a row, on the real backends (.env: WALLET_BACKEND=wdk-rgb, LLM_PROVIDER=qvac, Mutinynet).
# Each run: pnpm demo:reset → payee watch + server → upload 1-good (confirm → PAID) → 2-scam, 3-duplicate,
# 4-injection (each must be BLOCKED) → stop. Same HTTP calls as the web UI. One TSV line per run.
# Usage: infra/demo-loop.sh [runs=10] [out=infra/demo-runs.tsv]. It stops any running server and payee watch first.
set -u
cd "$(dirname "$0")/.."
RUNS=${1:-10}
OUT=${2:-infra/demo-runs.tsv}
B=http://127.0.0.1:${PORT:-8787}
LOGDIR=${LOGDIR:-.data/demo-loop}
mkdir -p "$LOGDIR"
[[ -f $OUT ]] || printf 'run\tstarted\treset_s\tmodel_s\tgood_verdict\tanalyze_s\tsettle_s\ttxid\tscam\tduplicate\tinjection\tresult\tnote\n' >"$OUT"

now() { date +%s; }
state() { curl -s "$B/api/invoices/$1" | jq -r '.invoice.state // "?"'; }
wait_state() { # id timeout_s regex → final state
  local end=$(( $(now) + $2 )) s
  while :; do
    s=$(state "$1")
    [[ $s =~ ^($3)$ ]] && { echo "$s"; return; }
    (( $(now) > end )) && { echo "TIMEOUT:$s"; return; }
    sleep 2
  done
}
upload() { curl -s -F "file=@$1" "$B/api/invoices" | jq -r '.invoiceId // empty'; }
stop_all() {
  [[ -n ${SRV:-} ]] && kill "$SRV" 2>/dev/null
  [[ -n ${PAY:-} ]] && kill "$PAY" 2>/dev/null
  pkill -f "[s]rc/main.ts" 2>/dev/null; pkill -f "[p]ayee.ts watch" 2>/dev/null
  # One wallet = one process: wait until no live process holds either wallet's lock (the server may take up to
  # ~15 s to stop when a send is still inside the library), then force it.
  local deadline=$(( $(now) + 60 )) busy l
  while (( $(now) < deadline )); do
    busy=0
    for l in .data/wallet/.wiseledger.lock .data/payee/.wiseledger.lock; do
      [[ -f $l ]] && kill -0 "$(cat "$l")" 2>/dev/null && busy=1
    done
    (( busy )) || break
    sleep 1
  done
  pkill -KILL -f "[s]rc/main.ts" 2>/dev/null; pkill -KILL -f "[p]ayee.ts watch" 2>/dev/null
  SRV=; PAY=
}

trap 'stop_all; exit 130' INT TERM

for run in $(seq 1 "$RUNS"); do
  started=$(date +%H:%M:%S); note=''; result=FAIL
  t=$(now)
  if ! pnpm -s demo:reset >"$LOGDIR/reset-$run.log" 2>&1; then
    printf '%s\t%s\t%s\t\t\t\t\t\t\t\t\tFAIL\tdemo:reset failed (see %s)\n' "$run" "$started" $(( $(now) - t )) "$LOGDIR/reset-$run.log" >>"$OUT"
    continue
  fi
  reset_s=$(( $(now) - t ))

  pnpm -s -F wallet payee watch >"$LOGDIR/payee-$run.log" 2>&1 & PAY=$!
  pnpm -s -F server start >"$LOGDIR/server-$run.log" 2>&1 & SRV=$!
  t=$(now); llm=''
  for _ in $(seq 1 180); do
    llm=$(curl -s "$B/api/health" | jq -r '.llm.state // empty' 2>/dev/null)
    [[ $llm == ready || $llm == error ]] && break
    sleep 1
  done
  model_s=$(( $(now) - t ))
  if [[ $llm != ready ]]; then
    note="model not ready ($llm)"
  else
    t=$(now); id=$(upload .data/demo/1-good-acme.pdf)
    s=$(wait_state "$id" 300 'AWAITING_CONFIRMATION|BLOCKED|FAILED'); analyze_s=$(( $(now) - t ))
    d=$(curl -s "$B/api/invoices/$id"); verdict=$(jq -r '.report.verdict // "?"' <<<"$d")
    if [[ $s != AWAITING_CONFIRMATION ]]; then
      note="good invoice → $s ($(jq -c '[.report.flags[]?.code]' <<<"$d"))"
    else
      plan=$(jq -r .plan.planId <<<"$d")
      ov=$([[ $verdict == review ]] && echo ',"override":true')
      t=$(now)
      curl -s -H 'content-type: application/json' -d "{\"planId\":\"$plan\"$ov}" "$B/api/invoices/$id/confirm" >/dev/null
      s=$(wait_state "$id" 900 'PAID|FAILED'); settle_s=$(( $(now) - t ))
      txid=$(curl -s "$B/api/invoices/$id" | jq -r '.result.txid // empty')
      [[ -z $txid ]] && txid=$(curl -s "$B/api/transfers" | jq -r --arg id "$id" '[.transfers[] | select(.invoiceId==$id)][0].txid // empty')
      [[ $s != PAID ]] && note="good invoice payment → $s"
      v=()
      for f in 2-scam-bank-change 3-duplicate-acme 4-injection-nordic; do
        bid=$(upload ".data/demo/$f.pdf")
        v+=("$(wait_state "$bid" 300 'AWAITING_CONFIRMATION|BLOCKED|FAILED')")
      done
      if [[ $s == PAID && ${v[0]} == BLOCKED && ${v[1]} == BLOCKED && ${v[2]} == BLOCKED ]]; then result=OK
      elif [[ -z $note ]]; then note="expected 3× BLOCKED"; fi
    fi
  fi
  printf '%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\n' "$run" "$started" "$reset_s" "$model_s" \
    "${verdict:-}" "${analyze_s:-}" "${settle_s:-}" "${txid:-}" "${v[0]:-}" "${v[1]:-}" "${v[2]:-}" "$result" "$note" >>"$OUT"
  tail -1 "$OUT"
  stop_all
  unset verdict analyze_s settle_s txid v
done
