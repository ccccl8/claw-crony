#!/usr/bin/env bash
set -euo pipefail

skills="${1:-}"
description="${2:-}"

if [[ -z "$skills" ]]; then
  echo "usage: $0 chat,code_review [description]" >&2
  exit 2
fi

params="$(node -e 'const skills=process.argv[1].split(",").map((s)=>s.trim()).filter(Boolean); const description=process.argv[2] || ""; const payload={skills}; if (description) payload.description=description; process.stdout.write(JSON.stringify(payload));' "$skills" "$description")"
openclaw gateway call a2a.match --params "$params"
