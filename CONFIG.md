# Claw Crony — 详细配置指南

本文档包含 Claw Crony 的完整安装和配置步骤。

## 前提条件

- **OpenClaw** ≥ 2026.3.0 已安装并运行
- 服务器之间有 **网络连通性**（Tailscale、局域网或公网 IP）
- **Node.js** ≥ 22

## 安装步骤

### 1. 克隆插件

```bash
mkdir -p ~/.openclaw/workspace/plugins
cd ~/.openclaw/workspace/plugins
git clone https://github.com/ccccl8/claw-crony.git claw-crony
cd claw-crony
npm install --production
```

### 2. 在 OpenClaw 中注册插件

```bash
# 添加到允许列表
openclaw config set plugins.allow '["telegram", "claw-crony"]'

# 设置插件路径
openclaw config set plugins.load.paths '["<插件绝对路径>/plugins/claw-crony"]'

# 启用插件
openclaw config set plugins.entries.claw-crony.enabled true
```

> **注意：** `<插件绝对路径>` 替换为实际路径，如 `/home/ubuntu/.openclaw/workspace/plugins/claw-crony`。

### 3. 配置 Agent Card

每个 A2A Agent 都需要一个描述自身的 Agent Card。如果跳过此步骤，插件使用以下默认值：

| 字段 | 默认值 |
|------|--------|
| `agentCard.name` | `OpenClaw A2A Gateway` |
| `agentCard.description` | `A2A bridge for OpenClaw agents` |
| `agentCard.skills` | `[{id:"chat",name:"chat",description:"Chat bridge"}]` |

自定义配置：

```bash
openclaw config set plugins.entries.claw-crony.config.agentCard.name '我的Agent'
openclaw config set plugins.entries.claw-crony.config.agentCard.description '我的 OpenClaw A2A Agent'
openclaw config set plugins.entries.claw-crony.config.agentCard.url 'http://<你的IP>:18800/a2a/jsonrpc'
openclaw config set plugins.entries.claw-crony.config.agentCard.skills '[{"id":"chat","name":"chat","description":"聊天桥接"}]'
```

> **重要：** `<你的IP>` 替换为对等方可达的 IP（Tailscale IP、内网 IP 或公网 IP）。

### 4. 配置 A2A 服务器

```bash
openclaw config set plugins.entries.claw-crony.config.server.host '0.0.0.0'
openclaw config set plugins.entries.claw-crony.config.server.port 18800
```

### 5. 配置安全认证（推荐）

生成入站认证 Token：

```bash
TOKEN=$(openssl rand -hex 24)
echo "你的 A2A Token: $TOKEN"

openclaw config set plugins.entries.claw-crony.config.security.inboundAuth 'bearer'
openclaw config set plugins.entries.claw-crony.config.security.token "$TOKEN"
```

> 保存好这个 Token —— 对等方连接你时需要用到。

### 6. 配置 Agent 路由

```bash
openclaw config set plugins.entries.claw-crony.config.routing.defaultAgentId 'main'
```

### 7. 配置 Hub（可选）

插件默认向 `https://www.factormining.cn` 注册：

```bash
openclaw config set plugins.entries.claw-crony.config.hub.url 'https://www.factormining.cn'
openclaw config set plugins.entries.claw-crony.config.hub.enabled true
openclaw config set plugins.entries.claw-crony.config.hub.registrationEnabled true

# 可选：注册信息
openclaw config set plugins.entries.claw-crony.config.registration.username '你的用户名'
openclaw config set plugins.entries.claw-crony.config.registration.email 'your@email.com'
```

### 8. 重启网关

```bash
openclaw gateway restart
```

### 9. 验证

```bash
# 检查 Agent Card 是否可访问
curl -s http://localhost:18800/.well-known/agent-card.json
```

## 完整示例：两台服务器配对

### 服务器 A 配置

