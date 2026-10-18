#!/usr/bin/env bash
# Builds the one-file release `wiseledger-linux-x64.run` (GitHub Releases only, never committed).
# It is a self-extracting archive: a bash launcher + tar.zst of Node 22, pnpm, this repository's source with its
# installed dependencies, and the RGB Lightning modules (built from source, see README "Stack declared").
# Nothing of ours is compiled: the app runs from the TypeScript sources it unpacks.
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

cat > "$OUT/launcher.sh" <<EOF
#!/usr/bin/env bash
# WiseLedger $VER: one-file release. Unpacks once to \$WISELEDGER_HOME (default ~/WiseLedger-app), then runs
# \`pnpm <your arguments>\` there with the bundled Node 22 and pnpm. Source: https://github.com/LucaCraft89/WiseLedger
set -euo pipefail
VER=$VER
APP="\${WISELEDGER_HOME:-\$HOME/WiseLedger-app}"
if [ "\$(uname -s)-\$(uname -m)" != "Linux-x86_64" ]; then
  echo "This release is for Linux x64 (on Windows: WSL2 Ubuntu 24.04). Elsewhere run from source: see the README." >&2; exit 1
fi
if [ ! -f "\$APP/.runtime/VERSION" ] || [ "\$(cat "\$APP/.runtime/VERSION")" != "\$VER" ]; then
  command -v zstd >/dev/null || { echo "Needs zstd to unpack: sudo apt install zstd  (Fedora: sudo dnf install zstd)" >&2; exit 1; }
  echo "Unpacking WiseLedger \$VER to \$APP (once, ~1-2 min, ~6 GB). Your .env and .data/ are kept." >&2
  mkdir -p "\$APP"
  N=\$(awk '/^__PAYLOAD__\$/ { print NR + 1; exit }' "\$0")
  tail -n +"\$N" "\$0" | zstd -dc -T0 | tar -x -C "\$APP"
fi
cd "\$APP"
[ -f .env ] || { cp .env.example .env; echo "Created \$APP/.env from .env.example: edit it there." >&2; }
export PATH="\$APP/.runtime/bin:\$APP/.runtime/node/bin:\$PATH"
export LN_MODULES="\${LN_MODULES:-\$APP/.runtime/ln_modules}"
if [ \$# -eq 0 ]; then
  cat <<'HELP'
WiseLedger: every argument is passed to pnpm inside the app folder. For example:
  ./wiseledger-linux-x64.run demo:mock               whole flow on mocks (1 minute)
  ./wiseledger-linux-x64.run wallet:smoke            create the wallets, print the address for test sats
  ./wiseledger-linux-x64.run -F wallet issue-asset   issue your own TUSDT, put its ID in .env (ASSET_ALLOWLIST)
  ./wiseledger-linux-x64.run demo:prepare            demo invoices
  ./wiseledger-linux-x64.run dev                     the app: http://localhost:5173
  ./wiseledger-linux-x64.run -F wallet payee watch   the supplier's wallet (second terminal)
Full guide: README.md in the app folder, section "For the judges".
HELP
  exit 0
fi
exec pnpm "\$@"
__PAYLOAD__
EOF

echo "[build] compressing (zstd)"
F="$OUT/wiseledger-linux-x64.run"
cp "$OUT/launcher.sh" "$F"
tar -C "$STAGE" -c . | zstd -T0 -10 --long=27 -q >> "$F"
chmod +x "$F"
sha256sum "$F" | tee "$F.sha256"
ls -lh "$F"
