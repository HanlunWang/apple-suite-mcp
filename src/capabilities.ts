/**
 * manage_capabilities meta tools (DESIGN.md §3.4).
 *
 * The one resident tool pair that is available without enabling any module:
 *  - capabilities_list          read-only view of the module matrix
 *  - capabilities_request_enable  writes a PENDING request only
 *
 * A pending request NEVER takes effect on its own: a human must approve it
 * with `apple-mcp approve <module>` (which re-runs the FDA acknowledgement
 * for high-risk modules) and restart the server. This keeps runtime sessions
 * incapable of expanding their own permissions, while still letting the
 * model discover what could be enabled and queue a request for the user.
 */

import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import {
  type AppConfig,
  FDA_MODULES,
  MODULE_IDS,
  configDir,
  configPath,
} from "./config.ts";
import { logger } from "./logger.ts";

const PendingFile = z.object({
  version: z.literal(1),
  requests: z.partialRecord(
    z.enum(MODULE_IDS),
    z.object({ mode: z.enum(["read", "write"]), requestedAt: z.string() }),
  ),
});
export type PendingFile = z.infer<typeof PendingFile>;

export function pendingPath(): string {
  return join(configDir(), "pending.json");
}

export function loadPending(): PendingFile {
  try {
    const parsed = PendingFile.safeParse(JSON.parse(readFileSync(pendingPath(), "utf8")));
    if (parsed.success) return parsed.data;
  } catch {
    // missing or unreadable → empty
  }
  return { version: 1, requests: {} };
}

export function savePending(p: PendingFile): void {
  if (Object.keys(p.requests).length === 0) {
    rmSync(pendingPath(), { force: true });
    return;
  }
  writeFileSync(pendingPath(), JSON.stringify(p, null, 2) + "\n", { mode: 0o600 });
}

/** Register the meta tools. The enable-request tool is LOCAL-ONLY: remote
 *  sessions can inspect the matrix but not queue permission changes. */
export function registerCapabilityTools(
  server: McpServer,
  cfg: AppConfig,
  opts: { remote: boolean },
): string[] {
  const registered: string[] = [];

  server.registerTool(
    "capabilities_list",
    {
      title: "List capabilities",
      description:
        "Show which Apple-app modules exist, which are enabled (read or " +
        "read/write), and any pending enable requests awaiting human approval. " +
        "An absent tool means its module is disabled — request it with " +
        "capabilities_request_enable instead of working around it.",
      inputSchema: {},
      annotations: { title: "List capabilities", readOnlyHint: true, destructiveHint: false },
    },
    async () => {
      const pending = loadPending();
      const modules = Object.fromEntries(
        MODULE_IDS.map((id) => [
          id,
          {
            enabled: cfg.modules[id]?.enabled ?? false,
            mode: cfg.modules[id]?.mode ?? "read",
            requiresFullDiskAccess: FDA_MODULES.has(id),
            pending: pending.requests[id] ?? null,
          },
        ]),
      );
      const data = {
        modules,
        note: "Changes require human approval via the apple-mcp CLI and a server restart.",
      };
      return {
        content: [{ type: "text" as const, text: JSON.stringify(data) }],
        structuredContent: data,
      };
    },
  );
  registered.push("capabilities_list");

  if (!opts.remote) {
    server.registerTool(
      "capabilities_request_enable",
      {
        title: "Request module enable",
        description:
          "Queue a request to enable a module. This does NOT enable anything: " +
          "the user must approve it by running `apple-mcp approve <module>` in " +
          "a terminal and restarting the server. Returns what to tell the user.",
        inputSchema: {
          module: z.enum(MODULE_IDS).describe("Module to request."),
          mode: z
            .enum(["read", "write"])
            .default("read")
            .describe("Requested access mode. Prefer read unless writes are needed."),
        },
        annotations: { title: "Request module enable", readOnlyHint: false, destructiveHint: false },
      },
      async ({ module: moduleId, mode }) => {
        const pending = loadPending();
        pending.requests[moduleId] = { mode, requestedAt: new Date().toISOString() };
        savePending(pending);
        logger.info("capabilities.request_enable", { module: moduleId, mode });
        const fdaNote = FDA_MODULES.has(moduleId)
          ? " This module requires Full Disk Access and shows an extra warning on approval."
          : "";
        const data = {
          queued: { module: moduleId, mode },
          nextStep:
            `Ask the user to run \`apple-mcp approve ${moduleId}\` in a terminal, ` +
            `then restart the MCP server.${fdaNote}`,
        };
        return {
          content: [{ type: "text" as const, text: JSON.stringify(data) }],
          structuredContent: data,
        };
      },
    );
    registered.push("capabilities_request_enable");
  }

  logger.info("capabilities.registered", { tools: registered, configPath: configPath() });
  return registered;
}
