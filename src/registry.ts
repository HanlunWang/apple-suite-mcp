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
import { ReadCache } from "./cache.ts";
import { registerCapabilityTools } from "./capabilities.ts";
import {
  type AppConfig,
  MODULE_IDS,
  type ModuleId,
  REMOTE_BLOCKED_MODULES,
  isModuleEnabled,
  needsConfirmation,
} from "./config.ts";
import { ConfirmationRefusedError, confirmOrThrow } from "./confirm.ts";
import { logger } from "./logger.ts";
import type { AppModule, ToolDef } from "./modules/_template/module.ts";
import { SlidingWindowLimiter } from "./ratelimit.ts";

export type ModuleLoader = () => Promise<AppModule>;

/** Lazy loaders — a module's code is only imported once it is enabled. */
// tsc's rewriteRelativeImportExtensions does not rewrite dynamic import()
// specifiers, so derive the extension (.ts in dev, .js in dist) from how this
// file itself is running.
const EXT = import.meta.url.slice(import.meta.url.lastIndexOf("."));

export const MODULE_LOADERS: Partial<Record<ModuleId, ModuleLoader>> = {
  calendar: async () =>
    (
      (await import(`./modules/calendar/module${EXT}`)) as typeof import("./modules/calendar/module.ts")
    ).createCalendarModule(),
  reminders: async () =>
    (
      (await import(`./modules/reminders/module${EXT}`)) as typeof import("./modules/reminders/module.ts")
    ).createRemindersModule(),
  contacts: async () =>
    (
      (await import(`./modules/contacts/module${EXT}`)) as typeof import("./modules/contacts/module.ts")
    ).createContactsModule(),
  notes: async () =>
    (
      (await import(`./modules/notes/module${EXT}`)) as typeof import("./modules/notes/module.ts")
    ).createNotesModule(),
  mail: async () =>
    (
      (await import(`./modules/mail/module${EXT}`)) as typeof import("./modules/mail/module.ts")
    ).createMailModule(),
  messages: async () =>
    (
      (await import(`./modules/messages/module${EXT}`)) as typeof import("./modules/messages/module.ts")
    ).createMessagesModule(),
  maps: async () =>
    (
      (await import(`./modules/maps/module${EXT}`)) as typeof import("./modules/maps/module.ts")
    ).createMapsModule(),
  photos: async () =>
    (
      (await import(`./modules/photos/module${EXT}`)) as typeof import("./modules/photos/module.ts")
    ).createPhotosModule(),
  music: async () =>
    (
      (await import(`./modules/music/module${EXT}`)) as typeof import("./modules/music/module.ts")
    ).createMusicModule(),
  shortcuts: async () =>
    (
      (await import(`./modules/shortcuts/module${EXT}`)) as typeof import("./modules/shortcuts/module.ts")
    ).createShortcutsModule(),
};

export interface RegistrationSummary {
  modules: ModuleId[];
  tools: string[];
  resources: string[];
}

export interface RegisterOptions {
  /** True for sessions arriving over the remote (HTTP) transport. Remote
   *  sessions get the minimal surface (DESIGN.md §4): high-risk modules are
   *  never registered, and write mode requires allowRemoteWrite. */
  remote?: boolean;
}

