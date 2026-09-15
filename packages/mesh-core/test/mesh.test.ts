import assert from "node:assert/strict";
import test from "node:test";
import {
  DEFAULT_MESH_FETCH_TIMEOUT_MS,
  InMemoryMeshBackend,
  TailscaleApiProvisioner,
  TailscaleBackend,
  ZeroTierBackend,
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
    calls.some((call) => call.url.includes("/member/abcdef0123")),
    "member modification should be requested",
  );
});

/**
 * Wait for `signal` to abort. `AbortSignal.timeout` timers are unref'd, so a
 * ref'd keep-alive timer is needed to stop the test runner from draining the
 * event loop before the mock fetch observes the abort.
 */
async function waitForAbort(signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) return;
  await new Promise<void>((resolve) => {
    const keepAlive = setTimeout(() => {}, 1_000);
    signal?.addEventListener(
      "abort",
      () => {
        clearTimeout(keepAlive);
        resolve();
      },
      { once: true },
    );
  });
}

test("ZtnetBackend aborts a stalled request after the configured timeout", async () => {
  let signal: AbortSignal | undefined;
  const fetchImpl: FetchLike = async (_url, init) => {
    signal = init?.signal;
    await waitForAbort(init?.signal);
    throw init?.signal?.reason ?? new Error("request was not aborted");
  };
  const backend = new ZtnetBackend({
    baseUrl: "https://ztnet.example.com",
    apiToken: "token",
    organizationId: "org-1",
    fetchImpl,
    timeoutMs: 20,
  });

  await assert.rejects(
    backend.provision("room-timeout", 1),
    (error: unknown) => {
      assert.equal((error as Error).name, "TimeoutError");
      return true;
    },
  );
  assert.equal(signal?.aborted, true);
});

test("mesh requests carry a timeout signal by default and none when disabled", async () => {
  const signals: Array<AbortSignal | undefined> = [];
  const fetchImpl: FetchLike = async (_url, init) => {
    signals.push(init?.signal);
    return {
      ok: true,
      status: 200,
      json: async () => ({ nwid: "8056c2e21c000001" }),
      text: async () => "",
    };
  };
  const options = {
    baseUrl: "https://ztnet.example.com",
    apiToken: "token",
    organizationId: "org-1",
    fetchImpl,
  };

  const withDefault = new ZtnetBackend(options);
  await withDefault.provision("room-default", 1);
  const firstSignal = signals.at(0);
  assert.ok(firstSignal instanceof AbortSignal);
  assert.equal(firstSignal.aborted, false);
  assert.ok(DEFAULT_MESH_FETCH_TIMEOUT_MS > 0);

  const withoutTimeout = new ZtnetBackend({ ...options, timeoutMs: 0 });
  await withoutTimeout.provision("room-no-timeout", 1);
  assert.equal(signals.at(-1), undefined);
});

test("TailscaleApiProvisioner aborts stalled key creation", async () => {
  let signal: AbortSignal | undefined;
  const fetchImpl: FetchLike = async (_url, init) => {
    signal = init?.signal;
    await waitForAbort(init?.signal);
    throw init?.signal?.reason ?? new Error("request was not aborted");
  };
  const provisioner = new TailscaleApiProvisioner({
    apiKey: "key",
    tailnet: "example.com",
    tag: "tag:drop",
    fetchImpl,
    timeoutMs: 20,
  });

  await assert.rejects(
    provisioner.issueAuthKey("tag:drop", "user-1", "room-1"),
    (error: unknown) => {
      assert.equal((error as Error).name, "TimeoutError");
      return true;
    },
  );
  assert.equal(signal?.aborted, true);
});

test("TailscaleBackend revokes a member device by id", async () => {
  const calls: Array<{ url: string; method: string }> = [];
  const fetchImpl: FetchLike = async (url, init) => {
    calls.push({ url, method: init?.method ?? "GET" });
    return {
      ok: true,
      status: 200,
      json: async () => ({}),
      text: async () => "",
    };
  };
  const provisioner = new TailscaleApiProvisioner({
    apiKey: "key",
    tailnet: "example.com",
    tag: "tag:drop",
    fetchImpl,
  });
  const backend = new TailscaleBackend(provisioner);

  await backend.revokeMember(
    "room-1",
    "user-1",
    { backend: "tailscale", aclTag: "tag:drop", expiresAt: 0 },
    "device-123",
  );
  assert.deepEqual(calls, [
    {
      url: "https://api.tailscale.com/api/v2/device/device-123",
      method: "DELETE",
    },
  ]);
});

