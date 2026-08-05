/**
 * Maps / photos / music / shortcuts modules over an in-memory MCP
 * connection with fake backends. The load-bearing assertions: shortcuts_run
 * never executes without confirmation, and shortcuts stays off the remote
 * surface.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { ElicitRequestSchema } from "@modelcontextprotocol/sdk/types.js";

import { type AppConfig, TransportConfig, defaultConfig } from "../../src/config.ts";
import type { HelperClient } from "../../src/native/client.ts";
import { createMapsModule } from "../../src/modules/maps/module.ts";
import { createMusicModule } from "../../src/modules/music/module.ts";
import { createPhotosModule } from "../../src/modules/photos/module.ts";
import { createShortcutsModule } from "../../src/modules/shortcuts/module.ts";
import { type ModuleLoader, registerEnabledModules } from "../../src/registry.ts";

class FakeBackend implements HelperClient {
  calls: Array<{ op: string; args: unknown }> = [];
  async call<T>(op: string, args?: Record<string, unknown>): Promise<T> {
    this.calls.push({ op, args });
    switch (op) {
      case "maps.search":
        return [{ name: "Place", latitude: 1, longitude: 2 }] as T;
      case "maps.directions":
        return {
          name: "Route", distanceMeters: 100, travelTimeSeconds: 60,
          transport: "driving", steps: ["go"],
        } as T;
      case "photos.list_albums": return [{ id: "a1", title: "Trip", count: 3 }] as T;
      case "photos.list":
        return [{ id: "p1", mediaType: "image", favorite: false, width: 4, height: 3 }] as T;
      case "music.now_playing": return { state: "playing" } as T;
      case "music.search": return [] as T;
      case "music.play":
      case "music.pause":
      case "music.next":
      case "music.previous":
      case "music.play_track":
        return { state: "playing" } as T;
      case "shortcuts.list": return { shortcuts: ["Morning Routine"] } as T;
      case "shortcuts.run": return { ran: true, output: "done" } as T;
      default: throw new Error(`unknown op ${op}`);
    }
  }
  close(): void {}
}

function loaders(backend: FakeBackend): Partial<Record<string, ModuleLoader>> {
  return {
    maps: async () => createMapsModule(backend),
    photos: async () => createPhotosModule(backend),
    music: async () => createMusicModule(backend),
    shortcuts: async () => createShortcutsModule(backend),
  };
}

function baseConfig(mode: "read" | "write"): AppConfig {
  const cfg = defaultConfig();
  cfg.capabilityTools = false;
  cfg.cache = { readTtlSeconds: 0, maxEntries: 100 };
  for (const id of ["maps", "photos", "music", "shortcuts"] as const) {
    cfg.modules[id] = { enabled: true, mode };
  }
  return cfg;
}

async function connect(opts: {
  cfg: AppConfig;
  backend: FakeBackend;
  elicit?: "accept" | "decline";
  remote?: boolean;
}) {
  const server = new McpServer({ name: "t", version: "0" });
  await registerEnabledModules(server, opts.cfg, loaders(opts.backend) as never, {
    remote: opts.remote === true,
  });
  const client = new Client(
    { name: "t", version: "0" },
    { capabilities: opts.elicit ? { elicitation: {} } : {} },
  );
  if (opts.elicit) {
    client.setRequestHandler(ElicitRequestSchema, (async () =>
      opts.elicit === "accept"
        ? { action: "accept", content: { confirm: true } }
        : { action: "decline" }) as never);
  }
  const [ct, st] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(st), client.connect(ct)]);
  return client;
}

describe("M5 modules", () => {
  it("read mode exposes read tools across all four modules", async () => {
    const client = await connect({ cfg: baseConfig("read"), backend: new FakeBackend() });
    const names = (await client.listTools()).tools.map((t) => t.name).sort();
    assert.deepEqual(names, [
      "maps_directions", "maps_search_places",
      "music_now_playing", "music_search",
      "photos_list", "photos_list_albums",
      "shortcuts_list",
    ]);
  });

  it("maps and photos have no write tools even in write mode", async () => {
    const client = await connect({ cfg: baseConfig("write"), backend: new FakeBackend() });
    const names = (await client.listTools()).tools.map((t) => t.name);
    assert.ok(!names.some((n) => n.startsWith("maps_") && n !== "maps_search_places" && n !== "maps_directions"));
    assert.ok(!names.some((n) => n.startsWith("photos_") && !n.startsWith("photos_list")));
    // Music controls DO appear in write mode.
    assert.ok(names.includes("music_play"));
    assert.ok(names.includes("music_play_track"));
  });

  it("maps results carry the _untrusted marker", async () => {
    const client = await connect({ cfg: baseConfig("read"), backend: new FakeBackend() });
    const result = await client.callTool({
      name: "maps_search_places",
      arguments: { query: "coffee" },
    });
    const structured = result.structuredContent as { _untrusted: boolean; places: unknown[] };
    assert.equal(structured._untrusted, true);
    assert.equal(structured.places.length, 1);
  });

  it("music controls run without confirmation (no user data, no send)", async () => {
    const backend = new FakeBackend();
    const client = await connect({ cfg: baseConfig("write"), backend });
    const result = await client.callTool({ name: "music_pause", arguments: {} });
    assert.notEqual(result.isError, true);
    assert.equal(backend.calls[0]?.op, "music.pause");
  });

  it("shortcuts_run: declined confirmation → CLI never invoked", async () => {
    const backend = new FakeBackend();
    const client = await connect({ cfg: baseConfig("write"), backend, elicit: "decline" });
    const result = await client.callTool({
      name: "shortcuts_run",
      arguments: { name: "Morning Routine" },
    });
    assert.equal(result.isError, true);
    assert.deepEqual(backend.calls, [], "a shortcut must never run without consent");
  });

  it("shortcuts_run: no elicitation support → refused", async () => {
    const backend = new FakeBackend();
    const client = await connect({ cfg: baseConfig("write"), backend });
    const result = await client.callTool({
      name: "shortcuts_run",
      arguments: { name: "Morning Routine" },
    });
    assert.equal(result.isError, true);
    assert.deepEqual(backend.calls, []);
  });

  it("shortcuts_run: accepted → runs with the name passed through verbatim", async () => {
    const backend = new FakeBackend();
    const client = await connect({ cfg: baseConfig("write"), backend, elicit: "accept" });
    const hostile = 'Routine"; rm -rf ~; echo "';
    const result = await client.callTool({
      name: "shortcuts_run",
      arguments: { name: hostile, input: "payload" },
    });
    assert.notEqual(result.isError, true);
    assert.equal(backend.calls[0]?.op, "shortcuts.run");
    assert.equal((backend.calls[0]?.args as { name: string }).name, hostile);
  });

  it("shortcuts is never registered for remote sessions", async () => {
    const cfg = baseConfig("write");
    cfg.transport = TransportConfig.parse({ type: "http", auth: "apikey", allowRemoteWrite: true });
    const client = await connect({ cfg, backend: new FakeBackend(), remote: true });
    const names = (await client.listTools()).tools.map((t) => t.name);
    assert.ok(!names.some((n) => n.startsWith("shortcuts_")), "shortcuts must be local-only");
    // …while maps/photos/music remain available remotely.
    assert.ok(names.includes("maps_search_places"));
  });
});

describe("read cache", () => {
  it("serves repeat reads from cache and drops them after a write", async () => {
    const cfg = baseConfig("write");
    cfg.cache = { readTtlSeconds: 30, maxEntries: 100 };
    const backend = new FakeBackend();
    const client = await connect({ cfg, backend });

    await client.callTool({ name: "music_now_playing", arguments: {} });
    await client.callTool({ name: "music_now_playing", arguments: {} });
    assert.equal(
      backend.calls.filter((c) => c.op === "music.now_playing").length,
      1,
      "second identical read should hit the cache",
    );

    // A write to the same module invalidates it.
    await client.callTool({ name: "music_pause", arguments: {} });
    await client.callTool({ name: "music_now_playing", arguments: {} });
    assert.equal(
      backend.calls.filter((c) => c.op === "music.now_playing").length,
      2,
      "cache must be invalidated by a write",
    );
  });
});
