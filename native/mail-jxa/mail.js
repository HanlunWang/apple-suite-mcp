// mail.js — FIXED JXA template for the mail module (DESIGN.md §5.1).
//
// SECURITY CONTRACT: identical to notes-jxa/notes.js — this file is a
// constant invoked as `osascript -l JavaScript mail.js` with ONE JSON request
// on stdin. Untrusted data only ever appears as parsed JSON values passed to
// Mail.app as JXA property values / structured whose-predicates — never
// concatenated into script source, shell text, or argv. Scanned by the CI
// injection guard.
//
// Sending is high-risk: the SERVER gates mail.send behind elicitation
// confirmation before this template is ever invoked. This template performs
// exactly one send per invocation and nothing else.

ObjC.import("Foundation");

function readStdin() {
  const data = $.NSFileHandle.fileHandleWithStandardInput.readDataToEndOfFile;
  return $.NSString.alloc.initWithDataEncoding(data, $.NSUTF8StringEncoding).js;
}

function clampLimit(limit, fallback, max) {
  const n = Number.isFinite(limit) ? Math.trunc(limit) : fallback;
  return Math.min(Math.max(n, 1), max);
}

function isoOrNull(d) {
  return d ? d.toISOString() : null;
}

function messageMeta(m, includeBody) {
  const meta = {
    id: m.id(),
    subject: m.subject(),
    sender: m.sender(),
    dateReceived: isoOrNull(m.dateReceived()),
    mailbox: m.mailbox().name(),
    read: m.readStatus(),
  };
  if (includeBody) {
    const content = String(m.content());
    meta.body = content.length > 4000 ? content.slice(0, 4000) + "\n[truncated]" : content;
  }
  return meta;
}

function requireStringArray(value, field) {
  const arr = Array.isArray(value) ? value.map(String).filter(Boolean) : [];
  if (arr.length === 0) {
    const err = new Error(field + " must be a non-empty array of addresses");
    err.code = "invalid_request";
    throw err;
  }
  return arr;
}

function handle(req) {
  const Mail = Application("Mail");
  const args = req.args || {};
  switch (req.op) {
    case "ping":
      return { pong: true, version: "0.1.0" };

    case "mail.list_unread": {
      const includeBody = args.includeBody === true;
      const limit = clampLimit(args.limit, 20, includeBody ? 20 : 100);
      const unread = Mail.inbox.messages.whose({ readStatus: false })();
      return unread.slice(0, limit).map((m) => messageMeta(m, includeBody));
    }

    case "mail.search": {
      const query = String(args.query || "");
      if (!query) {
        const err = new Error("query must not be empty");
        err.code = "invalid_request";
        throw err;
      }
      const limit = clampLimit(args.limit, 25, 100);
      // Structured whose-predicate: the query is a VALUE, not script text.
      // Inbox only — searching every mailbox via Apple Events is too slow.
      const matches = Mail.inbox.messages.whose({
        _or: [{ subject: { _contains: query } }, { sender: { _contains: query } }],
      })();
      return matches.slice(0, limit).map((m) => messageMeta(m, false));
    }

    case "mail.send": {
      const to = requireStringArray(args.to, "to");
      const cc = Array.isArray(args.cc) ? args.cc.map(String).filter(Boolean) : [];
      const bcc = Array.isArray(args.bcc) ? args.bcc.map(String).filter(Boolean) : [];
      const msg = Mail.OutgoingMessage({
        subject: String(args.subject || ""),
        content: String(args.body || ""),
        visible: false,
      });
      Mail.outgoingMessages.push(msg);
      to.forEach((a) => msg.toRecipients.push(Mail.Recipient({ address: a })));
      cc.forEach((a) => msg.ccRecipients.push(Mail.Recipient({ address: a })));
      bcc.forEach((a) => msg.bccRecipients.push(Mail.Recipient({ address: a })));
      msg.send();
      return { sent: true, to: to, subject: String(args.subject || "") };
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
    return JSON.stringify({
      id: id,
      ok: false,
      error: { code: code, message: message, hint: hintFor(code) },
    });
  }
}

function inferCode(message) {
  if (message.indexOf("-1743") !== -1 || /not allowed/i.test(message)) return "permission_denied";
  return "internal";
}

function hintFor(code) {
  if (code === "permission_denied") {
    return (
      "Allow automation of Mail in System Settings → Privacy & Security → " +
      "Automation for the process running the MCP server, then retry."
    );
  }
  return undefined;
}