export async function registerEnabledModules(
  server: McpServer,
  cfg: AppConfig,
  loaders: Partial<Record<ModuleId, ModuleLoader>> = MODULE_LOADERS,
  opts: RegisterOptions = {},
): Promise<RegistrationSummary> {
  const remote = opts.remote === true;
  const allowRemoteWrite = cfg.transport.type === "http" && cfg.transport.allowRemoteWrite;
  const summary: RegistrationSummary = { modules: [], tools: [], resources: [] };
  const perTool = new SlidingWindowLimiter(cfg.rateLimits.perToolPerMinute);
  const perSession = new SlidingWindowLimiter(cfg.rateLimits.perSessionPerMinute);
  const cache = new ReadCache(cfg.cache.readTtlSeconds, cfg.cache.maxEntries);

  // Advertise tools/resources capabilities even with zero modules enabled, so
  // clients can list (empty) instead of getting "method not found".
  server.server.registerCapabilities({ tools: { listChanged: false }, resources: {} });

  if (cfg.capabilityTools) {
    summary.tools.push(...registerCapabilityTools(server, cfg, { remote }));
  }

  for (const id of MODULE_IDS) {
    if (!isModuleEnabled(cfg, id)) continue;
    if (remote && REMOTE_BLOCKED_MODULES.has(id)) {
      logger.warn("registry.remote_blocked", { module: id });
      continue;
    }
    const loader = loaders[id];
    if (!loader) {
      logger.warn("registry.module_not_implemented", { module: id });
      continue;
    }

    // A module whose native backend is missing (helper not built yet) must
    // not take down the whole server — skip it and keep the rest running.
    let mod: AppModule;
    try {
      mod = await loader();
    } catch (err) {
      logger.error("registry.module_unavailable", {
        module: id,
        error: (err as Error).message,
      });
      continue;
    }
    const configuredMode = cfg.modules[id]?.mode ?? "read";
    const mode = remote && !allowRemoteWrite ? "read" : configuredMode;
    summary.modules.push(id);

    for (const res of mod.resources()) {
      // A URI with no RFC 6570 expression is a CONCRETE resource: register it
      // as a plain URI so it appears in resources/list. Templates registered
      // without a list callback are deliberately absent from that listing —
      // clients discover them through resources/templates/list instead.
      const isTemplate = res.uriTemplate.includes("{");
      const target = isTemplate
        ? new ResourceTemplate(res.uriTemplate, { list: undefined })
        : res.uriTemplate;

      server.registerResource(
        res.name,
        target as never,
        {
          title: res.title ?? res.name,
          description: res.description,
          mimeType: res.mimeType ?? "application/json",
        },
        (async (uri: URL, params: Record<string, unknown>) => {
          if (!perSession.take("session") || !perTool.take(`res:${res.name}`)) {
            throw new Error(`rate limit exceeded for resource "${res.name}"`);
          }
          // Template variables always arrive as strings (RFC 6570 expansion);
          // the backends coerce them. A concrete resource gets no params.
          const data = await res.read(uri, params ?? {});
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
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
        }) as any,
      );
      summary.resources.push(res.name);
    }

    const tools = mod.tools(mode).filter((t) => t.mode === "read" || mode === "write");
    for (const tool of tools) {
      registerTool(server, cfg, tool, { perTool, perSession, cache, module: id });
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
  ctx: {
    perTool: SlidingWindowLimiter;
    perSession: SlidingWindowLimiter;
    cache: ReadCache;
    module: ModuleId;
  },
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
      if (!ctx.perSession.take("session") || !ctx.perTool.take(`tool:${tool.name}`)) {
        return errorResult(`Rate limit exceeded for "${tool.name}". Retry later.`);
      }
      try {
        // Validate BEFORE interrupting the user: approving a confirmation
        // only to hit a schema error afterwards trains people to click through
        // dialogs, which is the opposite of what the gate is for.
        tool.validate?.(args);

        if (confirmable) {
          await confirmOrThrow(server, tool.actionId, tool.confirmPreview!(args));
        }

        if (tool.mode === "read") {
          const cached = ctx.cache.get(ctx.module, tool.name, args);
          if (cached !== undefined) {
            logger.debug("tool.cache_hit", { tool: tool.name });
            return {
              content: [{ type: "text" as const, text: JSON.stringify(cached) }],
              structuredContent: cached as Record<string, unknown>,
            };
          }
        }

        const result = await tool.run(args, { signal: extra.signal });

        if (tool.mode === "read") {
          ctx.cache.set(ctx.module, tool.name, args, result);
        } else {
          // Any write invalidates this module's cached reads immediately.
          ctx.cache.invalidateModule(ctx.module);
        }

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
