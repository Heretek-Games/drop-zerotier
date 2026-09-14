import assert from "node:assert/strict";
import test from "node:test";
import {
  InMemoryMeshBackend,
  allocateMemberAddress,
  networkCidr,
  type FetchLike,
} from "../src/index.js";
import { ZtnetBackend } from "../src/ztnet.js";

test("networkCidr is deterministic and inside the mesh pool", () => {
  assert.equal(networkCidr("room-1"), networkCidr("room-1"));
  assert.match(networkCidr("room-1"), /^10\.242\.\d+\.0\/24$/);
});

test("allocateMemberAddress avoids collisions", () => {
  const cidr = "10.242.1.0/24";
  const first = allocateMemberAddress(cidr, "user-1");
  assert.ok(first);
  const second = allocateMemberAddress(cidr, "user-1", [first!]);
  assert.ok(second);
  assert.notEqual(first, second);
});

test("InMemoryMeshBackend provisions and authorizes members", async () => {
  const backend = new InMemoryMeshBackend();
  const mesh = await backend.provision("room-1", 1234);
  assert.equal(mesh.backend, "zerotier");
  const address = await backend.authorizeMember(
    "room-1",
    "user-1",
    "abcdef0123",
    mesh,
  );
  assert.ok(address);
});

test("ZtnetBackend uses the org API and pre-authorizes a node id", async () => {
  const calls: Array<{ url: string; method: string; body?: string }> = [];
  const fetchImpl: FetchLike = async (url, init) => {
    calls.push({ url, method: init?.method ?? "GET", body: init?.body });
    if (init?.method === "POST" && /\/network\/[^/]+\/member\//.test(url)) {
      return {
        ok: true,
        status: 200,
        json: async () => ({ ipAssignments: ["10.242.1.20"] }),
        text: async () => "",
      };
    }
    if (init?.method === "POST" && /\/network$/.test(url)) {
      return {
        ok: true,
        status: 200,
        json: async () => ({ nwid: "8056c2e21c000001" }),
        text: async () => "",
      };
    }
    return {
      ok: true,
      status: 200,
      json: async () => ({}),
      text: async () => "",
    };
  };
  const backend = new ZtnetBackend({
    baseUrl: "https://ztnet.example.com",
    apiToken: "token",
    organizationId: "org-1",
    fetchImpl,
  });

  const mesh = await backend.provision("room-1", 1234);
  assert.equal(mesh.backend, "zerotier");
  if (mesh.backend === "zerotier") {
    assert.equal(mesh.networkId, "8056c2e21c000001");
  }

  const address = await backend.authorizeMember(
    "room-1",
    "user-1",
    "abcdef0123",
    mesh,
  );
  assert.equal(address, "10.242.1.20");
  assert.ok(
    calls.some((call) =>
      call.url.includes("/member/abcdef0123"),
    ),
    "member modification should be requested",
  );
});
