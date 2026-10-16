#!/usr/bin/env bash
# Prepara Ubuntu 24.04 in WSL2 per il progetto (strumenti di sistema, niente codice di prodotto).
# Uso, dentro Ubuntu:  bash wsl-bootstrap.sh
# Chiede la password di sudo una volta. Si può rilanciare: salta ciò che è già installato.
set -euo pipefail

step() { printf '\n\033[1;36m== %s\033[0m\n' "$*"; }

step "Pacchetti di sistema (build, git, gh, Vulkan, Python)"
sudo apt-get update -y
sudo apt-get install -y build-essential git curl unzip ca-certificates jq \
  python3 python3-pip python3-venv gh libvulkan1 mesa-vulkan-drivers vulkan-tools

step "Controllo glibc (serve >= 2.38 per @utexo/rgb-lib)"
ldd --version | head -1

step "Node 22 con nvm + pnpm"
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

step "Git: credenziali condivise con Windows (Git Credential Manager)"
GCM="/mnt/c/Program Files/Git/mingw64/bin/git-credential-manager.exe"
if [ -x "$GCM" ]; then
  git config --global credential.helper "\"$GCM\""
fi
git config --global init.defaultBranch main
git config --global core.autocrlf input

step "Cartelle di lavoro"
mkdir -p "$HOME/code" "$HOME/prova"

step "Versioni"
printf 'node %s · pnpm %s · gh %s\n' "$(node -v)" "$(pnpm -v)" "$(gh --version | head -1 | awk '{print $3}')"
"$HOME/.local/bin/claude" --version 2>/dev/null || claude --version 2>/dev/null || echo "claude: riaprire il terminale"

cat <<'EOF'

Fatto. Ultimi passi manuali (una volta sola):
  1) gh auth login                      # GitHub.com → HTTPS → login dal browser
  2) git config --global user.name  "<nome>"
     git config --global user.email "<email>"
  3) chiudi e riapri il terminale Ubuntu (carica nvm e claude nel PATH)
EOF
