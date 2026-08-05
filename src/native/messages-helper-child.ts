/**
 * messages-helper — isolated child process for chat.db reads (DESIGN.md §3.5).
 *
 * Runs as its own OS process so the ONLY code touching the Full-Disk-Access
 * surface is this file plus the parameterized query layer: the MCP server
 * process never opens chat.db. Speaks the standard NDJSON helper protocol on
 * stdio. The database is opened READ-ONLY and lazily — spawning the helper
 * does not touch the file until the first data operation.
 *
 * Sending is deliberately NOT here (that is the messages-send JXA template,
 * gated by elicitation in the server).
 */

import { createInterface } from "node:readline";
import { homedir } from "node:os";
import { join } from "node:path";
import DatabaseCtor, { type Database } from "better-sqlite3";
import { listChats, listMessages, searchMessages } from "./messages-queries.ts";

interface Request {
  id: number;
  op: string;
  args?: Record<string, unknown>;
}

class HelperError extends Error {
  readonly code: string;
  readonly hint: string | undefined;

  constructor(message: string, code: string, hint?: string) {
    super(message);
    this.code = code;
    this.hint = hint;
  }
}

const FDA_HINT =
  "Grant Full Disk Access in System Settings → Privacy & Security → Full Disk " +
  "Access to the process running the MCP server, then restart it. Enabling the " +
  "messages module requires this — see `apple-mcp enable messages`.";

function chatDbPath(): string {
  return process.env["APPLE_MCP_CHATDB"] ?? join(homedir(), "Library", "Messages", "chat.db");
}

let db: Database | undefined;

function ensureDb(): Database {
  if (db) return db;
  try {
    db = new DatabaseCtor(chatDbPath(), { readonly: true, fileMustExist: true });
    return db;
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code ?? "";
    if (
      code === "EPERM" ||
      code === "EACCES" ||
      code.startsWith("SQLITE_CANTOPEN") ||
      /unable to open database/i.test((err as Error).message)
    ) {
      throw new HelperError("cannot open chat.db — Full Disk Access is not granted", "permission_denied", FDA_HINT);
    }
    throw new HelperError((err as Error).message, "internal");
  }
}

function clampLimit(value: unknown, fallback: number): number {
  const n = typeof value === "number" && Number.isFinite(value) ? Math.trunc(value) : fallback;
  return Math.min(Math.max(n, 1), 200);
}

function handle(req: Request): unknown {
  const args = req.args ?? {};
  switch (req.op) {
    case "ping":
      return { pong: true, version: "0.1.0" };
    case "messages.list_chats":
      return listChats(ensureDb(), clampLimit(args["limit"], 25));
    case "messages.list":
      return listMessages(
        ensureDb(),
        typeof args["chatGuid"] === "string" ? args["chatGuid"] : null,
        clampLimit(args["limit"], 50),
      );
    case "messages.search": {
      const query = typeof args["query"] === "string" ? args["query"] : "";
      if (!query) throw new HelperError("query must not be empty", "invalid_request");
      return searchMessages(ensureDb(), query, clampLimit(args["limit"], 25));
    }
    default:
      throw new HelperError(`unknown op ${req.op}`, "invalid_request");
  }
}

function main(): void {
  if (process.argv[2] !== "--json-stdin") {
    process.stderr.write("usage: messages-helper-child --json-stdin\n");
    process.exit(2);
  }
  const rl = createInterface({ input: process.stdin });
  rl.on("line", (line) => {
    if (!line.trim()) return;
    let id = 0;
    try {
      const req = JSON.parse(line) as Request;
      id = req.id ?? 0;
      const data = handle(req);
      process.stdout.write(JSON.stringify({ id, ok: true, data }) + "\n");
    } catch (err) {
      const e =
        err instanceof HelperError
          ? err
          : new HelperError(err instanceof Error ? err.message : "internal error", "internal");
      process.stdout.write(
        JSON.stringify({
          id,
          ok: false,
          error: { code: e.code, message: e.message, ...(e.hint ? { hint: e.hint } : {}) },
        }) + "\n",
      );
    }
  });
}

main();
