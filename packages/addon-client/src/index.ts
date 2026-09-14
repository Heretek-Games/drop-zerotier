/**
 * drop-zerotier client addon.
 *
 * Owns the client side of mesh membership: before a game launches it looks up
 * the authenticated user's active networks from its own server plugin, joins
 * each ZeroTier network with `zerotier-cli`, and reports the local node id so
 * the server can authorize it with the ZTNET/ZeroTier controller. On game exit
 * it leaves the networks again (fail-closed revocation happens server-side).
 */

import type { ClientPlugin, ClientPluginContext } from "@droposs/plugin-sdk";
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
}

interface StoredJoin {
  key: string;
  networkId: string;
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
      "client:ws" as const,
      "system:command" as const,
      "ui:slot" as const,
    ],
  };

  init(ctx: ClientPluginContext): void {
    ctx.registerLaunchHook({
      stage: "pre-launch:network",
      order: 10,
      execute: () => this.joinActiveNetworks(ctx),
    });
    ctx.registerLaunchHook({
      stage: "post-exit:cleanup",
      order: 10,
      execute: () => this.leaveActiveNetworks(ctx),
    });

    ctx.registerSlot(
      "game-detail:badges",
      {
        template:
          '<span class="text-xs text-zinc-400">Mesh network available</span>',
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
    attempts = 3,
  ): Promise<NetworkView[]> {
    for (let attempt = 0; attempt < attempts; attempt++) {
      try {
        const res = await ctx.serverRequest<{ networks: NetworkView[] }>(
          "GET",
          "/networks/active",
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
  private async joinActiveNetworks(ctx: ClientPluginContext): Promise<void> {
    const networks = await this.activeNetworks(ctx);
    const joined: StoredJoin[] = [];

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
        joined.push({ key: network.key, networkId: network.mesh.networkId });
        ctx.logger.info(`Joined mesh network ${network.key} as ${id}`);
      } catch (err) {
        ctx.logger.warn(
          `Failed to join mesh network ${network.key}: ${String(err)}`,
        );
      }
    }

    await ctx.storage.set(ACTIVE_NETWORKS_KEY, joined);
  }

  /** Leave everything joined for this session. */
  private async leaveActiveNetworks(ctx: ClientPluginContext): Promise<void> {
    const joined =
      (await ctx.storage.get<StoredJoin[]>(ACTIVE_NETWORKS_KEY)) ?? [];
    for (const entry of joined) {
      try {
        await leaveNetwork(ctx, entry.networkId);
      } catch (err) {
        ctx.logger.warn(
          `Failed to leave mesh network ${entry.key}: ${String(err)}`,
        );
      }
    }
    await ctx.storage.delete(ACTIVE_NETWORKS_KEY).catch(() => {});
  }
}

export const dropZeroTierClientPlugin = new DropZeroTierClientPlugin();

export default dropZeroTierClientPlugin;
