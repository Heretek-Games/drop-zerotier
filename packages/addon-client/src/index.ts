/**
 * drop-zerotier client addon.
 *
 * Owns the client side of mesh membership: before a game launches it looks up
 * the authenticated user's active networks from its own server plugin, joins
 * each ZeroTier network with `zerotier-cli`, and reports the local node id so
 * the server can authorize it with the ZTNET/ZeroTier controller. On game exit
 * it leaves the networks again (fail-closed revocation happens server-side).
 */

import type {
  ClientPlugin,
  ClientPluginContext,
  LaunchContext,
} from "@droposs/plugin-sdk";
import { joinNetwork, leaveNetwork } from "./zerotier-cli.js";

export {
  ZEROTIER_CLI,
  NOT_INSTALLED,
  parseNodeId,
  nodeId,
  joinNetwork,
  leaveNetwork,
} from "./zerotier-cli.js";

/** Client-storage key holding the networks joined for the active session. */
export const ACTIVE_NETWORKS_KEY = "zerotier:activeNetworks";

type MeshInfo =
  | { backend: "zerotier"; cidr: string; networkId: string; expiresAt: number }
  | { backend: "tailscale"; aclTag: string; expiresAt: number };

export interface NetworkView {
  key: string;
  mesh: MeshInfo;
  members: Array<{ userId: string; address?: string; joinedAt: number }>;
  createdAt: number;
  expiresAt: number;
  gameId?: string;
}

interface StoredJoin {
  key: string;
  networkId: string;
  gameId?: string;
}

export class DropZeroTierClientPlugin implements ClientPlugin {
  metadata = {
    id: "drop-zerotier",
    name: "Drop ZeroTier Mesh",
    version: "0.3.0",
    description:
      "Joins multiplayer mesh networks managed by a Drop ZTNET controller",
    author: "Heretek Games",
    apiVersion: 2,
    targets: ["client" as const],
    capabilities: [
      "game:launch-hook" as const,
      "client:storage" as const,
      "system:command" as const,
      "ui:slot" as const,
    ],
  };

  init(ctx: ClientPluginContext): void {
    ctx.registerLaunchHook({
      stage: "pre-launch:network",
      order: 10,
      execute: (launch?: LaunchContext) => this.joinActiveNetworks(ctx, launch),
    });
    ctx.registerLaunchHook({
      stage: "post-exit:cleanup",
      order: 10,
      execute: (launch?: LaunchContext) => this.leaveActiveNetworks(ctx, launch),
    });

    ctx.registerSlot(
      "game-detail:badges",
      {
        render() {
          const g = globalThis as Record<string, any>;
          const vue = g.Vue ?? g.window?.Vue;
          if (typeof vue?.h === "function") {
            return vue.h(
              "span",
              { class: "text-xs text-zinc-400" },
              "Mesh network available",
            );
          }
          return {
            type: "span",
            props: { class: "text-xs text-zinc-400" },
            children: "Mesh network available",
          };
        },
      },
      { label: "ZeroTier", order: 40 },
    );
  }

  /**
   * List the user's active networks, retrying briefly: a just-created lobby may
   * still be provisioning on a consumer's `mesh:member-join` event.
   */
  private async activeNetworks(
    ctx: ClientPluginContext,
    gameId?: string,
    attempts = 3,
  ): Promise<NetworkView[]> {
    const query = gameId ? `?gameId=${encodeURIComponent(gameId)}` : "";
    for (let attempt = 0; attempt < attempts; attempt++) {
      try {
        const res = await ctx.serverRequest<{ networks: NetworkView[] }>(
          "GET",
          `/networks/active${query}`,
        );
        const networks = res?.networks ?? [];
        if (networks.length > 0 || attempt === attempts - 1) return networks;
      } catch (err) {
        if (attempt === attempts - 1) {
          ctx.logger.warn(
            `Failed to list active mesh networks: ${String(err)}`,
          );
          return [];
        }
      }
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
    return [];
  }

  /** Join every active ZeroTier network and report this node's id. */
  private async joinActiveNetworks(
    ctx: ClientPluginContext,
    launch?: LaunchContext,
  ): Promise<void> {
    const gameId = launch?.gameId;
    const networks = await this.activeNetworks(ctx, gameId);
    const previouslyJoined =
      (await ctx.storage.get<StoredJoin[]>(ACTIVE_NETWORKS_KEY)) ?? [];
    const newlyJoined: StoredJoin[] = [];

    for (const network of networks) {
      if (network.mesh.backend !== "zerotier") {
        ctx.logger.info(
          `Skipping ${network.mesh.backend} network ${network.key}: this addon only joins ZeroTier`,
        );
        continue;
      }
      try {
        const id = await joinNetwork(ctx, network.mesh.networkId);
        await ctx.serverRequest(
          "POST",
          `/networks/${encodeURIComponent(network.key)}/member`,
          { memberId: id },
        );
        newlyJoined.push({
          key: network.key,
          networkId: network.mesh.networkId,
          ...(gameId ? { gameId } : {}),
        });
        ctx.logger.info(`Joined mesh network ${network.key} as ${id}`);
      } catch (err) {
        ctx.logger.warn(
          `Failed to join mesh network ${network.key}: ${String(err)}`,
        );
      }
    }

    const merged = [
      ...previouslyJoined.filter(
        (prev) => !newlyJoined.some((curr) => curr.key === prev.key),
      ),
      ...newlyJoined,
    ];
    await ctx.storage.set(ACTIVE_NETWORKS_KEY, merged);
  }

  /** Leave networks joined for this game session. */
  private async leaveActiveNetworks(
    ctx: ClientPluginContext,
    launch?: LaunchContext,
  ): Promise<void> {
    const gameId = launch?.gameId;
    const joined =
      (await ctx.storage.get<StoredJoin[]>(ACTIVE_NETWORKS_KEY)) ?? [];

    const toLeave = gameId
      ? joined.filter((entry) => entry.gameId === gameId || !entry.gameId)
      : joined;
    const toKeep = gameId
      ? joined.filter((entry) => entry.gameId && entry.gameId !== gameId)
      : [];

    for (const entry of toLeave) {
      try {
        await leaveNetwork(ctx, entry.networkId);
      } catch (err) {
        ctx.logger.warn(
          `Failed to leave mesh network ${entry.key}: ${String(err)}`,
        );
      }
    }

    if (toKeep.length > 0) {
      await ctx.storage.set(ACTIVE_NETWORKS_KEY, toKeep);
    } else {
      await ctx.storage.delete(ACTIVE_NETWORKS_KEY).catch(() => {});
    }
  }
}

export const dropZeroTierClientPlugin = new DropZeroTierClientPlugin();

export default dropZeroTierClientPlugin;
