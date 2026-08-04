/**
 * Client for the resident eventkit-helper process (calendar + reminders).
 *
 * SECURITY (DESIGN.md §5.1): requests cross to the helper as STRUCTURED
 * NDJSON on stdin. The helper binary path and argv are fixed at construction
 * time and never contain request data.
 *
 * The helper is spawned LAZILY on the first call — merely enabling a module
 * (or listing its tools) starts no native process and triggers no TCC prompt.
 * One shared client (and thus one helper process) serves both the calendar
 * and reminders modules; the helper processes requests serially, which also
 * satisfies the "serialize calls into the same app" concurrency rule.
 */

import { spawn, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { createInterface } from "node:readline";
import { dirname, join } from "node:path";
import { logger } from "../logger.ts";

/** Fixed helper binary name (resolved to an absolute path at startup). */
export const EVENTKIT_HELPER_BIN = "eventkit-helper";

/** Fixed argv for every invocation. Request data NEVER appears in argv —
 *  argv is visible in `ps` output and easier to mangle than an stdin pipe. */
export const HELPER_ARGV: readonly string[] = Object.freeze(["--json-stdin"]);

const DEFAULT_TIMEOUT_MS = 30_000;

export class HelperCallError extends Error {
  readonly code: string;
  readonly hint: string | undefined;

  constructor(code: string, message: string, hint?: string) {
    super(hint ? `${message} (${hint})` : message);
    this.name = "HelperCallError";
    this.code = code;
    this.hint = hint;
  }
}

/** Minimal interface modules depend on — lets tests inject a fake. */
export interface HelperClient {
  call<T>(op: string, args?: Record<string, unknown>): Promise<T>;
  close(): void;
}

interface WireResponse {
  id: number;
  ok: boolean;
  data?: unknown;
  error?: { code: string; message: string; hint?: string };
}

interface Pending {
  resolve(value: unknown): void;
  reject(err: Error): void;
  timer: NodeJS.Timeout;
}

/** Locate the built helper binary. Never derived from request data. */
export function resolveHelperPath(): string {
  const override = process.env["APPLE_MCP_EVENTKIT_HELPER"];
  if (override) return override;

  // Walk up from this file to the package root (works from src/ and dist/).
  let dir = import.meta.dirname;
  for (let i = 0; i < 6; i++) {
    if (existsSync(join(dir, "package.json"))) break;
    dir = dirname(dir);
  }
  const candidates = [
    join(dir, "native", "eventkit-helper", ".build", "release", EVENTKIT_HELPER_BIN),
    join(dir, "native", "eventkit-helper", ".build", "debug", EVENTKIT_HELPER_BIN),
  ];
  for (const p of candidates) if (existsSync(p)) return p;
  throw new HelperCallError(
    "helper_missing",
    `${EVENTKIT_HELPER_BIN} binary not found`,
    `Build it with "npm run build:native" (requires Xcode command line tools), ` +
      `or point APPLE_MCP_EVENTKIT_HELPER at the binary.`,
  );
}

export class EventKitHelperClient implements HelperClient {
  private child: ChildProcess | undefined;
  private nextId = 1;
  private readonly pending = new Map<number, Pending>();
  private readonly binPath: string;
  private readonly timeoutMs: number;

  constructor(binPath?: string, timeoutMs: number = DEFAULT_TIMEOUT_MS) {
    // Resolve eagerly so a missing binary fails at construction with a clear
    // hint, and the path is immutable for the client's lifetime.
    this.binPath = binPath ?? resolveHelperPath();
    this.timeoutMs = timeoutMs;
  }

  private ensureChild(): ChildProcess {
    if (this.child && this.child.exitCode === null && !this.child.killed) return this.child;

    const child = spawn(this.binPath, [...HELPER_ARGV], {
      stdio: ["pipe", "pipe", "inherit"],
    });
    createInterface({ input: child.stdout! }).on("line", (line) => this.onLine(line));
    child.on("error", (err) => this.failAll(new HelperCallError("helper_spawn", err.message)));
    child.on("exit", (code) => {
      logger.warn("helper.exit", { code });
      this.failAll(
        new HelperCallError(
          "helper_exit",
          `helper process exited (code ${code}); it restarts on the next call`,
        ),
      );
      if (this.child === child) this.child = undefined;
    });
    this.child = child;
    logger.info("helper.spawned", { bin: this.binPath });
    return child;
  }

  private onLine(line: string): void {
    let resp: WireResponse;
    try {
      resp = JSON.parse(line) as WireResponse;
    } catch {
      logger.error("helper.bad_response");
      return;
    }
    const pending = this.pending.get(resp.id);
    if (!pending) return;
    this.pending.delete(resp.id);
    clearTimeout(pending.timer);
    if (resp.ok) {
      pending.resolve(resp.data);
    } else {
      const e = resp.error ?? { code: "internal", message: "unknown helper error" };
      pending.reject(new HelperCallError(e.code, e.message, e.hint));
    }
  }

  private failAll(err: Error): void {
    for (const p of this.pending.values()) {
      clearTimeout(p.timer);
      p.reject(err);
    }
    this.pending.clear();
  }

  call<T>(op: string, args: Record<string, unknown> = {}): Promise<T> {
    const child = this.ensureChild();
    const id = this.nextId++;
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(
          new HelperCallError(
            "timeout",
            `helper call ${op} timed out after ${this.timeoutMs}ms`,
            `If this is the first use, macOS may be showing a permission dialog — approve it and retry.`,
          ),
        );
      }, this.timeoutMs);
      this.pending.set(id, { resolve: resolve as (v: unknown) => void, reject, timer });
      child.stdin!.write(JSON.stringify({ id, op, args }) + "\n");
    });
  }

  close(): void {
    this.child?.kill();
    this.child = undefined;
  }
}

let shared: EventKitHelperClient | undefined;

/** One helper process shared by the calendar and reminders modules. */
export function sharedEventKitClient(): HelperClient {
  return (shared ??= new EventKitHelperClient());
}
