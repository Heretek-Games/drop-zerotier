import type { IssuedCredential, MeshBackend, PublicMeshInfo } from "./types.js";

function hashString(value: string): number {
  let hash = 0;
  for (const char of value) {
    hash = (hash * 31 + char.codePointAt(0)!) >>> 0;
  }
  return hash;
}

/** Base CIDR for per-network ZeroTier meshes (10.242.0.0/16, one /24 each). */
export const ZEROTIER_BASE_CIDR = "10.242.0.0/16"; // NOSONAR: RFC1918 private range for the built-in mesh pool

/** Deterministically derive a unique /24 network CIDR from the network key. */
export function networkCidr(key: string): string {
  const thirdOctet = hashString(key) % 256;
  return `10.242.${thirdOctet}.0/24`;
}

/** Deterministic host address inside a network /24 (offset 20–219). */
export function networkMemberAddress(
  cidr: string,
  userId: string,
): string | undefined {
  if (!cidr.endsWith("/24")) return undefined;
  const base = cidr.replace(/\.0\/24$/, "");
  const host = 20 + (hashString(userId) % 200);
  return `${base}.${host}`;
}

/**
 * First free address in a network /24, starting at the deterministic hash slot
 * and probing upward. `used` are addresses already assigned in the network, so
 * two members cannot collide even when their hashes do.
 */
export function allocateMemberAddress(
  cidr: string,
  userId: string,
  used: Iterable<string> = [],
): string | undefined {
  if (!cidr.endsWith("/24")) return undefined;
  const base = cidr.replace(/\.0\/24$/, "");
  const start = 20 + (hashString(userId) % 200);
  const taken = new Set(used);
  for (let offset = 0; offset < 200; offset++) {
    const host = 20 + ((start - 20 + offset) % 200);
    const candidate = `${base}.${host}`;
    if (!taken.has(candidate)) return candidate;
  }
  return undefined;
}

/**
 * In-memory mesh backend used for tests and local development. Produces
 * deterministic public info and opaque per-member credentials.
 */
export class InMemoryMeshBackend implements MeshBackend {
  readonly id = "zerotier" as const;
  private readonly members = new Map<string, Set<string>>();

  async provision(key: string, expiresAt: number): Promise<PublicMeshInfo> {
    return {
      backend: "zerotier",
      cidr: networkCidr(key),
      networkId: `zt-${key.slice(0, 16)}`,
      expiresAt,
    };
  }

  async issueCredential(
    key: string,
    userId: string,
    mesh: PublicMeshInfo,
  ): Promise<IssuedCredential> {
    const set = this.members.get(key) ?? new Set<string>();
    set.add(userId);
    this.members.set(key, set);
    return {
      secret: `zt-member:${key}:${userId}:${mesh.backend}`,
      address:
        mesh.backend === "zerotier"
          ? networkMemberAddress(mesh.cidr, userId)
          : undefined,
    };
  }

  async revokeMember(key: string, userId: string): Promise<void> {
    this.members.get(key)?.delete(userId);
  }

  async authorizeMember(
    key: string,
    _userId: string,
    memberId: string,
    mesh?: PublicMeshInfo,
    usedAddresses: string[] = [],
  ): Promise<string | undefined> {
    const cidr = mesh?.backend === "zerotier" ? mesh.cidr : networkCidr(key);
    return allocateMemberAddress(cidr, memberId, usedAddresses);
  }

  async teardown(key: string, _mesh?: PublicMeshInfo): Promise<void> {
    this.members.delete(key);
  }

  memberCount(key: string): number {
    return this.members.get(key)?.size ?? 0;
  }
}

/** Minimal fetch surface so the controller client is testable. */
export type FetchLike = (
  input: string,
  init?: {
    method?: string;
    headers?: Record<string, string>;
    body?: string;
  },
) => Promise<{
  ok: boolean;
  status: number;
  json: () => Promise<unknown>;
  text: () => Promise<string>;
}>;

export interface ZeroTierControllerOptions {
  /** Controller service API base, e.g. http://localhost:9993. */
  baseUrl: string;
  /** Contents of authtoken.secret. */
  authToken: string;
  /** Controller node id (see ZeroTier API `POST /controller/network`). */
  controllerNodeId: string;
  fetchImpl?: FetchLike;
}

/**
 * ZeroTier self-hosted controller backend.
 *
 * Network id format: `<controllerNodeId>` + six underscores, after which the
 * controller generates the network id.
 */
export class ZeroTierBackend implements MeshBackend {
  readonly id = "zerotier" as const;
  private readonly fetchImpl: FetchLike;
  private readonly networks = new Map<string, string>();
  /** key → (userId → member node id), for revocation. */
  private readonly memberIds = new Map<string, Map<string, string>>();

  constructor(private readonly options: ZeroTierControllerOptions) {
    this.fetchImpl = options.fetchImpl ?? (fetch as unknown as FetchLike);
  }

  private headers(): Record<string, string> {
    return {
      "X-ZT1-AUTH": this.options.authToken,
      "Content-Type": "application/json",
    };
  }

