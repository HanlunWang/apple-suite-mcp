#!/usr/bin/env node
// Stub for /usr/bin/osascript in notes-runner tests. Mimics the single-shot
// protocol of the fixed JXA template: reads request JSON on stdin, prints one
// JSON response. Ops: echo | fail | garbage | hang
const chunks = [];
process.stdin.on("data", (c) => chunks.push(c));
process.stdin.on("end", () => {
  const req = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  switch (req.op) {
    case "echo":
      process.stdout.write(JSON.stringify({ id: req.id, ok: true, data: { echoed: req } }));
      break;
    case "fail":
      process.stdout.write(
        JSON.stringify({
          id: req.id,
          ok: false,
          error: { code: "permission_denied", message: "nope", hint: "allow automation" },
        }),
      );
      break;
    case "garbage":
      process.stdout.write("this is not json");
      break;
    case "hang":
      setTimeout(() => process.exit(0), 60_000);
      return;
    default:
      process.stdout.write(
        JSON.stringify({ id: req.id, ok: false, error: { code: "invalid_request", message: "?" } }),
      );
  }
});
