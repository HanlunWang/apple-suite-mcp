/**
 * SECURITY BOTTOM LINE — SQL boundary for the messages module, exercised
 * against a REAL sqlite database (in-memory, chat.db schema). Complements
 * the serializer suite: here the payloads flow through the actual prepared
 * statements.
 */
import { beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import Database from "better-sqlite3";

import {
  appleNsToIso,
  escapeLike,
  extractText,
  listChats,
  listMessages,
  searchMessages,
} from "../../src/native/messages-queries.ts";

function fixtureDb(): InstanceType<typeof Database> {
  const db = new Database(":memory:");
  db.exec(`
    CREATE TABLE chat (ROWID INTEGER PRIMARY KEY, guid TEXT, chat_identifier TEXT, display_name TEXT);
    CREATE TABLE handle (ROWID INTEGER PRIMARY KEY, id TEXT);
    CREATE TABLE message (ROWID INTEGER PRIMARY KEY, guid TEXT, text TEXT, attributedBody BLOB, date INTEGER, is_from_me INTEGER, handle_id INTEGER);
    CREATE TABLE chat_message_join (chat_id INTEGER, message_id INTEGER);
    CREATE TABLE chat_handle_join (chat_id INTEGER, handle_id INTEGER);
    INSERT INTO chat VALUES (1, 'iMessage;-;+15550001', '+15550001', 'Chat A');
    INSERT INTO handle VALUES (1, '+15550001');
    INSERT INTO message VALUES
      (1, 'm1', 'hello world', NULL, 700000000000000000, 0, 1),
      (2, 'm2', 'discount: 100% off_deal', NULL, 700000000000001000, 1, NULL),
      (3, 'm3', 'contains ''; DROP TABLE message; -- literally', NULL, 700000000000002000, 0, 1);
    INSERT INTO chat_message_join VALUES (1,1),(1,2),(1,3);
    INSERT INTO chat_handle_join VALUES (1,1);
  `);
  return db;
}

let db: InstanceType<typeof Database>;
beforeEach(() => {
  db = fixtureDb();
});

describe("parameterized chat.db queries survive hostile input", () => {
  it("DROP TABLE payload is matched literally, never executed", () => {
    const payload = `'; DROP TABLE message; --`;
    const rows = searchMessages(db, payload, 50);
    // Matches only the message that literally CONTAINS the payload text.
    assert.equal(rows.length, 1);
    assert.match(rows[0]!.text ?? "", /DROP TABLE message/);
    // The table is intact and fully queryable afterwards.
    const count = (db.prepare("SELECT COUNT(*) AS n FROM message").get() as { n: number }).n;
    assert.equal(count, 3);
  });

  it("LIKE wildcards in queries match literally (escaped)", () => {
    // "%" must not act as a wildcard: "100%" matches only the literal text.
    assert.equal(searchMessages(db, "100% off", 50).length, 1);
    assert.equal(searchMessages(db, "100%X", 50).length, 0, "% must not wildcard-match");
    // "_" must not act as single-char wildcard.
    assert.equal(searchMessages(db, "off_deal", 50).length, 1);
    assert.equal(searchMessages(db, "offXdeal", 50).length, 0);
    // Backslash payloads round-trip through the escape without erroring.
    assert.equal(searchMessages(db, "Meeting\\", 50).length, 0);
  });

  it("chatGuid filter is a bound value", () => {
    const hostile = `x' OR '1'='1`;
    assert.equal(listMessages(db, hostile, 50).length, 0, "OR-injection must not widen the filter");
    assert.equal(listMessages(db, "iMessage;-;+15550001", 50).length, 3);
    assert.equal(listMessages(db, null, 50).length, 3);
  });

  it("listChats aggregates without interpreting content", () => {
    const chats = listChats(db, 10);
    assert.equal(chats.length, 1);
    assert.equal(chats[0]!.participants, "+15550001");
    assert.equal(chats[0]!.displayName, "Chat A");
  });
});

describe("helpers", () => {
  it("escapeLike escapes %, _ and backslash", () => {
    assert.equal(escapeLike("100%_x\\y"), "100\\%\\_x\\\\y");
  });

  it("appleNsToIso converts Apple-epoch nanoseconds", () => {
    assert.equal(appleNsToIso(0), null);
    assert.equal(appleNsToIso(null), null);
    assert.equal(appleNsToIso(700000000000000000), "2023-03-08T20:26:40.000Z");
  });

  it("extractText prefers plain text and decodes typedstream NSStrings", () => {
    assert.equal(extractText("plain", null), "plain");

    const short = Buffer.concat([
      Buffer.from("junk__NSString"),
      Buffer.from([0x01, 0x94, 0x84, 0x01, 0x2b, 5]),
      Buffer.from("hello"),
    ]);
    assert.equal(extractText(null, short), "hello");

    const longText = "x".repeat(300);
    const long = Buffer.concat([
      Buffer.from("NSString"),
      Buffer.from([0x01, 0x94, 0x84, 0x01, 0x2b, 0x81]),
      Buffer.from([300 & 0xff, (300 >> 8) & 0xff]),
      Buffer.from(longText),
    ]);
    assert.equal(extractText(null, long), longText);

    assert.equal(extractText(null, Buffer.from("garbage")), null);
    assert.equal(extractText(null, null), null);
  });
});
