import { allocateMemberAddress, type FetchLike, networkCidr } from "./mesh.js";
import type { IssuedCredential, MeshBackend, PublicMeshInfo } from "./types.js";

export interface ZtnetBackendOptions {
  /** ZTNET base URL, e.g. `https://ztnet.example.com`. */
  baseUrl: string;
  /** Organization API token (`x-ztnet-auth`). */
  apiToken: string;
  /** ZTNET organization id that owns the networks. */
  organizationId: string;
  fetchImpl?: FetchLike;
}

/** Strips trailing slashes without a backtracking-prone regular expression. */
function trimTrailingSlashes(value: string): string {
  let end = value.length;
  while (end > 0 && value[end - 1] === "/") {
    end--;
  }
  return value.slice(0, end);
}

interface ZtnetNetworkResponse {
  nwid?: string;
  id?: string;
}

interface ZtnetMemberResponse {
  ipAssignments?: string[];
}

/**
 * ZTNET-managed ZeroTier controller backend.
 *
 * ZTNET sits in front of a self-hosted `zerotier-one` controller. Networks are
 * created via the org API and configured in a second call (the create endpoint
 * only accepts a name); members are authorized by node id. All requests use the
 * `x-ztnet-auth` organization token.
 *
 * Note: ZTNET's network update schema does not expose `enableBroadcast`; LAN
 * discovery is delivered through the consumer's unicast `custom_broadcasts.txt`.
 */
export class ZtnetBackend implements MeshBackend {
  readonly id = "zerotier" as const;
  private readonly fetchImpl: FetchLike;
  private readonly baseUrl: string;
  private readonly baseOrigin: string;
  private readonly networks = new Map<string, string>();
  /** key → (userId → member node id), for revocation. */
  private readonly memberIds = new Map<string, Map<string, string>>();

  constructor(private readonly options: ZtnetBackendOptions) {
    this.fetchImpl = options.fetchImpl ?? (fetch as unknown as FetchLike);
    this.baseUrl = trimTrailingSlashes(options.baseUrl);
    this.baseOrigin = new URL(this.baseUrl).origin;
  }

  private headers(): Record<string, string> {
    return {
      "x-ztnet-auth": this.options.apiToken,
      "Content-Type": "application/json",
    };
  }

  private orgUrl(suffix = ""): string {
    return `${this.baseUrl}/api/v1/org/${this.options.organizationId}/network${suffix}`;
  }

  private async send(
    url: string,
    init?: {
      method?: string;
      body?: string;
    },
  ): Promise<Awaited<ReturnType<FetchLike>>> {
    // Re-parse every request against the configured base origin so a caller
    // cannot turn network/member ids into a request to another host.
    const target = new URL(url);
    if (target.origin !== this.baseOrigin) {
      throw new Error("ZTNET request URL escaped the configured base URL");
    }
    const response = await this.fetchImpl(target.toString(), {
      method: init?.method ?? "GET",
      headers: this.headers(),
      body: init?.body,
    });
    if (!response.ok) {
      // Already-deleted networks/members are a successful teardown/revoke.
      if (init?.method === "DELETE" && response.status === 404) {
        return response;
      }
      throw new Error(
        `ZTNET request failed (${response.status}) ${url}: ${await response.text()}`,
      );
    }
    return response;
  }

  /** Send a request and discard any body (used for DELETE). */
  private async request(
    url: string,
    init?: {
      method?: string;
      body?: string;
    },
  ): Promise<void> {
    await this.send(url, init);
  }

  private async json<T>(
    url: string,
    init?: {
      method?: string;
      body?: string;
    },
  ): Promise<T> {
    const response = await this.send(url, init);
    return (await response.json()) as T;
  }

  /**
   * Resolve a network id from live state or persisted mesh info, caching it so
   * a restarted coordinator can still authorize/revoke/tear down.
   */
  private networkIdFor(key: string, mesh?: PublicMeshInfo): string | undefined {
    const persisted = mesh?.backend === "zerotier" ? mesh.networkId : undefined;
    const networkId = this.networks.get(key) ?? persisted;
    if (networkId) this.networks.set(key, networkId);
    return networkId;
  }

