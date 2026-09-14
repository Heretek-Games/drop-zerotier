/**
 * Shared mesh contract for Drop's ZeroTier/ZTNET/Tailscale network providers.
 *
 * This package is transport-only: it knows how to provision a network, issue
 * a membership credential and authorize/revoke a node. It deliberately has no
 * notion of rooms, games or emulators — those live in consumers (e.g.
 * `drop-gse`), which call into these backends in-process.
 */

/**
 * Public network metadata, safe to broadcast. Never contains credentials.
 * A `""` network id (ZeroTier) or `""` aclTag (Tailscale) is the redacted
 * discovery form.
 */
export type PublicMeshInfo =
  | { backend: "tailscale"; aclTag: string; expiresAt: number }
  | { backend: "zerotier"; cidr: string; networkId: string; expiresAt: number };

/** Value returned by `MeshBackend.issueCredential`. */
export interface IssuedCredential {
  secret: string;
  address?: string;
  /** Backend-imposed credential lifetime (ms epoch), when shorter than the room. */
  expiresAt?: number;
}

/**
 * Pluggable per-network mesh provider. Implementations must be idempotent:
 * provisioning an existing network returns the same public info, and teardown
 * of an unknown network is a no-op.
 */
export interface MeshBackend {
  readonly id: PublicMeshInfo["backend"];
  provision(key: string, expiresAt: number): Promise<PublicMeshInfo>;
  /** Issue (and authorize) a credential for a member; server-side only. */
  issueCredential(
    key: string,
    userId: string,
    mesh: PublicMeshInfo,
  ): Promise<IssuedCredential>;
  /**
   * Revoke a member's access. No-op if already gone. `mesh`/`memberId` are
   * supplied from persisted state so revocation works after a restart.
   */
  revokeMember(
    key: string,
    userId: string,
    mesh?: PublicMeshInfo,
    memberId?: string,
  ): Promise<void>;
  /**
   * Authorize a member's node after it has joined the mesh. Returns the address
   * assigned by the backend, when it can report one. `usedAddresses` lets it
   * avoid reusing an address already handed to another member.
   */
  authorizeMember?(
    key: string,
    userId: string,
    memberId: string,
    mesh?: PublicMeshInfo,
    usedAddresses?: string[],
  ): Promise<string | undefined>;
  /**
   * Remove every node/network for the key. `mesh` is supplied when available so
   * teardown works after a restart.
   */
  teardown(key: string, mesh?: PublicMeshInfo): Promise<void>;
}

/** ZeroTier node ids are exactly 10 lowercase/uppercase hex characters. */
export const MESH_MEMBER_ID_PATTERN = /^[0-9a-f]{10}$/i;

export function isMeshMemberId(value: unknown): value is string {
  return typeof value === "string" && MESH_MEMBER_ID_PATTERN.test(value);
}

function isMeshInfo(value: unknown): value is PublicMeshInfo {
  if (!value || typeof value !== "object") return false;
  const mesh = value as { backend?: unknown };
  return mesh.backend === "zerotier" || mesh.backend === "tailscale";
}

/** Runtime shape check for persisted `PublicMeshInfo`. */
export function isPublicMeshInfo(value: unknown): value is PublicMeshInfo {
  return isMeshInfo(value);
}
