/**
 * Integration tests against the REAL eventkit-helper and the REAL EventKit
 * stores. These touch macOS TCC (a permission prompt appears on first run)
 * and mutate the user's default calendar/reminder list, so they are OFF by
 * default. Opt in with:
 *
 *   npm run build:native
 *   APPLE_MCP_INTEGRATION=1 npm test
 */
import { after, describe, it } from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { join } from "node:path";

import { EventKitHelperClient } from "../../src/native/eventkit.ts";

const REAL = join(
  import.meta.dirname, "..", "..",
  "native", "eventkit-helper", ".build", "release", "eventkit-helper",
);

const enabled = process.env["APPLE_MCP_INTEGRATION"] === "1" && existsSync(REAL);
const skip = enabled ? false : "set APPLE_MCP_INTEGRATION=1 and build the helper to run";

describe("eventkit-helper integration (touches real EventKit + TCC)", { skip }, () => {
  const client = new EventKitHelperClient(REAL, 120_000);
  after(() => client.close());

  it("creates, lists, and deletes a calendar event", async () => {
    const start = new Date(Date.now() + 60 * 60_000);
    const end = new Date(start.getTime() + 30 * 60_000);
    const marker = `apple-suite-mcp integration ${Date.now()}`;

    const created = await client.call<{ id: string; title: string }>(
      "calendar.create_event",
      { title: marker, start: start.toISOString(), end: end.toISOString() },
    );
    assert.equal(created.title, marker);

    const events = await client.call<Array<{ id: string; title: string }>>(
      "calendar.list_events",
      { from: new Date(Date.now() - 60_000).toISOString(), to: end.toISOString(), limit: 500 },
    );
    assert.ok(events.some((e) => e.id === created.id));

    const deleted = await client.call<{ deleted: boolean }>("calendar.delete_event", {
      id: created.id,
    });
    assert.equal(deleted.deleted, true);
  });

  it("creates, completes, and deletes a reminder", async () => {
    const marker = `apple-suite-mcp integration ${Date.now()}`;
    const created = await client.call<{ id: string; completed: boolean }>(
      "reminders.create",
      { title: marker, priority: "low" },
    );
    assert.equal(created.completed, false);

    const completed = await client.call<{ completed: boolean }>("reminders.complete", {
      id: created.id,
    });
    assert.equal(completed.completed, true);

    const deleted = await client.call<{ deleted: boolean }>("reminders.delete", {
      id: created.id,
    });
    assert.equal(deleted.deleted, true);
  });
});
