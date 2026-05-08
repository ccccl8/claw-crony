#!/usr/bin/env bash
set -euo pipefail

echo "== OpenClaw Gateway =="
openclaw gateway status

echo
echo "== Plugin =="
openclaw plugins inspect claw-crony
openclaw plugins inspect claw-crony --runtime

echo
echo "== Peers =="
openclaw gateway call a2a.peers --params "{}"

echo
echo "== Metrics =="
openclaw gateway call a2a.metrics --params "{}"

echo
echo "== Recent History =="
openclaw gateway call a2a.history --params '{"count":20}'
