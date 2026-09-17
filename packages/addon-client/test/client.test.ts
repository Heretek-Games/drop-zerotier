import assert from "node:assert/strict";
import test from "node:test";
import { MockClientPluginContext } from "@droposs/plugin-sdk";
import { DropZeroTierClientPlugin } from "../src/index.js";
import { parseNodeId } from "../src/zerotier-cli.js";

const NETWORK_ID = "8056c2e21c000001";

function makeContext() {
  const ctx = new MockClientPluginContext("drop-zerotier", [
    "game:launch-hook",
    "client:storage",
    "client:ws",
    "system:command",
    "ui:slot",
  ]);
  ctx.serverRequestLog.setResponse("GET", "/networks/active", {
    networks: [
      {
        key: "room-1",
        mesh: {
          backend: "zerotier",
          cidr: "10.242.1.0/24",
          networkId: NETWORK_ID,
          expiresAt: Date.now() + 60_000,
        },
        members: [],
        createdAt: Date.now(),
        expiresAt: Date.now() + 60_000,
      },
    ],
  });
  ctx.serverRequestLog.setResponse("POST", "/networks/room-1/member", {
    address: "10.242.1.20",
  });
  ctx.systemCommand.setResponse("zerotier-cli", ["info"], {
    code: 0,
    stdout: "200 info abcdef0123 1.12.2 ONLINE",
    stderr: "",
  });
  ctx.systemCommand.setResponse("zerotier-cli", ["join", NETWORK_ID], {
    code: 0,
    stdout: "200 join OK",
    stderr: "",
  });
  ctx.systemCommand.setResponse("zerotier-cli", ["leave", NETWORK_ID], {
    code: 0,
    stdout: "200 leave OK",
    stderr: "",
  });
  return ctx;
}

test("parseNodeId extracts the address from zerotier-cli info", () => {
  assert.equal(parseNodeId("200 info abcdef0123 1.12.2 ONLINE"), "abcdef0123");
  assert.equal(
    parseNodeId("200 info deadbeef01 1.14.0 ONLINE\n"),
    "deadbeef01",
  );
  assert.equal(parseNodeId("200 info not-a-node ONLINE"), undefined);
  assert.equal(parseNodeId(""), undefined);
});

test("pre-launch joins active networks and reports the node id", async () => {
  const plugin = new DropZeroTierClientPlugin();
  const ctx = makeContext();
  plugin.init(ctx);

  const hook = ctx.launchHooks.find((h) => h.stage === "pre-launch:network");
  assert.ok(hook, "pre-launch:network hook should be registered");
  await hook.execute({ gameId: "g1", gameTitle: "Game", gameDir: "/g" });

  assert.ok(
    ctx.systemCommand.calls.some(
      (call) => call.bin === "zerotier-cli" && call.args[0] === "join",
    ),
    "zerotier-cli join should be invoked",
  );
  const memberCall = ctx.serverRequestLog.calls.find(
    (call) => call.method === "POST" && call.path === "/networks/room-1/member",
  );
  assert.ok(memberCall, "member report should be sent");
  assert.deepEqual(memberCall.body, { memberId: "abcdef0123" });
});

test("post-exit leaves joined networks", async () => {
  const plugin = new DropZeroTierClientPlugin();
  const ctx = makeContext();
  plugin.init(ctx);

  const pre = ctx.launchHooks.find((h) => h.stage === "pre-launch:network");
  const post = ctx.launchHooks.find((h) => h.stage === "post-exit:cleanup");
  assert.ok(pre && post);

  await pre.execute({ gameId: "g1", gameTitle: "Game", gameDir: "/g" });
  await post.execute({ gameId: "g1", gameTitle: "Game", gameDir: "/g" });

  assert.ok(
    ctx.systemCommand.calls.some(
      (call) => call.bin === "zerotier-cli" && call.args[0] === "leave",
    ),
    "zerotier-cli leave should be invoked",
  );
  assert.equal(await ctx.storage.get("zerotier:activeNetworks"), null);
});

test("missing system:command capability is rejected", async () => {
  const plugin = new DropZeroTierClientPlugin();
  const ctx = new MockClientPluginContext("drop-zerotier", [
    "game:launch-hook",
    "client:storage",
    "ui:slot",
  ]);
  ctx.serverRequestLog.setResponse("GET", "/networks/active", {
    networks: [
      {
        key: "room-1",
        mesh: {
          backend: "zerotier",
          cidr: "10.242.1.0/24",
          networkId: NETWORK_ID,
          expiresAt: Date.now() + 60_000,
        },
        members: [],
        createdAt: Date.now(),
        expiresAt: Date.now() + 60_000,
      },
    ],
  });
  plugin.init(ctx);

  const hook = ctx.launchHooks.find((h) => h.stage === "pre-launch:network");
  // The hook swallows join errors; the network is simply not joined.
  await hook!.execute({ gameId: "g1", gameTitle: "Game", gameDir: "/g" });
  assert.equal(ctx.systemCommand.calls.length, 0);
});

