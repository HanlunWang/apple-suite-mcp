/**
 * Runner for the Notes JXA backend (DESIGN.md §5.1, "scripting-helper").
 *
 * Notes has no native framework, so it is driven through a FIXED JXA script
 * (native/notes-jxa/notes.js) executed by osascript. The script path and
 * argv are constants; the request travels as JSON on stdin and is consumed
 * by the script as parsed data — it never becomes script source.
 *
 * osascript is spawned per call (Notes calls are infrequent; a resident
 * scripting process would hold the Automation grant open for no benefit).
 *
 * TCC note: Apple Events from osascript are attributed to the process tree
 * running this server, so the Automation prompt names the host app (e.g.
 * your terminal or Claude), not a helper binary. See native/README.md.
 */

import { execFile } from "node:child_process";
import { join } from "node:path";
import { HelperCallError, type HelperClient, type WireResponse, packageRoot } from "./client.ts";

export const OSASCRIPT_BIN = "/usr/bin/osascript";

export function notesScriptPath(): string {
  return join(packageRoot(import.meta.dirname), "native", "notes-jxa", "notes.js");
}

/** Fixed argv: interpreter flag + constant script path. No request data. */
export function notesArgv(): readonly string[] {
  return Object.freeze(["-l", "JavaScript", notesScriptPath()]);
}

export class JxaNotesClient implements HelperClient {
  private readonly bin: string;
  private readonly argv: readonly string[];
  private readonly timeoutMs: number;

  constructor(timeoutMs = 60_000) {
    // Test override: point at a stub interpreter. Never derived from requests.
    this.bin = process.env["APPLE_MCP_OSASCRIPT"] ?? OSASCRIPT_BIN;
    this.argv = notesArgv();
    this.timeoutMs = timeoutMs;
  }

  call<T>(op: string, args: Record<string, unknown> = {}): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const child = execFile(
        this.bin,
        [...this.argv],
        { timeout: this.timeoutMs, maxBuffer: 8 * 1024 * 1024 },
        (err, stdout) => {
          if (err && !stdout) {
            const timedOut = /SIGTERM|timed? ?out/i.test(err.message) || err.killed === true;
            reject(
              new HelperCallError(
                timedOut ? "timeout" : "helper_spawn",
                timedOut
                  ? `notes call ${op} timed out after ${this.timeoutMs}ms — macOS may be ` +
                    `showing an Automation permission dialog; approve it and retry`
                  : err.message,
              ),
            );
            return;
          }
          let resp: WireResponse;
          try {
            resp = JSON.parse(stdout.trim()) as WireResponse;
          } catch {
            reject(new HelperCallError("internal", "notes backend returned malformed output"));
            return;
          }
          if (resp.ok) {
            resolve(resp.data as T);
          } else {
            const e = resp.error ?? { code: "internal", message: "unknown notes error" };
            reject(new HelperCallError(e.code, e.message, e.hint));
          }
        },
      );
      child.stdin!.write(JSON.stringify({ id: 1, op, args }));
      child.stdin!.end();
    });
  }

  close(): void {
    // Per-call processes; nothing resident to stop.
  }
}

let shared: JxaNotesClient | undefined;

export function sharedNotesClient(): HelperClient {
  return (shared ??= new JxaNotesClient());
}
