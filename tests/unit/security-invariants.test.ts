/**
 * Regression tests for the security defects found reviewing 1.0.0. Each of
 * these was reproducible before the fix, so each test fails if the property
 * is ever weakened again.
 */
import { afterEach, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { ElicitRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";

import {
  CONFIRMATION_FLOOR,
  configPath,
  defaultConfig,
  loadConfig,
  needsConfirmation,
} from "../../src/config.ts";
import { redact } from "../../src/logger.ts";
import type { AppModule } from "../../src/modules/_template/module.ts";
import { registerEnabledModules } from "../../src/registry.ts";

const CLI = join(import.meta.dirname, "..", "..", "cli", "index.ts");

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "apple-mcp-sec-"));
  process.env["APPLE_MCP_CONFIG_DIR"] = dir;
});
afterEach(() => {
  delete process.env["APPLE_MCP_CONFIG_DIR"];
  rmSync(dir, { recursive: true, force: true });
});

function runCli(args: string[]): { stdout: string; stderr: string; status: number } {
  const r = spawnSync(process.execPath, [CLI, ...args], {
    env: { ...process.env, APPLE_MCP_CONFIG_DIR: dir },
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  return { stdout: r.stdout ?? "", stderr: r.stderr ?? "", status: r.status ?? 1 };
}

describe("confirmation floor cannot be removed by config", () => {
  it("an empty requireConfirmation list still gates sends, runs, and deletes", () => {
    writeFileSync(
      configPath(),
      JSON.stringify({ version: 1, modules: {}, requireConfirmation: [] }),
    );
    const cfg = loadConfig();
    assert.deepEqual(cfg.requireConfirmation, [], "config value is preserved as written");
    for (const action of ["mail.send", "messages.send", "shortcuts.run", "calendar.delete"]) {
      assert.equal(needsConfirmation(cfg, action), true, `${action} must stay gated`);
    }
  });

  it("config can still ADD rules on top of the floor", () => {
    writeFileSync(
      configPath(),
      JSON.stringify({ version: 1, modules: {}, requireConfirmation: ["calendar.create"] }),
    );
    const cfg = loadConfig();
    assert.equal(needsConfirmation(cfg, "calendar.create"), true);
    assert.equal(needsConfirmation(cfg, "mail.send"), true);
    assert.equal(needsConfirmation(cfg, "calendar.list"), false);
  });

  it("the floor covers every outward-sending and destructive action", () => {
    assert.deepEqual([...CONFIRMATION_FLOOR].sort(), [
      "*.delete",
      "mail.send",
      "messages.send",
      "shortcuts.run",
    ]);
  });
});

describe("approve never grants more than the human typed", () => {
  it("a model-requested write is downgraded to read without --write", () => {
    runCli(["enable", "notes"]); // ensure a config exists
    writeFileSync(
      join(dir, "pending.json"),
      JSON.stringify({
        version: 1,
        requests: { messages: { mode: "write", requestedAt: "2026-01-01T00:00:00Z" } },
      }),
    );
    const { status, stderr } = runCli(["approve", "messages", "--yes"]);
    assert.equal(status, 0);
    assert.match(stderr, /asked for READ\/WRITE/, "the downgrade must be surfaced");
    const cfg = JSON.parse(readFileSync(configPath(), "utf8")) as {
      modules: Record<string, { mode: string }>;
    };
    assert.equal(cfg.modules["messages"]?.mode, "read", "write must require an explicit --write");
  });

  it("--write honors the request and states what write means", () => {
    runCli(["enable", "notes"]);
    writeFileSync(
      join(dir, "pending.json"),
      JSON.stringify({
        version: 1,
        requests: { messages: { mode: "write", requestedAt: "2026-01-01T00:00:00Z" } },
      }),
    );
    const { status, stderr } = runCli(["approve", "messages", "--write", "--yes"]);
    assert.equal(status, 0);
    assert.match(stderr, /SENDING iMessages/, "the prompt must name the real capability");
    const cfg = JSON.parse(readFileSync(configPath(), "utf8")) as {
      modules: Record<string, { mode: string }>;
    };
    assert.equal(cfg.modules["messages"]?.mode, "write");
  });

  it("enabling shortcuts for write warns that shortcuts run arbitrary automation", () => {
    const { stderr } = runCli(["enable", "shortcuts", "--write", "--yes"]);
    assert.match(stderr, /full privileges/i);
  });
});

describe("log redaction covers free-text error fields", () => {
  it("scrubs phone numbers and emails out of error/hint values", () => {
    const out = redact({
      error: "no iMessage buddy with handle: +15551234567",
      hint: "try alice@example.com instead",
      tool: "messages_send",
    }) as Record<string, string>;
    assert.ok(!out["error"]?.includes("15551234567"), `phone leaked: ${out["error"]}`);
    assert.ok(!out["hint"]?.includes("alice@example.com"), `email leaked: ${out["hint"]}`);
    assert.equal(out["tool"], "messages_send", "non-sensitive fields stay readable");
  });

  it("still redacts whole values for content-bearing keys", () => {
    const out = redact({ body: "secret text", subject: "hello" }) as Record<string, string>;
    assert.equal(out["body"], "[redacted]");
    assert.equal(out["subject"], "[redacted]");
  });
});

describe("input is validated before the user is asked to confirm", () => {
  function sendModule(executed: string[]): AppModule {
    const schema = z.object({ to: z.array(z.email()).min(1), body: z.string().min(1) });
    return {
      id: "mail",
      resources: () => [],
      tools: () => [
        {
          name: "mail_send",
          description: "send",
          inputSchema: { to: z.array(z.string()), body: z.string() },
          mode: "write",
          actionId: "mail.send",
          validate: (input) => void schema.parse(input),
          confirmPreview: () => "preview",
          run: async () => {
            executed.push("sent");
            return { sent: true };
          },
        },
      ],
    };
  }

  it("invalid input fails without ever raising an elicitation", async () => {
    const executed: string[] = [];
    const elicitations: unknown[] = [];
    const cfg = defaultConfig();
    cfg.capabilityTools = false;
    cfg.modules.mail = { enabled: true, mode: "write" };
    const server = new McpServer({ name: "t", version: "0" });
    await registerEnabledModules(server, cfg, { mail: async () => sendModule(executed) });
    const client = new Client({ name: "t", version: "0" }, { capabilities: { elicitation: {} } });
    client.setRequestHandler(ElicitRequestSchema, (async (req: { params: unknown }) => {
      elicitations.push(req.params);
      return { action: "accept", content: { confirm: true } };
    }) as never);
    const [ct, st] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(st), client.connect(ct)]);

    const result = await client.callTool({
      name: "mail_send",
      arguments: { to: ["not-an-email"], body: "x" },
    });
    assert.equal(result.isError, true);
    assert.deepEqual(executed, [], "must not send");
    assert.deepEqual(elicitations, [], "must not interrupt the user for a doomed action");
  });
});
