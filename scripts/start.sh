#!/usr/bin/env bash
# Ensure the project's Node version (.nvmrc) is active, then start the bot.
# pnpm runs scripts in a non-interactive shell, so nvm (a shell function)
# must be sourced explicitly before `nvm use` will work.
set -e

cd "$(dirname "$0")/.."

export NVM_DIR="${NVM_DIR:-$HOME/.nvm}"
if [ -s "$NVM_DIR/nvm.sh" ]; then
  # shellcheck disable=SC1091
  . "$NVM_DIR/nvm.sh"
  # Install the .nvmrc version if missing, then switch to it.
  nvm use --silent || nvm install
fi

echo "Node: $(node --version)"
exec node index.js
