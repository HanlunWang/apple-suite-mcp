#!/usr/bin/env node
// Fake eventkit-helper for tests: speaks the NDJSON protocol without EventKit.
// Ops: ping | echo (returns args) | fail (returns an error) |
//      sleep {ms} (delayed pong) | die (exits mid-stream)
import { createInterface } from "node:readline";

if (process.argv[2] !== "--json-stdin") {
  process.stderr.write("usage: fake-eventkit-helper --json-stdin\n");
  process.exit(2);
}

const rl = createInterface({ input: process.stdin });
rl.on("line", (line) => {
  const req = JSON.parse(line);
  const reply = (body) => process.stdout.write(JSON.stringify({ id: req.id, ...body }) + "\n");
  switch (req.op) {
    case "ping":
      reply({ ok: true, data: { pong: true, version: "fake" } });
      break;
    case "echo":
      reply({ ok: true, data: req.args });
      break;
    case "fail":
      reply({
        ok: false,
        error: { code: "permission_denied", message: "nope", hint: "grant access" },
      });
      break;
    case "sleep":
      setTimeout(() => reply({ ok: true, data: { pong: true } }), req.args.ms);
      break;
    case "die":
      process.exit(1);
      break;
    default:
      reply({ ok: false, error: { code: "invalid_request", message: `unknown op ${req.op}` } });
  }
});
