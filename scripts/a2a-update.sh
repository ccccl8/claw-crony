#!/usr/bin/env bash
set -euo pipefail

openclaw plugins update claw-crony
openclaw gateway restart
openclaw plugins inspect claw-crony --runtime
