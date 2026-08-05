/**
 * Mail + messages modules — the highest-risk paths. The load-bearing
 * assertions: mail_send / messages_send NEVER reach their backends without
 * an accepted elicitation, and both modules stay off the remote surface.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { ElicitRequestSchema } from "@modelcontextprotocol/sdk/types.js";

import { TransportConfig, defaultConfig } from "../../src/config.ts";
import type { HelperClient } from "../../src/native/client.ts";
import { createMailModule } from "../../src/modules/mail/module.ts";
import { createMessagesModule } from "../../src/modules/messages/module.ts";
import { registerEnabledModules } from "../../src/registry.ts";

class FakeBackend implements HelperClient {
  calls: Array<{ op: string; args: unknown }> = [];
  async call<T>(op: string, args?: Record<string, unknown>): Promise<T> {
    this.calls.push({ op, args });
    switch (op) {
      case "mail.list_unread":
      case "mail.search":
        return [] as T;
      case "mail.send":
        return { sent: true, to: (args as { to: string[] }).to, subject: "s" } as T;
      case "messages.list_chats": return [] as T;
      case "messages.list":
      case "messages.search":
        return [] as T;
      case "messages.send":
        return { sent: true, target: "t" } as T;
      default: throw new Error(`unknown op ${op}`);
    }
  }
  close(): void {}
}

async function connect(opts: {
  mode: "read" | "write";
  backend: FakeBackend;
  elicit?: "accept" | "decline";
}) {
  const cfg = defaultConfig();
  cfg.capabilityTools = false;
  cfg.modules.mail = { enabled: true, mode: opts.mode };
  cfg.modules.messages = { enabled: true, mode: opts.mode };
  const server = new McpServer({ name: "t", version: "0" });
  await registerEnabledModules(server, cfg, {
    mail: async () => createMailModule(opts.backend),
    messages: async () => createMessagesModule(opts.backend, opts.backend),
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

describe("mail + messages modules (local sessions)", () => {
  it("read mode: read tools only", async () => {
    const client = await connect({ mode: "read", backend: new FakeBackend() });
    const names = (await client.listTools()).tools.map((t) => t.name).sort();
    assert.deepEqual(names, [
      "mail_list_unread", "mail_search",
      "messages_list", "messages_list_chats", "messages_search",
    ]);
  });

  it("mail_send: declined confirmation → backend NEVER invoked", async () => {
    const backend = new FakeBackend();
    const client = await connect({ mode: "write", backend, elicit: "decline" });
    const result = await client.callTool({
      name: "mail_send",
      arguments: { to: ["a@example.test"], subject: "hi", body: "hello" },
    });
    assert.equal(result.isError, true);
    assert.deepEqual(backend.calls, [], "mail must not be sent without consent");
  });

  it("mail_send: no elicitation support → refused, backend never invoked", async () => {
    const backend = new FakeBackend();
    const client = await connect({ mode: "write", backend });
    const result = await client.callTool({
      name: "mail_send",
      arguments: { to: ["a@example.test"], subject: "hi", body: "hello" },
    });
    assert.equal(result.isError, true);
    assert.deepEqual(backend.calls, []);
  });

  it("mail_send: accepted → body reaches the template verbatim", async () => {
    const backend = new FakeBackend();
    const client = await connect({ mode: "write", backend, elicit: "accept" });
    const hostile = 'line1\n" & (do shell script "id") & "\nMeeting\\';
    const result = await client.callTool({
      name: "mail_send",
      arguments: { to: ["a@example.test"], subject: "hi", body: hostile },
    });
    assert.notEqual(result.isError, true);
    assert.equal(backend.calls[0]?.op, "mail.send");
    assert.equal((backend.calls[0]?.args as { body: string }).body, hostile);
  });

  it("messages_send: declined → backend never invoked; accepted → sends", async () => {
    const declined = new FakeBackend();
    const c1 = await connect({ mode: "write", backend: declined, elicit: "decline" });
    const r1 = await c1.callTool({
      name: "messages_send",
      arguments: { chatGuid: "iMessage;-;+1", body: "hello" },
    });
    assert.equal(r1.isError, true);
    assert.deepEqual(declined.calls, []);

    const accepted = new FakeBackend();
    const c2 = await connect({ mode: "write", backend: accepted, elicit: "accept" });
    const r2 = await c2.callTool({
      name: "messages_send",
      arguments: { chatGuid: "iMessage;-;+1", body: "hello" },
    });
    assert.notEqual(r2.isError, true);
    assert.equal(accepted.calls[0]?.op, "messages.send");
  });

  it("mail_send rejects invalid recipient addresses at the schema boundary", async () => {
    const backend = new FakeBackend();
    const client = await connect({ mode: "write", backend, elicit: "accept" });
    const result = await client.callTool({
      name: "mail_send",
      arguments: { to: ["not-an-email"], subject: "hi", body: "x" },
    });
    assert.equal(result.isError, true);
    assert.deepEqual(backend.calls, []);
  });
});

describe("remote surface (real modules, http config)", () => {
  it("mail and messages are never registered for remote sessions", async () => {
    const cfg = defaultConfig();
    cfg.capabilityTools = false;
    cfg.modules.mail = { enabled: true, mode: "write" };
    cfg.modules.messages = { enabled: true, mode: "write" };
    cfg.transport = TransportConfig.parse({ type: "http", auth: "apikey", allowRemoteWrite: true });
    const backend = new FakeBackend();
    const server = new McpServer({ name: "t", version: "0" });
    await registerEnabledModules(
      server,
      cfg,
      {
        mail: async () => createMailModule(backend),
        messages: async () => createMessagesModule(backend, backend),
      },
      { remote: true },
    );
    const client = new Client({ name: "t", version: "0" });
    const [ct, st] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(st), client.connect(ct)]);
    assert.deepEqual((await client.listTools()).tools, []);
  });
});
