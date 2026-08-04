/**
 * Module contract. Every Apple app (calendar, reminders, contacts, ...) is a
 * module implementing this interface. See DESIGN.md §3 & §6.
 *
 * The registry (src/registry.ts) only loads + registers modules that are
 * ENABLED in config. A disabled module contributes zero tools/resources,
 * is never even import()ed, and never touches the OS — the strongest form
 * of permission gating.
 */

import type { z } from "zod";

export type Mode = "read" | "write";

/** A read-only capability, surfaced to MCP clients as a Resource. */
export interface ResourceDef {
  /** RFC 6570 template, e.g. "calendar://events{?from,to}" */
  uriTemplate: string;
  name: string;
  title?: string;
  description: string;
  /** Defaults to application/json. */
  mimeType?: string;
  read(uri: URL, params: Record<string, unknown>): Promise<unknown>;
}

/** An action, surfaced to MCP clients as a Tool. */
export interface ToolDef {
  /** SEP-986 canonical name, e.g. "calendar_create_event" */
  name: string;
  title?: string;
  description: string;
  /** Zod raw shape — the SDK derives the JSON Schema from this. */
  inputSchema: z.ZodRawShape;
  outputSchema?: z.ZodRawShape;
  /** "write" tools are only registered when the module is in write mode. */
  mode: Mode;
  /** Action id for confirmation matching, "<module>.<action>", e.g. "mail.send".
   *  Keep the action segment stable ("send", "delete", "create") so config
   *  rules like "*.delete" match across modules. */
  actionId: string;
  /** MCP tool annotations (untrusted hints, but honest ones). */
  annotations?: {
    readOnlyHint?: boolean;
    destructiveHint?: boolean;
    idempotentHint?: boolean;
    openWorldHint?: boolean;
  };
  /** Human-readable preview shown in the elicitation confirmation dialog,
   *  e.g. "Send mail to a@b.c — subject: …". Required for confirmable tools. */
  confirmPreview?(input: Record<string, unknown>): string;
  /** Long-running implementations should honor ctx.signal (MCP cancellation). */
  run(input: Record<string, unknown>, ctx?: { signal?: AbortSignal }): Promise<unknown>;
}

export interface AppModule {
  id: string;
  /** Human-facing note shown by `apple-mcp enable`, e.g. FDA warning. */
  activationNotice?: string;
  /** Whether this module requires an isolated FDA helper process. */
  requiresFullDiskAccess?: boolean;
  /** Resources this module exposes (read). */
  resources(mode: Mode): ResourceDef[];
  /** Tools this module exposes (filtered by mode in the registry). */
  tools(mode: Mode): ToolDef[];
}

/**
 * IMPORTANT (security): tool/resource handlers must pass user/model-supplied
 * strings to the native helper as STRUCTURED DATA (JSON over stdin/argv).
 * Never interpolate them into AppleScript/shell source. See DESIGN.md §5.1
 * and the injection test suite under tests/injection/.
 */
