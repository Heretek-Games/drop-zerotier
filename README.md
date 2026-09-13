# drop-zerotier

ZeroTier and ZTNET virtual mesh network orchestration for the [Drop](https://github.com/Heretek-Games/drop) game distribution platform.

Maintained by [Heretek Games](https://github.com/Heretek-Games/drop-zerotier).

## Overview

`drop-zerotier` provides zero-configuration, secure peer-to-peer mesh networking between Drop instances and desktop clients. It manages the lifecycle of virtual private networks for multiplayer lobbies, handling node authorization, deterministic IP address allocation, and daemon connection management.

## Components

- **`packages/controller/`** (TypeScript): Server-side network provider implementing `ZtnetBackend` and `ZeroTierBackend`. Interacts with self-hosted ZTNET or ZeroTier controller REST APIs.
- **`packages/daemon/`** (Rust): Desktop client daemon management library wrapping `zerotier-cli` (`join`, `leave`, `status`, `peers`).
- **`deploy/`**: Turnkey container deployment templates:
  - `docker-compose.ztnet.yml`: Compose stack (ZeroTier One + ZTNET web controller + PostgreSQL).
  - `quadlet/`: Systemd Quadlet container definitions for rootless Podman environments.
- **`scripts/`**: Automation tools including `ztnet-bootstrap.mjs` for initial controller provisioning.

## Quick Start (Local Controller)

```bash
# Start the local ZeroTier + ZTNET stack
cd deploy && docker compose -f docker-compose.ztnet.yml up -d

# Bootstrap the initial organization and API token
node scripts/ztnet-bootstrap.mjs
```
