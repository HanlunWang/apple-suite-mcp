/**
 * SECURITY BOTTOM LINE — the Shortcuts CLI is the one backend that takes
 * untrusted text in argv (the shortcut name; the CLI offers no stdin
 * alternative). This suite proves that path never reaches a shell: the name
 * arrives at the executed process as ONE argv entry, byte-identical, with no
 * expansion, splitting, or command substitution.
 */
import { afterEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { chmodSync } from "node:fs";
import { join } from "node:path";

import { ShortcutsClient } from "../../src/native/shortcuts.ts";

const STUB = join(import.meta.dirname, "..", "fixtures", "fake-shortcuts.mjs");
chmodSync(STUB, 0o755);

afterEach(() => {
  delete process.env["APPLE_MCP_SHORTCUTS_BIN"];
});

/** Payloads that would be catastrophic if a shell ever saw them. */
const SHELL_PAYLOADS = [
  'Routine"; rm -rf ~; echo "',
  "Routine$(whoami)",
  "Routine`id`",
  "Routine && rm -rf /",
  "Routine | tee /tmp/pwned",
  "Routine; touch /tmp/pwned",
  "Routine\nrm -rf ~",
  "Routine with spaces and 'quotes'",
  "*",
  "~",
];

describe("shortcut names never reach a shell", () => {
  for (const payload of SHELL_PAYLOADS) {
    it(`passes as one inert argv entry: ${JSON.stringify(payload).slice(0, 40)}…`, async () => {
      process.env["APPLE_MCP_SHORTCUTS_BIN"] = STUB;
      const client = new ShortcutsClient();
      const result = await client.call<{ ran: boolean; output: string | null }>("shortcuts.run", {
        name: payload,
      });
      // The stub echoes its argv as JSON.
      const argv = JSON.parse(result.output ?? "[]") as string[];
      assert.deepEqual(argv, ["run", payload], "argv must be [run, <name>] exactly");
      // No glob expansion: "*" stays "*", never a list of files.
      assert.equal(argv[1], payload);
    });
  }

  it("input travels on stdin, not argv", async () => {
    process.env["APPLE_MCP_SHORTCUTS_BIN"] = STUB;
    const client = new ShortcutsClient();
    const result = await client.call<{ output: string | null }>("shortcuts.run", {
      name: "Routine",
      input: "secret payload",
    });
    const argv = JSON.parse(result.output ?? "[]") as string[];
    assert.deepEqual(argv, ["run", "Routine", "-i", "-"]);
    assert.ok(!argv.includes("secret payload"), "input must not appear in argv");
  });

  it("rejects an empty name before spawning anything", async () => {
    process.env["APPLE_MCP_SHORTCUTS_BIN"] = STUB;
    const client = new ShortcutsClient();
    await assert.rejects(client.call("shortcuts.run", { name: "" }));
  });
});
