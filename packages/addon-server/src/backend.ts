import {
  InMemoryMeshBackend,
  TailscaleApiProvisioner,
  TailscaleBackend,
  ZeroTierBackend,
  ZtnetBackend,
  type MeshBackend,
} from "@heretek-games/zerotier-mesh";

export type BackendName = "ztnet" | "zerotier" | "tailscale" | "memory";

const KNOWN_BACKENDS = new Set<BackendName>([
  "ztnet",
  "zerotier",
  "tailscale",
  "memory",
]);

/**
 * Select the mesh backend from `MESH_BACKEND` (explicit) or auto-detect from
 * configured credentials. Auto order: ZTNET → raw ZeroTier → Tailscale →
 * in-memory. An explicit value that is unknown or missing its configuration
 * fails closed instead of silently falling through.
 */
export function resolveBackend(
  env: Record<string, string | undefined> = process.env,
): MeshBackend {
  const selected = (env.MESH_BACKEND ?? "").trim().toLowerCase();

  if (selected === "memory") {
    return new InMemoryMeshBackend();
  }
  if (selected && !KNOWN_BACKENDS.has(selected as BackendName)) {
    throw new Error(
      `unknown MESH_BACKEND '${selected}' (expected ztnet, zerotier, tailscale or memory)`,
    );
  }
  const selectedOr = (name: BackendName) =>
    selected === "" || selected === name;

  // ZTNET-managed controller is the default path.
  const ztnetUrl = env.ZTNET_URL;
  const ztnetToken = env.ZTNET_TOKEN;
  const ztnetOrg = env.ZTNET_ORG;
  if (selectedOr("ztnet") && ztnetUrl && ztnetToken && ztnetOrg) {
    return new ZtnetBackend({
      baseUrl: ztnetUrl,
      apiToken: ztnetToken,
      organizationId: ztnetOrg,
    });
  }

  const baseUrl = env.ZEROTIER_URL;
  const authToken = env.ZEROTIER_TOKEN;
  const controllerNodeId = env.ZEROTIER_NODE;
  if (selectedOr("zerotier") && baseUrl && authToken && controllerNodeId) {
    return new ZeroTierBackend({ baseUrl, authToken, controllerNodeId });
  }

  const tailscaleKey = env.TAILSCALE_API_KEY;
  const tailnet = env.TAILSCALE_TAILNET;
  if (selectedOr("tailscale") && tailscaleKey && tailnet) {
    return new TailscaleBackend(
      new TailscaleApiProvisioner({
        apiKey: tailscaleKey,
        tailnet,
        tag: env.TAILSCALE_TAG ?? "tag:dropzerotier",
      }),
    );
  }

  if (selected) {
    throw new Error(
      `MESH_BACKEND='${selected}' is set but its required configuration is missing`,
    );
  }

  return new InMemoryMeshBackend();
}
