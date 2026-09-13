#!/usr/bin/env node
/**
 * One-time ZTNET bootstrap for local development / the gse E2E harness.
 *
 * Creates (or signs into) the first user, ensures an organization exists, mints
 * an ORGANIZATION API token, and prints the GSE_ZTNET_* values.
 *
 * Usage:
 *   GSE_ZTNET_URL=http://localhost:3099 node dev-tools/ztnet-bootstrap.mjs
 *
 * Env: ZTNET_EMAIL / ZTNET_PASSWORD override the dev defaults.
 */
let baseUrl = process.env.GSE_ZTNET_URL ?? "http://localhost:3099";
while (baseUrl.endsWith("/")) {
  baseUrl = baseUrl.slice(0, -1);
}
const email = process.env.ZTNET_EMAIL ?? "admin@drop.local";
const password = process.env.ZTNET_PASSWORD ?? "Password123!";
const origin = baseUrl;

/** Collapse CR/LF so server-controlled text cannot forge log lines. */
const sanitizeForLog = (value) => String(value).replace(/[\r\n]/g, "");

async function auth(path, body) {
  const response = await fetch(`${baseUrl}/api/auth/${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Origin: origin },
    body: JSON.stringify(body),
  });
  const cookies = response.headers.getSetCookie?.() ?? [];
  return { response, cookies };
}

async function trpcMutation(proc, input, cookie) {
  const response = await fetch(`${baseUrl}/api/trpc/${proc}?batch=1`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Origin: origin,
      Cookie: cookie,
    },
    body: JSON.stringify({ 0: { json: input } }),
  });
  const payload = await response.json();
  const item = Array.isArray(payload) ? payload[0] : payload;
  if (item.error) {
    throw new Error(`${proc}: ${JSON.stringify(item.error)}`);
  }
  return item.result.data.json;
}

async function trpcQuery(proc, input, cookie) {
  const encoded = encodeURIComponent(JSON.stringify({ 0: { json: input } }));
  const response = await fetch(
    `${baseUrl}/api/trpc/${proc}?batch=1&input=${encoded}`,
    {
      headers: { Origin: origin, Cookie: cookie },
    },
  );
  const payload = await response.json();
  const item = Array.isArray(payload) ? payload[0] : payload;
  if (item.error) {
    throw new Error(`${proc}: ${JSON.stringify(item.error)}`);
  }
  return item.result.data.json;
}

let session = await auth("sign-in/email", { email, password });
if (!session.response.ok) {
  session = await auth("sign-up/email", { email, password, name: "Admin" });
}
if (!session.response.ok) {
  console.error(sanitizeForLog(await session.response.text()));
  process.exit(1);
}
const cookie = session.cookies.map((entry) => entry.split(";")[0]).join("; ");

let orgId = (await trpcQuery("org.getOrgIdbyUserid", null, cookie))?.[0]?.id;
if (!orgId) {
  const user = await trpcMutation(
    "org.createOrg",
    { orgName: "drop-gse", orgDescription: "drop-gse rooms" },
    cookie,
  );
  orgId = user.memberOfOrgs?.[0]?.id;
}
if (!orgId) {
  throw new Error("could not determine organization id");
}

const token = await trpcMutation(
  "auth.addApiToken",
  {
    name: "drop-gse",
    daysToExpire: "never",
    apiAuthorizationType: ["ORGANIZATION"],
  },
  cookie,
);

console.log(`GSE_ZTNET_ORG=${sanitizeForLog(orgId)}`);
console.log(`GSE_ZTNET_TOKEN=${sanitizeForLog(token.token)}`);
