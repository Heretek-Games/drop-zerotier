import type { PluginStorage } from "@droposs/plugin-sdk";
import {
  isPublicMeshInfo,
  type MeshBackend,
  type PublicMeshInfo,
} from "@heretek-games/zerotier-mesh";

/** Default network lifetime (4 hours). */
export const NETWORK_TTL_MS = 4 * 60 * 60 * 1000;

export interface NetworkMember {
  userId: string;
  /** Backend node id (e.g. the ZeroTier member address) for revocation. */
  nodeId?: string;
  /** Address assigned inside the mesh. */
  address?: string;
  joinedAt: number;
}

export interface MeshNetwork {
  key: string;
  mesh: PublicMeshInfo;
  members: NetworkMember[];
  createdAt: number;
  expiresAt: number;
}

const STATE_KEY = "networks";

interface PersistedState {
  networks: Record<string, MeshNetwork>;
  /** userId → network keys the user has been added to. */
  membership: Record<string, string[]>;
}

function emptyState(): PersistedState {
  return { networks: {}, membership: {} };
}

function isNetwork(value: unknown): value is MeshNetwork {
  if (!value || typeof value !== "object") return false;
  const network = value as Partial<MeshNetwork>;
  return (
    typeof network.key === "string" &&
    typeof network.createdAt === "number" &&
    typeof network.expiresAt === "number" &&
    Array.isArray(network.members) &&
    network.members.every(
      (member) => !!member && typeof member.userId === "string",
    ) &&
    isPublicMeshInfo(network.mesh)
  );
}

/**
 * Durable registry of mesh networks, keyed by an opaque consumer-supplied key
 * (e.g. a `drop-gse` room id). Persisted as a single JSON blob in plugin
 * storage; all mutations are serialized in-process so read-modify-write cannot
 * clobber concurrent updates.
 */
export class NetworkStore {
  private lock: Promise<unknown> = Promise.resolve();

  constructor(
    private readonly storage: PluginStorage,
    private readonly backend: MeshBackend,
    private readonly now: () => number = Date.now,
  ) {}

  private withLock<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.lock.then(fn, fn);
    this.lock = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  private async load(): Promise<PersistedState> {
    const raw = await this.storage.get<PersistedState>(STATE_KEY);
    if (!raw || typeof raw !== "object") return emptyState();
    const state = emptyState();
    for (const [key, network] of Object.entries(raw.networks ?? {})) {
      if (isNetwork(network)) state.networks[key] = network;
    }
    for (const [userId, keys] of Object.entries(raw.membership ?? {})) {
      if (Array.isArray(keys)) {
        state.membership[userId] = keys.filter(
          (key): key is string => typeof key === "string",
        );
      }
    }
    return state;
  }

  private async save(state: PersistedState): Promise<void> {
    await this.storage.set(STATE_KEY, state);
  }

  private liveNetwork(
    state: PersistedState,
    key: string,
  ): MeshNetwork | undefined {
    const network = state.networks[key];
    if (!network || network.expiresAt <= this.now()) return undefined;
    return network;
  }

  /** Provision (or return) the network for `key`. */
  async ensure(key: string, ttlMs = NETWORK_TTL_MS): Promise<MeshNetwork> {
    return this.withLock(async () => {
      const state = await this.load();
      const existing = this.liveNetwork(state, key);
      if (existing) return existing;

      const createdAt = this.now();
      const expiresAt = createdAt + ttlMs;
      const mesh = await this.backend.provision(key, expiresAt);
      const network: MeshNetwork = {
        key,
        mesh,
        members: [],
        createdAt,
        expiresAt,
      };
      state.networks[key] = network;
      await this.save(state);
      return network;
    });
  }

  async get(key: string): Promise<MeshNetwork | undefined> {
    const state = await this.load();
    return this.liveNetwork(state, key);
  }

  /** Every non-expired network. */
  async list(): Promise<MeshNetwork[]> {
    const state = await this.load();
    return Object.values(state.networks).filter(
      (network) => network.expiresAt > this.now(),
    );
  }

