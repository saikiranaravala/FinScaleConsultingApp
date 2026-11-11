#!/usr/bin/env bash
# Bootstraps the FinScale Consulting Console natively on a RunPod Pod with no
# Docker daemon (the common case for GPU/ML pod templates — see
# FinscaleNvidiaPlatform's own runpod-start.sh, which never uses Docker
# either). Installs Node + MongoDB, clones+builds LibreChat (not vendored
# into this repo's git history), and starts mongod/shim/LibreChat under pm2.
#
# Does NOT touch scripts/serve_vllm.py — start/confirm that separately on the
# FinscaleNvidiaPlatform side; see ../../DEPLOY_RUNPOD.md step 3.
#
# Run from anywhere; idempotent — re-run after editing config or after a Pod
# restart. Run as root (the default RunPod user).
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
DATA_DIR="${FINSCALE_MONGO_DATA_DIR:-/workspace/FinScaleChat-data/mongo}"
BACKUP_DIR="${FINSCALE_CONFIG_BACKUP_DIR:-/workspace/FinScaleChat-config}"
LIBRECHAT_DIR="$REPO_ROOT/librechat"

echo "== 1. Node.js >=18 =="
NEED_NODE_INSTALL=1
if command -v node >/dev/null 2>&1; then
  NODE_MAJOR="$(node -e 'console.log(process.versions.node.split(".")[0])')"
  [ "$NODE_MAJOR" -ge 18 ] && NEED_NODE_INSTALL=0
fi
if [ "$NEED_NODE_INSTALL" = "1" ]; then
  export NVM_DIR="$HOME/.nvm"
  if [ ! -s "$NVM_DIR/nvm.sh" ]; then
    curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.1/install.sh | bash
  fi
  # shellcheck disable=SC1091
  . "$NVM_DIR/nvm.sh"
  nvm install 20
  nvm use 20
  NVM_INIT='export NVM_DIR="$HOME/.nvm"; [ -s "$NVM_DIR/nvm.sh" ] && \. "$NVM_DIR/nvm.sh"'
  grep -qxF "$NVM_INIT" "$HOME/.bashrc" 2>/dev/null || echo "$NVM_INIT" >> "$HOME/.bashrc"
fi
node --version
npm --version

echo "== 2. pm2 =="
command -v pm2 >/dev/null 2>&1 || npm install -g pm2

echo "== 3. MongoDB =="
if ! command -v mongod >/dev/null 2>&1; then
  CODENAME="$(. /etc/os-release && echo "${VERSION_CODENAME:-jammy}")"
  apt-get update -y
  apt-get install -y gnupg curl
  mkdir -p /usr/share/keyrings
  curl -fsSL https://pgp.mongodb.com/server-7.0.asc | gpg --yes -o /usr/share/keyrings/mongodb-server-7.0.gpg --dearmor
  echo "deb [ signed-by=/usr/share/keyrings/mongodb-server-7.0.gpg ] https://repo.mongodb.org/apt/ubuntu ${CODENAME}/mongodb-org/7.0 multiverse" \
    > /etc/apt/sources.list.d/mongodb-org-7.0.list
  apt-get update -y
  apt-get install -y mongodb-org
fi
mkdir -p "$DATA_DIR"

echo "== 4. Persistent config (survives /FinScaleChat being wiped with the Pod's ephemeral disk) =="
mkdir -p "$BACKUP_DIR"
NEEDS_EDIT=0
if [ ! -f "$BACKUP_DIR/.env" ]; then
  cp "$REPO_ROOT/deploy/runpod/.env.example" "$BACKUP_DIR/.env"
  NEEDS_EDIT=1
fi
if [ ! -f "$BACKUP_DIR/clients.json" ]; then
  cp "$REPO_ROOT/config/clients.example.json" "$BACKUP_DIR/clients.json"
  NEEDS_EDIT=1
fi
ln -sf "$BACKUP_DIR/.env" "$REPO_ROOT/.env"
mkdir -p "$REPO_ROOT/config"
ln -sf "$BACKUP_DIR/clients.json" "$REPO_ROOT/config/clients.json"
if [ "$NEEDS_EDIT" = "1" ]; then
  echo ">>> Edit $BACKUP_DIR/.env (secrets + FINSCALE_VLLM_BASE_URL) and"
  echo ">>> $BACKUP_DIR/clients.json (client -> adapter mapping), then re-run this script."
  exit 0
fi

echo "== 5. LibreChat source (cloned here at deploy time, not vendored into this repo) =="
if [ ! -d "$LIBRECHAT_DIR" ]; then
  git clone --depth 1 https://github.com/danny-avila/LibreChat.git "$LIBRECHAT_DIR"
fi
cd "$LIBRECHAT_DIR"
npm ci
# Script names per LibreChat's current non-Docker setup docs; check
# `cat package.json` if these have been renamed upstream.
npm run frontend
cd "$REPO_ROOT"

echo "== 6. Start mongod, shim, and LibreChat under pm2 =="
pm2 start "$REPO_ROOT/deploy/runpod/ecosystem.config.js"
pm2 save

echo
echo "Done. 'pm2 status' / 'pm2 logs' to check."
echo "Reminder: scripts/serve_vllm.py is NOT managed by this script — start/confirm it"
echo "separately on the FinscaleNvidiaPlatform side (see ../../DEPLOY_RUNPOD.md step 3)."
