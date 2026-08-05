/**
 * Client for the resident eventkit-helper process (calendar + reminders).
 * One shared client (and thus one helper process) serves both modules; the
 * helper processes requests serially, which also satisfies the "serialize
 * calls into the same app" concurrency rule.
 */

import {
  HelperCallError,
  type HelperClient,
  HelperProcessClient,
  resolveHelperBin,
} from "./client.ts";

export { HelperCallError, type HelperClient };

/** Fixed helper binary name (resolved to an absolute path at startup). */
export const EVENTKIT_HELPER_BIN = "eventkit-helper";

/** Fixed argv for every invocation. Request data NEVER appears in argv —
 *  argv is visible in `ps` output and easier to mangle than an stdin pipe. */
export const EVENTKIT_HELPER_ARGV: readonly string[] = Object.freeze(["--json-stdin"]);

export function resolveEventKitHelperPath(): string {
  return resolveHelperBin(EVENTKIT_HELPER_BIN, "APPLE_MCP_EVENTKIT_HELPER", import.meta.dirname);
}

export class EventKitHelperClient extends HelperProcessClient {
  constructor(binPath?: string, timeoutMs?: number) {
    super(binPath ?? resolveEventKitHelperPath(), EVENTKIT_HELPER_ARGV, timeoutMs);
  }
}

let shared: EventKitHelperClient | undefined;

/** One helper process shared by the calendar and reminders modules. */
export function sharedEventKitClient(): HelperClient {
  return (shared ??= new EventKitHelperClient());
}
