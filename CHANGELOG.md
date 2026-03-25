# Changelog

All notable changes will be documented in this file.

## [1.0.1] - 2026-03-25

### Changed
- Updated README.md and README_CN.md with npm install instructions
- Added npm package support (@clawcrony/claw-crony)

## [1.0.0] - 2026-03-05

### Added
- Initial release of Claw Crony A2A Gateway
- A2A Protocol v0.3.0 support (JSON-RPC / REST / gRPC)
- Hub matchmaking with token exchange
- Smart routing by message patterns, tags, or peer skills
- Bearer Token authentication with multi-token rotation
- Health checks with exponential backoff and circuit breaker
- File transfer with URI / base64 / MIME whitelist and SSRF protection
- JSONL audit logs and Telemetry metrics endpoint
- Based on [win4r/openclaw-a2a-gateway](https://github.com/win4r/openclaw-a2a-gateway)
