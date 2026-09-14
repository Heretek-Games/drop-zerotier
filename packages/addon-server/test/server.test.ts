import assert from "node:assert/strict";
import test from "node:test";
import {
  InMemoryMeshBackend,
  networkCidr,
  type MeshBackend,
} from "@drop/zerotier-mesh";
import {
  MockPluginContext,
  MockPluginStorage,
} from "@droposs/plugin-sdk";
import { DropZeroTierServerPlugin } from "../src/index.js";
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
  const member = await store.authorizeMember(
    "room-2",
    "user-1",
    "abcdef0123",
  );
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
  assert.deepEqual(
    active.map((network) => network.key).sort(),
    ["room-a", "room-b"],
  );
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
  const result = (await backendRoute!.handler({}, { params: {}, query: {} })) as {
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
  assert.deepEqual(active.networks.map((n) => n.key), ["room-x"]);
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
  assert.deepEqual(active.networks.map((n) => n.key), ["room-gse"]);
  plugin.teardown();
});