```bash
# 生成 A 的 Token
A_TOKEN=$(openssl rand -hex 24)
echo "服务器 A Token: $A_TOKEN"

# 配置 A2A
openclaw config set plugins.entries.claw-crony.config.agentCard.name 'Server-A'
openclaw config set plugins.entries.claw-crony.config.agentCard.url 'http://100.10.10.1:18800/a2a/jsonrpc'
openclaw config set plugins.entries.claw-crony.config.agentCard.skills '[{"id":"chat","name":"chat","description":"聊天桥接"}]'
openclaw config set plugins.entries.claw-crony.config.server.host '0.0.0.0'
openclaw config set plugins.entries.claw-crony.config.server.port 18800
openclaw config set plugins.entries.claw-crony.config.security.inboundAuth 'bearer'
openclaw config set plugins.entries.claw-crony.config.security.token "$A_TOKEN"
openclaw config set plugins.entries.claw-crony.config.routing.defaultAgentId 'main'

# 添加 B 为 Peer（用 B 的 Token）
openclaw config set plugins.entries.claw-crony.config.peers '[{"name":"Server-B","agentCardUrl":"http://100.10.10.2:18800/.well-known/agent-card.json","auth":{"type":"bearer","token":"<B_TOKEN>"}}]'

openclaw gateway restart
```

### 服务器 B 配置

```bash
# 生成 B 的 Token
B_TOKEN=$(openssl rand -hex 24)
echo "服务器 B Token: $B_TOKEN"

# 配置 A2A
openclaw config set plugins.entries.claw-crony.config.agentCard.name 'Server-B'
openclaw config set plugins.entries.claw-crony.config.agentCard.url 'http://100.10.10.2:18800/a2a/jsonrpc'
openclaw config set plugins.entries.claw-crony.config.agentCard.skills '[{"id":"chat","name":"chat","description":"聊天桥接"}]'
openclaw config set plugins.entries.claw-crony.config.server.host '0.0.0.0'
openclaw config set plugins.entries.claw-crony.config.server.port 18800
openclaw config set plugins.entries.claw-crony.config.security.inboundAuth 'bearer'
openclaw config set plugins.entries.claw-crony.config.security.token "$B_TOKEN"
openclaw config set plugins.entries.claw-crony.config.routing.defaultAgentId 'main'

# 添加 A 为 Peer（用 A 的 Token）
openclaw config set plugins.entries.claw-crony.config.peers '[{"name":"Server-A","agentCardUrl":"http://100.10.10.1:18800/.well-known/agent-card.json","auth":{"type":"bearer","token":"<A_TOKEN>"}}]'

openclaw gateway restart
```

## 配置参考

| 配置路径 | 类型 | 默认值 | 说明 |
|---------|------|--------|------|
| `agentCard.name` | string | `OpenClaw A2A Gateway` | Agent 显示名称 |
| `agentCard.description` | string | `A2A bridge for OpenClaw agents` | 人类可读的描述 |
| `agentCard.url` | string | 自动 | JSON-RPC 端点 URL |
| `agentCard.skills` | array | `[{chat}]` | Agent 提供的技能列表 |
| `server.host` | string | `0.0.0.0` | 绑定地址 |
| `server.port` | number | `18800` | A2A 服务端口 |
| `hub.url` | string | `https://www.factormining.cn` | Hub 服务器地址 |
| `hub.enabled` | boolean | `true` | 是否启用 Hub 集成 |
| `hub.registrationEnabled` | boolean | `true` | 是否自动向 Hub 注册 |
| `storage.tasksDir` | string | `~/.openclaw/a2a-tasks` | 磁盘持久化任务目录 |
| `peers` | array | `[]` | 对等 Agent 列表 |
| `peers[].name` | string | *必填* | 对等方显示名称 |
| `peers[].agentCardUrl` | string | *必填* | 对等方 Agent Card URL |
| `peers[].auth.type` | string | — | `bearer` 或 `apiKey` |
| `peers[].auth.token` | string | — | 认证 Token |
| `security.inboundAuth` | string | `none` | `none` 或 `bearer` |
| `security.token` | string | — | 入站认证 Token |
| `routing.defaultAgentId` | string | `default` | 入站消息路由到的 Agent ID |
| `timeouts.agentResponseTimeoutMs` | number | `300000` | Agent 响应最大等待时间（毫秒） |
| `limits.maxConcurrentTasks` | number | `4` | 同时运行的入站任务上限 |
| `limits.maxQueuedTasks` | number | `100` | 超过后直接拒绝的新入站任务数上限 |
| `observability.structuredLogs` | boolean | `true` | 输出 JSON 结构化日志 |
| `observability.exposeMetricsEndpoint` | boolean | `true` | 通过 HTTP 暴露 telemetry 快照 |
| `observability.metricsPath` | string | `/a2a/metrics` | telemetry 快照 HTTP 路径 |
| `resilience.healthCheck.enabled` | boolean | `true` | 启用健康检查 |
| `resilience.retry.maxRetries` | number | `3` | 最大重试次数 |
| `resilience.circuitBreaker.failureThreshold` | number | `5` | 熔断器打开的失败次数 |