  async provision(key: string, expiresAt: number): Promise<PublicMeshInfo> {
    const url = `${this.options.baseUrl}/controller/network/${encodeURIComponent(this.options.controllerNodeId)}______`;
    const cidr = networkCidr(key);
    const response = await this.fetchImpl(url, {
      method: "POST",
      headers: this.headers(),
      body: JSON.stringify({
        name: `drop-zerotier-${key}`,
        private: true,
        enableBroadcast: true,
        v4AssignMode: { zt: true },
        ipAssignmentPools: [
          {
            ipRangeStart: cidr.replace(/\.0\/24$/, ".1"),
            ipRangeEnd: cidr.replace(/\.0\/24$/, ".254"),
          },
        ],
        routes: [{ target: cidr, via: null }],
      }),
    });
    if (!response.ok) {
      throw new Error(
        `ZeroTier network creation failed (${response.status}): ${await response.text()}`,
      );
    }
    const created = (await response.json()) as { id?: string };
    if (!created?.id) {
      throw new Error("ZeroTier network creation returned no network id");
    }
    this.networks.set(key, created.id);
    return {
      backend: "zerotier",
      cidr,
      networkId: created.id,
      expiresAt,
    };
  }

  async issueCredential(
    key: string,
    userId: string,
    mesh: PublicMeshInfo,
  ): Promise<IssuedCredential> {
    if (mesh.backend !== "zerotier") {
      throw new Error("ZeroTierBackend received non-zerotier mesh info");
    }
    // A member joins the network and requests authorization; the assigned
    // address is reported by the controller once the member is authorized.
    return { secret: `zerotier:${mesh.networkId}:${key}:${userId}` };
  }

  private networkIdFor(key: string, mesh?: PublicMeshInfo): string | undefined {
    const persisted = mesh?.backend === "zerotier" ? mesh.networkId : undefined;
    const networkId = this.networks.get(key) ?? persisted;
    if (networkId) this.networks.set(key, networkId);
    return networkId;
  }

  async authorizeMember(
    key: string,
    userId: string,
    memberId: string,
    mesh?: PublicMeshInfo,
  ): Promise<string | undefined> {
    const networkId = this.networkIdFor(key, mesh);
    if (!networkId) return undefined;
    const response = await this.fetchImpl(
      `${this.options.baseUrl}/network/${encodeURIComponent(networkId)}/member/${encodeURIComponent(memberId)}`,
      {
        method: "POST",
        headers: this.headers(),
        body: JSON.stringify({ authorized: true }),
      },
    );
    if (!response.ok) {
      throw new Error(
        `ZeroTier member authorization failed (${response.status})`,
      );
    }
    const roomMembers = this.memberIds.get(key) ?? new Map<string, string>();
    roomMembers.set(userId, memberId);
    this.memberIds.set(key, roomMembers);

    const member = (await response.json()) as {
      assignedAddresses?: string[];
    };
    const address = member.assignedAddresses?.[0];
    // Controller reports addresses as CIDR (e.g. 10.242.5.20/24).
    return address ? address.split("/")[0] : undefined;
  }

  async revokeMember(
    key: string,
    userId: string,
    mesh?: PublicMeshInfo,
    memberId?: string,
  ): Promise<void> {
    const networkId = this.networkIdFor(key, mesh);
    const nodeId = memberId ?? this.memberIds.get(key)?.get(userId);
    if (!networkId || !nodeId) return;
    this.memberIds.get(key)?.delete(userId);
    const response = await this.fetchImpl(
      `${this.options.baseUrl}/network/${encodeURIComponent(networkId)}/member/${encodeURIComponent(nodeId)}`,
      {
        method: "POST",
        headers: this.headers(),
        body: JSON.stringify({ authorized: false }),
      },
    );
    // A 404 means the node is already gone: revocation is idempotent.
    if (!response.ok && response.status !== 404) {
      throw new Error(`ZeroTier member revocation failed (${response.status})`);
    }
  }

  async teardown(key: string, mesh?: PublicMeshInfo): Promise<void> {
    const networkId = this.networkIdFor(key, mesh);
    this.memberIds.delete(key);
    if (!networkId) return;
    this.networks.delete(key);
    const response = await this.fetchImpl(
      `${this.options.baseUrl}/controller/network/${encodeURIComponent(networkId)}`,
      { method: "DELETE", headers: this.headers() },
    );
    // Already-deleted networks are a successful teardown (idempotent).
    if (!response.ok && response.status !== 404) {
      throw new Error(`ZeroTier network deletion failed (${response.status})`);
    }
  }
}

/**
 * Tailscale control-plane operations, injected so the backend is testable
 * without a tailnet. A real implementation provisions a network tag + same-room
 * ACL before issuing any key, and removes tagged nodes on teardown.
 */
export interface TailscaleProvisioner {
  provisionRoom(key: string): Promise<string>;
  issueAuthKey(aclTag: string, userId: string, key: string): Promise<string>;
  teardownRoom(key: string): Promise<void>;
}

/** Lifetime requested for Tailscale auth keys (matches the API request below). */
export const TAILSCALE_KEY_LIFETIME_MS = 60 * 60 * 1000;

