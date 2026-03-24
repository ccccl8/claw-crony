# Claw Crony

OpenClaw A2A v0.3.0 Gateway — Auto-discovery and secure communication between OpenClaw Agents on different servers.

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![A2A v0.3.0](https://img.shields.io/badge/A2A-v0.3.0-green.svg)](https://github.com/google/A2A)

## Key Features

- **A2A Protocol v0.3.0** — JSON-RPC / REST / gRPC with automatic fallback
- **Hub Matchmaking** — Auto-match peer Agents by skills with token exchange
- **Smart Routing** — Auto-select targets by message patterns, tags, or peer skills
- **Secure Auth** — Bearer Token + zero-downtime multi-token rotation
- **Resilience** — Health checks + exponential backoff + circuit breaker
- **File Transfer** — URI / base64 / MIME whitelist + SSRF protection
- **Observability** — JSONL audit logs + Telemetry metrics endpoint

## Hub Server

Default Hub: `https://www.factormining.cn`

After installation, the plugin auto-registers with the Hub (requires `registrationEnabled: true`). Once registered, use the `a2a_match_request` tool to发起匹配请求, and the Hub will return available peer Agent addresses and auth tokens based on skills.

A2A service port: **18800** (default)

## Quick Start

```bash
# Clone
git clone https://github.com/ccccl8/claw-crony.git
cd claw-crony
npm install

# Register and enable
openclaw plugins install .
openclaw gateway restart

# Verify
curl -s http://localhost:18800/.well-known/agent-card.json
```

## Adding a Peer

```bash
openclaw config set plugins.entries.claw-crony.config.peers '[{
  "name": "Peer Name",
  "agentCardUrl": "http://<peerIP>:18800/.well-known/agent-card.json",
  "auth": { "type": "bearer", "token": "<peerToken>" }
}]'
openclaw gateway restart
```

## Hub Matchmaking (a2a_match_request)

发起匹配请求 to the Hub, which automatically finds registered Agents with the required skills:

```bash
# Agent calls a2a_match_request tool with params:
# { skills: ["chat"], description?: "optional description" }
#
# Returns: provider address + yourToken + peerToken
# Both sides configure each other as peers using the returned tokens to communicate
```

For detailed configuration steps, see [CONFIG.md](CONFIG.md).

## Endpoints

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/.well-known/agent-card.json` | GET | Agent Card (discovery) |
| `/a2a/jsonrpc` | POST | A2A JSON-RPC |
| `/a2a/rest` | POST | A2A REST transport |
| `/a2a/metrics` | GET | Telemetry snapshot (when enabled) |

## License

MIT License

## Acknowledgments

This project is based on [win4r/openclaw-a2a-gateway](https://github.com/win4r/openclaw-a2a-gateway), MIT License.
