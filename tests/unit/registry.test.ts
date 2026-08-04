/**
 * Registration-time gating, end-to-end over an in-memory MCP connection:
 * what the client can actually LIST is the security boundary.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { ElicitRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";

import { defaultConfig } from "../../src/config.ts";
import type { AppModule } from "../../src/modules/_template/module.ts";
import { registerEnabledModules } from "../../src/registry.ts";
import { SERVER_NAME, SERVER_VERSION } from "../../src/version.ts";

/** Fake calendar module: one resource, one read tool, one confirmable write tool. */
function fakeCalendarModule(executed: string[]): AppModule {
  return {
    id: "calendar",
    resources: () => [
      {
        uriTemplate: "calendar://events",
        name: "calendar-events",
        description: "events",
        read: async () => [{ title: "untrusted event" }],
      },
    ],
    tools: () => [
      {
        name: "calendar_list_events",
        description: "list",
        inputSchema: {},
        mode: "read",
        actionId: "calendar.list",
        run: async () => {
          executed.push("list");
          return { ok: true };
        },
      },
      {
        name: "calendar_delete_event",
        description: "delete",
        inputSchema: { id: z.string() },
        mode: "write",
        actionId: "calendar.delete",
        confirmPreview: (input) => `Delete event ${String(input["id"])}`,
        run: async () => {
          executed.push("delete");
          return { deleted: true };
        },
      },
    ],
  };
}

async function connect(
  cfg = defaultConfig(),
  executed: string[] = [],
  clientCapabilities: Record<string, object> = {},
  onElicit?: (params: unknown) => Promise<unknown>,
) {
  const server = new McpServer({ name: SERVER_NAME, version: SERVER_VERSION });
  await registerEnabledModules(server, cfg, {
    calendar: async () => fakeCalendarModule(executed),
  });
  const client = new Client(
    { name: "test-client", version: "0.0.0" },
    { capabilities: clientCapabilities },
  );
  if (onElicit) {
    client.setRequestHandler(ElicitRequestSchema, (async (req: { params: unknown }) =>
      onElicit(req.params)) as never);
  }
  const [ct, st] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(st), client.connect(ct)]);
  return { client, server };
}

/** Module tools only — the always-on capabilities_* meta tools are covered
 *  in capabilities.test.ts. */
const moduleTools = (names: string[]) => names.filter((n) => !n.startsWith("capabilities_"));

describe("registration-time gating", () => {
  it("disabled module: client sees only the meta tools, zero module surface", async () => {
    const { client } = await connect(); // default config: all disabled
    const names = (await client.listTools()).tools.map((t) => t.name).sort();
    assert.deepEqual(names, ["capabilities_list", "capabilities_request_enable"]);
    const templates = await client.listResourceTemplates();
    assert.deepEqual(templates.resourceTemplates, []);
  });

  it("capabilityTools=false: truly zero tools", async () => {
    const cfg = defaultConfig();
    cfg.capabilityTools = false;
    const { client } = await connect(cfg);
    assert.deepEqual((await client.listTools()).tools, []);
  });

  it("read mode: read tools + resources visible, write tools absent", async () => {
    const cfg = defaultConfig();
    cfg.modules.calendar = { enabled: true, mode: "read" };
    const { client } = await connect(cfg);
    const names = moduleTools((await client.listTools()).tools.map((t) => t.name));
    assert.deepEqual(names, ["calendar_list_events"]);
    const templates = await client.listResourceTemplates();
    assert.equal(templates.resourceTemplates.length, 1);
  });

  it("write mode: write tools become visible", async () => {
    const cfg = defaultConfig();
    cfg.modules.calendar = { enabled: true, mode: "write" };
    const { client } = await connect(cfg);
    const names = moduleTools((await client.listTools()).tools.map((t) => t.name)).sort();
    assert.deepEqual(names, ["calendar_delete_event", "calendar_list_events"]);
  });

  it("every tool carries title + readOnlyHint + destructiveHint annotations", async () => {
    const cfg = defaultConfig();
    cfg.modules.calendar = { enabled: true, mode: "write" };
    const { client } = await connect(cfg);
    for (const tool of (await client.listTools()).tools) {
      const a = tool.annotations ?? {};
      assert.equal(typeof a.title, "string", `${tool.name} missing title annotation`);
      assert.equal(typeof a.readOnlyHint, "boolean", `${tool.name} missing readOnlyHint`);
      assert.equal(typeof a.destructiveHint, "boolean", `${tool.name} missing destructiveHint`);
      if (a.readOnlyHint) assert.equal(a.destructiveHint, false);
    }
  });

  it("resource reads are wrapped with the _untrusted marker", async () => {
    const cfg = defaultConfig();
    cfg.modules.calendar = { enabled: true, mode: "read" };
    const { client } = await connect(cfg);
    const res = await client.readResource({ uri: "calendar://events" });
    const first = res.contents[0];
    assert.ok(first && "text" in first);
    const body = JSON.parse(first.text as string) as { _untrusted: boolean };
    assert.equal(body._untrusted, true);
  });
});

describe("confirmation gate (calendar.delete matches *.delete)", () => {
  it("refuses the action when the client lacks elicitation support", async () => {
    const cfg = defaultConfig();
    cfg.modules.calendar = { enabled: true, mode: "write" };
    const executed: string[] = [];
    const { client } = await connect(cfg, executed);
    const result = await client.callTool({
      name: "calendar_delete_event",
      arguments: { id: "abc" },
    });
    assert.equal(result.isError, true);
    assert.deepEqual(executed, [], "side effect must NOT run without confirmation");
  });

  it("executes after the user accepts the elicitation", async () => {
    const cfg = defaultConfig();
    cfg.modules.calendar = { enabled: true, mode: "write" };
    const executed: string[] = [];
    const { client } = await connect(cfg, executed, { elicitation: {} }, async () => ({
      action: "accept",
      content: { confirm: true },
    }));
    const result = await client.callTool({
      name: "calendar_delete_event",
      arguments: { id: "abc" },
    });
    assert.notEqual(result.isError, true);
    assert.deepEqual(executed, ["delete"]);
  });

  it("does not execute when the user declines", async () => {
    const cfg = defaultConfig();
    cfg.modules.calendar = { enabled: true, mode: "write" };
    const executed: string[] = [];
    const { client } = await connect(cfg, executed, { elicitation: {} }, async () => ({
      action: "decline",
    }));
    const result = await client.callTool({
      name: "calendar_delete_event",
      arguments: { id: "abc" },
    });
    assert.equal(result.isError, true);
    assert.deepEqual(executed, []);
  });

  it("non-confirmable read tool runs without elicitation", async () => {
    const cfg = defaultConfig();
    cfg.modules.calendar = { enabled: true, mode: "read" };
    const executed: string[] = [];
    const { client } = await connect(cfg, executed);
    const result = await client.callTool({ name: "calendar_list_events", arguments: {} });
    assert.notEqual(result.isError, true);
    assert.deepEqual(executed, ["list"]);
  });
});