## 网络配置

### 方案 A：Tailscale（推荐）

[Tailscale](https://tailscale.com/) 在服务器之间创建安全的 Mesh 网络，无需防火墙配置。

```bash
# 两台服务器都装
curl -fsSL https://tailscale.com/install.sh | sh

# 用同一个账号认证
sudo tailscale up

# 查看状态
tailscale status
# 你会看到每台机器的 100.x.x.x IP

# 测试连通性
ping <对方的Tailscale_IP>
```

在 A2A 配置中使用 `100.x.x.x` 的 Tailscale IP。流量端对端加密。

### 方案 B：局域网

两台服务器在同一局域网内，直接用内网 IP。确保 18800 端口可访问。

### 方案 C：公网 IP

使用公网 IP + Bearer Token 认证。建议用防火墙限制来源 IP。

## 常见问题

### "Request accepted (no agent dispatch available)"

这表示 A2A 网关收到了请求，但底层 OpenClaw agent 的执行没有成功完成。

常见原因：

1) **目标 OpenClaw 实例没有配置 AI Provider**。

```bash
openclaw config get auth.profiles
```

2) **任务耗时过长导致调度超时**。

解决：
- 发送端使用异步 task 模式：`--non-blocking --wait`
- 或提高插件超时：`plugins.entries.claw-crony.config.timeouts.agentResponseTimeoutMs`（默认 300000）

### Agent Card 返回 404

插件没加载。检查：

```bash
# 确认插件在允许列表中
openclaw config get plugins.allow

# 确认加载路径正确
openclaw config get plugins.load.paths

# 查看网关日志
cat /tmp/openclaw/openclaw-$(date +%Y-%m-%d).log | grep claw
```

### 18800 端口连接被拒

```bash
# 检查 A2A 服务是否在监听
ss -tlnp | grep 18800

# 如果没有，重启网关
openclaw gateway restart
```

### 对等方认证失败

确保你的 peer 配置中的 token 和目标服务器的 `security.token` 完全一致。

## Hub 匹配流程

1. **注册**：插件启动时自动向 Hub (`https://www.factormining.cn`) 注册，保存 `~/.openclaw/a2a-registration.json`
2. **发起匹配**：Agent 调用 `a2a_match_request` 工具，传入所需技能列表
3. **Token 交换**：Hub 返回 provider 的地址和临时 Token
4. **配置 Peer**：两端分别将对方配置为 peer
5. **通信**：通过 A2A 协议进行通信

## 通过 A2A 发送消息（命令行）

```bash
node <插件路径>/skill/scripts/a2a-send.mjs \
  --peer-url http://<对等方IP>:18800 \
  --token <对等方Token> \
  --message "你好，来自服务器A！"
```

脚本使用 `@a2a-js/sdk` ClientFactory 自动发现 Agent Card 并选择最佳传输协议。

### 异步 task 模式（推荐用于耗时长的任务）

```bash
node <插件路径>/skill/scripts/a2a-send.mjs \
  --peer-url http://<对等方IP>:18800 \
  --token <对等方Token> \
  --non-blocking \
  --wait \
  --timeout-ms 600000 \
  --poll-ms 1000 \
  --message "用 3 轮讨论 A2A 通信的优势并给出最终结论"
```
