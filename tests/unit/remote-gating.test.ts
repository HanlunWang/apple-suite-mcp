/**
 * Remote minimal-surface gating (DESIGN.md §4): what a remote session can
 * see, compared to a local one, from the SAME config.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { z } from "zod";

import { type AppConfig, TransportConfig, defaultConfig } from "../../src/config.ts";
import type { AppModule } from "../../src/modules/_template/module.ts";
import { type ModuleLoader, registerEnabledModules } from "../../src/registry.ts";

function fakeModule(id: string): AppModule {
  return {
    id,
    resources: () => [],
    tools: (mode) => {
      const tools = [
        {
          name: `${id}_read`,
          description: "read",
          inputSchema: {},
          mode: "read" as const,
          actionId: `${id}.list`,
          run: async () => ({ ok: true }),
        },
        {
          name: `${id}_write`,
          description: "write",
          inputSchema: { x: z.string() },
          mode: "write" as const,
          actionId: `${id}.create`,
          run: async () => ({ ok: true }),
        },
      ];
      return mode === "write" ? tools : tools.filter((t) => t.mode === "read");
    },
  };
}

const LOADERS: Partial<Record<string, ModuleLoader>> = {
  calendar: async () => fakeModule("calendar"),
  mail: async () => fakeModule("mail"),
  messages: async () => fakeModule("messages"),
};

function httpConfig(allowRemoteWrite: boolean): AppConfig {
  const cfg = defaultConfig();
  cfg.capabilityTools = false;
  cfg.modules.calendar = { enabled: true, mode: "write" };
  cfg.modules.mail = { enabled: true, mode: "write" };
  cfg.modules.messages = { enabled: true, mode: "write" };
  cfg.transport = TransportConfig.parse({ type: "http", auth: "apikey", allowRemoteWrite });
  return cfg;
}

async function toolNames(cfg: AppConfig, remote: boolean): Promise<string[]> {
  const server = new McpServer({ name: "t", version: "0" });
  await registerEnabledModules(server, cfg, LOADERS as never, { remote });
  const client = new Client({ name: "t", version: "0" });
  const [ct, st] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(st), client.connect(ct)]);
  return (await client.listTools()).tools.map((t) => t.name).sort();
}

describe("remote minimal surface", () => {
  it("local sessions see everything the config allows", async () => {
    assert.deepEqual(await toolNames(httpConfig(false), false), [
      "calendar_read", "calendar_write",
      "mail_read", "mail_write",
      "messages_read", "messages_write",
    ]);
  });

  it("remote sessions: high-risk modules vanish, writes degrade to read", async () => {
    assert.deepEqual(await toolNames(httpConfig(false), true), ["calendar_read"]);
  });

  it("allowRemoteWrite=true restores writes but NEVER the blocked modules", async () => {
    assert.deepEqual(await toolNames(httpConfig(true), true), [
      "calendar_read", "calendar_write",
    ]);
  });
});