  /** Networks the user has been added to (provisioning any missing ones). */
  async activeForUser(userId: string): Promise<MeshNetwork[]> {
    const keys = await this.withLock(async () => {
      const state = await this.load();
      return [...(state.membership[userId] ?? [])];
    });
    const networks: MeshNetwork[] = [];
    for (const key of keys) {
      const network = await this.ensure(key);
      if (network.members.some((member) => member.userId === userId)) {
        networks.push(network);
      }
    }
    return networks;
  }

  /** Add a user to a network, provisioning it if necessary. */
  async addMember(key: string, userId: string): Promise<MeshNetwork> {
    await this.ensure(key);
    return this.withLock(async () => {
      const state = await this.load();
      const network = this.liveNetwork(state, key);
      if (!network) throw new Error("network not found");
      if (!network.members.some((member) => member.userId === userId)) {
        network.members.push({ userId, joinedAt: this.now() });
      }
      const keys = state.membership[userId] ?? [];
      if (!keys.includes(key)) keys.push(key);
      state.membership[userId] = keys;
      await this.save(state);
      return network;
    });
  }

  /**
   * Authorize a member's node after it joins and record the assigned address.
   */
  async authorizeMember(
    key: string,
    userId: string,
    nodeId: string,
  ): Promise<NetworkMember> {
    // Self-heal: the network may not be provisioned yet if the client reported
    // its node before the async `mesh:member-join` handler finished.
    await this.ensure(key);
    return this.withLock(async () => {
      const state = await this.load();
      const network = this.liveNetwork(state, key);
      if (!network) throw new Error("network not found");
      const member = network.members.find((entry) => entry.userId === userId);
      if (!member) throw new Error("not a network member");

      const heldByAnother = network.members.some(
        (entry) => entry.userId !== userId && entry.nodeId === nodeId,
      );
      if (heldByAnother) {
        throw new Error("node id already registered to another member");
      }

      if (member.nodeId && member.nodeId !== nodeId) {
        await this.backend.revokeMember(
          key,
          userId,
          network.mesh,
          member.nodeId,
        );
      }

      member.nodeId = nodeId;
      if (this.backend.authorizeMember) {
        const used = network.members
          .filter((entry) => entry.userId !== userId)
          .map((entry) => entry.address)
          .filter((address): address is string => Boolean(address));
        const address = await this.backend.authorizeMember(
          key,
          userId,
          nodeId,
          network.mesh,
          used,
        );
        if (address) member.address = address;
      }
      await this.save(state);
      return member;
    });
  }

  /** Remove a member and revoke its node. */
  async removeMember(key: string, userId: string): Promise<void> {
    return this.withLock(async () => {
      const state = await this.load();
      const network = state.networks[key];
      if (network) {
        const member = network.members.find((entry) => entry.userId === userId);
        network.members = network.members.filter(
          (entry) => entry.userId !== userId,
        );
        await this.backend.revokeMember(
          key,
          userId,
          network.mesh,
          member?.nodeId,
        );
      }
      const keys = state.membership[userId];
      if (keys) {
        state.membership[userId] = keys.filter((entry) => entry !== key);
      }
      await this.save(state);
    });
  }

  /** Tear down a network and drop all membership references. */
  async teardown(key: string): Promise<void> {
    return this.withLock(async () => {
      const state = await this.load();
      const network = state.networks[key];
      if (!network) return;
      await this.backend.teardown(key, network.mesh);
      Reflect.deleteProperty(state.networks, key);
      for (const [userId, keys] of Object.entries(state.membership)) {
        state.membership[userId] = keys.filter((entry) => entry !== key);
      }
      await this.save(state);
    });
  }

  /** Tear down expired networks. Returns the number removed. */
  async pruneExpired(): Promise<number> {
    return this.withLock(async () => {
      const state = await this.load();
      const now = this.now();
      const expired = Object.values(state.networks).filter(
        (network) => network.expiresAt <= now,
      );
      let removed = 0;
      for (const network of expired) {
        try {
          await this.backend.teardown(network.key, network.mesh);
        } catch {
          // Keep the entry so a later sweep can retry the teardown.
          continue;
        }
        Reflect.deleteProperty(state.networks, network.key);
        for (const [userId, keys] of Object.entries(state.membership)) {
          state.membership[userId] = keys.filter(
            (entry) => entry !== network.key,
          );
        }
        removed += 1;
      }
      if (removed > 0) await this.save(state);
      return removed;
    });
  }
}
