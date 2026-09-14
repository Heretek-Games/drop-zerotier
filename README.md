# drop-zerotier

Virtual mesh network provider plugin for the [Drop](https://github.com/Heretek-Games/drop) game distribution platform.

Maintained by [Heretek Games](https://github.com/Heretek-Games/drop-zerotier).

## Overview

`drop-zerotier` is a full-stack Drop plugin (server + desktop client) that
provisions isolated virtual private networks for multiplayer lobbies and joins
clients to them. It talks to a **ZTNET controller that you supply** — it does
not bundle or host a controller.

- The **server addon** is configured with your ZTNET endpoint, API token and
  organization id (or a raw ZeroTier controller / Tailscale tailnet), creates
  networks, authorizes members by ZeroTier node id, and revokes access.
- The **client addon** asks the server for the authenticated user's active
  networks, runs `zerotier-cli join <nwid>` through the host's allowlisted
  command API, reports the local node id so the server can authorize it, and
  leaves the network on game exit.

## Components

| Package                                                | Purpose                                                                                                                                                                                                                    |
| :----------------------------------------------------- | :------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `packages/mesh-core/` (`@heretek-games/zerotier-mesh`) | Transport-only `MeshBackend` implementations: `ZtnetBackend`, `ZeroTierBackend`, `TailscaleBackend`, `InMemoryMeshBackend`, plus deterministic address allocation. Consumed in-process by `drop-gse` and the server addon. |
| `packages/addon-server/`                               | Drop server plugin: network lifecycle, membership, REST routes, WebSocket channel and event-bus coordination.                                                                                                              |
| `packages/addon-client/`                               | Drop desktop client addon: `pre-launch:network` / `post-exit:cleanup` hooks that join/leave ZeroTier networks.                                                                                                             |
| `plugin-bundle/`                                       | Assembled `drop-plugin.json` + signed server/client bundles (`.dropplugin`).                                                                                                                                               |
| `deploy/quadlet/`                                      | Base Drop + PostgreSQL Podman Quadlet deployment template (no controller bundled).                                                                                                                                         |

## Bring your own ZTNET

Install ZTNET yourself (see the [ZTNET docs](https://ztnet.network)) and create
an API token plus an organization id in its UI. Then configure the Drop server:

```bash
# Select a backend (auto-detected from credentials when omitted).
MESH_BACKEND=ztnet

# ZTNET organization API token (x-ztnet-auth) and org id.
ZTNET_URL=https://ztnet.example.com
ZTNET_TOKEN=<api-token>
ZTNET_ORG=<organization-id>
```

The Drop server must be able to reach `ZTNET_URL`; ZTNET must be able to reach
its ZeroTier controller. ZTNET rate-limits the REST API (50 requests/minute), so
network provisioning is cached and idempotent per key.

Raw ZeroTier controller (`ZEROTIER_URL`, `ZEROTIER_TOKEN`, `ZEROTIER_NODE`) and
Tailscale (`TAILSCALE_API_KEY`, `TAILSCALE_TAILNET`, `TAILSCALE_TAG`) are also
supported. With no credentials the plugin uses an in-memory backend (dev only).

## Client requirement

The client addon runs `zerotier-cli` on the user's machine via the Drop
desktop's native command capability (`system:command`, allowlisted to
`zerotier-cli`). ZeroTier One must be installed and the user must be able to run
`zerotier-cli` (typically elevated).

## Build, test and package

```bash
npm install
npm run build          # build mesh-core first, then the addons
npm test               # unit tests for all three packages
npm run bundle:build   # assemble + sign plugin-bundle/
npm run validate       # validate drop-plugin.json against the schema
npm run pack           # produce dist-packages/drop-zerotier-<version>.dropplugin
```

## Installation

Install the produced `.dropplugin` through the Drop admin UI
(Settings → Plugins), or copy `plugin-bundle/` into
`<drop-data>/plugins/drop-zerotier/`.
