/**
 * Generic runner for FIXED JXA templates executed by osascript
 * (DESIGN.md §5.1, "scripting-helper").
 *
 * The script path and argv are constants per client; the request travels as
 * JSON on stdin and is consumed by the template as parsed data — it never
 * becomes script source. osascript is spawned per call.
 *
 * TCC note: Apple Events from osascript are attributed to the process tree
 * running this server, so Automation prompts name the host app (terminal /
 * Claude), not a helper binary. See native/README.md.
 */

import { execFile } from "node:child_process";
import { HelperCallError, type HelperClient, type WireResponse } from "./client.ts";

export const OSASCRIPT_BIN = "/usr/bin/osascript";

export class JxaScriptClient implements HelperClient {
  private readonly bin: string;
  private readonly argv: readonly string[];
  private readonly timeoutMs: number;
  private readonly appLabel: string;

  constructor(scriptPath: string, appLabel: string, timeoutMs = 60_000) {
    // Test override: point at a stub interpreter. Never derived from requests.
    this.bin = process.env["APPLE_MCP_OSASCRIPT"] ?? OSASCRIPT_BIN;
    this.argv = Object.freeze(["-l", "JavaScript", scriptPath]);
    this.appLabel = appLabel;
    this.timeoutMs = timeoutMs;
  }

  call<T>(op: string, args: Record<string, unknown> = {}, signal?: AbortSignal): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      let cancelled = false;
      const child = execFile(
        this.bin,
        [...this.argv],
        { timeout: this.timeoutMs, maxBuffer: 8 * 1024 * 1024 },
        (err, stdout, stderr) => {
          if (cancelled) {
            reject(new HelperCallError("cancelled", `${this.appLabel} call ${op} was cancelled`));
            return;
          }
          if (err && !stdout) {
            const timedOut = err.killed === true || /SIGTERM|timed? ?out/i.test(err.message);
            const tooLarge = (err as NodeJS.ErrnoException).code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER";
            reject(
              new HelperCallError(
                timedOut ? "timeout" : tooLarge ? "too_large" : "helper_spawn",
                timedOut
                  ? `${this.appLabel} call ${op} timed out after ${this.timeoutMs}ms — macOS may ` +
                    `be showing an Automation permission dialog; approve it and retry`
                  : tooLarge
                    ? `${this.appLabel} returned more data than the 8MB buffer allows; narrow the query`
                    : (stderr?.trim() || err.message),
              ),
            );
            return;
          }
          let resp: WireResponse;
          try {
            resp = JSON.parse(stdout.trim()) as WireResponse;
          } catch {
            reject(
              new HelperCallError("internal", `${this.appLabel} backend returned malformed output`),
            );
            return;
          }
          if (resp.ok) {
            resolve(resp.data as T);
          } else {
            const e = resp.error ?? { code: "internal", message: `unknown ${this.appLabel} error` };
            reject(new HelperCallError(e.code, e.message, e.hint));
          }
        },
      );
      // MCP cancellation: osascript runs per call, so it can genuinely be
      // stopped rather than left running until the timeout.
      signal?.addEventListener(
        "abort",
        () => {
          cancelled = true;
          child.kill();
        },
        { once: true },
      );

      child.stdin!.write(JSON.stringify({ id: 1, op, args }));
      child.stdin!.end();
    });
  }

  close(): void {
    // Per-call processes; nothing resident to stop.
  }
}
