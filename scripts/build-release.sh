#!/usr/bin/env bash
# Builds the one-file release `wiseledger-linux-x64.run` (GitHub Releases only, never committed).
# It is a self-extracting archive: a bash launcher + tar.zst of Node 22, pnpm, this repository's source with its
# installed dependencies, and the RGB Lightning modules (built from source, see README "Stack declared").
# Nothing of ours is compiled: the app runs from the TypeScript sources it unpacks.
# With no arguments the launcher runs the real app: QVAC on device, RGB wallet on Mutinynet, RGB Lightning + our LSP.
#
#   bash scripts/build-release.sh <public-repo-checkout> <ln-node_modules> <out-dir>
set -euo pipefail
SRC=$(realpath "$1"); LN=$(realpath "$2"); OUT=$(realpath "$3")
VER=$(git -C "$SRC" rev-parse --short HEAD)
NODE_BIN=$(command -v node); PNPM_DIR="${PNPM_DIR:-$HOME/.cache/node/corepack/v1/pnpm/12.11.2}"
STAGE="$OUT/stage"; rm -rf "$STAGE"; mkdir -p "$STAGE/.runtime/node/bin" "$STAGE/.runtime/bin"

echo "[build] source $SRC @ $VER"
git -C "$SRC" archive HEAD | tar -x -C "$STAGE"
(cd "$STAGE" && pnpm install --frozen-lockfile --prefer-offline >/dev/null)
cp "$NODE_BIN" "$STAGE/.runtime/node/bin/node"
cp -a "$PNPM_DIR" "$STAGE/.runtime/pnpm"
cat > "$STAGE/.runtime/bin/pnpm" <<'EOF'
#!/usr/bin/env bash
exec "$(dirname "$0")/../node/bin/node" "$(dirname "$0")/../pnpm/bin/pnpm.mjs" "$@"
EOF
chmod +x "$STAGE/.runtime/bin/pnpm"
echo "[build] lightning modules $LN"
cp -a "$LN" "$STAGE/.runtime/ln_modules"
echo "$VER" > "$STAGE/.runtime/VERSION"

cat > "$OUT/launcher.sh" <<'EOF'
#!/usr/bin/env bash
# WiseLedger @VER@: one-file release. Unpacks once to $WISELEDGER_HOME (default ~/WiseLedger-app).
#   (no arguments) | start   the real app: first-run setup, then QVAC + RGB wallet + RGB Lightning with our LSP
#   <anything else>          `pnpm <anything else>` in the app folder with the bundled Node 22 and pnpm
# Source: https://github.com/LucaCraft89/WiseLedger
set -euo pipefail
VER=@VER@
APP="${WISELEDGER_HOME:-$HOME/WiseLedger-app}"
SELF=$(realpath "$0")
if [ "$(uname -s)-$(uname -m)" != "Linux-x86_64" ]; then
  echo "This release is for Linux x64 (on Windows: WSL2 Ubuntu 24.04). Elsewhere run from source: see the README." >&2; exit 1
fi
if [ ! -f "$APP/.runtime/VERSION" ] || [ "$(cat "$APP/.runtime/VERSION")" != "$VER" ]; then
  command -v zstd >/dev/null || { echo "Needs zstd to unpack: sudo apt install zstd  (Fedora: sudo dnf install zstd)" >&2; exit 1; }
  echo "Unpacking WiseLedger $VER to $APP (once, ~1 min, ~6 GB). Your .env and .data/ are kept." >&2
  mkdir -p "$APP"
  N=$(awk '/^__PAYLOAD__$/ { print NR + 1; exit }' "$SELF")
  tail -n +"$N" "$SELF" | zstd -dc -T0 | tar -x -C "$APP"
fi
cd "$APP"
if [ ! -f .env ]; then
  # The real backends are the defaults of .env.example; the release also turns on RGB Lightning with our LSP.
  sed -e 's/^LN_ENABLED=.*/LN_ENABLED=true/' .env.example > .env
  echo "Created $APP/.env (QVAC, RGB wallet on Mutinynet, Lightning on). Edit it there." >&2
fi
export PATH="$APP/.runtime/bin:$APP/.runtime/node/bin:$PATH"
export LN_MODULES="${LN_MODULES:-$APP/.runtime/ln_modules}"

say() { printf '\n\033[1m[wiseledger] %s\033[0m\n' "$*"; }
lightning_on() { grep -Eq '^LN_ENABLED=(1|true|yes)' .env; }

if [ $# -gt 0 ] && [ "$1" != start ]; then exec pnpm "$@"; fi

# --- first-run setup (each step runs once, safe to rerun) ---
mkdir -p .data
if [ ! -f .data/tusdt.json ]; then
  say "Step 1/2: wallets (payer = you, payee = a supplier) on Mutinynet"
  pnpm wallet:smoke || true
  say "Step 2/2: issuing your test token TUSDT (RGB NIA, precision 6, no value)"
  if ! pnpm -F wallet issue-asset; then
    say "Your wallet needs test sats first."
    echo "  1. Open https://faucet.mutinynet.com and send 200000 sats to the payer funding address printed above."
    echo "  2. Wait about one minute (a Mutinynet block is ~30 s), then run this file again."
    exit 1
  fi
fi
if [ ! -f .data/.release-funded ]; then
  say "Giving the supplier wallet some sats (it needs them to make payment requests)"
  pnpm wallet:smoke -- --fund-payee 30000 || echo "  (skipped: run again later)"
  if lightning_on; then
    say "Funding our Lightning LSP (node A) from your wallet"
    pnpm -F wallet lsp fund 50000 || echo "  (skipped: run again later; the app works on-chain meanwhile)"
  fi
  touch .data/.release-funded
fi
if [ ! -d .data/demo ]; then
  say "Making demo invoices from the supplier wallet (.data/demo/)"
  pnpm demo:prepare || echo "  (skipped: the supplier may still be waiting for its sats; run again in a minute)"
fi

# --- run: the supplier's wallet in the background, the app in front ---
say "Starting WiseLedger: open http://localhost:5173  (first start downloads the QVAC model, ~2.6 GB; Ctrl+C stops)"
pnpm -F wallet payee watch > .data/payee-watch.log 2>&1 &
PAYEE=$!
trap 'kill $PAYEE 2>/dev/null || true' EXIT
pnpm dev
__PAYLOAD__
EOF
sed -i "s/@VER@/$VER/g" "$OUT/launcher.sh"

echo "[build] compressing (zstd)"
F="$OUT/wiseledger-linux-x64.run"
cp "$OUT/launcher.sh" "$F"
tar -C "$STAGE" -c . | zstd -T0 -10 --long=27 -q >> "$F"
chmod +x "$F"
sha256sum "$F" | tee "$F.sha256"
ls -lh "$F"
