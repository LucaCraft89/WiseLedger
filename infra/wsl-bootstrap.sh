#!/usr/bin/env bash
# Prepares Ubuntu 24.04 (WSL2, or native Ubuntu 24.04 / Debian 13) for the project: system tools only, no product code.
# Ported from Antonino's wsl-bootstrap.sh (verified 14-15 Oct) and extended with libatomic1, Rust build deps and GPU groups.
# Usage, inside Ubuntu:  bash infra/wsl-bootstrap.sh
# Asks for the sudo password once. Safe to rerun: it skips what is already installed.
set -euo pipefail

step() { printf '\n\033[1;36m== %s\033[0m\n' "$*"; }

step "Check glibc (the RGB native binaries need >= 2.38)"
glibc="$(ldd --version | head -1 | grep -oE '[0-9]+\.[0-9]+$')"
echo "glibc $glibc"
if [ "$(printf '%s\n2.38\n' "$glibc" | sort -V | head -1)" != "2.38" ]; then
  echo "glibc $glibc is older than 2.38: this machine cannot run @utexo/rgb-lib. Use Ubuntu 24.04+ / Debian 13+." >&2
  exit 1
fi

step "System packages (build, git, gh, Python, libatomic, Vulkan)"
sudo apt-get update -y
sudo apt-get install -y build-essential pkg-config libssl-dev cmake clang git curl unzip ca-certificates jq \
  python3 python3-pip python3-venv gh libatomic1 libvulkan1 mesa-vulkan-drivers vulkan-tools

step "GPU groups for QVAC (log out and in, or 'wsl --shutdown', for them to apply)"
sudo usermod -aG render,video "$USER" || true

step "Node 22 with nvm + pnpm"
export NVM_DIR="$HOME/.nvm"
if [ ! -s "$NVM_DIR/nvm.sh" ]; then
  curl -fsSL https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.3/install.sh | bash
fi
# shellcheck disable=SC1091
. "$NVM_DIR/nvm.sh"
nvm install 22
nvm alias default 22
export COREPACK_ENABLE_DOWNLOAD_PROMPT=0
corepack enable
corepack prepare pnpm@latest --activate

step "Claude Code"
if ! command -v claude >/dev/null 2>&1 && [ ! -x "$HOME/.local/bin/claude" ]; then
  curl -fsSL https://claude.ai/install.sh | bash
fi

step "Git defaults (WSL only: share credentials with Windows Git Credential Manager if present)"
GCM="/mnt/c/Program Files/Git/mingw64/bin/git-credential-manager.exe"
if [ -x "$GCM" ]; then
  git config --global credential.helper "\"$GCM\""
fi
git config --global init.defaultBranch main
git config --global core.autocrlf input

step "Working folders"
mkdir -p "$HOME/code" "$HOME/prove"

step "Versions"
printf 'node %s · pnpm %s · gh %s\n' "$(node -v)" "$(pnpm -v)" "$(gh --version | head -1 | awk '{print $3}')"
"$HOME/.local/bin/claude" --version 2>/dev/null || claude --version 2>/dev/null || echo "claude: reopen the terminal"

cat <<'MSG'

Done. Manual steps left (once):
  1) gh auth login                      # GitHub.com -> HTTPS -> browser login
  2) git config --global user.name  "<name>"
     git config --global user.email "<email>"
  3) close and reopen the terminal (loads nvm, claude and the new groups)
  4) continue with docs/setup/common.md (QVAC models, npm warm-up, funding)
MSG
