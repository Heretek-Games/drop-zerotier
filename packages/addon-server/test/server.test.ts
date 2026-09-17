import assert from "node:assert/strict";
import test from "node:test";
import {
  InMemoryMeshBackend,
  networkCidr,
  type MeshBackend,
} from "@heretek-games/zerotier-mesh";
import { MockPluginContext, MockPluginStorage } from "@droposs/plugin-sdk";
import { DropZeroTierServerPlugin, resolveBackend } from "../src/index.js";
import { NetworkStore } from "../src/network-store.js";

function makeStore(backend: MeshBackend = new InMemoryMeshBackend()) {
  return new NetworkStore(new MockPluginStorage(), backend);
}

test("NetworkStore provisions idempotently by key", async () => {
  const store = makeStore();
  const first = await store.ensure("room-1", 10_000);
  const second = await store.ensure("room-1", 10_000);
  assert.equal(first.key, "room-1");
  assert.equal(first.mesh.backend, "zerotier");
  assert.deepEqual(second.mesh, first.mesh);
  if (first.mesh.backend === "zerotier") {
    assert.equal(first.mesh.cidr, networkCidr("room-1"));
  }
});

test("NetworkStore authorizes a member and records the address", async () => {
  const store = makeStore();
  await store.addMember("room-2", "user-1");
  const member = await store.authorizeMember("room-2", "user-1", "abcdef0123");
  assert.equal(member.nodeId, "abcdef0123");
  assert.ok(member.address, "address should be assigned");
});

test("NetworkStore rejects a node id held by another member", async () => {
  const store = makeStore();
  await store.addMember("room-3", "user-1");
  await store.addMember("room-3", "user-2");
  await store.authorizeMember("room-3", "user-1", "abcdef0123");
  await assert.rejects(
    store.authorizeMember("room-3", "user-2", "abcdef0123"),
    /already registered/,
  );
});

test("NetworkStore activeForUser tracks membership index", async () => {
  const store = makeStore();
  await store.addMember("room-a", "user-1");
  await store.addMember("room-b", "user-1");
  await store.addMember("room-c", "user-2");
  const active = await store.activeForUser("user-1");
  assert.deepEqual(active.map((network) => network.key).sort(), [
    "room-a",
    "room-b",
  ]);
});

test("NetworkStore removeMember drops membership and revokes", async () => {
  const store = makeStore();
  await store.addMember("room-d", "user-1");
  await store.removeMember("room-d", "user-1");
  const network = await store.get("room-d");
  assert.equal(network?.members.length, 0);
  assert.deepEqual(await store.activeForUser("user-1"), []);
});

test("NetworkStore teardown removes the network", async () => {
  const store = makeStore();
  await store.addMember("room-e", "user-1");
  await store.teardown("room-e");
  assert.equal(await store.get("room-e"), undefined);
});

test("plugin registers its routes and reports the backend", async () => {
  const plugin = new DropZeroTierServerPlugin(
    undefined,
    new InMemoryMeshBackend(),
  );
  const ctx = new MockPluginContext("drop-zerotier");
  plugin.init(ctx);

  assert.ok(ctx.routes.has("GET /backend"));
  assert.ok(ctx.routes.has("GET /networks"));
  assert.ok(ctx.routes.has("GET /networks/active"));
  assert.ok(ctx.routes.has("POST /networks"));
  assert.ok(ctx.routes.has("POST /networks/:key/join"));
  assert.ok(ctx.routes.has("POST /networks/:key/member"));
  assert.ok(ctx.routes.has("DELETE /networks/:key"));

  const backendRoute = ctx.routes.get("GET /backend");
  const result = (await backendRoute!.handler(
    {},
    { params: {}, query: {} },
  )) as {
    backend: string;
  };
  assert.equal(result.backend, "zerotier");
  plugin.teardown();
});

test("plugin join route adds the caller and returns join info", async () => {
  const plugin = new DropZeroTierServerPlugin(
    undefined,
    new InMemoryMeshBackend(),
  );
  const ctx = new MockPluginContext("drop-zerotier");
  plugin.init(ctx);

  const joinRoute = ctx.routes.get("POST /networks/:key/join");
  const result = (await joinRoute!.handler(
    {},
    { params: { key: "room-x" }, query: {}, userId: "user-1" },
  )) as { join: { backend: string; networkId?: string } };
  assert.equal(result.join.backend, "zerotier");
  assert.ok(result.join.networkId);

  const activeRoute = ctx.routes.get("GET /networks/active");
  const active = (await activeRoute!.handler(
    {},
    { params: {}, query: {}, userId: "user-1" },
  )) as { networks: Array<{ key: string }> };
  assert.deepEqual(
    active.networks.map((n) => n.key),
    ["room-x"],
  );
  plugin.teardown();
});

test("plugin reacts to mesh:member-join events from consumers", async () => {
  const plugin = new DropZeroTierServerPlugin(
    undefined,
    new InMemoryMeshBackend(),
  );
  const ctx = new MockPluginContext("drop-zerotier");
  plugin.init(ctx);

  ctx.broadcast("mesh:member-join", { key: "room-gse", userId: "user-9" });
  await new Promise((resolve) => setTimeout(resolve, 20));

  const activeRoute = ctx.routes.get("GET /networks/active");
  const active = (await activeRoute!.handler(
    {},
    { params: {}, query: {}, userId: "user-9" },
  )) as { networks: Array<{ key: string }> };
  assert.deepEqual(
    active.networks.map((n) => n.key),
    ["room-gse"],
  );
  plugin.teardown();
});

