#!/bin/zsh
cd "${0:A:h}"
if ! command -v node >/dev/null && [[ -s "$HOME/.nvm/nvm.sh" ]]; then
  source "$HOME/.nvm/nvm.sh" --no-use
  nvm use --silent default >/dev/null
fi
if ! command -v node >/dev/null; then
  echo "Node.js is required to open the call dashboard."
  exit 1
fi
node dashboard/open.mjs "$@"
