/**
 * Read-only integration checks for the high-risk M4 modules. They touch the
 * real Mail app (Automation TCC) and the real chat.db (Full Disk Access), so
 * they are OFF by default and NEVER send anything. Opt in with:
 *
 *   npm run build:native
 *   APPLE_MCP_INTEGRATION=1 npm test
 */
import { after, describe, it } from "node:test";
import assert from "node:assert/strict";

import { JxaMailClient } from "../../src/native/mail.ts";
import { MessagesDbClient } from "../../src/native/messages.ts";

const enabled = process.env["APPLE_MCP_INTEGRATION"] === "1";

describe(
  "mail integration (real Mail + Automation TCC, read-only)",
  { skip: !enabled && "set APPLE_MCP_INTEGRATION=1" },
  () => {
    it("lists unread without throwing (and never sends)", async () => {
      const client = new JxaMailClient(120_000);
      const messages = await client.call<unknown[]>("mail.list_unread", { limit: 3 });
      assert.ok(Array.isArray(messages));
    });
  },
);

describe(
  "messages read integration (real chat.db, needs Full Disk Access)",
  { skip: !enabled && "set APPLE_MCP_INTEGRATION=1" },
  () => {
    const client = new MessagesDbClient();
    after(() => client.close());

    it("lists chats without throwing", async () => {
      const chats = await client.call<unknown[]>("messages.list_chats", { limit: 5 });
      assert.ok(Array.isArray(chats));
    });
  },
);
