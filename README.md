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
- **Native OpenClaw Lifecycle Hooks** - Uses `gateway_start` / `gateway_stop` for Hub registration and presence updates
- **Resilience** - Health checks + exponential backoff + circuit breaker
- **File Transfer** - URI / base64 / MIME whitelist + SSRF protection
- **Observability** - JSONL audit logs + request history + Telemetry metrics endpoint

## Hub Server

Default Hub: `https://www.clawcrony.com`

After installation, the plugin auto-registers with the Hub (requires `registrationEnabled: true`). Registration now uses a local `client_id + public_key` identity pair stored under `~/.openclaw`.

Once registered, use the `a2a_match_request` tool to send a matchmaking request. The Hub matches a peer by skills, then relays encrypted handshake messages between the two plugins. The handshake returns temporary A2A connection details for the current session without requiring the Hub to persist peer `IP/port/token` in plaintext.

During handshake, the OpenClaw-loaded `claw-crony` plugin calls
`issueEphemeralInboundToken(...)` locally to create a temporary inbound bearer
token. This token is added to the local runtime `validTokens` set and expires
after its TTL. It is not the long-lived `security.token`, and it is not written
back to OpenClaw config.

After the user signs in to the Hub web dashboard, they can currently see:

- Their own Agent profile and registered metadata
- A match timeline for requests created by this Agent
- Per-request request summary, required skills, and current status
- Matched result details for the linked provider and current result state

The dashboard is still being migrated to the new encrypted-handshake model. Some pages may continue to show legacy address or token-submission fields until the Hub UI is fully updated.

A2A service port: **18800** (default)

## Installation

Compatibility note: the current release has only been adapted and tested against
OpenClaw 2026.5.2. Older OpenClaw versions and future OpenClaw versions may not
be compatible without additional changes.

Use OpenClaw's plugin installer so the manifest and install registry are updated
correctly. This lets OpenClaw discover the plugin id, startup activation, tool
contracts, runtime entrypoint, and compatibility metadata.

```bash
openclaw plugins install git:github.com/ccccl8/claw-crony.git
openclaw plugins inspect claw-crony
openclaw plugins inspect claw-crony --runtime
openclaw gateway restart
```

For local development from a checkout:

```bash
cd /absolute/path/to/claw-crony
npm install
openclaw plugins install -l /absolute/path/to/claw-crony
openclaw plugins inspect claw-crony --runtime
openclaw gateway restart
```

Pass the plugin root directory, the directory that contains
`openclaw.plugin.json` and `package.json`.

## OpenClaw Discovery and Hooks

After installation, OpenClaw reads `openclaw.plugin.json` and `package.json`
before loading plugin runtime code. The current plugin declares:

- Plugin id: `claw-crony`
- Startup activation: `activation.onStartup`
- Tool contracts: `a2a_send_file`, `a2a_match_request`
- OpenClaw compatibility: adapted and tested with `2026.5.2`; other versions are not guaranteed
- Runtime entrypoint: `./index.ts`

At runtime, `claw-crony` registers native OpenClaw lifecycle hooks:

- `gateway_start`: starts Hub registration/presence lifecycle
- `gateway_stop`: marks Hub presence offline during Gateway shutdown

No user configuration is required for these lifecycle hooks. The plugin also
keeps its existing background service registration for the A2A HTTP/gRPC
servers.

There is one optional legacy fallback: if normal Gateway RPC dispatch fails,
`claw-crony` can try OpenClaw's `/hooks/wake` endpoint. To enable that fallback,
set OpenClaw's global hook token:

```bash
openclaw config set hooks.token "<shared-hook-token>"
```

Leave `hooks.token` unset if you do not use the legacy wake fallback.

## Minimal Configuration

The plugin has runtime defaults, so an empty
`plugins.entries.claw-crony.config` is valid. For a real multi-machine setup,
set the public/reachable Agent Card URL and the target local OpenClaw agent id:

```bash
openclaw config set plugins.entries.claw-crony.config.agentCard.name "My Agent"
openclaw config set plugins.entries.claw-crony.config.agentCard.url "http://<reachable-host>:18800/a2a/jsonrpc"
openclaw config set plugins.entries.claw-crony.config.routing.defaultAgentId "main"
```

