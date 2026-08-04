import { after, describe, it } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, existsSync } from "node:fs";
import { join } from "node:path";

import {
  EventKitHelperClient,
  HelperCallError,
} from "../../src/native/eventkit.ts";

const FAKE = join(import.meta.dirname, "..", "fixtures", "fake-eventkit-helper.mjs");
chmodSync(FAKE, 0o755);

const clients: EventKitHelperClient[] = [];
function makeClient(timeoutMs?: number): EventKitHelperClient {
  const c = new EventKitHelperClient(FAKE, timeoutMs);
  clients.push(c);
  return c;
}
after(() => {
  for (const c of clients) c.close();
});

describe("EventKitHelperClient (against the fake helper)", () => {
  it("round-trips structured data unchanged", async () => {
    const client = makeClient();
    const payload = { title: 'x" & (do shell script "rm -rf ~") & "', n: 42 };
    const echoed = await client.call<typeof payload>("echo", payload);
    assert.deepEqual(echoed, payload);
  });

  it("maps helper errors to HelperCallError with code and hint", async () => {
    const client = makeClient();
    await assert.rejects(
      client.call("fail"),
      (err: unknown) => {
        assert.ok(err instanceof HelperCallError);
        assert.equal(err.code, "permission_denied");
        assert.equal(err.hint, "grant access");
        return true;
      },
    );
  });

  it("interleaves concurrent calls by id", async () => {
    const client = makeClient();
    const [slow, fast] = await Promise.all([
      client.call<{ pong: boolean }>("sleep", { ms: 120 }),
      client.call<{ pong: boolean }>("ping"),
    ]);
    assert.equal(slow.pong, true);
    assert.equal(fast.pong, true);
  });

  it("times out with an actionable hint", async () => {
    const client = makeClient(100);
    await assert.rejects(client.call("sleep", { ms: 5_000 }), (err: unknown) => {
      assert.ok(err instanceof HelperCallError);
      assert.equal(err.code, "timeout");
      assert.match(err.message, /permission dialog/);
      return true;
    });
  });

  it("rejects in-flight calls when the helper dies, then respawns", async () => {
    const client = makeClient();
    await assert.rejects(client.call("die"), (err: unknown) => {
      assert.ok(err instanceof HelperCallError);
      assert.equal(err.code, "helper_exit");
      return true;
    });
    const pong = await client.call<{ pong: boolean }>("ping");
    assert.equal(pong.pong, true);
  });
});

describe("real helper protocols (no TCC required)", () => {
  const EVENTKIT = join(
    import.meta.dirname, "..", "..",
    "native", "eventkit-helper", ".build", "release", "eventkit-helper",
  );
  const CONTACTS = join(
    import.meta.dirname, "..", "..",
    "native", "contacts-helper", ".build", "release", "contacts-helper",
  );

  it("eventkit-helper answers ping", { skip: !existsSync(EVENTKIT) && "helper not built" }, async () => {
    const real = new EventKitHelperClient(EVENTKIT);
    clients.push(real);
    const pong = await real.call<{ pong: boolean; version: string }>("ping");
    assert.equal(pong.pong, true);
  });

  it("contacts-helper answers ping", { skip: !existsSync(CONTACTS) && "helper not built" }, async () => {
    const { ContactsHelperClient } = await import("../../src/native/contacts.ts");
    const real = new ContactsHelperClient(CONTACTS);
    clients.push(real);
    const pong = await real.call<{ pong: boolean; version: string }>("ping");
    assert.equal(pong.pong, true);
  });
});
