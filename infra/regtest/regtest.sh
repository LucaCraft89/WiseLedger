#!/usr/bin/env bash
# Local regtest helper. Usage: infra/regtest/regtest.sh start|stop|mine [n]|fund <address> [btc]|height
set -euo pipefail
cd "$(dirname "$0")"
bcli() { docker compose exec -T -u blits bitcoind bitcoin-cli -regtest "$@"; }
case "${1:-}" in
  start)
    docker compose down -v --remove-orphans >/dev/null 2>&1 || true
    docker compose up -d
    until bcli getblockchaininfo >/dev/null 2>&1; do sleep 1; done
    bcli createwallet miner >/dev/null 2>&1 || bcli loadwallet miner >/dev/null 2>&1 || true
    bcli -generate 111 >/dev/null
    until (exec 3<>/dev/tcp/127.0.0.1/50001) 2>/dev/null; do sleep 1; done
    echo "regtest up: height $(bcli getblockcount)" ;;
  stop) docker compose down -v --remove-orphans ;;
  mine) bcli -generate "${2:-1}" >/dev/null; echo "height $(bcli getblockcount)" ;;
  fund) bcli -rpcwallet=miner sendtoaddress "$2" "${3:-1}"; bcli -generate 1 >/dev/null ;;
  height) bcli getblockcount ;;
  *) echo "usage: $0 start|stop|mine [n]|fund <address> [btc]|height" >&2; exit 2 ;;
esac
