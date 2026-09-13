# AGENTS.md — Drop ZeroTier contributor & AI agent guide

**Drop ZeroTier** (`drop-zerotier`) manages virtual private mesh networks (ZeroTier & ZTNET) for multiplayer game lobbies in the Drop platform.

---

## 1. Architecture

- **`packages/controller/`** (TypeScript): Server-side network provider implementing network provisioning (`/24` CIDR), node authorization, deterministic addressing, and host lease cleanup.
- **`packages/daemon/`** (Rust): Desktop daemon wrapper (`zerotier-cli`) for joining/leaving networks without privilege escalation.
- **`deploy/`**: Turnkey container templates:
  - `docker-compose.ztnet.yml`: ZeroTier One + ZTNET controller + PostgreSQL.
  - `quadlet/`: Systemd Quadlet unit files for Podman.
- **`scripts/`**: `ztnet-bootstrap.mjs` — programmatic admin setup via tRPC.

---

## 2. Invariants

- **Token Security**: Never log or expose `x-ztnet-auth` or `authtoken.secret` in plaintext.
- **Fail-Closed Member Revocation**: Leaving or expiring a multiplayer room immediately revokes the member's network authorization.
- **Pin PostgreSQL**: Use `postgres:15-alpine` (not Alpine 18+ which alters default data volume semantics).

---

## 3. Development Commands

```bash
# Check daemon Rust crate
cd packages/daemon && cargo +nightly check

# Build controller package
cd packages/controller && npm install && npm run build
```