test("Tailscale device revocation is idempotent when the device is gone", async () => {
  const fetchImpl: FetchLike = async () => ({
    ok: false,
    status: 404,
    json: async () => ({}),
    text: async () => "not found",
  });
  const provisioner = new TailscaleApiProvisioner({
    apiKey: "key",
    tailnet: "example.com",
    tag: "tag:drop",
    fetchImpl,
  });

  await assert.doesNotReject(provisioner.revokeDevice("gone-device"));
});

test("Tailscale credential expiry follows the configured key TTL", async () => {
  let body: { expirySeconds?: number } | undefined;
  const fetchImpl: FetchLike = async (_url, init) => {
    body = JSON.parse(init?.body ?? "{}") as { expirySeconds?: number };
    return {
      ok: true,
      status: 200,
      json: async () => ({ id: "key-1", key: "tskey-abc" }),
      text: async () => "",
    };
  };
  const provisioner = new TailscaleApiProvisioner({
    apiKey: "key",
    tailnet: "example.com",
    tag: "tag:drop",
    fetchImpl,
    keyExpirySeconds: 120,
  });
  const backend = new TailscaleBackend(provisioner);

  const before = Date.now();
  const credential = await backend.issueCredential("room-1", "user-1", {
    backend: "tailscale",
    aclTag: "tag:drop",
    expiresAt: 0,
  });
  const after = Date.now();

  assert.equal(body?.expirySeconds, 120);
  assert.ok(credential.expiresAt);
  assert.ok(credential.expiresAt! >= before + 120_000);
  assert.ok(credential.expiresAt! <= after + 120_000);
});

test("ZeroTierBackend member authorize/revoke use the /controller path", async () => {
  const calls: Array<{ url: string; method: string; body?: string }> = [];
  const fetchImpl: FetchLike = async (url, init) => {
    calls.push({ url, method: init?.method ?? "GET", body: init?.body });
    if (init?.method === "POST" && /______$/.test(url)) {
      return {
        ok: true,
        status: 200,
        json: async () => ({ id: "8056c2e21c000001" }),
        text: async () => "",
      };
    }
    return {
      ok: true,
      status: 200,
      json: async () => ({ assignedAddresses: ["10.242.1.20/24"] }),
      text: async () => "",
    };
  };

  const backend = new ZeroTierBackend({
    baseUrl: "http://localhost:9993",
    authToken: "authtoken",
    controllerNodeId: "abcdef0123",
    fetchImpl,
  });

  const mesh = await backend.provision("room-1", 1234);
  await backend.authorizeMember("room-1", "user-1", "member-1", mesh);
  await backend.revokeMember("room-1", "user-1", mesh, "member-1");

  const memberUrl =
    "http://localhost:9993/controller/network/8056c2e21c000001/member/member-1";
  const memberCalls = calls.filter((call) => call.url === memberUrl);
  const trace = calls
    .map((call) => `${call.method} ${call.url} ${call.body ?? ""}`)
    .join("\n");

  assert.equal(
    memberCalls.length,
    2,
    `expected exactly two /controller member calls; got:\n${trace}`,
  );

  const [authorizeCall, revokeCall] = memberCalls;
  assert.equal(authorizeCall.method, "POST");
  assert.deepEqual(
    JSON.parse(authorizeCall.body ?? "null"),
    { authorized: true },
    `expected the authorize call to send {"authorized":true}; got:\n${trace}`,
  );
  assert.equal(revokeCall.method, "POST");
  assert.deepEqual(
    JSON.parse(revokeCall.body ?? "null"),
    { authorized: false },
    `expected the revoke call to send {"authorized":false}; got:\n${trace}`,
  );
});
