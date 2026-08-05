/**
 * Resource surface contract: every resource a client can discover must also
 * be readable. Shipping 1.0.0 with this untested meant all seven
 * parameterized resources threw on read and none of the eleven appeared in
 * resources/list — invisible because the only two prior tests read
 * zero-parameter URIs through a fake module that ignored params.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

import { type AppConfig, MODULE_IDS, defaultConfig } from "../../src/config.ts";
import type { HelperClient } from "../../src/native/client.ts";
import { createCalendarModule } from "../../src/modules/calendar/module.ts";
import { createContactsModule } from "../../src/modules/contacts/module.ts";
import { createMailModule } from "../../src/modules/mail/module.ts";
import { createMapsModule } from "../../src/modules/maps/module.ts";
import { createMessagesModule } from "../../src/modules/messages/module.ts";
import { createMusicModule } from "../../src/modules/music/module.ts";
import { createNotesModule } from "../../src/modules/notes/module.ts";
import { createPhotosModule } from "../../src/modules/photos/module.ts";
import { createRemindersModule } from "../../src/modules/reminders/module.ts";
import { createShortcutsModule } from "../../src/modules/shortcuts/module.ts";
import { type ModuleLoader, registerEnabledModules } from "../../src/registry.ts";

/** Echoes the request back so we can assert what the backend received. */
class EchoBackend implements HelperClient {
  calls: Array<{ op: string; args: Record<string, unknown> }> = [];
  async call<T>(op: string, args: Record<string, unknown> = {}): Promise<T> {
    this.calls.push({ op, args });
    return { op, args } as T;
  }
  close(): void {}
}

function allModulesConfig(): AppConfig {
  const cfg = defaultConfig();
  cfg.capabilityTools = false;
  cfg.cache = { readTtlSeconds: 0, maxEntries: 100 };
  for (const id of MODULE_IDS) cfg.modules[id] = { enabled: true, mode: "read" };
  return cfg;
}

function loaders(backend: EchoBackend): Partial<Record<string, ModuleLoader>> {
  return {
    calendar: async () => createCalendarModule(backend),
    reminders: async () => createRemindersModule(backend),
    contacts: async () => createContactsModule(backend),
    notes: async () => createNotesModule(backend),
    mail: async () => createMailModule(backend),
    messages: async () => createMessagesModule(backend, backend),
    maps: async () => createMapsModule(backend),
    photos: async () => createPhotosModule(backend),
    music: async () => createMusicModule(backend),
    shortcuts: async () => createShortcutsModule(backend),
  };
}

async function connect(backend: EchoBackend) {
  const server = new McpServer({ name: "t", version: "0" });
  await registerEnabledModules(server, allModulesConfig(), loaders(backend) as never);
  const client = new Client({ name: "t", version: "0" });
  const [ct, st] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(st), client.connect(ct)]);
  return client;
}

describe("resource surface", () => {
  it("resources/list is non-empty", async () => {
    const client = await connect(new EchoBackend());
    const { resources } = await client.listResources();
    assert.ok(resources.length > 0, "no resource is discoverable via resources/list");
  });

  it("EVERY listed resource is readable and returns the _untrusted envelope", async () => {
    const client = await connect(new EchoBackend());
    const { resources } = await client.listResources();
    for (const r of resources) {
      const res = await client.readResource({ uri: r.uri });
      const first = res.contents[0];
      assert.ok(first && typeof first.text === "string", `${r.uri} returned no text`);
      const body = JSON.parse(first.text as string) as { _untrusted: boolean };
      assert.equal(body._untrusted, true, `${r.uri} is missing the _untrusted marker`);
    }
  });

  it("resources declare concrete URIs, so none are hidden behind an unusable template", async () => {
    const client = await connect(new EchoBackend());
    const { resourceTemplates } = await client.listResourceTemplates();
    // The SDK compiles every {?a,b} variable into a REQUIRED regex segment, so
    // a template only matches when the client supplies all of them in order.
    // Any template we register must therefore also be listed concretely.
    const { resources } = await client.listResources();
    for (const t of resourceTemplates) {
      assert.ok(
        resources.some((r) => t.uriTemplate.startsWith(r.uri)),
        `template ${t.uriTemplate} has no concrete counterpart in resources/list`,
      );
    }
  });

  it("reads reach the backend with validated, typed arguments", async () => {
    const backend = new EchoBackend();
    const client = await connect(backend);
    await client.readResource({ uri: "calendar://events" });
    const call = backend.calls.find((c) => c.op === "calendar.list_events");
    assert.ok(call, "calendar://events did not reach the backend");
    // Defaults applied, and the date window is real ISO 8601 — not undefined.
    assert.equal(typeof call.args["limit"], "number");
    assert.match(String(call.args["from"]), /^\d{4}-\d{2}-\d{2}T/);
    assert.match(String(call.args["to"]), /^\d{4}-\d{2}-\d{2}T/);
  });
});

describe("module load failures are isolated", () => {
  it("a module whose backend is unavailable does not take down the server", async () => {
    const cfg = allModulesConfig();
    const backend = new EchoBackend();
    const server = new McpServer({ name: "t", version: "0" });
    const broken: Partial<Record<string, ModuleLoader>> = {
      ...loaders(backend),
      // Simulates an unbuilt Swift helper: the client constructor throws.
      calendar: async () => {
        throw new Error("eventkit-helper binary not found");
      },
    };
    await registerEnabledModules(server, cfg, broken as never);
    const client = new Client({ name: "t", version: "0" });
    const [ct, st] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(st), client.connect(ct)]);

    const names = (await client.listTools()).tools.map((t) => t.name);
    assert.ok(!names.some((n) => n.startsWith("calendar_")), "broken module must be skipped");
    assert.ok(names.includes("notes_list"), "healthy modules must still be registered");
  });
});