test("plugin tears a network down on mesh:network-close", async () => {
  const plugin = new DropZeroTierServerPlugin(
    undefined,
    new InMemoryMeshBackend(),
  );
  const ctx = new MockPluginContext("drop-zerotier");
  plugin.init(ctx);

  ctx.broadcast("mesh:member-join", { key: "room-close", userId: "user-1" });
  await new Promise((resolve) => setTimeout(resolve, 20));

  ctx.broadcast("mesh:network-close", { key: "room-close" });
  await new Promise((resolve) => setTimeout(resolve, 20));

  const activeRoute = ctx.routes.get("GET /networks/active");
  const active = (await activeRoute!.handler(
    {},
    { params: {}, query: {}, userId: "user-1" },
  )) as { networks: Array<{ key: string }> };
  assert.deepEqual(active.networks, []);
  plugin.teardown();
});

test("NetworkStore activeForUser does not re-provision expired networks", async () => {
  let currentTime = 1000;
  const store = new NetworkStore(
    new MockPluginStorage(),
    new InMemoryMeshBackend(),
    () => currentTime,
  );

  await store.addMember("expiring-room", "user-1");
  // Fast forward past default TTL
  currentTime += 5 * 60 * 60 * 1000;

  // activeForUser should return empty and prune expired from user membership
  const active = await store.activeForUser("user-1");
  assert.equal(active.length, 0);

  // Expired network is not re-provisioned
  const fetched = await store.get("expiring-room");
  assert.equal(fetched, undefined);
});

test("resolveBackend applies MESH_HTTP_TIMEOUT_MS and rejects invalid values", () => {
  const backend = resolveBackend({
    MESH_BACKEND: "ztnet",
    ZTNET_URL: "https://ztnet.example.com",
    ZTNET_TOKEN: "token",
    ZTNET_ORG: "org-1",
    MESH_HTTP_TIMEOUT_MS: "5000",
  });
  assert.equal(backend.id, "zerotier");

  const zeroTimeout = resolveBackend({
    MESH_BACKEND: "tailscale",
    TAILSCALE_API_KEY: "key",
    TAILSCALE_TAILNET: "example.com",
    MESH_HTTP_TIMEOUT_MS: "0",
    TAILSCALE_KEY_EXPIRY_SECONDS: "900",
  });
  assert.equal(zeroTimeout.id, "tailscale");

  assert.throws(
    () =>
      resolveBackend({
        MESH_BACKEND: "tailscale",
        TAILSCALE_API_KEY: "key",
        TAILSCALE_TAILNET: "example.com",
        TAILSCALE_KEY_EXPIRY_SECONDS: "0",
      }),
    /TAILSCALE_KEY_EXPIRY_SECONDS/,
  );

  const ztnetEnv = {
    MESH_BACKEND: "ztnet",
    ZTNET_URL: "https://ztnet.example.com",
    ZTNET_TOKEN: "token",
    ZTNET_ORG: "org-1",
  };
  assert.throws(
    () => resolveBackend({ ...ztnetEnv, MESH_HTTP_TIMEOUT_MS: "soon" }),
    /MESH_HTTP_TIMEOUT_MS/,
  );

  assert.throws(
    () => resolveBackend({ ...ztnetEnv, MESH_HTTP_TIMEOUT_MS: "-1" }),
    /MESH_HTTP_TIMEOUT_MS/,
  );
});

test("plugin enforces auth on GET /networks and authorization on DELETE /networks/:key", async () => {
  const plugin = new DropZeroTierServerPlugin(
    undefined,
    new InMemoryMeshBackend(),
  );
  const ctx = new MockPluginContext("drop-zerotier");
  plugin.init(ctx);

  const getNetworksRoute = ctx.routes.get("GET /networks");
  await assert.rejects(
    async () => getNetworksRoute!.handler({}, { params: {}, query: {} }),
    /Authentication required/,
  );

  const postRoute = ctx.routes.get("POST /networks");
  await postRoute!.handler(
    { key: "auth-room" },
    { params: {}, query: {}, userId: "owner-user" },
  );

  const deleteRoute = ctx.routes.get("DELETE /networks/:key");
  // 1. Unauthenticated -> 401
  await assert.rejects(
    async () =>
      deleteRoute!.handler({}, { params: { key: "auth-room" }, query: {} }),
    /Authentication required/,
  );

  // 2. Non-member / non-owner -> 403
  await assert.rejects(
    async () =>
      deleteRoute!.handler(
        {},
        { params: { key: "auth-room" }, query: {}, userId: "attacker-user" },
      ),
    /Forbidden/,
  );

  // 3. Owner -> 200
  const ownerResult = (await deleteRoute!.handler(
    {},
    { params: { key: "auth-room" }, query: {}, userId: "owner-user" },
  )) as { success: boolean };
  assert.equal(ownerResult.success, true);

  // 4. Already deleted -> 404
  await assert.rejects(
    async () =>
      deleteRoute!.handler(
        {},
        { params: { key: "auth-room" }, query: {}, userId: "owner-user" },
      ),
    /Network not found/,
  );

  plugin.teardown();
});

test("NetworkStore isolates active networks by gameId", async () => {
  const store = makeStore();
  await store.addMember("game1-net", "user-1", "game-alpha");
  await store.addMember("game2-net", "user-1", "game-beta");
  await store.addMember("global-net", "user-1");

  const alphaActive = await store.activeForUser("user-1", "game-alpha");
  assert.deepEqual(alphaActive.map((n) => n.key).sort(), ["game1-net", "global-net"]);

  const betaActive = await store.activeForUser("user-1", "game-beta");
  assert.deepEqual(betaActive.map((n) => n.key).sort(), ["game2-net", "global-net"]);

  const allActive = await store.activeForUser("user-1");
  assert.deepEqual(allActive.map((n) => n.key).sort(), ["game1-net", "game2-net", "global-net"]);
});

