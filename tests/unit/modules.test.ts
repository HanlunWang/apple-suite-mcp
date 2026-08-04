/**
 * Calendar + reminders modules over a real in-memory MCP connection,
 * with a fake helper client — verifies gating, schemas, the _untrusted
 * marker, and that deletion never reaches the helper without confirmation.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { ElicitRequestSchema } from "@modelcontextprotocol/sdk/types.js";

import { defaultConfig } from "../../src/config.ts";
import type { HelperClient } from "../../src/native/eventkit.ts";
import { createCalendarModule } from "../../src/modules/calendar/module.ts";
import { createRemindersModule } from "../../src/modules/reminders/module.ts";
import { registerEnabledModules } from "../../src/registry.ts";

const EVENT = {
  id: "evt-1",
  title: "untrusted title",
  start: "2026-01-01T10:00:00Z",
  end: "2026-01-01T11:00:00Z",
  allDay: false,
  calendarId: "cal-1",
  calendarTitle: "Personal",
};

const REMINDER = {
  id: "rem-1",
  title: "untrusted reminder",
  listId: "list-1",
  listTitle: "Inbox",
  completed: false,
  priority: "none",
};

class FakeHelper implements HelperClient {
  calls: Array<{ op: string; args: unknown }> = [];
  async call<T>(op: string, args?: Record<string, unknown>): Promise<T> {
    this.calls.push({ op, args });
    switch (op) {
      case "calendar.list_events": return [EVENT] as T;
      case "calendar.list_calendars":
        return [{ id: "cal-1", title: "Personal", editable: true, kind: "event" }] as T;
      case "calendar.create_event": return { ...EVENT, title: (args as { title: string }).title } as T;
      case "calendar.delete_event": return { deleted: true } as T;
      case "reminders.list": return [REMINDER] as T;
      case "reminders.list_lists":
        return [{ id: "list-1", title: "Inbox", editable: true, kind: "reminder" }] as T;
      case "reminders.create": return { ...REMINDER, title: (args as { title: string }).title } as T;
      case "reminders.complete": return { ...REMINDER, completed: true } as T;
      case "reminders.delete": return { deleted: true } as T;
      default: throw new Error(`fake helper: unknown op ${op}`);
    }
  }
  close(): void {}
}

async function connect(opts: {
  mode: "read" | "write";
  helper: FakeHelper;
  elicit?: "accept" | "decline";
}) {
  const cfg = defaultConfig();
  cfg.modules.calendar = { enabled: true, mode: opts.mode };
  cfg.modules.reminders = { enabled: true, mode: opts.mode };
  const server = new McpServer({ name: "test", version: "0.0.0" });
  await registerEnabledModules(server, cfg, {
    calendar: async () => createCalendarModule(opts.helper),
    reminders: async () => createRemindersModule(opts.helper),
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

describe("calendar + reminders modules", () => {
  it("read mode exposes only read tools; enabling spawns no helper call", async () => {
    const helper = new FakeHelper();
    const client = await connect({ mode: "read", helper });
    const names = (await client.listTools()).tools
      .map((t) => t.name)
      .filter((n) => !n.startsWith("capabilities_"))
      .sort();
    assert.deepEqual(names, [
      "calendar_list_calendars",
      "calendar_list_events",
      "reminders_list",
      "reminders_list_lists",
    ]);
    // Registration alone must not touch the native layer (TCC laziness).
    assert.deepEqual(helper.calls, []);
  });

  it("write mode exposes the full tool set", async () => {
    const client = await connect({ mode: "write", helper: new FakeHelper() });
    const names = (await client.listTools()).tools.map((t) => t.name);
    for (const expected of [
      "calendar_create_event", "calendar_update_event", "calendar_delete_event",
      "reminders_create", "reminders_complete", "reminders_delete",
    ]) {
      assert.ok(names.includes(expected), `missing ${expected}`);
    }
  });

  it("list results carry the _untrusted marker and structured content", async () => {
    const client = await connect({ mode: "read", helper: new FakeHelper() });
    const result = await client.callTool({
      name: "calendar_list_events",
      arguments: { from: "2026-01-01T00:00:00Z", to: "2026-01-02T00:00:00Z" },
    });
    const structured = result.structuredContent as {
      _untrusted: boolean;
      events: Array<{ title: string }>;
    };
    assert.equal(structured._untrusted, true);
    assert.equal(structured.events[0]?.title, "untrusted title");
  });

  it("payload content flows to the helper byte-identical", async () => {
    const helper = new FakeHelper();
    const client = await connect({ mode: "write", helper });
    const hostile = 'x" & (do shell script "rm -rf ~") & "';
    await client.callTool({
      name: "calendar_create_event",
      arguments: { title: hostile, start: "2026-01-01T10:00:00Z", end: "2026-01-01T11:00:00Z" },
    });
    const create = helper.calls.find((c) => c.op === "calendar.create_event");
    assert.equal((create?.args as { title: string }).title, hostile);
  });

  it("delete requires confirmation: declined → helper never called", async () => {
    const helper = new FakeHelper();
    const client = await connect({ mode: "write", helper, elicit: "decline" });
    const result = await client.callTool({
      name: "reminders_delete",
      arguments: { id: "rem-1" },
    });
    assert.equal(result.isError, true);
    assert.equal(helper.calls.length, 0, "helper must not be reached without consent");
  });

  it("delete requires confirmation: accepted → executes", async () => {
    const helper = new FakeHelper();
    const client = await connect({ mode: "write", helper, elicit: "accept" });
    const result = await client.callTool({
      name: "calendar_delete_event",
      arguments: { id: "evt-1" },
    });
    assert.notEqual(result.isError, true);
    assert.equal(helper.calls[0]?.op, "calendar.delete_event");
  });

  it("helper errors surface as tool errors with the hint, not crashes", async () => {
    const helper = new FakeHelper();
    helper.call = async () => {
      throw Object.assign(new Error("Calendar access is not granted (grant it in System Settings)"), {
        code: "permission_denied",
      });
    };
    const client = await connect({ mode: "read", helper });
    const result = await client.callTool({
      name: "calendar_list_calendars",
      arguments: {},
    });
    assert.equal(result.isError, true);
    const text = (result.content as Array<{ text: string }>)[0]?.text ?? "";
    assert.match(text, /System Settings/);
  });

  it("resources read through the same backend", async () => {
    const client = await connect({ mode: "read", helper: new FakeHelper() });
    const res = await client.readResource({ uri: "reminders://lists" });
    const body = JSON.parse((res.contents[0] as { text: string }).text) as {
      _untrusted: boolean;
      data: Array<{ title: string }>;
    };
    assert.equal(body._untrusted, true);
    assert.equal(body.data[0]?.title, "Inbox");
  });
});
