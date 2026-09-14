# Drop ZeroTier — Claude Developer Guide

> **Canonical guide: read [`AGENTS.md`](./AGENTS.md)** — it is the source of truth for architecture, security invariants, and commands.

## Quick Reference

- **Mesh core**: `packages/mesh-core/` (`@heretek-games/zerotier-mesh`)
- **Server addon**: `packages/addon-server/`
- **Client addon**: `packages/addon-client/`
- **Deployment**: `deploy/quadlet/` (base Drop stack; BYO ZTNET controller)

```bash
npm install && npm run build -w @heretek-games/zerotier-mesh && npm run build
npm test
npm run bundle:build && npm run validate && npm run pack
```
