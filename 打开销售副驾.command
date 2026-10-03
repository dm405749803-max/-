#!/bin/zsh
set -eu
copilot_root="${0:A:h}"
copilot_node="$HOME/.openclaw/tools/node/bin/node"
if [[ ! -x "$copilot_node" ]]; then
  copilot_node="$(command -v node)"
fi
cd "$copilot_root"
"$copilot_node" scripts/copilot-service.mjs start
open 'http://127.0.0.1:8834/sales-copilot.html?mode=sidebar'
