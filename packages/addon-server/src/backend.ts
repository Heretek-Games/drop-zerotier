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
 * Per-request HTTP timeout for provider calls, from `MESH_HTTP_TIMEOUT_MS`.
 * Left unset the backends use their 10-second default; `0` disables the
 * timeout. Invalid values fail closed.
 */
function readTimeoutMs(
  env: Record<string, string | undefined>,
): number | undefined {
  const raw = env.MESH_HTTP_TIMEOUT_MS?.trim();
  if (!raw) return undefined;
  const value = Number(raw);
  if (!Number.isFinite(value) || value < 0) {
    throw new Error(
      `MESH_HTTP_TIMEOUT_MS must be a non-negative number (got '${raw}')`,
    );
  }
  return value;
}

/**
 * Tailscale auth-key lifetime in seconds, from `TAILSCALE_KEY_EXPIRY_SECONDS`.
 * Left unset the provisioner requests one hour. Invalid values fail closed.
 */
function readKeyExpirySeconds(
  env: Record<string, string | undefined>,
): number | undefined {
  const raw = env.TAILSCALE_KEY_EXPIRY_SECONDS?.trim();
  if (!raw) return undefined;
  const value = Number(raw);
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error(
      `TAILSCALE_KEY_EXPIRY_SECONDS must be a positive number (got '${raw}')`,
    );
  }
  return value;
}

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
  const timeoutMs = readTimeoutMs(env);

  // ZTNET-managed controller is the default path.
  const ztnetUrl = env.ZTNET_URL;
  const ztnetToken = env.ZTNET_TOKEN;
  const ztnetOrg = env.ZTNET_ORG;
  if (selectedOr("ztnet") && ztnetUrl && ztnetToken && ztnetOrg) {
    return new ZtnetBackend({
      baseUrl: ztnetUrl,
      apiToken: ztnetToken,
      organizationId: ztnetOrg,
      timeoutMs,
    });
  }

  const baseUrl = env.ZEROTIER_URL;
  const authToken = env.ZEROTIER_TOKEN;
  const controllerNodeId = env.ZEROTIER_NODE;
  if (selectedOr("zerotier") && baseUrl && authToken && controllerNodeId) {
    return new ZeroTierBackend({
      baseUrl,
      authToken,
      controllerNodeId,
      timeoutMs,
    });
  }

  const tailscaleKey = env.TAILSCALE_API_KEY;
  const tailnet = env.TAILSCALE_TAILNET;
  if (selectedOr("tailscale") && tailscaleKey && tailnet) {
    return new TailscaleBackend(
      new TailscaleApiProvisioner({
        apiKey: tailscaleKey,
        tailnet,
        tag: env.TAILSCALE_TAG ?? "tag:dropzerotier",
        timeoutMs,
        keyExpirySeconds: readKeyExpirySeconds(env),
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