test("launch hooks isolate joined networks by gameId", async () => {
  const plugin = new DropZeroTierClientPlugin();
  const ctx = new MockClientPluginContext("drop-zerotier", [
    "game:launch-hook",
    "client:storage",
    "system:command",
    "ui:slot",
  ]);

  const NET_A = "8056c2e21c00000a";
  const NET_B = "8056c2e21c00000b";

  ctx.serverRequestLog.setResponse("GET", "/networks/active?gameId=game-a", {
    networks: [
      {
        key: "room-a",
        mesh: { backend: "zerotier", cidr: "10.242.1.0/24", networkId: NET_A, expiresAt: Date.now() + 60_000 },
        members: [],
        createdAt: Date.now(),
        expiresAt: Date.now() + 60_000,
        gameId: "game-a",
      },
    ],
  });
  ctx.serverRequestLog.setResponse("GET", "/networks/active?gameId=game-b", {
    networks: [
      {
        key: "room-b",
        mesh: { backend: "zerotier", cidr: "10.242.2.0/24", networkId: NET_B, expiresAt: Date.now() + 60_000 },
        members: [],
        createdAt: Date.now(),
        expiresAt: Date.now() + 60_000,
        gameId: "game-b",
      },
    ],
  });
  ctx.serverRequestLog.setResponse("POST", "/networks/room-a/member", { address: "10.242.1.20" });
  ctx.serverRequestLog.setResponse("POST", "/networks/room-b/member", { address: "10.242.2.20" });

  ctx.systemCommand.setResponse("zerotier-cli", ["info"], {
    code: 0,
    stdout: "200 info abcdef0123 1.12.2 ONLINE",
    stderr: "",
  });
  ctx.systemCommand.setResponse("zerotier-cli", ["join", NET_A], { code: 0, stdout: "200 join OK", stderr: "" });
  ctx.systemCommand.setResponse("zerotier-cli", ["join", NET_B], { code: 0, stdout: "200 join OK", stderr: "" });
  ctx.systemCommand.setResponse("zerotier-cli", ["leave", NET_A], { code: 0, stdout: "200 leave OK", stderr: "" });
  ctx.systemCommand.setResponse("zerotier-cli", ["leave", NET_B], { code: 0, stdout: "200 leave OK", stderr: "" });

  plugin.init(ctx);
  const pre = ctx.launchHooks.find((h) => h.stage === "pre-launch:network")!;
  const post = ctx.launchHooks.find((h) => h.stage === "post-exit:cleanup")!;

  // 1. Launch Game A
  await pre.execute({ gameId: "game-a", gameTitle: "Game A", gameDir: "/a" });
  let stored = (await ctx.storage.get<any[]>("zerotier:activeNetworks")) ?? [];
  assert.equal(stored.length, 1);
  assert.equal(stored[0].key, "room-a");
  assert.equal(stored[0].gameId, "game-a");

  // 2. Launch Game B concurrently
  await pre.execute({ gameId: "game-b", gameTitle: "Game B", gameDir: "/b" });
  stored = (await ctx.storage.get<any[]>("zerotier:activeNetworks")) ?? [];
  assert.equal(stored.length, 2);

  // 3. Exit Game B -> leaves only room-b
  await post.execute({ gameId: "game-b", gameTitle: "Game B", gameDir: "/b" });
  stored = (await ctx.storage.get<any[]>("zerotier:activeNetworks")) ?? [];
  assert.equal(stored.length, 1);
  assert.equal(stored[0].key, "room-a");

  // 4. Exit Game A -> leaves room-a
  await post.execute({ gameId: "game-a", gameTitle: "Game A", gameDir: "/a" });
  assert.equal(await ctx.storage.get("zerotier:activeNetworks"), null);
});

test("slot component renders without template compiler", () => {
  const plugin = new DropZeroTierClientPlugin();
  const ctx = makeContext();
  plugin.init(ctx);

  const slots = ctx.registeredSlots.get("game-detail:badges");
  assert.ok(slots && slots.length > 0, "badge slot should be registered");
  const comp = slots[0].component as { render?: () => unknown; template?: string };
  assert.ok(typeof comp.render === "function", "component should provide a render function");
  const rendered = comp.render();
  assert.ok(rendered, "render() should return a vnode or node descriptor");
});

