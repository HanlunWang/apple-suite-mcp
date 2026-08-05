// messages-send.js — FIXED JXA template: sends ONE iMessage per invocation.
//
// SECURITY CONTRACT: identical to the other JXA templates — constant file,
// one JSON request on stdin, untrusted data only as parsed JSON values and
// JXA arguments. Scanned by the CI injection guard.
//
// The SERVER gates messages.send behind elicitation confirmation before this
// template is ever invoked. Reading chat history is NOT done here — that is
// the sqlite messages-helper's job (separate process, FDA).

ObjC.import("Foundation");

function readStdin() {
  const data = $.NSFileHandle.fileHandleWithStandardInput.readDataToEndOfFile;
  return $.NSString.alloc.initWithDataEncoding(data, $.NSUTF8StringEncoding).js;
}

function handle(req) {
  const Messages = Application("Messages");
  const args = req.args || {};
  switch (req.op) {
    case "ping":
      return { pong: true, version: "0.1.0" };

    case "messages.send": {
      const body = String(args.body || "");
      if (!body) {
        const err = new Error("body must not be empty");
        err.code = "invalid_request";
        throw err;
      }

      // Preferred: target an existing chat by its guid (from messages_list_chats).
      if (args.chatGuid) {
        const chat = Messages.chats.byId(String(args.chatGuid));
        Messages.send(body, { to: chat });
        return { sent: true, target: String(args.chatGuid) };
      }

      // Fallback: a direct handle (phone/email) on the iMessage service.
      const to = String(args.to || "");
      if (!to) {
        const err = new Error("either chatGuid or to is required");
        err.code = "invalid_request";
        throw err;
      }
      const services = Messages.services.whose({ serviceType: "iMessage" })();
      if (services.length === 0) {
        const err = new Error("no iMessage service is configured");
        err.code = "not_found";
        throw err;
      }
      const buddies = services[0].buddies.whose({ handle: to })();
      if (buddies.length === 0) {
        const err = new Error("no iMessage buddy with handle: " + to);
        err.code = "not_found";
        err.hint = "Use messages_list_chats and send with chatGuid instead.";
        throw err;
      }
      Messages.send(body, { to: buddies[0] });
      return { sent: true, target: to };
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
  if (message.indexOf("-1743") !== -1 || /not allowed/i.test(message)) return "permission_denied";
  return "internal";
}

function hintFor(code) {
  if (code === "permission_denied") {
    return (
      "Allow automation of Messages in System Settings → Privacy & Security → " +
      "Automation for the process running the MCP server, then retry."
    );
  }
  return undefined;
}
