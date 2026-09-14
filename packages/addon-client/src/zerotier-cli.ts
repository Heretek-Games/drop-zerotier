/**
 * ZeroTier CLI helpers for the client addon.
 *
 * The desktop host runs commands directly (no shell) through
 * `ctx.system.run`, restricted to the manifest's `client.commands` allowlist.
 * Joining/leaving a network requires the ZeroTier One service to be installed
 * and typically elevated; failures are surfaced with actionable messages.
 */

import type { ClientPluginContext } from "@droposs/plugin-sdk";

export const ZEROTIER_CLI = "zerotier-cli";

/** Shown when no ZeroTier CLI can be found on the host. */
export const NOT_INSTALLED =
  "ZeroTier is not installed. Install ZeroTier One and sign in to join multiplayer rooms.";

/**
 * Extract the 10-hex node address from `200 info <address> <version> <status>`.
 */
export function parseNodeId(output: string): string | undefined {
  return output
    .split(/\s+/)
    .find(
      (token) =>
        token.length === 10 && [...token].every((c) => /[0-9a-f]/i.test(c)),
    );
}

function commandError(verb: string, stdout: string, stderr: string): string {
  const message = (stderr || stdout).trim();
  return message.length > 0 ? message : `zerotier-cli ${verb} failed`;
}

/** Read this node's ZeroTier address from `zerotier-cli info`. */
export async function nodeId(ctx: ClientPluginContext): Promise<string> {
  const result = await ctx.system.run(ZEROTIER_CLI, ["info"]);
  if (result.code !== 0) {
    throw new Error(commandError("info", result.stdout, result.stderr));
  }
  const parsed = parseNodeId(result.stdout);
  if (!parsed) {
    throw new Error(
      "could not read the ZeroTier node id from `zerotier-cli info`",
    );
  }
  return parsed;
}

/**
 * Join a network and return this node's ZeroTier address. Re-joining a network
 * the node already belongs to is treated as success.
 */
export async function joinNetwork(
  ctx: ClientPluginContext,
  networkId: string,
): Promise<string> {
  if (networkId.trim().length === 0) {
    throw new Error("missing ZeroTier network id");
  }
  const result = await ctx.system.run(ZEROTIER_CLI, ["join", networkId]);
  if (result.code !== 0) {
    const message = commandError("join", result.stdout, result.stderr);
    if (message.toLowerCase().includes("already")) {
      return await nodeId(ctx);
    }
    throw new Error(message);
  }
  return await nodeId(ctx);
}

/** Leave a network. Leaving an unjoined network is treated as success. */
export async function leaveNetwork(
  ctx: ClientPluginContext,
  networkId: string,
): Promise<void> {
  if (networkId.trim().length === 0) return;
  const result = await ctx.system.run(ZEROTIER_CLI, ["leave", networkId]);
  if (result.code !== 0) {
    const message = commandError("leave", result.stdout, result.stderr);
    if (message.toLowerCase().includes("not a member")) return;
    throw new Error(message);
  }
}
