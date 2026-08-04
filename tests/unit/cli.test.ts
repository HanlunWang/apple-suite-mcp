import { afterEach, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const CLI = join(import.meta.dirname, "..", "..", "cli", "index.ts");

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "apple-mcp-cli-"));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function run(args: string[]): { stdout: string; status: number } {
  try {
    const stdout = execFileSync(process.execPath, [CLI, ...args], {
      env: { ...process.env, APPLE_MCP_CONFIG_DIR: dir },
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    return { stdout, status: 0 };
  } catch (err) {
    const e = err as { status?: number; stdout?: string };
    return { stdout: e.stdout ?? "", status: e.status ?? 1 };
  }
}

function configState(): Record<string, { enabled: boolean; mode: string }> {
  let text: string;
  try {
    text = readFileSync(join(dir, "config.json"), "utf8");
  } catch {
    return {}; // no config written at all — nothing was enabled
  }
  const raw = JSON.parse(text) as {
    modules: Record<string, { enabled: boolean; mode: string }>;
  };
  return raw.modules;
}

describe("apple-mcp CLI", () => {
  it("status generates defaults on first run and shows all modules disabled", () => {
    const { stdout, status } = run(["status"]);
    assert.equal(status, 0);
    assert.match(stdout, /calendar\s+disabled/);
    assert.match(stdout, /messages\s+disabled\s+\[Full Disk Access\]/);
  });

  it("enable defaults to read-only", () => {
    const { status } = run(["enable", "calendar"]);
    assert.equal(status, 0);
    assert.deepEqual(configState()["calendar"], { enabled: true, mode: "read" });
  });

  it("enable --write sets write mode; disable resets", () => {
    run(["enable", "reminders", "--write"]);
    assert.deepEqual(configState()["reminders"], { enabled: true, mode: "write" });
    run(["disable", "reminders"]);
    assert.deepEqual(configState()["reminders"], { enabled: false, mode: "read" });
  });

  it("rejects unknown modules with exit code 2", () => {
    const { status } = run(["enable", "spotify"]);
    assert.equal(status, 2);
  });

  it("refuses to enable the FDA module non-interactively without --yes", () => {
    const { status } = run(["enable", "messages"]);
    assert.notEqual(status, 0);
    const state = configState();
    assert.equal(state["messages"]?.enabled ?? false, false);
  });

  it("enables the FDA module with explicit --yes acknowledgement", () => {
    const { status } = run(["enable", "messages", "--write", "--yes"]);
    assert.equal(status, 0);
    assert.deepEqual(configState()["messages"], { enabled: true, mode: "write" });
  });
});
