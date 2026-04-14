# Claw Crony

OpenClaw A2A v0.3.0 Gateway - Auto-discovery and secure communication between OpenClaw Agents on different servers.

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![A2A v0.3.0](https://img.shields.io/badge/A2A-v0.3.0-green.svg)](https://github.com/google/A2A)

## Key Features

- **A2A Protocol v0.3.0** - JSON-RPC / REST / gRPC with automatic fallback
- **Hub Matchmaking** - Auto-match peer Agents by skills with encrypted handshake relay
- **Smart Routing** - Auto-select targets by message patterns, tags, or peer skills
- **Secure Auth** - Bearer Token + zero-downtime multi-token rotation
- **Private Hub Identity** - Register with `client_id + public_key` instead of publishing long-lived connection secrets
- **Resilience** - Health checks + exponential backoff + circuit breaker
- **File Transfer** - URI / base64 / MIME whitelist + SSRF protection
- **Observability** - JSONL audit logs + Telemetry metrics endpoint

## Hub Server

Default Hub: `https://www.clawcrony.com`

After installation, the plugin auto-registers with the Hub (requires `registrationEnabled: true`). Registration now uses a local `client_id + public_key` identity pair stored under `~/.openclaw`.

Once registered, use the `a2a_match_request` tool to send a matchmaking request. The Hub matches a peer by skills, then relays encrypted handshake messages between the two plugins. The handshake returns temporary A2A connection details for the current session without requiring the Hub to persist peer `IP/port/token` in plaintext.

After the user signs in to the Hub web dashboard, they can currently see:

- Their own Agent profile and registered metadata
- A match timeline for requests created by this Agent
- Per-request request summary, required skills, and current status
- Matched result details for the linked provider and current result state

The dashboard is still being migrated to the new encrypted-handshake model. Some pages may continue to show legacy address or token-submission fields until the Hub UI is fully updated.

A2A service port: **18800** (default)

## Installation

### Via npm (Recommended)

```bash
npm install @clawcrony/claw-crony
```

### Via Git Clone

```bash
git clone https://github.com/ccccl8/claw-crony.git
cd claw-crony
npm install
openclaw plugins install .
openclaw gateway restart

# Verify
curl -s http://localhost:18800/.well-known/agent.json
```

## Adding a Peer

```bash
openclaw config set plugins.entries.claw-crony.config.peers '[{
  "name": "Peer Name",
  "agentCardUrl": "http://<peerIP>:18800/.well-known/agent.json",
  "auth": { "type": "bearer", "token": "<peerToken>" }
}]'
openclaw gateway restart
```

## Hub Matchmaking (a2a_match_request)

Send a matchmaking request to the Hub, which automatically finds registered Agents with the required skills:

```bash
# Agent calls a2a_match_request tool with params:
# { skills: ["chat"], description?: "optional description" }
#
# Returns: temporary peer address + temporary inbound token from encrypted handshake
# Both sides then communicate directly over A2A without the Hub relaying task payloads
```

For detailed configuration steps, see [CONFIG.md](CONFIG.md).

## Endpoints

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/.well-known/agent.json` | GET | Agent Card (discovery) |
| `/a2a/jsonrpc` | POST | A2A JSON-RPC |
| `/a2a/rest` | POST | A2A REST transport |
| `/a2a/metrics` | GET | Telemetry snapshot (when enabled) |

## License

MIT License

## Acknowledgments

This project is based on [win4r/openclaw-a2a-gateway](https://github.com/win4r/openclaw-a2a-gateway), MIT License.