/**
 * Tailscale ephemeral backend. Keys are one-off and tagged per network; the
 * client joins with isolated ephemeral state so a user's own tailnet identity
 * is never replaced.
 */
export class TailscaleBackend implements MeshBackend {
  readonly id = "tailscale" as const;

  constructor(private readonly provisioner: TailscaleProvisioner) {}

  async provision(key: string, expiresAt: number): Promise<PublicMeshInfo> {
    const aclTag = await this.provisioner.provisionRoom(key);
    return { backend: "tailscale", aclTag, expiresAt };
  }

  async issueCredential(
    key: string,
    userId: string,
    mesh: PublicMeshInfo,
  ): Promise<IssuedCredential> {
    if (mesh.backend !== "tailscale") {
      throw new Error("TailscaleBackend received non-tailscale mesh info");
    }
    return {
      secret: await this.provisioner.issueAuthKey(mesh.aclTag, userId, key),
      expiresAt: Date.now() + TAILSCALE_KEY_LIFETIME_MS,
    };
  }

  async revokeMember(): Promise<void> {
    // Ephemeral nodes purge themselves; tagged-node removal happens on teardown.
  }

  async teardown(key: string, _mesh?: PublicMeshInfo): Promise<void> {
    await this.provisioner.teardownRoom(key);
  }
}

export interface TailscaleApiOptions {
  /** API base URL (default https://api.tailscale.com/api/v2). */
  baseUrl?: string;
  /** Tailscale API access token. */
  apiKey: string;
  /** Tailnet name, e.g. `example.com`. */
  tailnet: string;
  /**
   * Pre-declared tag applied to network devices. Tailscale tags are declared in
   * the tailnet policy file; the plugin does not mutate policy, so one tag is
   * reused (BYO-tailnet mode, weaker per-network isolation than ZeroTier).
   */
  tag: string;
  fetchImpl?: FetchLike;
}

/**
 * Tailscale API provisioner. Issues one-off, ephemeral, pre-authorized keys
 * tagged for the network and revokes them on teardown.
 */
export class TailscaleApiProvisioner implements TailscaleProvisioner {
  private readonly fetchImpl: FetchLike;
  private readonly baseUrl: string;
  /** key → (userId → issued key id), so a re-issued key can revoke its predecessor. */
  private readonly keyIds = new Map<string, Map<string, string>>();

  constructor(private readonly options: TailscaleApiOptions) {
    this.fetchImpl = options.fetchImpl ?? (fetch as unknown as FetchLike);
    this.baseUrl = options.baseUrl ?? "https://api.tailscale.com/api/v2";
  }

  private headers(): Record<string, string> {
    return {
      Authorization: `Bearer ${this.options.apiKey}`,
      "Content-Type": "application/json",
    };
  }

  async provisionRoom(_key: string): Promise<string> {
    // Tags are policy-declared; reuse the configured tag for the network.
    return this.options.tag;
  }

  async issueAuthKey(
    aclTag: string,
    userId: string,
    key: string,
  ): Promise<string> {
    const networkKeys = this.keyIds.get(key) ?? new Map<string, string>();
    this.keyIds.set(key, networkKeys);

    // Revoke the member's previous key before minting a new one, so rotation
    // does not leave a trail of live keys.
    const previous = networkKeys.get(userId);
    if (previous) {
      await this.deleteKey(previous, true);
      networkKeys.delete(userId);
    }

    const url = `${this.baseUrl}/tailnet/${this.options.tailnet}/keys`;
    const response = await this.fetchImpl(url, {
      method: "POST",
      headers: this.headers(),
      body: JSON.stringify({
        capabilities: {
          devices: {
            create: {
              reusable: false,
              ephemeral: true,
              preauthorized: true,
              tags: [aclTag],
            },
          },
        },
        expirySeconds: 3600,
        description: `drop-zerotier ${userId}`,
      }),
    });
    if (!response.ok) {
      throw new Error(
        `Tailscale key creation failed (${response.status}): ${await response.text()}`,
      );
    }
    const data = (await response.json()) as { id?: string; key?: string };
    if (!data.key) {
      throw new Error("Tailscale key creation returned no key");
    }
    if (data.id) networkKeys.set(userId, data.id);
    return data.key;
  }

  /** Delete a key; a 404 is treated as success when `tolerateNotFound`. */
  private async deleteKey(id: string, tolerateNotFound = false): Promise<void> {
    const response = await this.fetchImpl(
      `${this.baseUrl}/tailnet/${this.options.tailnet}/keys/${id}`,
      { method: "DELETE", headers: this.headers() },
    );
    if (!response.ok && !(tolerateNotFound && response.status === 404)) {
      throw new Error(`Tailscale key deletion failed (${response.status})`);
    }
  }

  async teardownRoom(key: string): Promise<void> {
    const networkKeys = this.keyIds.get(key);
    this.keyIds.delete(key);
    if (!networkKeys) return;
    for (const id of networkKeys.values()) {
      await this.deleteKey(id);
    }
  }
}
