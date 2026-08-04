import { afterEach, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  ConfigError,
  MODULE_IDS,
  configPath,
  defaultConfig,
  isModuleEnabled,
  isWriteAllowed,
  loadConfig,
  needsConfirmation,
} from "../../src/config.ts";

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "apple-mcp-test-"));
  process.env["APPLE_MCP_CONFIG_DIR"] = dir;
});
afterEach(() => {
  delete process.env["APPLE_MCP_CONFIG_DIR"];
  rmSync(dir, { recursive: true, force: true });
});

describe("defaults", () => {
  it("everything is disabled and read-only by default", () => {
    const cfg = defaultConfig();
    for (const id of MODULE_IDS) {
      assert.equal(isModuleEnabled(cfg, id), false);
      assert.equal(isWriteAllowed(cfg, id), false);
      assert.equal(cfg.modules[id]?.mode, "read");
    }
    assert.equal(cfg.transport.type, "stdio");
    assert.deepEqual(cfg.requireConfirmation, ["mail.send", "messages.send", "*.delete"]);
  });
});

describe("loader", () => {
  it("generates a locked-down config on first run, with 0600 permissions", () => {
    const cfg = loadConfig();
    for (const id of MODULE_IDS) assert.equal(isModuleEnabled(cfg, id), false);
    const mode = statSync(configPath()).mode & 0o777;
    assert.equal(mode, 0o600);
  });

  it("fills missing module entries with the disabled default (forward compat)", () => {
    const partial = { version: 1, modules: { calendar: { enabled: true, mode: "read" } } };
    writeFileSync(configPath(), JSON.stringify(partial));
    const cfg = loadConfig();
    assert.equal(isModuleEnabled(cfg, "calendar"), true);
    assert.equal(isModuleEnabled(cfg, "messages"), false);
  });

  it("rejects malformed JSON with an actionable hint", () => {
    writeFileSync(configPath(), "{ nope");
    assert.throws(() => loadConfig(), (err: unknown) => {
      assert.ok(err instanceof ConfigError);
      assert.match(err.hint, /delete the file/);
      return true;
    });
  });

  it("rejects invalid values (unknown mode)", () => {
    const bad = { version: 1, modules: { calendar: { enabled: true, mode: "admin" } } };
    writeFileSync(configPath(), JSON.stringify(bad));
    assert.throws(() => loadConfig(), ConfigError);
  });
});

describe("http transport validation", () => {
  const parse = (t: unknown) => AppConfigParse({ version: 1, modules: {}, transport: t });
  function AppConfigParse(raw: unknown) {
    writeFileSync(configPath(), JSON.stringify(raw));
    return loadConfig();
  }

  it("oauth2.1 requires issuer + audience", () => {
    assert.throws(() => parse({ type: "http", auth: "oauth2.1" }), ConfigError);
  });

  it("rejects a plain-http issuer on a non-localhost host", () => {
    assert.throws(
      () =>
        parse({
          type: "http",
          auth: "oauth2.1",
          oauth: { issuer: "http://auth.example.com", audience: "https://x/mcp" },
        }),
      ConfigError,
    );
  });

  it("accepts https issuer and localhost http issuer", () => {
    const cfg = parse({
      type: "http",
      auth: "oauth2.1",
      oauth: { issuer: "https://auth.example.com", audience: "https://x/mcp" },
    });
    assert.equal(cfg.transport.type, "http");
    const local = parse({
      type: "http",
      auth: "oauth2.1",
      oauth: { issuer: "http://127.0.0.1:9999", audience: "https://x/mcp" },
    });
    assert.equal(local.transport.type, "http");
  });

  it("apikey mode needs no oauth block; defaults are loopback + no remote write", () => {
    const cfg = parse({ type: "http", auth: "apikey" });
    assert.equal(cfg.transport.type, "http");
    if (cfg.transport.type === "http") {
      assert.equal(cfg.transport.bind, "127.0.0.1");
      assert.equal(cfg.transport.allowRemoteWrite, false);
      assert.equal(cfg.transport.port, 8765);
    }
  });
});

describe("confirmation matching", () => {
  const cfg = defaultConfig();

  it("matches exact, action-wildcard, and module-wildcard rules", () => {
    assert.equal(needsConfirmation(cfg, "mail.send"), true);
    assert.equal(needsConfirmation(cfg, "messages.send"), true);
    assert.equal(needsConfirmation(cfg, "calendar.delete"), true); // *.delete
    assert.equal(needsConfirmation(cfg, "calendar.create"), false);
    assert.equal(needsConfirmation(cfg, "notes.read"), false);
  });

  it("fails closed on malformed action ids", () => {
    assert.equal(needsConfirmation(cfg, "not-an-action-id"), true);
  });
});
