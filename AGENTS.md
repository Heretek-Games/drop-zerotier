# AGENTS.md — Drop ZeroTier contributor & AI agent guide

**Drop ZeroTier** (`drop-zerotier`) is the canonical virtual mesh network
provider for the Drop platform. It manages ZTNET / ZeroTier / Tailscale network
lifecycles for multiplayer lobbies and joins desktop clients to them.

---

## 1. Architecture

- **`packages/mesh-core/`** (`@drop/zerotier-mesh`, TypeScript): transport-only
  `MeshBackend` implementations (`ZtnetBackend`, `ZeroTierBackend`,
  `TailscaleBackend`, `InMemoryMeshBackend`) plus deterministic `/24` address
  allocation. **Consumed in-process** by `drop-gse` and the server addon — this
  is the single source of truth for mesh backends.
- **`packages/addon-server/`** (TypeScript, `@droposs/plugin-sdk`
  `ServerPlugin`): Drop server plugin. Owns network provisioning, membership,
  the `/networks*` REST routes, the `zerotier:active` WebSocket channel, and the
  `mesh:member-join` / `mesh:member-leave` event-bus coordination used by
  consumers such as `drop-gse`.
- **`packages/addon-client/`** (TypeScript, `ClientPlugin`): Drop desktop client
  addon. Runs `pre-launch:network` / `post-exit:cleanup` hooks that call
  `zerotier-cli` through `ctx.system.run` (host-allowlisted, no shell).
- **`plugin-bundle/`**: assembled + signed plugin manifest and bundles.
- **`deploy/quadlet/`**: base Drop + PostgreSQL Podman Quadlet template. It does
  **not** bundle a controller; ZTNET is bring-your-own.

### Cross-repo contract

- `drop-gse` depends on `@drop/zerotier-mesh` (not a duplicate copy) for mesh
  backends. The mesh is owned here; `drop-gse` keeps only rooms/emulator logic.
- Backend selection and membership changes are transport details behind
  `MeshBackend`; do not leak them into consumers.

---

## 2. Invariants

- **Token security**: never log or expose `x-ztnet-auth`, `authtoken.secret`, or
  the configured API token.
- **Fail-closed revocation**: leaving or expiring a lobby immediately revokes
  the member's network authorization.
- **Idempotency**: provisioning by key is idempotent; teardown of an unknown
  network is a no-op.
- **No bundled controller**: `deploy/` must not bring up ZTNET/ZeroTier/Postgres
  for the mesh. Users supply their own ZTNET and configure `ZTNET_URL/TOKEN/ORG`
  (or raw ZeroTier / Tailscale).
- **Native exec is allowlisted**: client native commands run only via
  `ctx.system.run`, enforced against `manifest.client.commands` by the Drop
  desktop host (no shell).
- **Deterministic addressing**: address allocation must skip already-used
  addresses so two members never collide.
- **Pin PostgreSQL**: use `postgres:15-alpine` in deployment templates.

---

## 3. Development Commands

```bash
npm install

# Build mesh-core first (addons import its emitted types)
npm run build -w @drop/zerotier-mesh
npm run build

# Unit tests (mesh-core, addon-server, addon-client)
npm test

# Assemble, validate, sign and package the plugin bundle
npm run bundle:build
npm run validate
npm run pack
```

The addons depend on the published `@droposs/plugin-sdk@^0.3.0`, which adds the
`system:command` capability used by the client addon.
