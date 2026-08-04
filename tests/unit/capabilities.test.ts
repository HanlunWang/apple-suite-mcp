/**
 * manage_capabilities meta tools + the CLI approval loop: a request queued by
 * the model must never take effect without the human running `apple-mcp
 * approve` — and the FDA acknowledgement survives the approval path.
 */
import { afterEach, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

import { defaultConfig } from "../../src/config.ts";
import { loadPending, pendingPath } from "../../src/capabilities.ts";
import { registerEnabledModules } from "../../src/registry.ts";

const CLI = join(import.meta.dirname, "..", "..", "cli", "index.ts");

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "apple-mcp-cap-"));
  process.env["APPLE_MCP_CONFIG_DIR"] = dir;
});
afterEach(() => {
  delete process.env["APPLE_MCP_CONFIG_DIR"];
  rmSync(dir, { recursive: true, force: true });
});

function runCli(args: string[]): { stdout: string; status: number } {
  try {
    const stdout = execFileSync(process.execPath, [CLI, ...args], {
      env: { ...process.env, APPLE_MCP_CONFIG_DIR: dir },
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    return { stdout, status: 0 };
  } catch (err) {
    const e = err as { status?: number; stdout?: string };
    return { stdout: e.stdout ?? "", status: e.status ?? 1 };
  }
}

async function connect(opts: { remote: boolean }) {
  const server = new McpServer({ name: "t", version: "0" });
  await registerEnabledModules(server, defaultConfig(), {}, opts);
  const client = new Client({ name: "t", version: "0" });
  const [ct, st] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(st), client.connect(ct)]);
  return client;
}

describe("capabilities meta tools", () => {
  it("capabilities_list shows the matrix without touching any module", async () => {
    const client = await connect({ remote: false });
    const result = await client.callTool({ name: "capabilities_list", arguments: {} });
    const data = result.structuredContent as {
      modules: Record<string, { enabled: boolean; requiresFullDiskAccess: boolean }>;
    };
    assert.equal(data.modules["calendar"]?.enabled, false);
    assert.equal(data.modules["messages"]?.requiresFullDiskAccess, true);
  });

  it("request_enable queues a pending request but does NOT change config", async () => {
    const client = await connect({ remote: false });
    const result = await client.callTool({
      name: "capabilities_request_enable",
      arguments: { module: "calendar", mode: "write" },
    });
    const data = result.structuredContent as { nextStep: string };
    assert.match(data.nextStep, /apple-mcp approve calendar/);

    // pending recorded…
    assert.equal(loadPending().requests.calendar?.mode, "write");
    // …but the live config is untouched (still disabled).
    const { stdout } = runCli(["status"]);
    assert.match(stdout, /calendar\s+disabled/);
  });

  it("the request tool is NOT registered for remote sessions", async () => {
    const client = await connect({ remote: true });
    const names = (await client.listTools()).tools.map((t) => t.name);
    assert.ok(names.includes("capabilities_list"));
    assert.ok(!names.includes("capabilities_request_enable"));
  });
});

describe("CLI approval loop", () => {
  it("pending → approve applies the requested mode and clears the queue", async () => {
    const client = await connect({ remote: false });
    await client.callTool({
      name: "capabilities_request_enable",
      arguments: { module: "reminders", mode: "write" },
    });

    assert.match(runCli(["pending"]).stdout, /reminders\s+write/);
    assert.equal(runCli(["approve", "reminders"]).status, 0);

    const cfg = JSON.parse(readFileSync(join(dir, "config.json"), "utf8")) as {
      modules: Record<string, { enabled: boolean; mode: string }>;
    };
    assert.deepEqual(cfg.modules["reminders"], { enabled: true, mode: "write" });
    assert.ok(!existsSync(pendingPath()), "pending file cleared");
  });

  it("reject discards without enabling", async () => {
    const client = await connect({ remote: false });
    await client.callTool({
      name: "capabilities_request_enable",
      arguments: { module: "notes" },
    });
    assert.equal(runCli(["reject", "notes"]).status, 0);
    assert.equal(loadPending().requests.notes, undefined);
    assert.match(runCli(["status"]).stdout, /notes\s+disabled/);
  });

  it("approving the FDA module still demands acknowledgement", async () => {
    const client = await connect({ remote: false });
    await client.callTool({
      name: "capabilities_request_enable",
      arguments: { module: "messages", mode: "write" },
    });
    // Non-interactive without --yes must refuse.
    assert.notEqual(runCli(["approve", "messages"]).status, 0);
    assert.equal(loadPending().requests.messages?.mode, "write", "request stays queued");
    // Explicit acknowledgement applies it.
    assert.equal(runCli(["approve", "messages", "--yes"]).status, 0);
    const cfg = JSON.parse(readFileSync(join(dir, "config.json"), "utf8")) as {
      modules: Record<string, { enabled: boolean; mode: string }>;
    };
    assert.deepEqual(cfg.modules["messages"], { enabled: true, mode: "write" });
  });

  it("approve without a pending request fails", () => {
    assert.notEqual(runCli(["approve", "calendar"]).status, 0);
  });
});
