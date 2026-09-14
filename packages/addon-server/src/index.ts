import { createError, readBody } from "h3";
import type {
  PluginContext,
  PluginMetadata,
  ServerPlugin,
} from "@droposs/plugin-sdk";
import type { MeshBackend } from "@heretek-games/zerotier-mesh";
import { isMeshMemberId } from "@heretek-games/zerotier-mesh";
import { resolveBackend } from "./backend.js";
import {
  NETWORK_TTL_MS,
  NetworkStore,
  type MeshNetwork,
} from "./network-store.js";

export type { MeshNetwork, NetworkMember } from "./network-store.js";
export { resolveBackend } from "./backend.js";
export { NetworkStore } from "./network-store.js";

/**
 * Plugin API version. Kept as a local literal so the external bundle does not
 * emit a runtime `@droposs/plugin-sdk` import (the SDK is types-only for
 * plugins and is not resolvable from the server's data directory).
 */
const PLUGIN_API_VERSION = 2;

const PRUNE_INTERVAL_MS = 60_000;

/** Event bus channels used for cross-plugin mesh coordination. */
export const MESH_EVENT_MEMBER_JOIN = "mesh:member-join";
export const MESH_EVENT_MEMBER_LEAVE = "mesh:member-leave";
export const MESH_EVENT_NETWORK_CLOSE = "mesh:network-close";
export const MESH_EVENT_NETWORK = "mesh:network";
export const MESH_EVENT_MEMBER = "mesh:member";

interface MemberJoinPayload {
  key?: unknown;
  userId?: unknown;
}

function readKeyedMembership(payload: unknown): {
  key: string;
  userId: string;
} | null {
  const data = (payload ?? {}) as MemberJoinPayload;
  if (
    typeof data.key !== "string" ||
    data.key.length === 0 ||
    typeof data.userId !== "string" ||
    data.userId.length === 0
  ) {
    return null;
  }
  return { key: data.key, userId: data.userId };
}

/** Member-visible view: peer node ids are revocation handles, so redact them. */
function toNetworkView(network: MeshNetwork) {
  return {
    key: network.key,
    mesh: network.mesh,
    members: network.members.map((member) => ({
      userId: member.userId,
      address: member.address,
      joinedAt: member.joinedAt,
    })),
    createdAt: network.createdAt,
    expiresAt: network.expiresAt,
  };
}

/**
 * Drop ZeroTier mesh provider.
 *
 * Owns the lifecycle of virtual mesh networks against a user-supplied ZTNET
 * controller (or a raw ZeroTier controller / Tailscale tailnet) and exposes
 * membership + join routes to the drop-zerotier client addon. Consumers such as
 * `drop-gse` coordinate membership over the plugin event bus
 * (`mesh:member-join` / `mesh:member-leave`).
 */
export class DropZeroTierServerPlugin implements ServerPlugin {
  metadata: PluginMetadata = {
    id: "drop-zerotier",
    name: "Drop ZeroTier Mesh",
    version: "0.3.0",
    description:
      "Virtual mesh network provider for multiplayer rooms (ZTNET, ZeroTier or Tailscale)",
    author: "Heretek Games",
    builtin: false,
    apiVersion: PLUGIN_API_VERSION,
    trust: "trusted",
    storageVersion: 1,
    category: "multiplayer",
    capabilities: ["routes", "events", "storage", "network", "websocket"],
    enabled: true,
  };

  private store!: NetworkStore;
  private backend!: MeshBackend;
  private pruneTimer: ReturnType<typeof setInterval> | undefined;

  constructor(
    private readonly storeOverride?: NetworkStore,
    private readonly backendOverride?: MeshBackend,
  ) {}

