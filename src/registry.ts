/**
 * Module → tool/resource registry (DESIGN.md §3).
 *
 * Registration-time gating: a module that is not enabled in config is never
 * even import()ed — it contributes zero tools/resources, the client cannot
 * see (let alone call) it, and no TCC prompt can fire. Write-mode tools are
 * additionally dropped unless the module is in write mode, and confirmable
 * actions are wrapped with the elicitation gate.
 */

import { McpServer, ResourceTemplate } from "@modelcontextprotocol/sdk/server/mcp.js";
import {
  ListResourceTemplatesRequestSchema,
  ListResourcesRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import {
  type AppConfig,
  MODULE_IDS,
  type ModuleId,
  isModuleEnabled,
  needsConfirmation,
} from "./config.ts";
import { ConfirmationRefusedError, confirmOrThrow } from "./confirm.ts";
import { logger } from "./logger.ts";
import type { AppModule, ToolDef } from "./modules/_template/module.ts";
import { SlidingWindowLimiter } from "./ratelimit.ts";

export type ModuleLoader = () => Promise<AppModule>;

/**
 * Lazy loaders — a module's code is only imported once it is enabled.
 * Filled in as milestones land (M1: calendar, reminders; M3: contacts, notes; …).
 */
export const MODULE_LOADERS: Partial<Record<ModuleId, ModuleLoader>> = {
  // M1: calendar: async () => (await import("./modules/calendar/module.ts")).default,
  // M1: reminders: async () => (await import("./modules/reminders/module.ts")).default,
};

export interface RegistrationSummary {
  modules: ModuleId[];
  tools: string[];
  resources: string[];
}

export async function registerEnabledModules(
  server: McpServer,
  cfg: AppConfig,
  loaders: Partial<Record<ModuleId, ModuleLoader>> = MODULE_LOADERS,
): Promise<RegistrationSummary> {
  const summary: RegistrationSummary = { modules: [], tools: [], resources: [] };
  const perTool = new SlidingWindowLimiter(cfg.rateLimits.perToolPerMinute);
  const perSession = new SlidingWindowLimiter(cfg.rateLimits.perSessionPerMinute);

  // Advertise tools/resources capabilities even with zero modules enabled, so
  // clients can list (empty) instead of getting "method not found".
  server.server.registerCapabilities({ tools: { listChanged: false }, resources: {} });

  for (const id of MODULE_IDS) {
    if (!isModuleEnabled(cfg, id)) continue;
    const loader = loaders[id];
    if (!loader) {
      logger.warn("registry.module_not_implemented", { module: id });
      continue;
    }

    const mod = await loader();
    const mode = cfg.modules[id]?.mode ?? "read";
    summary.modules.push(id);

    for (const res of mod.resources(mode)) {
      server.registerResource(
        res.name,
        new ResourceTemplate(res.uriTemplate, { list: undefined }),
        {
          title: res.title ?? res.name,
          description: res.description,
          mimeType: res.mimeType ?? "application/json",
        },
        async (uri, params) => {
          if (!perSession.take("session") || !perTool.take(`res:${res.name}`)) {
            throw new Error(`rate limit exceeded for resource "${res.name}"`);
          }
          const data = await res.read(uri, params as Record<string, unknown>);
          // Content read from Apple apps is untrusted input to the model
          // (DESIGN.md §5.4) — label it so clients/models can treat it as data.
          const payload = { _untrusted: true, data };
          return {
            contents: [
              {
                uri: uri.href,
                mimeType: res.mimeType ?? "application/json",
                text: JSON.stringify(payload),
              },
            ],
          };
        },
      );
      summary.resources.push(res.name);
    }

    const tools = mod.tools(mode).filter((t) => t.mode === "read" || mode === "write");
    for (const tool of tools) {
      registerTool(server, cfg, tool, { perTool, perSession });
      summary.tools.push(tool.name);
    }
  }

  // With zero registered tools/resources the SDK never installs the list
  // handlers; install empty ones so clients get an empty list rather than
  // "method not found".
  if (summary.tools.length === 0) {
    server.server.setRequestHandler(ListToolsRequestSchema, () => ({ tools: [] }));
  }
  if (summary.resources.length === 0) {
    server.server.setRequestHandler(ListResourcesRequestSchema, () => ({ resources: [] }));
    server.server.setRequestHandler(ListResourceTemplatesRequestSchema, () => ({
      resourceTemplates: [],
    }));
  }

  logger.info("registry.registered", {
    modules: summary.modules,
    toolCount: summary.tools.length,
    resourceCount: summary.resources.length,
  });
  return summary;
}

function registerTool(
  server: McpServer,
  cfg: AppConfig,
  tool: ToolDef,
  limits: { perTool: SlidingWindowLimiter; perSession: SlidingWindowLimiter },
): void {
  const confirmable = needsConfirmation(cfg, tool.actionId);
  if (confirmable && !tool.confirmPreview) {
    // A confirmable tool without a human-readable preview cannot present an
    // informed choice — refuse to register it at all (fail closed).
    throw new Error(
      `tool "${tool.name}" (${tool.actionId}) requires confirmation but defines no confirmPreview`,
    );
  }

  server.registerTool(
    tool.name,
    {
      title: tool.title ?? tool.name,
      description: tool.description,
      inputSchema: tool.inputSchema,
      ...(tool.outputSchema ? { outputSchema: tool.outputSchema } : {}),
      annotations: {
        // Always emit title + readOnlyHint + destructiveHint (Anthropic
        // directory hard requirements; hosts derive permission UX from them).
        // Conservative default: a write tool is destructive unless the module
        // explicitly says otherwise.
        title: tool.title ?? tool.name,
        readOnlyHint: tool.mode === "read",
        destructiveHint: tool.mode === "write",
        ...tool.annotations,
      },
    },
    (async (args: Record<string, unknown>, extra: { signal: AbortSignal }) => {
      if (!limits.perSession.take("session") || !limits.perTool.take(`tool:${tool.name}`)) {
        return errorResult(`Rate limit exceeded for "${tool.name}". Retry later.`);
      }
      try {
        if (confirmable) {
          await confirmOrThrow(server, tool.actionId, tool.confirmPreview!(args));
        }
        const result = await tool.run(args, { signal: extra.signal });
        return {
          content: [{ type: "text" as const, text: JSON.stringify(result) }],
          structuredContent: result as Record<string, unknown>,
        };
      } catch (err) {
        if (err instanceof ConfirmationRefusedError) return errorResult(err.message);
        logger.error("tool.failed", { tool: tool.name, error: (err as Error).message });
        return errorResult(`${tool.name} failed: ${(err as Error).message}`);
      }
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    }) as any,
  );
}

function errorResult(message: string) {
  return { content: [{ type: "text" as const, text: message }], isError: true };
}
