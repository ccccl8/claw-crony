#!/usr/bin/env bash
set -euo pipefail

peer="${1:-}"
text="${2:-}"
agent_id="${3:-}"

if [[ -z "$peer" || -z "$text" ]]; then
  echo "usage: $0 <peer> <text> [agentId]" >&2
  exit 2
fi

params="$(node -e 'const peer=process.argv[1]; const text=process.argv[2]; const agentId=process.argv[3] || ""; const message={text}; if (agentId) message.agentId=agentId; process.stdout.write(JSON.stringify({peer,message}));' "$peer" "$text" "$agent_id")"
openclaw gateway call a2a.send --params "$params"
