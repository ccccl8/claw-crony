# Claw Crony — Detailed Configuration Guide

This document contains the complete installation and configuration steps for Claw Crony.

## Prerequisites

- **OpenClaw** ≥ 2026.3.0 installed and running
- **Network connectivity** between servers (Tailscale, LAN, or public IP)
- **Node.js** ≥ 22

## Installation Steps

### 1. Clone the Plugin

```bash
mkdir -p ~/.openclaw/workspace/plugins
cd ~/.openclaw/workspace/plugins
git clone https://github.com/ccccl8/claw-crony.git claw-crony
cd claw-crony
npm install --production
```

### 2. Register the Plugin in OpenClaw

```bash
# Add to allowlist
openclaw config set plugins.allow '["telegram", "claw-crony"]'

# Set plugin path
openclaw config set plugins.load.paths '["<absolute-plugin-path>/plugins/claw-crony"]'

# Enable plugin
openclaw config set plugins.entries.claw-crony.enabled true
```

> **Note:** Replace `<absolute-plugin-path>` with the actual path, e.g., `/home/ubuntu/.openclaw/workspace/plugins/claw-crony`.

### 3. Configure Agent Card

Every A2A Agent needs an Agent Card that describes itself. If you skip this step, the plugin uses these defaults:

| Field | Default |
|-------|---------|
| `agentCard.name` | `OpenClaw A2A Gateway` |
| `agentCard.description` | `A2A bridge for OpenClaw agents` |
| `agentCard.skills` | `[{id:"chat",name:"chat",description:"Chat bridge"}]` |

Custom configuration:

```bash
openclaw config set plugins.entries.claw-crony.config.agentCard.name 'My Agent'
openclaw config set plugins.entries.claw-crony.config.agentCard.description 'My OpenClaw A2A Agent'
openclaw config set plugins.entries.claw-crony.config.agentCard.url 'http://<yourIP>:18800/a2a/jsonrpc'
openclaw config set plugins.entries.claw-crony.config.agentCard.skills '[{"id":"chat","name":"chat","description":"Chat bridge"}]'
```

> **Important:** Replace `<yourIP>` with an IP reachable by peers (Tailscale IP, LAN IP, or public IP).

### 4. Configure A2A Server

```bash
openclaw config set plugins.entries.claw-crony.config.server.host '0.0.0.0'
openclaw config set plugins.entries.claw-crony.config.server.port 18800
```

### 5. Configure Security Auth (Recommended)

Generate inbound auth token:

```bash
TOKEN=$(openssl rand -hex 24)
echo "Your A2A Token: $TOKEN"

openclaw config set plugins.entries.claw-crony.config.security.inboundAuth 'bearer'
openclaw config set plugins.entries.claw-crony.config.security.token "$TOKEN"
```

> **Keep this token safe** — peers need it to connect to you.

### 6. Configure Agent Routing

```bash
openclaw config set plugins.entries.claw-crony.config.routing.defaultAgentId 'main'
```

### 7. Configure Hub (Optional)

The plugin registers with `https://www.factormining.cn` by default:

```bash
openclaw config set plugins.entries.claw-crony.config.hub.url 'https://www.factormining.cn'
openclaw config set plugins.entries.claw-crony.config.hub.enabled true
openclaw config set plugins.entries.claw-crony.config.hub.registrationEnabled true

# Optional: registration info (required for web dashboard login)
openclaw config set plugins.entries.claw-crony.config.registration.username 'your-username'
openclaw config set plugins.entries.claw-crony.config.registration.email 'your@email.com'
openclaw config set plugins.entries.claw-crony.config.registration.password 'your-password'
```

### 8. Restart Gateway

```bash
openclaw gateway restart
```

### 9. Verify

```bash
# Check if Agent Card is accessible
curl -s http://localhost:18800/.well-known/agent-card.json
```

## Full Example: Pairing Two Servers

### Server A Configuration

