import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import extension, { extensionInfo } from "../../.pi/extensions/television/index.ts";

test("e2e fixture imports the live local .pi extension shim", async () => {
  const settingsPath = path.join(
    process.cwd(),
    "e2e",
    ".pi",
    "agent",
    "settings.json",
  );
  assert.equal(existsSync(settingsPath), true);

  const settings = JSON.parse(await readFile(settingsPath, "utf8"));
  assert.deepEqual(settings.extensions, [
    "../../.pi/extensions/television/index.ts",
  ]);
  assert.equal(extension.name, "television");
  assert.equal(extensionInfo.description, "Pi extension that replaces the fuzzy file finder with television (tv) for faster, non-blocking file search");
});
