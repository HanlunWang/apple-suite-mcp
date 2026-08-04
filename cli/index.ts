#!/usr/bin/env node
/**
 * apple-mcp CLI — the human-in-the-loop control surface (DESIGN.md §3.4).
 *
 *   apple-mcp status
 *   apple-mcp enable <module> [--write] [--yes]
 *   apple-mcp disable <module>
 *
 * Enabling a module edits ~/.apple-mcp/config.json. Changes apply on server
 * RESTART — deliberately, so a running session cannot be coerced into
 * enabling capabilities. Enabling an FDA module (messages) requires explicit
 * acknowledgement because it grants access to the full iMessage history.
 */

import { createInterface } from "node:readline/promises";
import { loadPending, savePending } from "../src/capabilities.ts";
import {
  type AppConfig,
  FDA_MODULES,
  MODULE_IDS,
  type ModuleId,
  configPath,
  isModuleId,
  loadConfig,
  saveConfig,
  ConfigError,
} from "../src/config.ts";

const USAGE = `apple-mcp — capability control for the Apple Suite MCP server

Usage:
  apple-mcp status                       Show module matrix + config path
  apple-mcp enable <module> [--write]    Enable a module (read-only by default)
  apple-mcp disable <module>             Disable a module
  apple-mcp pending                      Show enable requests queued by the model
  apple-mcp approve <module>             Approve a pending request
  apple-mcp reject <module>              Discard a pending request
  apple-mcp help                         Show this help

Modules: ${MODULE_IDS.join(", ")}

Changes apply when the server is restarted.`;

function fail(message: string, code = 1): never {
  process.stderr.write(`error: ${message}\n`);
  process.exit(code);
}

function requireModuleId(arg: string | undefined): ModuleId {
  if (!arg) fail(`missing <module>. Modules: ${MODULE_IDS.join(", ")}`, 2);
  if (!isModuleId(arg)) fail(`unknown module "${arg}". Modules: ${MODULE_IDS.join(", ")}`, 2);
  return arg;
}

function printStatus(cfg: AppConfig): void {
  const rows = MODULE_IDS.map((id) => {
    const m = cfg.modules[id] ?? { enabled: false, mode: "read" as const };
    const state = m.enabled ? (m.mode === "write" ? "enabled (read/write)" : "enabled (read)") : "disabled";
    const fda = FDA_MODULES.has(id) ? "  [Full Disk Access]" : "";
    return `  ${id.padEnd(10)} ${state}${fda}`;
  });
  process.stdout.write(
    [
      `config: ${configPath()}`,
      `transport: ${cfg.transport.type}`,
      `confirmation required: ${cfg.requireConfirmation.join(", ") || "(none)"}`,
      "",
      "modules:",
      ...rows,
      "",
      "Note: enabling a module exposes its tools/resources to MCP clients after a",
      "server restart. macOS will still ask for the corresponding system permission",
      "on first real use (enable ≠ authorized).",
      "",
    ].join("\n"),
  );
}

async function acknowledgeFda(id: ModuleId, yes: boolean): Promise<void> {
  process.stderr.write(
    [
      "",
      `⚠  "${id}" requires FULL DISK ACCESS.`,
      "   It reads ~/Library/Messages/chat.db — your ENTIRE iMessage history.",
      "   The helper runs as an isolated process; revoke it anytime in",
      "   System Settings → Privacy & Security → Full Disk Access.",
      "",
    ].join("\n"),
  );
  if (yes) return;
  if (!process.stdin.isTTY) {
    fail(`refusing to enable "${id}" non-interactively without --yes`);
  }
  const rl = createInterface({ input: process.stdin, output: process.stderr });
  const answer = (await rl.question(`Type "yes" to enable ${id}: `)).trim().toLowerCase();
  rl.close();
  if (answer !== "yes") fail("aborted — module not enabled");
}

async function main(): Promise<void> {
  const [cmd, ...rest] = process.argv.slice(2);
  const flags = new Set(rest.filter((a) => a.startsWith("--")));
  const args = rest.filter((a) => !a.startsWith("--"));
  for (const f of flags) {
    if (!["--write", "--yes"].includes(f)) fail(`unknown flag ${f}`, 2);
  }

  switch (cmd) {
    case undefined:
    case "help":
    case "--help":
    case "-h":
      process.stdout.write(USAGE + "\n");
      return;

    case "status":
      printStatus(loadConfig());
      return;

    case "enable": {
      const id = requireModuleId(args[0]);
      const write = flags.has("--write");
      if (FDA_MODULES.has(id)) await acknowledgeFda(id, flags.has("--yes"));
      const cfg = loadConfig();
      cfg.modules[id] = { enabled: true, mode: write ? "write" : "read" };
      saveConfig(cfg);
      process.stdout.write(
        `enabled ${id} (${write ? "read/write" : "read-only"}). Restart the server to apply.\n`,
      );
      return;
    }

    case "disable": {
      const id = requireModuleId(args[0]);
      const cfg = loadConfig();
      cfg.modules[id] = { enabled: false, mode: "read" };
      saveConfig(cfg);
      process.stdout.write(`disabled ${id}. Restart the server to apply.\n`);
      return;
    }

    case "pending": {
      const pending = loadPending();
      const entries = Object.entries(pending.requests);
      if (entries.length === 0) {
        process.stdout.write("no pending enable requests\n");
        return;
      }
      for (const [id, req] of entries) {
        const fda = FDA_MODULES.has(id as ModuleId) ? "  [Full Disk Access]" : "";
        process.stdout.write(`  ${id.padEnd(10)} ${req.mode.padEnd(5)} requested ${req.requestedAt}${fda}\n`);
      }
      process.stdout.write('\nApprove with "apple-mcp approve <module>" or discard with "apple-mcp reject <module>".\n');
      return;
    }

    case "approve": {
      const id = requireModuleId(args[0]);
      const pending = loadPending();
      const req = pending.requests[id];
      if (!req) fail(`no pending request for "${id}" (see "apple-mcp pending")`);
      if (FDA_MODULES.has(id)) await acknowledgeFda(id, flags.has("--yes"));
      const cfg = loadConfig();
      cfg.modules[id] = { enabled: true, mode: req.mode };
      saveConfig(cfg);
      delete pending.requests[id];
      savePending(pending);
      process.stdout.write(
        `approved ${id} (${req.mode === "write" ? "read/write" : "read-only"}). Restart the server to apply.\n`,
      );
      return;
    }

    case "reject": {
      const id = requireModuleId(args[0]);
      const pending = loadPending();
      if (!pending.requests[id]) fail(`no pending request for "${id}"`);
      delete pending.requests[id];
      savePending(pending);
      process.stdout.write(`rejected pending request for ${id}.\n`);
      return;
    }

    default:
      fail(`unknown command "${cmd}"\n\n${USAGE}`, 2);
  }
}

main().catch((err: unknown) => {
  if (err instanceof ConfigError) fail(`${err.message}\nhint: ${err.hint}`);
  fail((err as Error).message);
});
