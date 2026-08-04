/**
 * Read-only integration checks against the REAL Contacts store and Notes app.
 * They trigger macOS permission prompts (Contacts TCC; Notes Automation), so
 * they are OFF by default. Opt in with:
 *
 *   npm run build:native
 *   APPLE_MCP_INTEGRATION=1 npm test
 */
import { after, describe, it } from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { join } from "node:path";

import { ContactsHelperClient } from "../../src/native/contacts.ts";
import { JxaNotesClient } from "../../src/native/notes.ts";

const CONTACTS = join(
  import.meta.dirname, "..", "..",
  "native", "contacts-helper", ".build", "release", "contacts-helper",
);

const enabled = process.env["APPLE_MCP_INTEGRATION"] === "1";

describe(
  "contacts-helper integration (touches real Contacts + TCC)",
  { skip: !(enabled && existsSync(CONTACTS)) && "set APPLE_MCP_INTEGRATION=1 and build the helper" },
  () => {
    const client = new ContactsHelperClient(CONTACTS, 120_000);
    after(() => client.close());

    it("searches contacts without throwing", async () => {
      const results = await client.call<unknown[]>("contacts.search", { query: "a", limit: 5 });
      assert.ok(Array.isArray(results));
    });
  },
);

describe(
  "notes JXA integration (touches real Notes + Automation TCC)",
  { skip: !enabled && "set APPLE_MCP_INTEGRATION=1" },
  () => {
    it("lists folders without throwing", async () => {
      const client = new JxaNotesClient(120_000);
      const folders = await client.call<Array<{ name: string }>>("notes.list_folders");
      assert.ok(Array.isArray(folders));
    });
  },
);
