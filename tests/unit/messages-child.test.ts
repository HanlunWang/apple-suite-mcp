/**
 * The messages-helper child end-to-end: spawned as a real separate process
 * over the NDJSON protocol, reading a fixture chat.db (no FDA involved).
 */
import { after, describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";

import { HelperCallError } from "../../src/native/client.ts";
import { MessagesDbClient } from "../../src/native/messages.ts";

const dir = mkdtempSync(join(tmpdir(), "apple-mcp-chatdb-"));
const DB_PATH = join(dir, "chat.db");

{
  const db = new Database(DB_PATH);
  db.exec(`
    CREATE TABLE chat (ROWID INTEGER PRIMARY KEY, guid TEXT, chat_identifier TEXT, display_name TEXT);
    CREATE TABLE handle (ROWID INTEGER PRIMARY KEY, id TEXT);
    CREATE TABLE message (ROWID INTEGER PRIMARY KEY, guid TEXT, text TEXT, attributedBody BLOB, date INTEGER, is_from_me INTEGER, handle_id INTEGER);
    CREATE TABLE chat_message_join (chat_id INTEGER, message_id INTEGER);
    CREATE TABLE chat_handle_join (chat_id INTEGER, handle_id INTEGER);
    INSERT INTO chat VALUES (1, 'iMessage;-;+15550001', '+15550001', NULL);
    INSERT INTO handle VALUES (1, '+15550001');
    INSERT INTO message VALUES (1, 'm1', 'hello from fixture', NULL, 700000000000000000, 0, 1);
    INSERT INTO chat_message_join VALUES (1,1);
    INSERT INTO chat_handle_join VALUES (1,1);
  `);
  db.close();
}

const clients: MessagesDbClient[] = [];
after(() => {
  for (const c of clients) c.close();
  rmSync(dir, { recursive: true, force: true });
});

function makeClient(): MessagesDbClient {
  process.env["APPLE_MCP_CHATDB"] = DB_PATH;
  const c = new MessagesDbClient();
  clients.push(c);
  return c;
}

describe("messages-helper child process", () => {
  it("pings without touching the database", async () => {
    process.env["APPLE_MCP_CHATDB"] = join(dir, "does-not-exist.db");
    const c = new MessagesDbClient();
    clients.push(c);
    const pong = await c.call<{ pong: boolean }>("ping");
    assert.equal(pong.pong, true);
  });

  it("reads chats and messages from the fixture db", async () => {
    const c = makeClient();
    const chats = await c.call<Array<{ guid: string }>>("messages.list_chats", { limit: 10 });
    assert.equal(chats[0]?.guid, "iMessage;-;+15550001");
    const messages = await c.call<Array<{ text: string | null }>>("messages.search", {
      query: "hello",
    });
    assert.equal(messages[0]?.text, "hello from fixture");
  });

  it("missing database surfaces as permission_denied with the FDA hint", async () => {
    process.env["APPLE_MCP_CHATDB"] = join(dir, "does-not-exist.db");
    const c = new MessagesDbClient();
    clients.push(c);
    await assert.rejects(c.call("messages.list_chats"), (err: unknown) => {
      assert.ok(err instanceof HelperCallError);
      assert.equal(err.code, "permission_denied");
      assert.match(err.message, /Full Disk Access/);
      return true;
    });
  });
});
