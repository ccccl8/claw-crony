# Claw Crony

OpenClaw A2A v0.3.0 Gateway — 将不同服务器上的 OpenClaw Agent 自动发现、安全通信。

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![A2A v0.3.0](https://img.shields.io/badge/A2A-v0.3.0-green.svg)](https://github.com/google/A2A)

## 核心特性

- **A2A 协议 v0.3.0** — JSON-RPC / REST / gRPC 三种传输方式，自动降级
- **Hub 匹配服务** — 通过技能（skills）自动匹配对端 Agent，支持 Token 交换
- **智能路由** — 按消息模式、标签或 Peer 技能自动选择目标
- **安全认证** — Bearer Token + 多 Token 零停机轮换
- **韧性机制** — 健康检查 + 指数退避 + 熔断器
- **文件传输** — URI / base64 / MIME 白名单 + SSRF 防护
- **可观测性** — JSONL 审计日志 + Telemetry 指标端点

## Hub 服务器

默认 Hub 服务器：`https://www.factormining.cn`

插件安装后将自动向 Hub 注册（需 `registrationEnabled: true`），注册后可使用 `a2a_match_request` 工具发起匹配请求，Hub 会根据技能返回可用的对端 Agent 地址和认证 Token。

A2A 服务端口：**18800**（默认）

## 安装

### 通过 npm（推荐）

```bash
npm install @clawcrony/claw-crony
```

### 通过 Git 克隆

```bash
git clone https://github.com/ccccl8/claw-crony.git
cd claw-crony
npm install
openclaw plugins install .
openclaw gateway restart

# 验证
curl -s http://localhost:18800/.well-known/agent-card.json
```

## 添加 Peer

```bash
openclaw config set plugins.entries.claw-crony.config.peers '[{
  "name": "对等方名称",
  "agentCardUrl": "http://<对等方IP>:18800/.well-known/agent-card.json",
  "auth": { "type": "bearer", "token": "<对等方Token>" }
}]'
openclaw gateway restart
```

## Hub 匹配（a2a_match_request）

向 Hub 发起匹配请求，Hub 会自动找到具有所需技能的已注册 Agent：

```bash
# Agent 调用 a2a_match_request 工具，参数：
# { skills: ["chat"], description?: "可选描述" }
#
# 返回：provider 地址 + yourToken + peerToken
# 两端分别用返回的 Token 配置 peer 后即可通信
```

详细配置步骤见 [CONFIG.md](CONFIG.md)。

## 端点

| 端点 | 方法 | 说明 |
|------|------|------|
| `/.well-known/agent-card.json` | GET | Agent Card（发现） |
| `/a2a/jsonrpc` | POST | A2A JSON-RPC |
| `/a2a/rest` | POST | A2A REST 传输 |
| `/a2a/metrics` | GET | Telemetry 快照（启用时） |

## 许可证

MIT License

## 致谢

本项目基于 [win4r/openclaw-a2a-gateway](https://github.com/win4r/openclaw-a2a-gateway) 开发，遵循 MIT License。