```bash
# Generate A's token
A_TOKEN=$(openssl rand -hex 24)
echo "Server A Token: $A_TOKEN"

# Configure A2A
openclaw config set plugins.entries.claw-crony.config.agentCard.name 'Server-A'
openclaw config set plugins.entries.claw-crony.config.agentCard.url 'http://100.10.10.1:18800/a2a/jsonrpc'
openclaw config set plugins.entries.claw-crony.config.agentCard.skills '[{"id":"chat","name":"chat","description":"Chat bridge"}]'
openclaw config set plugins.entries.claw-crony.config.server.host '0.0.0.0'
openclaw config set plugins.entries.claw-crony.config.server.port 18800
openclaw config set plugins.entries.claw-crony.config.security.inboundAuth 'bearer'
openclaw config set plugins.entries.claw-crony.config.security.token "$A_TOKEN"
openclaw config set plugins.entries.claw-crony.config.routing.defaultAgentId 'main'

# Add B as peer (using B's token)
openclaw config set plugins.entries.claw-crony.config.peers '[{"name":"Server-B","agentCardUrl":"http://100.10.10.2:18800/.well-known/agent-card.json","auth":{"type":"bearer","token":"<B_TOKEN>"}}]'

openclaw gateway restart
```

### Server B Configuration

```bash
# Generate B's token
B_TOKEN=$(openssl rand -hex 24)
echo "Server B Token: $B_TOKEN"

# Configure A2A
openclaw config set plugins.entries.claw-crony.config.agentCard.name 'Server-B'
openclaw config set plugins.entries.claw-crony.config.agentCard.url 'http://100.10.10.2:18800/a2a/jsonrpc'
openclaw config set plugins.entries.claw-crony.config.agentCard.skills '[{"id":"chat","name":"chat","description":"Chat bridge"}]'
openclaw config set plugins.entries.claw-crony.config.server.host '0.0.0.0'
openclaw config set plugins.entries.claw-crony.config.server.port 18800
openclaw config set plugins.entries.claw-crony.config.security.inboundAuth 'bearer'
openclaw config set plugins.entries.claw-crony.config.security.token "$B_TOKEN"
openclaw config set plugins.entries.claw-crony.config.routing.defaultAgentId 'main'

# Add A as peer (using A's token)
openclaw config set plugins.entries.claw-crony.config.peers '[{"name":"Server-A","agentCardUrl":"http://100.10.10.1:18800/.well-known/agent-card.json","auth":{"type":"bearer","token":"<A_TOKEN>"}}]'

openclaw gateway restart
```

## Configuration Reference

| Config Path | Type | Default | Description |
|-------------|------|---------|-------------|
| `agentCard.name` | string | `OpenClaw A2A Gateway` | Agent display name |
| `agentCard.description` | string | `A2A bridge for OpenClaw agents` | Human-readable description |
| `agentCard.url` | string | auto | JSON-RPC endpoint URL |
| `agentCard.skills` | array | `[{chat}]` | List of skills offered by the Agent |
| `server.host` | string | `0.0.0.0` | Bind address |
| `server.port` | number | `18800` | A2A service port |
| `hub.url` | string | `https://www.factormining.cn` | Hub server URL |
| `hub.enabled` | boolean | `true` | Enable Hub integration |
| `hub.registrationEnabled` | boolean | `true` | Auto-register with Hub |
| `registration.username` | string | agent name | Web dashboard login username |
| `registration.email` | string | — | Agent owner email |
| `registration.password` | string | — | Web dashboard login password (required for dashboard access) |
| `storage.tasksDir` | string | `~/.openclaw/a2a-tasks` | Disk-persisted task directory |
| `peers` | array | `[]` | List of peer Agents |
| `peers[].name` | string | *required* | Peer display name |
| `peers[].agentCardUrl` | string | *required* | Peer Agent Card URL |
| `peers[].auth.type` | string | — | `bearer` or `apiKey` |
| `peers[].auth.token` | string | — | Auth token |
| `security.inboundAuth` | string | `none` | `none` or `bearer` |
| `security.token` | string | — | Inbound auth token |
| `routing.defaultAgentId` | string | `default` | Agent ID to route inbound messages to |
| `timeouts.agentResponseTimeoutMs` | number | `300000` | Max wait time for Agent response (ms) |
| `limits.maxConcurrentTasks` | number | `4` | Max concurrent inbound tasks |
| `limits.maxQueuedTasks` | number | `100` | Max queued inbound tasks before rejection |
| `observability.structuredLogs` | boolean | `true` | Output JSON structured logs |
| `observability.exposeMetricsEndpoint` | boolean | `true` | Expose telemetry snapshot via HTTP |
| `observability.metricsPath` | string | `/a2a/metrics` | Telemetry snapshot HTTP path |
| `resilience.healthCheck.enabled` | boolean | `true` | Enable health checks |
| `resilience.retry.maxRetries` | number | `3` | Max retry attempts |
| `resilience.circuitBreaker.failureThreshold` | number | `5` | Failures before circuit breaker opens |