  async provision(key: string, expiresAt: number): Promise<PublicMeshInfo> {
    const created = await this.json<ZtnetNetworkResponse>(this.orgUrl(), {
      method: "POST",
      body: JSON.stringify({ name: `drop-zerotier-${key}` }),
    });
    const networkId = created.nwid ?? created.id;
    if (!networkId) {
      throw new Error("ZTNET network creation returned no network id");
    }

    const cidr = networkCidr(key);
    await this.json<ZtnetNetworkResponse>(
      this.orgUrl(`/${encodeURIComponent(networkId)}`),
      {
        method: "POST",
        body: JSON.stringify({
          name: `drop-zerotier-${key}`,
          private: true,
          v4AssignMode: { zt: true },
          ipAssignmentPools: [
            {
              ipRangeStart: cidr.replace(/\.0\/24$/, ".1"),
              ipRangeEnd: cidr.replace(/\.0\/24$/, ".254"),
            },
          ],
          routes: [{ target: cidr, via: null }],
        }),
      },
    );

    this.networks.set(key, networkId);
    return {
      backend: "zerotier",
      cidr,
      networkId,
      expiresAt,
    };
  }

  async issueCredential(
    key: string,
    userId: string,
    mesh: PublicMeshInfo,
  ): Promise<IssuedCredential> {
    if (mesh.backend !== "zerotier") {
      throw new Error("ZtnetBackend received non-zerotier mesh info");
    }
    // The client joins the network with the nwid; ZTNET authorizes the node
    // once it reports its member id (see `authorizeMember`).
    return { secret: `zerotier:${mesh.networkId}:${key}:${userId}` };
  }

  async authorizeMember(
    key: string,
    userId: string,
    memberId: string,
    mesh?: PublicMeshInfo,
    usedAddresses: string[] = [],
  ): Promise<string | undefined> {
    const networkId = this.networkIdFor(key, mesh);
    if (!networkId) return undefined;

    // Assign a deterministic address from the network pool at authorization
    // time; peers need known addresses for their unicast peer list. Existing
    // assignments are skipped so two members cannot collide.
    const assigned = allocateMemberAddress(
      networkCidr(key),
      memberId,
      usedAddresses,
    );

    const member = await this.json<ZtnetMemberResponse>(
      this.orgUrl(
        `/${encodeURIComponent(networkId)}/member/${encodeURIComponent(memberId)}`,
      ),
      {
        method: "POST",
        body: JSON.stringify({
          authorized: true,
          ...(assigned ? { ipAssignments: [assigned] } : {}),
        }),
      },
    );

    const networkMembers = this.memberIds.get(key) ?? new Map<string, string>();
    networkMembers.set(userId, memberId);
    this.memberIds.set(key, networkMembers);

    // ZTNET returns plain IPs (no CIDR suffix).
    return member.ipAssignments?.[0] ?? assigned;
  }

  async revokeMember(
    key: string,
    userId: string,
    mesh?: PublicMeshInfo,
    memberId?: string,
  ): Promise<void> {
    const networkId = this.networkIdFor(key, mesh);
    // Prefer the persisted node id so revocation survives a restart.
    const nodeId = memberId ?? this.memberIds.get(key)?.get(userId);
    this.memberIds.get(key)?.delete(userId);
    if (!networkId || !nodeId) return;
    await this.request(
      this.orgUrl(
        `/${encodeURIComponent(networkId)}/member/${encodeURIComponent(nodeId)}`,
      ),
      {
        method: "DELETE",
      },
    );
  }

  async teardown(key: string, mesh?: PublicMeshInfo): Promise<void> {
    const networkId = this.networkIdFor(key, mesh);
    this.memberIds.delete(key);
    if (!networkId) return;
    this.networks.delete(key);
    await this.request(this.orgUrl(`/${encodeURIComponent(networkId)}`), {
      method: "DELETE",
    });
  }
}
