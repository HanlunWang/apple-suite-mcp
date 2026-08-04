/**
 * JXA notes runner: protocol against a stub interpreter, plus a REAL
 * osascript ping (the fixed template answers ping without sending any Apple
 * Event to Notes — safe on CI, no Automation prompt).
 */
import { afterEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, existsSync } from "node:fs";
import { join } from "node:path";

import { HelperCallError } from "../../src/native/client.ts";
import { JxaNotesClient, OSASCRIPT_BIN, notesScriptPath } from "../../src/native/notes.ts";

const STUB = join(import.meta.dirname, "..", "fixtures", "fake-osascript.mjs");
chmodSync(STUB, 0o755);

afterEach(() => {
  delete process.env["APPLE_MCP_OSASCRIPT"];
});

describe("JxaNotesClient (stub interpreter)", () => {
  it("round-trips ok responses", async () => {
    process.env["APPLE_MCP_OSASCRIPT"] = STUB;
    const client = new JxaNotesClient();
    const data = await client.call<{ echoed: { op: string } }>("echo", { x: 1 });
    assert.equal(data.echoed.op, "echo");
  });

  it("maps protocol errors to HelperCallError", async () => {
    process.env["APPLE_MCP_OSASCRIPT"] = STUB;
    const client = new JxaNotesClient();
    await assert.rejects(client.call("fail"), (err: unknown) => {
      assert.ok(err instanceof HelperCallError);
      assert.equal(err.code, "permission_denied");
      return true;
    });
  });

  it("rejects malformed interpreter output", async () => {
    process.env["APPLE_MCP_OSASCRIPT"] = STUB;
    const client = new JxaNotesClient();
    await assert.rejects(client.call("garbage"), (err: unknown) => {
      assert.ok(err instanceof HelperCallError);
      assert.equal(err.code, "internal");
      return true;
    });
  });

  it("times out with a permission hint", async () => {
    process.env["APPLE_MCP_OSASCRIPT"] = STUB;
    const client = new JxaNotesClient(200);
    await assert.rejects(client.call("hang"), (err: unknown) => {
      assert.ok(err instanceof HelperCallError);
      assert.equal(err.code, "timeout");
      assert.match(err.message, /Automation/);
      return true;
    });
  });
});

describe("real osascript + fixed template (no Apple Events)", () => {
  const available = existsSync(OSASCRIPT_BIN) && existsSync(notesScriptPath());

  it("answers ping", { skip: !available && "osascript or template missing" }, async () => {
    const client = new JxaNotesClient();
    const pong = await client.call<{ pong: boolean }>("ping");
    assert.equal(pong.pong, true);
  });

  it("rejects unknown ops", { skip: !available && "osascript or template missing" }, async () => {
    const client = new JxaNotesClient();
    await assert.rejects(client.call("bogus"), (err: unknown) => {
      assert.ok(err instanceof HelperCallError);
      assert.equal(err.code, "invalid_request");
      return true;
    });
  });
});