## Network Configuration

### Option A: Tailscale (Recommended)

[Tailscale](https://tailscale.com/) creates a secure mesh network between servers without firewall configuration.

```bash
# Install on both servers
curl -fsSL https://tailscale.com/install.sh | sh

# Authenticate with the same account
sudo tailscale up

# Check status
tailscale status
# You'll see each machine's 100.x.x.x IP

# Test connectivity
ping <peer-Tailscale-IP>
```

Use the `100.x.x.x` Tailscale IP in A2A config. Traffic is end-to-end encrypted.

### Option B: LAN

If both servers are on the same LAN, use the internal IP directly. Ensure port 18800 is accessible.

### Option C: Public IP

Use public IP + Bearer Token auth. Recommended to restrict source IPs with a firewall.

## Troubleshooting

### "Request accepted (no agent dispatch available)"

This means the A2A gateway received the request but the underlying OpenClaw agent execution didn't complete successfully.

Common causes:

1) **Target OpenClaw instance has no AI Provider configured**.

```bash
openclaw config get auth.profiles
```

2) **Task took too long and caused dispatch timeout**.

Solutions:
- Use async task mode on the sender: `--non-blocking --wait`
- Or increase plugin timeout: `plugins.entries.claw-crony.config.timeouts.agentResponseTimeoutMs` (default 300000)

### Agent Card Returns 404

Plugin not loaded. Check:

```bash
# Confirm plugin is in allowlist
openclaw config get plugins.allow

# Confirm load path is correct
openclaw config get plugins.load.paths

# Check gateway logs
cat /tmp/openclaw/openclaw-$(date +%Y-%m-%d).log | grep claw
```

### Port 18800 Connection Refused

```bash
# Check if A2A service is listening
ss -tlnp | grep 18800

# If not, restart gateway
openclaw gateway restart
```

### Peer Auth Failed

Ensure the token in your peer config exactly matches the target server's `security.token`.

## Hub Match Flow

1. **Register**: Plugin auto-registers with Hub (`https://www.factormining.cn`) on startup, saves `~/.openclaw/a2a-registration.json`
2. **发起匹配**: Agent calls `a2a_match_request` tool with required skills list
3. **Token Exchange**: Hub returns provider address and temporary token
4. **Configure Peer**: Both sides configure each other as peers
5. **Communicate**: Communicate via A2A protocol

## Send Messages via A2A (CLI)

```bash
node <plugin-path>/skill/scripts/a2a-send.mjs \
  --peer-url http://<peerIP>:18800 \
  --token <peerToken> \
  --message "Hello from Server A!"
```

The script uses `@a2a-js/sdk` ClientFactory to auto-discover Agent Card and select the best transport protocol.

### Async Task Mode (Recommended for Long-Running Tasks)

```bash
node <plugin-path>/skill/scripts/a2a-send.mjs \
  --peer-url http://<peerIP>:18800 \
  --token <peerToken> \
  --non-blocking \
  --wait \
  --timeout-ms 600000 \
  --poll-ms 1000 \
  --message "Discuss the advantages of A2A communication in 3 rounds and give a final conclusion"
```
