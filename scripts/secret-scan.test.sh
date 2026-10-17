#!/usr/bin/env bash
# Self-test: the scan passes on a clean temp repo and fails on a planted fake key, a tracked .env and a tracked .data file.
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
repo_root="$(cd "$here/.." && pwd)"
tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT
cd "$tmp"
git init -q .
mkdir -p scripts publish
cp "$repo_root/scripts/secret-scan.sh" scripts/
cp "$repo_root/publish/deny-patterns.txt" publish/
echo 'const ok = 1;' > clean.ts
git add -A

expect() { # expect <0|1> <label>
  if bash scripts/secret-scan.sh >/dev/null 2>&1; then got=0; else got=1; fi
  if [ "$got" != "$1" ]; then echo "secret-scan.test: FAIL ($2): exit $got, expected $1" >&2; exit 1; fi
}

expect 0 clean
# Built at runtime so this file never contains the literal header.
printf '%s\n' "-----BEGIN ""PRIVATE KEY-----" 'MIIEvQIBADANBg' > planted.pem.txt
expect 1 planted-key
rm planted.pem.txt; expect 0 removed
printf 'X=1\n' > .env && git add -f .env
expect 1 tracked-env
git rm -q --cached .env && rm .env
mkdir .data && echo x > .data/w && git add -f .data/w
expect 1 tracked-data
echo "secret-scan.test: ok"