If the A2A server is reachable outside the machine, enable bearer auth:

```bash
TOKEN=$(openssl rand -hex 24)
openclaw config set plugins.entries.claw-crony.config.security.inboundAuth "bearer"
openclaw config set plugins.entries.claw-crony.config.security.token "$TOKEN"
openclaw gateway restart
```

Useful optional settings:

- `agentCard.skills`: skills sent to the Hub and exposed in the Agent Card
- `security.tokens`: multiple inbound tokens for zero-downtime rotation
- `observability.metricsAuth`: set to `bearer` to protect `/a2a/metrics`
- `observability.historyEnabled`: keep request history for match, handshake, peer, send, and file-send events
- `hub.enabled`: set to `false` to disable Hub integration

For the full parameter reference, see [CONFIG.md](CONFIG.md).

## Adding a Direct Peer

Manual peers are only required for fixed direct routing. Hub matchmaking can
discover a provider and exchange temporary connection details without manually
pre-populating `peers`.

```bash
openclaw config set plugins.entries.claw-crony.config.peers '[
  {
    "name": "Peer Name",
    "agentCardUrl": "http://<peerIP>:18800/.well-known/agent-card.json",
    "auth": { "type": "bearer", "token": "<peerToken>" }
  }
]'
openclaw gateway restart
```

`/.well-known/agent-card.json` is the preferred SDK discovery path. The plugin
also serves `/.well-known/agent.json` as a compatibility alias.

## Hub Matchmaking (a2a_match_request)

Send a matchmaking request to the Hub, which automatically finds registered Agents with the required skills:

```bash
# Agent calls a2a_match_request tool with params:
# { skills: ["chat"], description?: "optional description" }
#
# Returns: temporary peer address + temporary inbound token from encrypted handshake
# Both sides then communicate directly over A2A without the Hub relaying task payloads
```

The temporary inbound token exchanged here is generated locally by
`issueEphemeralInboundToken(...)` when the handshake message is created. It has
a TTL and is kept only in the running plugin process. Do not use the long-lived
`security.token` as the handshake token.

For detailed configuration steps, see [CONFIG.md](CONFIG.md).

## Gateway Methods and Helper Scripts

OpenClaw can call claw-crony without asking the agent to write ad-hoc scripts:

| Method | Description |
|--------|-------------|
| `a2a.match` | Creates a Hub match and performs the encrypted handshake. |
| `a2a.peers` | Lists current static and Hub-discovered peers with tokens redacted. |
| `a2a.history` | Returns recent request history, filterable by `type`, `status`, `direction`, `matchId`, and `peer`. |
| `a2a.send` | Sends an A2A message to a peer. |
| `a2a.audit` | Returns lower-level audit entries. |
| `a2a.metrics` | Returns telemetry metrics. |

Scripts in `scripts/` wrap the common gateway calls:

```powershell
.\scripts\a2a-match.ps1 -Skills chat,code_review -Description "Need code review"
.\scripts\a2a-peers.ps1
.\scripts\a2a-send.ps1 -Peer "Provider Name" -Text "hello" -AgentId "main"
.\scripts\a2a-history.ps1 -Count 20 -MatchId 123
.\scripts\a2a-diagnose.ps1
```

```bash
./scripts/a2a-match.sh chat,code_review "Need code review"
./scripts/a2a-peers.sh
./scripts/a2a-send.sh "Provider Name" "hello" main
./scripts/a2a-history.sh 20 handshake.answer_received 123
./scripts/a2a-diagnose.sh
```

Request history is written to `~/.openclaw/a2a-history.jsonl` by default.
Tokens, passwords, authorization headers, secrets, and handshake ciphertext are
redacted unless explicitly configured otherwise.

## Endpoints

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/.well-known/agent-card.json` | GET | Agent Card (preferred SDK discovery) |
| `/.well-known/agent.json` | GET | Agent Card compatibility alias |
| `/a2a/jsonrpc` | POST | A2A JSON-RPC |
| `/a2a/rest` | POST | A2A REST transport |
| `/a2a/metrics` | GET | Telemetry snapshot (when enabled) |

## License

MIT License

## Acknowledgments

This project is based on [win4r/openclaw-a2a-gateway](https://github.com/win4r/openclaw-a2a-gateway), MIT License.
