/**
 * Client for the Shortcuts CLI (/usr/bin/shortcuts) — the shortcuts module.
 *
 * SECURITY: the binary is invoked with execFile and an ARRAY argv — no shell
 * is ever involved, so metacharacters in a shortcut name cannot become
 * commands. Documented exception to the "data never in argv" rule: the
 * Shortcuts CLI takes the shortcut NAME as an argument (there is no stdin
 * alternative). Only the name travels in argv — it is visible in `ps` but is
 * not sensitive content; any INPUT to the shortcut goes via stdin ("-i -").
 *
 * Running a shortcut executes user-authored automation with the user's full
 * privileges, so shortcuts.run sits in the default requireConfirmation list
 * and the module is remote-blocked.
 */

import { execFile } from "node:child_process";
import { HelperCallError, type HelperClient } from "./client.ts";

export const SHORTCUTS_BIN = "/usr/bin/shortcuts";

export class ShortcutsClient implements HelperClient {
  private readonly bin: string;
  private readonly timeoutMs: number;

  constructor(timeoutMs = 120_000) {
    // Test override: point at a stub binary. Never derived from requests.
    this.bin = process.env["APPLE_MCP_SHORTCUTS_BIN"] ?? SHORTCUTS_BIN;
    this.timeoutMs = timeoutMs;
  }

  call<T>(op: string, args: Record<string, unknown> = {}): Promise<T> {
    switch (op) {
      case "shortcuts.list":
        return this.exec(["list"], undefined) as Promise<T>;
      case "shortcuts.run": {
        const name = String(args["name"] ?? "");
        if (!name) {
          return Promise.reject(new HelperCallError("invalid_request", "name is required"));
        }
        const input = typeof args["input"] === "string" ? args["input"] : undefined;
        const argv = input !== undefined ? ["run", name, "-i", "-"] : ["run", name];
        return this.exec(argv, input) as Promise<T>;
      }
      default:
        return Promise.reject(new HelperCallError("invalid_request", `unknown op ${op}`));
    }
  }

  private exec(argv: string[], stdin: string | undefined): Promise<unknown> {
    return new Promise((resolve, reject) => {
      const child = execFile(
        this.bin,
        argv,
        { timeout: this.timeoutMs, maxBuffer: 4 * 1024 * 1024 },
        (err, stdout, stderr) => {
          if (err) {
            const timedOut = err.killed === true;
            reject(
              new HelperCallError(
                timedOut ? "timeout" : "shortcut_failed",
                timedOut
                  ? `shortcut timed out after ${this.timeoutMs}ms`
                  : (stderr.trim() || err.message),
              ),
            );
            return;
          }
          if (argv[0] === "list") {
            resolve({ shortcuts: stdout.split("\n").map((s) => s.trim()).filter(Boolean) });
          } else {
            resolve({ ran: true, output: stdout.trim() || null });
          }
        },
      );
      if (stdin !== undefined) {
        child.stdin!.write(stdin);
      }
      child.stdin!.end();
    });
  }

  close(): void {
    // Per-call processes; nothing resident to stop.
  }
}

let shared: ShortcutsClient | undefined;

export function sharedShortcutsClient(): HelperClient {
  return (shared ??= new ShortcutsClient());
}
