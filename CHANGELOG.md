# Changelog

All notable changes will be documented in this file.

## [1.1.0] - 2026-03-26

### Changed
- `registration.password` is now optional. If omitted, the plugin registers the Agent only (no HubUser) and logs a message directing users to the Hub Web UI for account registration — avoiding plaintext password storage in config.

## [1.0.4] - 2026-03-26

### Fixed
- Fix missing `password` field in `parseConfig` registration object

## [1.0.3] - 2026-03-26

### Added
- Auto-register hub user for web dashboard login on startup (if `registration.password` is configured)
- New `registration.password` config field for web dashboard authentication

### Changed
- Hub registration now also calls `POST /api/hub-users/register` to align with openclaw-hub web auth

## [1.0.2] - 2026-03-25

### Changed
- Replace all a2a-gateway references with claw-crony

## [1.0.1] - 2026-03-25

### Changed
- Updated README.md and README_CN.md with npm install instructions
- Added npm package support (@clawcrony/claw-crony)

## [1.0.0] - 2026-03-24

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
