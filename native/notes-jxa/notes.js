// notes.js — FIXED JXA template for the notes module (DESIGN.md §5.1).
//
// SECURITY CONTRACT: this file is a constant. The server invokes it as
//   osascript -l JavaScript <this file>
// and writes ONE JSON request to stdin; the script prints ONE JSON response.
// Untrusted data arrives exclusively through the parsed JSON request and is
// only ever passed to Notes.app as JXA property values — never concatenated
// into script source, shell text, or argv. The CI static guard scans this
// file; do not introduce template interpolation into executable text.
//
// Note bodies are stored by Notes.app as HTML. Incoming body text is treated
// as PLAIN TEXT and entity-escaped here (presentation encoding, not
// sanitization — the transport layer never rewrites data).
//
// Wire protocol (single-shot, matches the NDJSON helpers):
//   request:  {"id": 1, "op": "notes.list", "args": {...}}
//   success:  {"id": 1, "ok": true, "data": ...}
//   failure:  {"id": 1, "ok": false, "error": {"code", "message", "hint"?}}

ObjC.import("Foundation");

function readStdin() {
  const data = $.NSFileHandle.fileHandleWithStandardInput.readDataToEndOfFile;
  return $.NSString.alloc.initWithDataEncoding(data, $.NSUTF8StringEncoding).js;
}

function escapeHtml(text) {
  return String(text)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function textToBodyHtml(text) {
  return String(text)
    .split("\n")
    .map((line) => "<div>" + (escapeHtml(line) || "<br>") + "</div>")
    .join("");
}

function clampLimit(limit, fallback) {
  const n = Number.isFinite(limit) ? Math.trunc(limit) : fallback;
  return Math.min(Math.max(n, 1), 200);
}

function noteMeta(note, folderName) {
  return {
    id: note.id(),
    name: note.name(),
    folder: folderName,
    modified: note.modificationDate() ? note.modificationDate().toISOString() : null,
  };
}

function findFolder(app, folderName) {
  const folders = app.folders.whose({ name: folderName })();
  if (folders.length === 0) {
    const err = new Error("folder not found: " + folderName);
    err.code = "not_found";
    throw err;
  }
  return folders[0];
}

function handle(req) {
  const app = Application("Notes");
  const args = req.args || {};
  switch (req.op) {
    case "ping":
      return { pong: true, version: "1.0.0" };

    case "notes.list_folders": {
      return app.folders().map((f) => ({ id: f.id(), name: f.name() }));
    }

    case "notes.list": {
      const limit = clampLimit(args.limit, 50);
      const scope = args.folderName ? findFolder(app, String(args.folderName)) : app;
      const notes = scope.notes();
      return notes.slice(0, limit).map((n) => {
        const container = args.folderName ? String(args.folderName) : n.container().name();
        return noteMeta(n, container);
      });
    }

    case "notes.search": {
      const limit = clampLimit(args.limit, 25);
      const query = String(args.query || "");
      if (!query) {
        const err = new Error("query must not be empty");
        err.code = "invalid_request";
        throw err;
      }
      // JXA "whose" clauses take the query as a VALUE in a structured
      // predicate — it is not spliced into any script text.
      const matches = app.notes.whose({
        _or: [{ name: { _contains: query } }, { plaintext: { _contains: query } }],
      })();
      return matches.slice(0, limit).map((n) => noteMeta(n, n.container().name()));
    }

    case "notes.get": {
      const notes = app.notes.whose({ id: String(args.id) })();
      if (notes.length === 0) {
        const err = new Error("note not found: " + String(args.id));
        err.code = "not_found";
        throw err;
      }
      const n = notes[0];
      return {
        id: n.id(),
        name: n.name(),
        folder: n.container().name(),
        plaintext: n.plaintext(),
        modified: n.modificationDate() ? n.modificationDate().toISOString() : null,
      };
    }

    case "notes.create": {
      const title = String(args.title);
      const bodyHtml =
        "<div><h1>" + escapeHtml(title) + "</h1></div>" + textToBodyHtml(String(args.body || ""));
      const target = args.folderName ? findFolder(app, String(args.folderName)) : app.defaultAccount();
      const note = app.Note({ body: bodyHtml });
      target.notes.push(note);
      return { id: note.id(), name: note.name(), folder: args.folderName || null };
    }

    default: {
      const err = new Error("unknown op " + String(req.op));
      err.code = "invalid_request";
      throw err;
    }
  }
}

function run() {
  let id = 0;
  try {
    const req = JSON.parse(readStdin());
    id = req.id || 0;
    return JSON.stringify({ id: id, ok: true, data: handle(req) });
  } catch (e) {
    const message = e && e.message ? String(e.message) : "internal error";
    const code = e && e.code ? String(e.code) : inferCode(message);
    const hint = e && e.hint ? String(e.hint) : hintFor(code);
    return JSON.stringify({
      id: id,
      ok: false,
      error: { code: code, message: message, hint: hint },
    });
  }
}

function inferCode(message) {
  // Automation-permission failures surface as error -1743.
  if (message.indexOf("-1743") !== -1 || /not allowed/i.test(message)) return "permission_denied";
  return "internal";
}

function hintFor(code) {
  if (code === "permission_denied") {
    return (
      "Allow automation of Notes in System Settings → Privacy & Security → " +
      "Automation for the process running the MCP server, then retry."
    );
  }
  return undefined;
}
