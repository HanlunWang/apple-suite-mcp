/**
 * Contacts + notes modules over an in-memory MCP connection with fake
 * backends — gating, _untrusted marking, and byte-identical payload flow.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

import { defaultConfig } from "../../src/config.ts";
import type { HelperClient } from "../../src/native/client.ts";
import { createContactsModule } from "../../src/modules/contacts/module.ts";
import { createNotesModule } from "../../src/modules/notes/module.ts";
import { registerEnabledModules } from "../../src/registry.ts";

const CONTACT = {
  id: "c-1",
  givenName: "Ada",
  familyName: "Lovelace",
  fullName: "Ada Lovelace",
  emails: [{ label: "home", value: "ada@example.test" }],
  phones: [],
};

class FakeBackend implements HelperClient {
  calls: Array<{ op: string; args: unknown }> = [];
  async call<T>(op: string, args?: Record<string, unknown>): Promise<T> {
    this.calls.push({ op, args });
    switch (op) {
      case "contacts.search": return [CONTACT] as T;
      case "contacts.get": return CONTACT as T;
      case "contacts.create": return { ...CONTACT, givenName: (args as { givenName: string }).givenName } as T;
      case "notes.list_folders": return [{ id: "f-1", name: "Ideas" }] as T;
      case "notes.list":
      case "notes.search":
        return [{ id: "n-1", name: "untrusted note", folder: "Ideas", modified: null }] as T;
      case "notes.get":
        return { id: "n-1", name: "untrusted note", folder: "Ideas", plaintext: "body", modified: null } as T;
      case "notes.create": return { id: "n-2", name: (args as { title: string }).title, folder: null } as T;
      default: throw new Error(`fake backend: unknown op ${op}`);
    }
  }
  close(): void {}
}

async function connect(mode: "read" | "write", backend: FakeBackend) {
  const cfg = defaultConfig();
  cfg.capabilityTools = false;
  cfg.modules.contacts = { enabled: true, mode };
  cfg.modules.notes = { enabled: true, mode };
  const server = new McpServer({ name: "t", version: "0" });
  await registerEnabledModules(server, cfg, {
    contacts: async () => createContactsModule(backend),
    notes: async () => createNotesModule(backend),
  });
  const client = new Client({ name: "t", version: "0" });
  const [ct, st] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(st), client.connect(ct)]);
  return client;
}

describe("contacts + notes modules", () => {
  it("read mode: read tools only; no backend calls at registration", async () => {
    const backend = new FakeBackend();
    const client = await connect("read", backend);
    const names = (await client.listTools()).tools.map((t) => t.name).sort();
    assert.deepEqual(names, [
      "contacts_get", "contacts_search",
      "notes_get", "notes_list", "notes_list_folders", "notes_search",
    ]);
    assert.deepEqual(backend.calls, []);
  });

  it("write mode adds the create tools", async () => {
    const client = await connect("write", new FakeBackend());
    const names = (await client.listTools()).tools.map((t) => t.name);
    assert.ok(names.includes("contacts_create"));
    assert.ok(names.includes("notes_create"));
  });

  it("reads carry _untrusted; hostile query reaches backend verbatim", async () => {
    const backend = new FakeBackend();
    const client = await connect("read", backend);
    const hostile = `x" & (do shell script "rm -rf ~") & "`;
    const result = await client.callTool({
      name: "contacts_search",
      arguments: { query: hostile },
    });
    const structured = result.structuredContent as { _untrusted: boolean };
    assert.equal(structured._untrusted, true);
    assert.equal((backend.calls[0]?.args as { query: string }).query, hostile);
  });

  it("note body flows to the fixed template verbatim (no transport rewriting)", async () => {
    const backend = new FakeBackend();
    const client = await connect("write", backend);
    const body = "line1\n<script>alert(1)</script>\nMeeting\\";
    await client.callTool({
      name: "notes_create",
      arguments: { title: "t", body },
    });
    const create = backend.calls.find((c) => c.op === "notes.create");
    assert.equal((create?.args as { body: string }).body, body);
  });

  it("backend permission errors surface as tool errors with hints", async () => {
    const backend = new FakeBackend();
    backend.call = async () => {
      throw new Error("Contacts access is not granted (System Settings → Privacy)");
    };
    const client = await connect("read", backend);
    const result = await client.callTool({ name: "contacts_get", arguments: { id: "c-1" } });
    assert.equal(result.isError, true);
    assert.match((result.content as Array<{ text: string }>)[0]?.text ?? "", /System Settings/);
  });
});
