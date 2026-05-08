#!/usr/bin/env bash
set -euo pipefail

count="${1:-50}"
type="${2:-}"
match_id="${3:-}"

params="$(node -e 'const payload={count:Number(process.argv[1] || 50)}; if (process.argv[2]) payload.type=process.argv[2]; if (process.argv[3]) payload.matchId=Number(process.argv[3]); process.stdout.write(JSON.stringify(payload));' "$count" "$type" "$match_id")"
openclaw gateway call a2a.history --params "$params"
