/**
 * Client for the resident eventkit-helper process (calendar + reminders).
 * One shared client (and thus one helper process) serves both modules; the
 * helper processes requests serially, which also satisfies the "serialize
 * calls into the same app" concurrency rule.
 */

import { existsSync } from "node:fs";
import { join } from "node:path";
import {
  HelperCallError,
  type HelperClient,
  HelperProcessClient,
  packageRoot,
} from "./client.ts";

export { HelperCallError, type HelperClient };

/** Fixed helper binary name (resolved to an absolute path at startup). */
export const EVENTKIT_HELPER_BIN = "eventkit-helper";

/** Fixed argv for every invocation. Request data NEVER appears in argv —
 *  argv is visible in `ps` output and easier to mangle than an stdin pipe. */
export const HELPER_ARGV: readonly string[] = Object.freeze(["--json-stdin"]);

/** Locate the built helper binary. Never derived from request data. */
export function resolveHelperPath(): string {
  const override = process.env["APPLE_MCP_EVENTKIT_HELPER"];
  if (override) return override;

  const root = packageRoot(import.meta.dirname);
  const candidates = [
    join(root, "native", "eventkit-helper", ".build", "release", EVENTKIT_HELPER_BIN),
    join(root, "native", "eventkit-helper", ".build", "debug", EVENTKIT_HELPER_BIN),
  ];
  for (const p of candidates) if (existsSync(p)) return p;
  throw new HelperCallError(
    "helper_missing",
    `${EVENTKIT_HELPER_BIN} binary not found`,
    `Build it with "npm run build:native" (requires Xcode command line tools), ` +
      `or point APPLE_MCP_EVENTKIT_HELPER at the binary.`,
  );
}

export class EventKitHelperClient extends HelperProcessClient {
  constructor(binPath?: string, timeoutMs?: number) {
    super(binPath ?? resolveHelperPath(), HELPER_ARGV, timeoutMs);
  }
}

let shared: EventKitHelperClient | undefined;

/** One helper process shared by the calendar and reminders modules. */
export function sharedEventKitClient(): HelperClient {
  return (shared ??= new EventKitHelperClient());
}
