/**
 * Generic client for resident native helper processes (DESIGN.md §2, §5.1).
 *
 * Every helper speaks the same NDJSON protocol over stdio; the binary path
 * and argv are fixed at construction time and never contain request data.
 * Helpers are spawned LAZILY on the first call, so enabling a module (or
 * listing its tools) starts no native process and triggers no TCC prompt.
 */

import { spawn, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { createInterface } from "node:readline";
import { dirname, join } from "node:path";
import { logger } from "../logger.ts";

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

/** Minimal interface modules depend on — lets tests inject a fake.
 *  `signal` carries MCP cancellation down to the backend where the backend
 *  can act on it (per-call processes can be killed; the resident NDJSON
 *  helpers finish the in-flight request and simply stop being awaited). */
export interface HelperClient {
  call<T>(op: string, args?: Record<string, unknown>, signal?: AbortSignal): Promise<T>;
  close(): void;
}

export interface WireResponse {
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

/** Walk up from a module directory to the package root (works from src/ and dist/). */
export function packageRoot(fromDir: string): string {
  let dir = fromDir;
  for (let i = 0; i < 6; i++) {
    if (existsSync(join(dir, "package.json"))) return dir;
    dir = dirname(dir);
  }
  return fromDir;
}

export class HelperProcessClient implements HelperClient {
  private child: ChildProcess | undefined;
  private nextId = 1;
  private readonly pending = new Map<number, Pending>();
  private readonly binPath: string;
  private readonly argv: readonly string[];
  private readonly timeoutMs: number;

  constructor(binPath: string, argv: readonly string[], timeoutMs = 30_000) {
    this.binPath = binPath;
    this.argv = argv;
    this.timeoutMs = timeoutMs;
  }

  private ensureChild(): ChildProcess {
    if (this.child && this.child.exitCode === null && !this.child.killed) return this.child;

    const child = spawn(this.binPath, [...this.argv], {
      stdio: ["pipe", "pipe", "inherit"],
    });
    createInterface({ input: child.stdout! }).on("line", (line) => this.onLine(line));
    child.on("error", (err) => this.failAll(new HelperCallError("helper_spawn", err.message)));
    child.on("exit", (code) => {
      logger.warn("helper.exit", { bin: this.binPath, code });
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
      logger.error("helper.bad_response", { bin: this.binPath });
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

  call<T>(op: string, args: Record<string, unknown> = {}, signal?: AbortSignal): Promise<T> {
    const child = this.ensureChild();
    const id = this.nextId++;
    return new Promise<T>((resolve, reject) => {
      signal?.addEventListener(
        "abort",
        () => {
          const p = this.pending.get(id);
          if (!p) return;
          this.pending.delete(id);
          clearTimeout(p.timer);
          reject(new HelperCallError("cancelled", `helper call ${op} was cancelled`));
        },
        { once: true },
      );
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
