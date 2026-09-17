import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { assertManifestSupports } from "@droposs/plugin-sdk";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const bundlePath = path.resolve(
  __dirname,
  "../../../..",
  "plugin-bundle",
  "drop-plugin.json",
);

test("drop-zerotier manifest conforms to server and client requirements", () => {
  const manifest = JSON.parse(readFileSync(bundlePath, "utf-8"));

  assert.doesNotThrow(() => {
    assertManifestSupports(manifest, {
      server: ["routes", "storage", "websocket", "events", "network"],
      client: [
        "game:launch-hook",
        "client:storage",
        "system:command",
        "ui:slot",
      ],
    });
  });
});