  init(ctx: PluginContext): void {
    this.backend = this.backendOverride ?? resolveBackend();
    this.store =
      this.storeOverride ?? new NetworkStore(ctx.storage, this.backend);

    ctx.logger.info(`drop-zerotier mesh backend: ${this.backend.id}`);

    // Periodic expiry sweep; unref so tests/CLI do not hang on the timer.
    this.pruneTimer = setInterval(() => {
      this.store.pruneExpired().catch(() => {});
    }, PRUNE_INTERVAL_MS);
    this.pruneTimer.unref?.();

    // Cross-plugin membership coordination (e.g. drop-gse room join/leave).
    ctx.subscribe(MESH_EVENT_MEMBER_JOIN, (payload) => {
      const membership = readKeyedMembership(payload);
      if (!membership) return;
      void this.store
        .addMember(membership.key, membership.userId)
        .then((network) => {
          ctx.broadcast(MESH_EVENT_NETWORK, {
            type: "member_joined",
            key: membership.key,
            userId: membership.userId,
            mesh: network.mesh,
          });
        })
        .catch((err) => {
          ctx.logger.warn(`Failed to add mesh member: ${String(err)}`);
        });
    });

    ctx.subscribe(MESH_EVENT_MEMBER_LEAVE, (payload) => {
      const membership = readKeyedMembership(payload);
      if (!membership) return;
      void this.store
        .removeMember(membership.key, membership.userId)
        .then(() => {
          ctx.broadcast(MESH_EVENT_MEMBER, {
            type: "member_left",
            key: membership.key,
            userId: membership.userId,
          });
        })
        .catch((err) => {
          ctx.logger.warn(`Failed to remove mesh member: ${String(err)}`);
        });
    });

    // A consumer (e.g. drop-gse) signals the lobby/network is finished.
    ctx.subscribe(MESH_EVENT_NETWORK_CLOSE, (payload) => {
      const data = (payload ?? {}) as { key?: unknown };
      if (typeof data.key !== "string" || data.key.length === 0) return;
      void this.store
        .teardown(data.key)
        .then(() => {
          ctx.broadcast(MESH_EVENT_NETWORK, {
            type: "network_closed",
            key: data.key,
          });
        })
        .catch((err) => {
          ctx.logger.warn(`Failed to tear down mesh network: ${String(err)}`);
        });
    });

    // WebSocket: authenticated active-network lookup for the client addon.
    ctx.registerWebSocket("zerotier:active", async (message, wsCtx) => {
      if (!wsCtx.userId) {
        wsCtx.send({ ok: false, error: "authentication required" });
        return;
      }
      try {
        const networks = await this.store.activeForUser(wsCtx.userId);
        wsCtx.send({
          ok: true,
          networks: networks.map(toNetworkView),
        });
      } catch (err) {
        ctx.logger.warn(`Failed to list active mesh networks: ${String(err)}`);
        wsCtx.send({ ok: false, error: "failed to list networks" });
      }
    });

    ctx.registerSubscriptionAuthorizer(
      (channel) => channel.startsWith("zerotier:network:"),
      (channel, auth) => {
        if (!auth.userId) return false;
        const key = channel.slice("zerotier:network:".length);
        return auth.userId.length > 0 && key.length > 0;
      },
    );

    // Route: GET /backend
    ctx.registerRoute("GET", "/backend", () => ({
      backend: this.backend.id,
    }));

    // Route: GET /networks
    ctx.registerRoute("GET", "/networks", async () => {
      await this.store.pruneExpired();
      const networks = await this.store.list();
      return { networks: networks.map(toNetworkView) };
    });

    // Route: GET /networks/active — networks for the authenticated user.
    // Registered before `/networks/:key` so the literal path wins.
    ctx.registerRoute("GET", "/networks/active", async (_event, context) => {
      if (!context.userId) {
        throw createError({
          statusCode: 401,
          statusMessage: "Authentication required",
        });
      }
      await this.store.pruneExpired();
      const networks = await this.store.activeForUser(context.userId);
      return { networks: networks.map(toNetworkView) };
    });

    // Route: POST /networks — provision (idempotent by `key`).
    ctx.registerRoute("POST", "/networks", async (event, context) => {
      if (!context.userId) {
        throw createError({
          statusCode: 401,
          statusMessage: "Authentication required",
        });
      }
      const body = await readBody<{ key?: string; ttlMs?: number }>(event);
      if (typeof body?.key !== "string" || body.key.length === 0) {
        throw createError({
          statusCode: 400,
          statusMessage: "key is required",
        });
      }
      if (
        body.ttlMs !== undefined &&
        (!Number.isFinite(body.ttlMs) || body.ttlMs <= 0)
      ) {
        throw createError({
          statusCode: 400,
          statusMessage: "ttlMs must be a positive number",
        });
      }
      try {
        const network = await this.store.ensure(
          body.key,
          body.ttlMs ?? NETWORK_TTL_MS,
        );
        ctx.broadcast(MESH_EVENT_NETWORK, {
          type: "network_created",
          key: network.key,
          mesh: network.mesh,
        });
        return { network: toNetworkView(network) };
      } catch (err) {
        ctx.logger.warn(`Failed to provision mesh network: ${String(err)}`);
        throw createError({
          statusCode: 502,
          statusMessage: "failed to provision mesh network",
        });
      }
    });

    // Route: GET /networks/:key
    ctx.registerRoute("GET", "/networks/:key", async (_event, context) => {
      const network = await this.store.get(context.params.key);
      if (!network) {
        throw createError({
          statusCode: 404,
          statusMessage: "Network not found",
        });
      }
      return { network: toNetworkView(network) };
    });

    // Route: POST /networks/:key/join — self-service membership + join info.
    ctx.registerRoute(
      "POST",
      "/networks/:key/join",
      async (_event, context) => {
        if (!context.userId) {
          throw createError({
            statusCode: 401,
            statusMessage: "Authentication required",
          });
        }
        try {
          const network = await this.store.addMember(
            context.params.key,
            context.userId,
          );
          return {
            network: toNetworkView(network),
            join: {
              backend: network.mesh.backend,
              ...(network.mesh.backend === "zerotier"
                ? {
                    networkId: network.mesh.networkId,
                    cidr: network.mesh.cidr,
                  }
                : { aclTag: network.mesh.aclTag }),
            },
          };
        } catch (err) {
          ctx.logger.warn(`Failed to join mesh network: ${String(err)}`);
          throw createError({
            statusCode: 404,
            statusMessage: "Network not found",
          });
        }
      },
    );

    // Route: POST /networks/:key/member — report a joined node id.
    ctx.registerRoute(
      "POST",
      "/networks/:key/member",
      async (event, context) => {
        if (!context.userId) {
          throw createError({
            statusCode: 401,
            statusMessage: "Authentication required",
          });
        }
        const body = await readBody<{ memberId?: string }>(event);
        if (!isMeshMemberId(body?.memberId)) {
          throw createError({
            statusCode: 400,
            statusMessage:
              "memberId must be a 10-character hex ZeroTier node id",
          });
        }
        try {
          const member = await this.store.authorizeMember(
            context.params.key,
            context.userId,
            body.memberId,
          );
          ctx.broadcast(MESH_EVENT_MEMBER, {
            type: "member_authorized",
            key: context.params.key,
            userId: context.userId,
            address: member.address,
          });
          return { address: member.address };
        } catch (err) {
          const message = String(err);
          ctx.logger.warn(`Failed to authorize mesh member: ${message}`);
          if (message.includes("not a network member")) {
            throw createError({
              statusCode: 403,
              statusMessage: "not a network member",
            });
          }
          if (message.includes("already registered")) {
            throw createError({
              statusCode: 409,
              statusMessage:
                "mesh node is already registered to another member",
            });
          }
          throw createError({
            statusCode: 404,
            statusMessage: "Network not found",
          });
        }
      },
    );

    // Route: DELETE /networks/:key/member — revoke the caller.
    ctx.registerRoute(
      "DELETE",
      "/networks/:key/member",
      async (_event, context) => {
        if (!context.userId) {
          throw createError({
            statusCode: 401,
            statusMessage: "Authentication required",
          });
        }
        await this.store.removeMember(context.params.key, context.userId);
        ctx.broadcast(MESH_EVENT_MEMBER, {
          type: "member_left",
          key: context.params.key,
          userId: context.userId,
        });
        return { success: true };
      },
    );

    // Route: DELETE /networks/:key — tear the whole network down.
    ctx.registerRoute("DELETE", "/networks/:key", async (_event, context) => {
      if (!context.userId) {
        throw createError({
          statusCode: 401,
          statusMessage: "Authentication required",
        });
      }
      await this.store.teardown(context.params.key);
      ctx.broadcast(MESH_EVENT_NETWORK, {
        type: "network_closed",
        key: context.params.key,
      });
      return { success: true };
    });
  }

  teardown(): void {
    if (this.pruneTimer) {
      clearInterval(this.pruneTimer);
      this.pruneTimer = undefined;
    }
  }
}

export const dropZeroTierServerPlugin = new DropZeroTierServerPlugin();

export default dropZeroTierServerPlugin;
