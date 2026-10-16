#!/usr/bin/env bash
# Prepares Fedora 40+ (native, or inside a Fedora distrobox) for the project: system tools only, no product code.
# Twin of infra/wsl-bootstrap.sh. NOT yet run on a real Fedora machine: the first person to use it should say what broke.
# Usage:  bash infra/fedora-bootstrap.sh
# Asks for the sudo password once. Safe to rerun.
set -euo pipefail

step() { printf '\n\033[1;36m== %s\033[0m\n' "$*"; }

step "Check glibc (the RGB native binaries need >= 2.38)"
glibc="$(ldd --version | head -1 | grep -oE '[0-9]+\.[0-9]+$')"
echo "glibc $glibc"
if [ "$(printf '%s\n2.38\n' "$glibc" | sort -V | head -1)" != "2.38" ]; then
  echo "glibc $glibc is older than 2.38: use Fedora 40 or newer." >&2
  exit 1
fi

step "System packages (build, git, gh, Python, libatomic, Vulkan)"
sudo dnf install -y gcc gcc-c++ make cmake clang pkgconf-pkg-config openssl-devel \
  git curl unzip jq ca-certificates python3 python3-pip gh \
  libatomic vulkan-loader vulkan-tools mesa-vulkan-drivers

step "GPU groups for QVAC (log out and in for them to apply)"
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

step "Git defaults"
git config --global init.defaultBranch main
git config --global core.autocrlf input

step "Working folders"
mkdir -p "$HOME/code" "$HOME/prove"

step "Versions"
printf 'node %s · pnpm %s · gh %s\n' "$(node -v)" "$(pnpm -v)" "$(gh --version | head -1 | awk '{print $3}')"
"$HOME/.local/bin/claude" --version 2>/dev/null || claude --version 2>/dev/null || echo "claude: reopen the terminal"

cat <<'MSG'

Done. Not installed here on purpose:
  - Docker (moby-engine) for the regtest fallback
  - ffmpeg-free (optional, voice)
Manual steps left (once):
  1) gh auth login                      # GitHub.com -> HTTPS -> browser login
  2) git config --global user.name  "<name>"
     git config --global user.email "<email>"
  3) log out and back in (loads the render/video groups), then open a new terminal
MSG
