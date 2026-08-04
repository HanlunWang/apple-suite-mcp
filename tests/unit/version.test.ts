import { it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { SERVER_NAME, SERVER_VERSION } from "../../src/version.ts";

it("src/version.ts stays in sync with package.json", () => {
  const pkg = JSON.parse(
    readFileSync(join(import.meta.dirname, "..", "..", "package.json"), "utf8"),
  ) as { name: string; version: string };
  assert.equal(SERVER_NAME, pkg.name);
  assert.equal(SERVER_VERSION, pkg.version);
});
